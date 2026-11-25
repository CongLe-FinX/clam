import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionEvent } from "@clam/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOmpRuntime, type OmpSupervisor } from "../src/omp/index.ts";
import type { RuntimeSession } from "../src/types.ts";

const FAKE_OMP = fileURLToPath(new URL("./fixtures/fake-omp.mjs", import.meta.url));

let tmp: string;
const supervisors: OmpSupervisor[] = [];

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "clam-account-pin-"));
});

afterEach(async () => {
	await Promise.all(supervisors.splice(0).map((s) => s.shutdown()));
	rmSync(tmp, { recursive: true, force: true });
});

async function open(id: string): Promise<{ session: RuntimeSession; events: SessionEvent[] }> {
	const supervisor = createOmpRuntime({
		binary: () => FAKE_OMP,
		settings: { maxConcurrentRuntimes: 2, idleTimeoutMs: 60_000, approvalMode: "yolo" },
		env: { FAKE_OMP_EVENT_DELAY_MS: "1" },
		startTimeoutMs: 5000,
		requestTimeoutMs: 5000,
		closeGraceMs: 1000,
		stateRefreshMs: 10,
		restart: { baseDelayMs: 20, maxDelayMs: 100, maxAttempts: 3 },
		reapIntervalMs: 20,
	});
	supervisors.push(supervisor);
	const events: SessionEvent[] = [];
	supervisor.onEvent((_sessionId, event) => events.push(event));
	const cwd = join(tmp, "project");
	mkdirSync(cwd, { recursive: true });
	return { session: await supervisor.open({ sessionId: id, cwd, sessionDir: join(tmp, "sessions", id) }), events };
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 6000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("RuntimeSession OAuth account pinning", () => {
	it("lists accounts with the active one and switches it on pin", async () => {
		const { session } = await open("pin1");
		expect(await session.oauthAccounts()).toEqual({
			provider: "Fake",
			accounts: [
				{ label: "a@example.com", active: true },
				{ label: "b@example.com (Org B)", active: false },
			],
		});
		await session.pinOauthAccount("b@example.com (Org B)");
		const after = await session.oauthAccounts();
		expect(after?.accounts.map((a) => a.active)).toEqual([false, true]);
		await expect(session.pinOauthAccount("nobody@example.com")).rejects.toMatchObject({ code: "invalid_argument" });
	});

	it("refuses while a turn is running", async () => {
		const { session, events } = await open("pin2");
		await session.prompt({ message: "__slow__", clientId: "slow" });
		await waitFor(() => events.some((e) => e.type === "agent_start"), "the agent to start");
		await expect(session.oauthAccounts()).rejects.toMatchObject({ code: "invalid_state" });
		await expect(session.pinOauthAccount("a@example.com")).rejects.toMatchObject({ code: "invalid_state" });
		await session.abort();
		await waitFor(() => events.some((e) => e.type === "settled"), "settle after abort");
	});
});
