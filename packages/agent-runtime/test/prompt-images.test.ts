import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionEvent } from "@clam/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type OmpSupervisor, createOmpRuntime } from "../src/omp/index.ts";
import { AgentRuntimeError } from "../src/types.ts";

const FAKE_OMP = fileURLToPath(new URL("./fixtures/fake-omp.mjs", import.meta.url));
// 1×1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let tmp: string;
const supervisors: OmpSupervisor[] = [];
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "clam-prompt-images-"));
});
afterEach(async () => {
	await Promise.all(supervisors.splice(0).map((s) => s.shutdown()));
	rmSync(tmp, { recursive: true, force: true });
});

function open(env: Record<string, string> = {}) {
	const supervisor = createOmpRuntime({
		binary: () => FAKE_OMP,
		settings: { maxConcurrentRuntimes: 2, idleTimeoutMs: 60_000, approvalMode: "yolo" },
		env: { FAKE_OMP_LOG: join(tmp, "fake.log"), FAKE_OMP_EVENT_DELAY_MS: "1", ...env },
		startTimeoutMs: 5000,
		requestTimeoutMs: 5000,
		closeGraceMs: 1000,
		stateRefreshMs: 10,
		reapIntervalMs: 20,
	});
	supervisors.push(supervisor);
	const events: SessionEvent[] = [];
	supervisor.onEvent((_id, event) => events.push(event));
	const cwd = join(tmp, "project");
	mkdirSync(cwd, { recursive: true });
	return { events, session: supervisor.open({ sessionId: "s1", cwd, sessionDir: join(tmp, "sessions", "s1") }) };
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 6000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function prompts(): Array<Record<string, any>> {
	return readFileSync(join(tmp, "fake.log"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { kind: string; frame?: Record<string, any> })
		.filter((r) => r.kind === "command" && r.frame?.type === "prompt")
		.map((r) => r.frame as Record<string, any>);
}

describe("prompt images", () => {
	it("sends images as OMP ImageContent and shows them on the user message at once and after the echo", async () => {
		const { session: opening, events } = open();
		const session = await opening;
		await session.prompt({ message: "what is this?", clientId: "c-img", images: [{ mimeType: "image/png", data: PNG }] });
		await waitFor(() => events.some((e) => e.type === "settled"), "settled");

		expect(prompts()[0]).toMatchObject({ message: "what is this?", images: [{ type: "image", mimeType: "image/png", data: PNG }] });
		const users = events.filter((e) => (e.type === "message_start" || e.type === "message_end") && e.message.role === "user");
		for (const e of users) {
			expect(e.type === "message_start" || e.type === "message_end" ? e.message.content : []).toEqual([
				{ type: "text", text: "what is this?" },
				{ type: "image", mimeType: "image/png", data: PNG },
			]);
		}
		const page = await session.messages();
		expect(page.messages[0]?.content.map((b) => b.type)).toEqual(["text", "image"]);
	});

	it("keeps the images of a steered or queued prompt while the agent is running", async () => {
		const { session: opening, events } = open();
		const session = await opening;
		await session.prompt({ message: "__slow__", clientId: "c-slow" });
		await waitFor(() => events.some((e) => e.type === "agent_start"), "agent_start");
		await session.prompt({ message: "look at this", clientId: "c-steer", streamingBehavior: "steer", images: [{ mimeType: "image/png", data: PNG }] });
		await session.prompt({ message: "and this", clientId: "c-follow", streamingBehavior: "followUp", images: [{ mimeType: "image/png", data: PNG }] });
		const sent = prompts();
		expect(sent.map((p) => [p.streamingBehavior, p.images?.length])).toEqual([[undefined, undefined], ["steer", 1], ["followUp", 1]]);
		await session.abort();
	});

	it("sends no images key for a text prompt", async () => {
		const { session: opening, events } = open();
		const session = await opening;
		await session.prompt({ message: "hello", clientId: "c-text", images: [] });
		await waitFor(() => events.some((e) => e.type === "settled"), "settled");
		expect(prompts()[0]).not.toHaveProperty("images");
	});

	it("refuses a prompt that cannot fit one OMP frame instead of sending it", async () => {
		const { session: opening } = open({ FAKE_OMP_MAX_FRAME_BYTES: "4096" });
		const session = await opening;
		const error = await session.prompt({ message: "too big", clientId: "c-big", images: [{ mimeType: "image/png", data: "A".repeat(8000) }] }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(AgentRuntimeError);
		expect((error as AgentRuntimeError).code).toBe("invalid_argument");
		expect(prompts()).toHaveLength(0);
	});
});
