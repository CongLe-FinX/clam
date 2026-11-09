import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeStatus, SessionEvent } from "@clam/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type OmpRuntimeOptions, OmpSupervisor, createOmpRuntime } from "../src/omp/index.ts";
import { AgentRuntimeError, type RuntimeSessionSpec } from "../src/types.ts";

const FAKE_OMP = fileURLToPath(new URL("./fixtures/fake-omp.mjs", import.meta.url));

let tmp: string;
const supervisors: OmpSupervisor[] = [];

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "clam-supervisor-"));
});

afterEach(async () => {
	await Promise.all(supervisors.splice(0).map((s) => s.shutdown()));
	rmSync(tmp, { recursive: true, force: true });
});

function create(options: Partial<OmpRuntimeOptions> = {}) {
	const supervisor = createOmpRuntime({
		binary: () => FAKE_OMP,
		settings: { maxConcurrentRuntimes: 4, idleTimeoutMs: 60_000, approvalMode: "yolo" },
		env: { FAKE_OMP_LOG: join(tmp, "fake.log"), FAKE_OMP_EVENT_DELAY_MS: "1" },
		startTimeoutMs: 5000,
		requestTimeoutMs: 5000,
		closeGraceMs: 1000,
		stateRefreshMs: 10,
		restart: { baseDelayMs: 20, maxDelayMs: 100, maxAttempts: 3 },
		reapIntervalMs: 20,
		...options,
	});
	supervisors.push(supervisor);
	const events: Array<{ sessionId: string; event: SessionEvent }> = [];
	const statuses: RuntimeStatus[] = [];
	supervisor.onEvent((sessionId, event) => events.push({ sessionId, event }));
	supervisor.onStatus((status) => statuses.push(status));
	return { supervisor, events, statuses };
}

function spec(id: string): RuntimeSessionSpec {
	const cwd = join(tmp, "project");
	mkdirSync(cwd, { recursive: true });
	return { sessionId: id, cwd, sessionDir: join(tmp, "sessions", id) };
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 6000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function eventTypes(events: Array<{ event: SessionEvent }>): string[] {
	return events.map((e) => e.event.type);
}

function spawnRecords(): Array<{ kind: string; argv?: string[] }> {
	return readFileSync(join(tmp, "fake.log"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { kind: string; argv?: string[] })
		.filter((record) => record.kind === "spawn");
}

describe("OmpSupervisor", () => {
	it("opens a session, streams a prompt turn with clientId correlation, then settles", async () => {
		const { supervisor, events } = create();
		const session = await supervisor.open(spec("s1"));
		expect(session.status().state).toBe("ready");
		expect(session.binding().runtimeSessionId).toBeTruthy();

		const { promptId } = await session.prompt({ message: "hello mesh", clientId: "c-1" });
		await waitFor(() => eventTypes(events).includes("settled"), "settled");

		const result = events.find((e) => e.event.type === "prompt_result")?.event;
		expect(result).toMatchObject({ type: "prompt_result", promptId, clientId: "c-1", status: "completed" });
		const types = eventTypes(events);
		expect(types.indexOf("prompt_result")).toBeLessThan(types.indexOf("settled"));
		expect(types).toContain("message_delta");

		const userStart = events.find((e) => e.event.type === "message_start" && e.event.message.role === "user")?.event;
		expect(userStart).toMatchObject({ message: { clientId: "c-1" } });

		const page = await session.messages();
		expect(page.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
		const assistant = page.messages[1];
		expect(assistant?.content).toEqual([{ type: "text", text: "FAKE: hello mesh" }]);
		expect(session.takeUsage()).toHaveLength(1);
		expect(session.takeUsage()).toHaveLength(0);
		expect((await session.getStats()).assistantMessages).toBe(1);
		await waitFor(() => session.status().state === "ready", "ready after settle");
	});

	it("runs rpc-ui in every mode (rpc has no `ask` tool) and adds --no-ui only in yolo", async () => {
		const { supervisor } = create();
		await supervisor.open(spec("yolo"));
		supervisor.updateOptions({ approvalMode: "always-ask" });
		await supervisor.open(spec("ask"));
		const [yolo, ask] = spawnRecords();
		expect(yolo?.argv).toContain("--no-ui");
		expect(yolo?.argv).toEqual(expect.arrayContaining(["--mode", "rpc-ui", "--approval-mode", "yolo", "--cwd"]));
		expect(yolo?.argv).not.toContain("rpc");
		expect(ask?.argv).toEqual(expect.arrayContaining(["--mode", "rpc-ui"]));
		expect(ask?.argv).not.toContain("--no-ui");
		expect(ask?.argv).toEqual(expect.arrayContaining(["--approval-mode", "always-ask"]));
	});

	it("prepends --profile when configured", async () => {
		const { supervisor } = create({ profile: "clam-dev" });
		await supervisor.open(spec("p"));
		const args = spawnRecords()[0]?.argv ?? [];
		expect(args.slice(0, 2)).toEqual(["--profile", "clam-dev"]);
	});

	it("surfaces approvals as ui_request and answers them", async () => {
		const { supervisor, events } = create({ settings: { maxConcurrentRuntimes: 2, idleTimeoutMs: 60_000, approvalMode: "write" } });
		const session = await supervisor.open(spec("approve"));
		await session.prompt({ message: "__approve__", clientId: "c-approve" });
		await waitFor(() => events.some((e) => e.event.type === "ui_request"), "ui_request");
		const request = session.pendingUiRequests()[0];
		expect(request).toBeDefined();
		expect(request?.options).toContain("Approve");
		await expect(session.respondToUiRequest({ requestId: request?.requestId ?? "", value: "Nope" })).rejects.toMatchObject({ code: "invalid_argument" });
		await session.respondToUiRequest({ requestId: request?.requestId ?? "", value: "Approve" });
		expect(session.pendingUiRequests()).toHaveLength(0);
		await waitFor(() => eventTypes(events).includes("settled"), "settled");
		expect(eventTypes(events)).toContain("ui_request_resolved");
		const text = JSON.stringify((await session.messages()).messages);
		expect(text).toContain("Approve");
		await expect(session.respondToUiRequest({ requestId: "ghost", value: "Approve" })).rejects.toMatchObject({ code: "invalid_state" });
	});

	it("recovers from a crash: crashed -> restarting -> ready, interrupted prompt errored, history kept, session usable", async () => {
		const { supervisor, events, statuses } = create();
		const session = await supervisor.open(spec("crashy"));
		await session.prompt({ message: "first turn", clientId: "c-a" });
		await waitFor(() => eventTypes(events).includes("settled"), "first settled");
		const firstPid = session.status().pid;
		events.length = 0;
		statuses.length = 0;

		await session.prompt({ message: "__crash__", clientId: "c-crash" });
		await waitFor(() => statuses.some((s) => s.state === "ready"), "recovery");

		const states = statuses.map((s) => s.state);
		expect(states).toContain("crashed");
		expect(states.indexOf("crashed")).toBeLessThan(states.lastIndexOf("ready"));
		expect(states).toContain("restarting");
		const crashResult = events.find((e) => e.event.type === "prompt_result")?.event;
		expect(crashResult).toMatchObject({ type: "prompt_result", clientId: "c-crash", status: "error" });
		expect(eventTypes(events)).toContain("notice");

		expect(session.status()).toMatchObject({ state: "ready", restarts: 1 });
		expect(session.status().pid).not.toBe(firstPid);
		const page = await session.messages();
		expect(page.messages[0]?.content).toEqual([{ type: "text", text: "first turn" }]);

		events.length = 0;
		await session.prompt({ message: "after crash", clientId: "c-b" });
		await waitFor(() => eventTypes(events).includes("settled"), "settled after recovery");
		const last = (await session.messages()).messages.at(-1);
		expect(last?.content).toEqual([{ type: "text", text: "FAKE: after crash" }]);
	});

	it("recovers when the child process is killed from outside", async () => {
		const { supervisor, statuses } = create();
		const session = await supervisor.open(spec("killed"));
		const pid = session.status().pid;
		expect(pid).toBeTruthy();
		process.kill(pid as number, "SIGKILL");
		await waitFor(() => statuses.some((s) => s.state === "crashed"), "crashed");
		await session.whenReady();
		expect(session.status()).toMatchObject({ state: "ready", restarts: 1 });
		expect(session.status().pid).not.toBe(pid);
		await session.getState();
	});

	it("gives up after maxAttempts failed recoveries and a manual restart resets it", async () => {
		let broken = false;
		const { supervisor } = create({ binary: () => (broken ? join(tmp, "missing-omp") : FAKE_OMP), restart: { baseDelayMs: 10, maxDelayMs: 40, maxAttempts: 2 } });
		const session = await supervisor.open(spec("giveup"));
		broken = true;
		process.kill(session.status().pid as number, "SIGKILL");
		await waitFor(() => session.status().state === "crashed" && !session.restartPending, "gave up", 8000);
		await expect(session.whenReady(200)).rejects.toMatchObject({ code: "not_ready" });
		broken = false;
		const status = await supervisor.restart("giveup");
		expect(status.state).toBe("ready");
	});

	it("enforces the concurrency cap by evicting the least recently used idle runtime, and refuses when none is idle", async () => {
		const { supervisor, statuses } = create({ settings: { maxConcurrentRuntimes: 1, idleTimeoutMs: 60_000, approvalMode: "yolo" } });
		const a = await supervisor.open(spec("A"));
		const b = await supervisor.open(spec("B"));
		expect(supervisor.get("A")).toBeUndefined();
		expect(a.status().state).toBe("stopped");
		expect(statuses.some((s) => s.sessionId === "A" && s.state === "stopped")).toBe(true);
		expect(supervisor.list().map((s) => s.sessionId)).toEqual(["B"]);

		await b.prompt({ message: "__slow__", clientId: "slow" });
		await waitFor(() => b.status().state === "busy", "busy");
		const error = await supervisor.open(spec("C")).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(AgentRuntimeError);
		expect((error as AgentRuntimeError).code).toBe("capacity");
		await b.abort();
	});

	it("reaps idle settled runtimes but never a busy one", async () => {
		const { supervisor } = create({ settings: { maxConcurrentRuntimes: 4, idleTimeoutMs: 150, approvalMode: "yolo" } });
		const idle = await supervisor.open(spec("idle"));
		const busy = await supervisor.open(spec("busy"));
		await busy.prompt({ message: "__slow__", clientId: "slow" });
		await waitFor(() => supervisor.get("idle") === undefined, "idle reaped");
		expect(idle.status().state).toBe("stopped");
		expect(supervisor.get("busy")?.status().state).toBe("busy");
		await busy.abort();
		await waitFor(() => supervisor.get("busy") === undefined, "busy reaped after it settled", 8000);
	});

	it("handles abort with late/duplicate events without corrupting the transcript", async () => {
		const { supervisor, events } = create();
		const session = await supervisor.open(spec("abort"));
		await session.prompt({ message: "__slow__", clientId: "c-slow" });
		await waitFor(() => events.some((e) => e.event.type === "message_delta"), "streaming");
		await session.abort();
		await waitFor(() => eventTypes(events).includes("settled"), "settled after abort");
		// Real-process integration: the fake emits its stale frames on its own clock after session_settled and the
		// mapper drops them silently, so there is no signal to await; give them time to arrive before asserting.
		await new Promise((resolve) => setTimeout(resolve, 150));

		const result = events.find((e) => e.event.type === "prompt_result")?.event;
		expect(result).toMatchObject({ clientId: "c-slow", status: "aborted" });
		expect(eventTypes(events).filter((t) => t === "prompt_result")).toHaveLength(1);
		const endIndex = events.findIndex((e) => e.event.type === "message_end" && e.event.message.role === "assistant");
		expect(endIndex).toBeGreaterThan(-1);
		expect(events.slice(endIndex + 1).some((e) => e.event.type === "message_delta")).toBe(false);
		const page = await session.messages();
		expect(page.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
		await waitFor(() => session.status().state === "ready", "ready");
	});

	it("reports a session that waits only on background work as busy in the background, and abort does not end that", async () => {
		const { supervisor, events, statuses } = create();
		// The turn ends while a job the agent left running keeps the session from settling for 3 s.
		const session = await supervisor.open(spec("bg"));
		await session.prompt({ message: "start the scan\n@@fake-background 3000", clientId: "c-bg" });
		await waitFor(() => events.some((e) => e.sessionId === "bg" && e.event.type === "prompt_result"), "turn over");
		// Within the grace period a normal end of turn (settled moments later) must not read as background work.
		expect(session.status()).toMatchObject({ state: "busy", background: false });
		await waitFor(() => session.status().background === true, "background after the grace period", 3_000);
		expect(session.status().state).toBe("busy");
		expect(statuses.some((s) => s.sessionId === "bg" && s.state === "busy" && s.background === true)).toBe(true);
		// As in OMP, abort does not end the job: still busy, still background.
		await session.abort();
		expect(session.status()).toMatchObject({ state: "busy", background: true });
		// The job finishes: the session settles and the flag drops.
		await waitFor(() => events.some((e) => e.sessionId === "bg" && e.event.type === "settled"), "settled after the job", 6_000);
		expect(session.status()).toMatchObject({ state: "ready", background: false });
	});

	it("rejects a prompt whose acknowledgement never arrives and stays usable", async () => {
		const { supervisor } = create({ requestTimeoutMs: 300 });
		const session = await supervisor.open(spec("noack"));
		const error = await session.prompt({ message: "__noack__", clientId: "c-n" }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(AgentRuntimeError);
		expect((error as AgentRuntimeError).code).toBe("timeout");
		await waitFor(() => session.status().state === "ready", "ready again");
		await session.prompt({ message: "still alive", clientId: "c-ok" });
	});

	it("stops, resumes the same conversation on reopen, and shuts every process down", async () => {
		const { supervisor, events } = create();
		const session = await supervisor.open(spec("resume"));
		const runtimeSessionId = session.binding().runtimeSessionId;
		await session.prompt({ message: "remember me", clientId: "c1" });
		await waitFor(() => eventTypes(events).includes("settled"), "turn settled");
		await supervisor.stop("resume");
		expect(supervisor.get("resume")).toBeUndefined();
		await supervisor.stop("resume"); // idempotent

		const reopened = await supervisor.open(spec("resume"));
		expect(reopened.binding().runtimeSessionId).toBe(runtimeSessionId);
		expect((await reopened.messages()).messages.map((m) => m.role)).toEqual(["user", "assistant"]);

		const pid = reopened.status().pid as number;
		await supervisor.shutdown();
		expect(supervisor.list()).toEqual([]);
		expect(() => process.kill(pid, 0)).toThrow();
		await expect(supervisor.open(spec("late"))).rejects.toMatchObject({ code: "invalid_state" });
	});

	it("reports not_installed when omp cannot be found", async () => {
		const { supervisor } = create({ binary: () => null });
		await expect(supervisor.open(spec("none"))).rejects.toMatchObject({ code: "not_installed" });
		expect(supervisor.get("none")).toBeUndefined();
	});

	it("keeps the configured thinking selector next to the effective level (auto resolves per turn)", async () => {
		const { supervisor, events } = create();
		const session = await supervisor.open(spec("auto"));
		expect((await session.getState()).thinkingSelector).toBeNull();
		await session.prompt({ message: "__auto__", clientId: "c-auto" });
		await waitFor(() => eventTypes(events).includes("settled"), "settled");
		const state = await session.getState();
		expect(state).toMatchObject({ thinkingLevel: "low", thinkingSelector: "auto" });
		const lastEvent = events.filter((e) => e.event.type === "state").at(-1)?.event;
		expect(lastEvent).toMatchObject({ state: { thinkingLevel: "low", thinkingSelector: "auto" } });
		await session.setThinkingLevel("high");
		expect(await session.getState()).toMatchObject({ thinkingLevel: "high", thinkingSelector: null });
	});

	it("shows a prompt at once while OMP has not echoed it, folds the echo into the same message, and withdraws it when the prompt fails", async () => {
		const slowStart = { FAKE_OMP_LOG: join(tmp, "fake.log"), FAKE_OMP_EVENT_DELAY_MS: "1", FAKE_OMP_PRE_RUN_DELAY_MS: "400" };
		const { supervisor, events } = create({ env: slowStart, requestTimeoutMs: 400 });
		const session = await supervisor.open(spec("pending"));

		await session.prompt({ message: "hello pending", clientId: "init_pending" });
		// Admitted, but OMP will not start the run (and echo the user message) for another ~400 ms.
		expect(eventTypes(events)).toEqual(["message_start", "message_end"]);
		expect(events[0]?.event).toMatchObject({ message: { id: "m1", role: "user", clientId: "init_pending", content: [{ type: "text", text: "hello pending" }] } });
		const early = await session.messages();
		expect(early.messages).toHaveLength(1);
		expect(early.messages[0]).toMatchObject({ id: "m1", role: "user", clientId: "init_pending" });
		expect(session.status().state).toBe("busy");

		await waitFor(() => eventTypes(events).includes("settled"), "settled");
		const users = events.filter((e) => e.event.type === "message_start" && e.event.message.role === "user");
		expect(users).toHaveLength(1); // OMP's echo did not publish a second user message
		const page = await session.messages();
		expect(page.messages.map((m) => `${m.id}:${m.role}`)).toEqual(["m1:user", "m2:assistant"]);
		expect(page.messages[0]).toMatchObject({ clientId: "init_pending" });

		// A prompt that never gets acknowledged is withdrawn and reported.
		events.length = 0;
		const error = await session.prompt({ message: "__noack__", clientId: "c-doomed" }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(AgentRuntimeError);
		const doomed = events.map((e) => e.event).filter((e) => e.type !== "state"); // state refreshes of the previous run may still land
		expect(doomed.map((e) => e.type)).toEqual(["message_start", "message_end", "message_removed", "prompt_result"]);
		expect(doomed[2]).toMatchObject({ type: "message_removed", messageId: "m3" });
		expect(doomed[3]).toMatchObject({ type: "prompt_result", clientId: "c-doomed", status: "error", error: expect.stringContaining("did not answer") });
		expect((await session.messages()).messages.map((m) => m.id)).toEqual(["m1", "m2"]);
	});

	it("does not show a second copy for a prompt queued behind a running turn", async () => {
		const { supervisor, events } = create();
		const session = await supervisor.open(spec("queued"));
		await session.prompt({ message: "__slow__", clientId: "first" });
		await waitFor(() => events.some((e) => e.event.type === "message_delta"), "streaming");
		events.length = 0;
		await session.prompt({ message: "after this", clientId: "second", streamingBehavior: "followUp" });
		expect(events.filter((e) => e.event.type === "message_start")).toHaveLength(0); // queue state already represents it
		expect((await session.messages()).messages.filter((m) => m.clientId === "second")).toHaveLength(0);
		await session.abort();
	});

	it("pages the transcript newest first", async () => {
		const { supervisor, events } = create();
		const session = await supervisor.open(spec("pages"));
		for (let i = 0; i < 3; i++) {
			events.length = 0;
			await session.prompt({ message: `turn ${i}`, clientId: `c${i}` });
			await waitFor(() => eventTypes(events).includes("settled"), `settled ${i}`);
		}
		const first = await session.messages({ limit: 4 });
		expect(first.total).toBe(6);
		expect(first.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
		expect(first.nextCursor).not.toBeNull();
		const older = await session.messages({ limit: 4, cursor: first.nextCursor ?? undefined });
		expect(older.messages).toHaveLength(2);
		expect(older.nextCursor).toBeNull();
	});
});
