import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionEvent } from "@clam/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOmpRuntime, type OmpSupervisor } from "../src/omp/index.ts";
import { AgentRuntimeError, type RuntimeSession } from "../src/types.ts";

const FAKE_OMP = fileURLToPath(new URL("./fixtures/fake-omp.mjs", import.meta.url));

let tmp: string;
const supervisors: OmpSupervisor[] = [];

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "clam-handoff-summary-"));
});

afterEach(async () => {
	await Promise.all(supervisors.splice(0).map((s) => s.shutdown()));
	rmSync(tmp, { recursive: true, force: true });
});

async function open(id: string, env: Record<string, string> = {}): Promise<{ session: RuntimeSession; events: SessionEvent[] }> {
	const supervisor = createOmpRuntime({
		binary: () => FAKE_OMP,
		settings: { maxConcurrentRuntimes: 2, idleTimeoutMs: 60_000, approvalMode: "yolo" },
		env: { FAKE_OMP_EVENT_DELAY_MS: "1", ...env },
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

async function talk(session: RuntimeSession, events: SessionEvent[], message: string): Promise<void> {
	const before = events.filter((e) => e.type === "settled").length;
	await session.prompt({ message, clientId: `c-${message}` });
	await waitFor(() => events.filter((e) => e.type === "settled").length > before, `settle of ${message}`);
}

describe("RuntimeSession.handoffSummary", () => {
	it("reads the handoff document from the saved path", async () => {
		const { session, events } = await open("h1");
		await talk(session, events, "first request");
		await talk(session, events, "second request");
		const result = await session.handoffSummary("be brief");
		expect(result.savedPath).not.toBeNull();
		expect(existsSync(result.savedPath as string)).toBe(true);
		expect(result.text).toBe(readFileSync(result.savedPath as string, "utf8").trim());
		expect(result.text).toContain("- first request");
		expect(result.text).toContain("- second request");
		expect(result.text).toContain("Extra instructions: be brief");
	});

	it("falls back to the newest compactionSummary message when no path is saved", async () => {
		const { session, events } = await open("h2", { FAKE_OMP_HANDOFF: "summary-message" });
		await talk(session, events, "only request");
		const result = await session.handoffSummary();
		expect(result.savedPath).toBeNull();
		expect(result.text).toContain("- only request");
	});

	it("answers null text when the runtime produced no document", async () => {
		const { session, events } = await open("h3", { FAKE_OMP_HANDOFF: "null" });
		await talk(session, events, "a request");
		expect(await session.handoffSummary()).toEqual({ text: null, savedPath: null });
	});

	it("rejects while a turn is running and when there is nothing to hand off", async () => {
		const { session, events } = await open("h4");
		await expect(session.handoffSummary()).rejects.toMatchObject({ code: "rejected" });
		await session.prompt({ message: "__slow__", clientId: "slow" });
		await waitFor(() => events.some((e) => e.type === "agent_start"), "the agent to start");
		await expect(session.handoffSummary()).rejects.toBeInstanceOf(AgentRuntimeError);
		await expect(session.handoffSummary()).rejects.toMatchObject({ code: "invalid_state" });
		await session.abort();
		await waitFor(() => events.some((e) => e.type === "settled"), "settle after abort");
	});
});
