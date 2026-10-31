import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type OmpFrame, type OmpResponseFrame, OmpTransport, type OmpTransportOptions, type TransportExit } from "../src/omp/index.ts";
import { AgentRuntimeError } from "../src/types.ts";

const FAKE_OMP = fileURLToPath(new URL("./fixtures/fake-omp.mjs", import.meta.url));

type AnyFrame = OmpFrame | OmpResponseFrame;

let tmp: string;
const transports: OmpTransport[] = [];

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "clam-transport-"));
});

afterEach(() => {
	for (const transport of transports.splice(0)) transport.kill();
	rmSync(tmp, { recursive: true, force: true });
});

function create(env: Record<string, string | undefined> = {}, extra: Partial<OmpTransportOptions> = {}) {
	const transport = new OmpTransport({
		command: FAKE_OMP,
		args: ["--mode", "rpc", "--no-ui"],
		env,
		startTimeoutMs: 5000,
		requestTimeoutMs: 5000,
		...extra,
	});
	const frames: AnyFrame[] = [];
	const exits: TransportExit[] = [];
	transport.onFrame((frame) => frames.push(frame));
	transport.onExit((exit) => exits.push(exit));
	transports.push(transport);
	return { transport, frames, exits };
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function rejection(promise: Promise<unknown>): Promise<AgentRuntimeError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(AgentRuntimeError);
		return error as AgentRuntimeError;
	}
	throw new Error("expected rejection");
}

function types(frames: AnyFrame[]): string[] {
	return frames.map((f) => f.type);
}

describe("OmpTransport handshake", () => {
	it("spawns, receives ready and negotiates protocol v2", async () => {
		const logFile = join(tmp, "log.jsonl");
		const { transport, frames } = create({ FAKE_OMP_LOG: logFile });
		expect(transport.state).toBe("idle");
		const ready = await transport.start();
		expect(ready).toMatchObject({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 65536 });
		expect(transport.state).toBe("ready");
		expect(transport.protocolVersion).toBe(2);
		expect(transport.pid).toBeTypeOf("number");
		// ready and the negotiate response are consumed by the transport.
		expect(frames).toEqual([]);
		const records = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		expect(records[0]).toMatchObject({ kind: "spawn", argv: ["--mode", "rpc", "--no-ui"] });
		expect(records[1]).toMatchObject({ kind: "command", frame: { type: "negotiate_protocol", protocolVersion: 2 } });
	});

	it("falls back to v1 when negotiation fails", async () => {
		const warnings: unknown[] = [];
		const log = { debug() {}, info() {}, error() {}, warn: (o: unknown) => void warnings.push(o) };
		const { transport } = create({ FAKE_OMP_NEGOTIATE_FAIL: "1" }, { log });
		await transport.start();
		expect(transport.protocolVersion).toBe(1);
		expect(transport.state).toBe("ready");
		expect(warnings).toHaveLength(1);
		await expect(transport.request("get_available_thinking_levels")).resolves.toEqual({ levels: ["off", "low", "medium", "high"] });
	});

	it("stays on v1 when v2 is not advertised", async () => {
		const logFile = join(tmp, "log.jsonl");
		const { transport } = create({ FAKE_OMP_V1_ONLY: "1", FAKE_OMP_LOG: logFile });
		await transport.start();
		expect(transport.protocolVersion).toBe(1);
		expect(readFileSync(logFile, "utf8")).not.toContain("negotiate_protocol");
	});

	it("rejects start twice and requests before start", async () => {
		const { transport } = create();
		expect((await rejection(transport.request("get_state"))).code).toBe("invalid_state");
		expect(() => transport.send({ type: "x" })).toThrow(AgentRuntimeError);
		await transport.start();
		expect((await rejection(transport.start())).code).toBe("invalid_state");
	});
});

describe("OmpTransport requests", () => {
	it("correlates out-of-order responses by id and never delivers matched responses to onFrame", async () => {
		const { transport, frames } = create();
		await transport.start();
		const slow = transport.request("predict_word", { text: "slow word", cursor: 9 });
		const quick = transport.request<{ sessionId: string }>("get_state");
		const order: string[] = [];
		void slow.then(() => order.push("slow"));
		void quick.then(() => order.push("quick"));
		await Promise.all([slow, quick]);
		expect(order).toEqual(["quick", "slow"]);
		expect((await quick).sessionId).toBeTypeOf("string");
		expect(await slow).toEqual({ suffix: null });
		expect(frames).toEqual([]);
	});

	it("uses auto ids r<counter> and honours a caller-chosen id", async () => {
		const logFile = join(tmp, "log.jsonl");
		const { transport } = create({ FAKE_OMP_LOG: logFile });
		await transport.start();
		await transport.request("get_state");
		await transport.request("get_state", {}, { id: "custom-1" });
		const ids = readFileSync(logFile, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l))
			.filter((r) => r.kind === "command" && r.frame.type === "get_state")
			.map((r) => r.frame.id);
		expect(ids).toEqual([expect.stringMatching(/^r\d+$/), "custom-1"]);
	});

	it("rejects a failed response with code rejected and runtime details", async () => {
		const { transport } = create();
		await transport.start();
		const error = await rejection(transport.request("set_model", { provider: "p", modelId: "id" }));
		expect(error.code).toBe("rejected");
		expect(error.message).toBe("Model not found: p/id");
		expect(error.details).toMatchObject({ command: "set_model", error: "Model not found: p/id" });

		const busy = transport.request("prompt", { message: "__slow__" }, { id: "slow-1" });
		await busy;
		const paging = await rejection(transport.request("get_messages_page", {}));
		expect(paging.details).toMatchObject({ runtimeCode: "session_busy" });
		await transport.request("abort");
	});

	it("times out one request, ignores the late response but still delivers it via onFrame", async () => {
		const { transport, frames } = create();
		await transport.start();
		const slow = transport.request("predict_word", { text: "slow", cursor: 4 }, { timeoutMs: 40, id: "late-1" });
		const error = await rejection(slow);
		expect(error.code).toBe("timeout");
		// Another request keeps working while the late one is outstanding.
		await expect(transport.request("get_state")).resolves.toBeTypeOf("object");
		await waitFor(() => frames.some((f) => f.type === "response" && f.id === "late-1"), "late response");
		expect(transport.state).toBe("ready");
	});

	it("delivers unmatched responses (no id) and sends raw frames", async () => {
		const { transport, frames } = create();
		await transport.start();
		transport.send({ type: "does_not_exist" });
		await waitFor(() => frames.length > 0, "unmatched response");
		expect(frames[0]).toMatchObject({ type: "response", command: "does_not_exist", success: false, error: "Unknown command: does_not_exist" });
	});

	it("reassembles a huge response over rpc_chunk (v2)", async () => {
		const { transport, frames } = create({ FAKE_OMP_MAX_FRAME_BYTES: "600" });
		await transport.start();
		expect(transport.protocolVersion).toBe(2);
		const state = await transport.request<{ model: { provider: string }; sessionId: string }>("get_state");
		expect(state.model.provider).toBe("fake");
		expect(frames).toEqual([]);
	});

	it("reports an overflowing response as rejected on v1", async () => {
		const { transport } = create({ FAKE_OMP_MAX_FRAME_BYTES: "600", FAKE_OMP_V1_ONLY: "1" });
		await transport.start();
		const error = await rejection(transport.request("get_state"));
		expect(error.code).toBe("rejected");
		expect(error.message).toBe("RPC response exceeded the transport limit");
	});

	it("reassembles a huge event over the real pipe", async () => {
		const { transport, frames } = create({ FAKE_OMP_MAX_FRAME_BYTES: "4096" });
		await transport.start();
		await transport.request("prompt", { message: "__big__" }, { id: "big-1" });
		await waitFor(() => frames.some((f) => f.type === "session_settled"), "session_settled");
		const end = frames.find((f) => f.type === "message_end" && (f.message as { role: string }).role === "assistant") as OmpFrame;
		const content = (end.message as { content: Array<{ text: string }> }).content;
		expect(content[0]?.text.length).toBe(4096 * 3);
		expect(frames.some((f) => f.type === "rpc_chunk")).toBe(false);
		expect(frames.find((f) => f.type === "prompt_result")).toMatchObject({ id: "big-1", status: "completed" });
	});
});

describe("OmpTransport event stream", () => {
	it("streams a prompt with delta projection and stable message ids", async () => {
		const { transport, frames } = create();
		await transport.start();
		await transport.request("set_event_filter", { events: null, messageUpdates: "delta" });
		await expect(transport.request("prompt", { message: "hello" }, { id: "p1" })).resolves.toEqual({ agentInvoked: true });
		await waitFor(() => frames.some((f) => f.type === "session_settled"), "session_settled");
		expect(types(frames).slice(0, 4)).toEqual(["agent_start", "turn_start", "message_start", "message_end"]);
		const assistantStart = frames.filter((f) => f.type === "message_start")[1] as OmpFrame;
		const id = assistantStart.messageId;
		const updates = frames.filter((f) => f.type === "message_update") as OmpFrame[];
		expect(updates.length).toBeGreaterThan(4);
		for (const update of updates) {
			expect(update.messageId).toBe(id);
			expect(update.message).toEqual({ role: "assistant" });
			expect((update.assistantMessageEvent as Record<string, unknown>).partial).toBeUndefined();
		}
		const subtypes = updates.map((u) => (u.assistantMessageEvent as { type: string }).type);
		expect(subtypes[0]).toBe("start");
		expect(subtypes.at(-1)).toBe("done");
		const end = frames.filter((f) => f.type === "message_end")[1] as OmpFrame;
		expect(end.messageId).toBe(id);
		expect(((end.message as { content: Array<{ text: string }> }).content[0] as { text: string }).text).toBe("FAKE: hello");
		expect(frames.find((f) => f.type === "prompt_result")).toMatchObject({ id: "p1", agentInvoked: true, status: "completed", sessionSettled: true });
	});

	it("round-trips an extension_ui_request approval", async () => {
		const { transport, frames } = create();
		await transport.start();
		transport.onFrame((frame) => {
			if (frame.type === "extension_ui_request" && frame.method === "select") {
				transport.send({ type: "extension_ui_response", id: frame.id, value: "Approve bash for this session" });
			}
		});
		await transport.request("prompt", { message: "__approve__" }, { id: "ap" });
		await waitFor(() => frames.some((f) => f.type === "session_settled"), "session_settled");
		const methods = frames.filter((f) => f.type === "extension_ui_request").map((f) => (f as OmpFrame).method);
		expect(methods).toEqual(["select", "notify", "setStatus"]);
		const reply = frames.filter((f) => f.type === "message_end").at(-1) as OmpFrame;
		expect(JSON.stringify(reply.message)).toContain("approval Approve bash for this session");
	});
});

describe("OmpTransport failures", () => {
	it("rejects start_failed on ENOENT with a helpful message", async () => {
		const { transport, exits } = create({}, { command: join(tmp, "no-such-omp") });
		const error = await rejection(transport.start());
		expect(error.code).toBe("start_failed");
		expect(error.message).toContain("no-such-omp");
		expect(error.message).toContain("not found");
		expect(transport.state).toBe("exited");
		await waitFor(() => exits.length === 1, "exit");
		expect(exits[0]?.error).toBeInstanceOf(Error);
		expect(exits[0]?.expected).toBe(false);
	});

	it("rejects start_failed on EACCES", async () => {
		const file = join(tmp, "not-executable");
		writeFileSync(file, "#!/bin/sh\n");
		chmodSync(file, 0o644);
		const { transport } = create({}, { command: file });
		const error = await rejection(transport.start());
		expect(error.code).toBe("start_failed");
		expect(error.message).toContain("permission denied");
	});

	it("rejects start_failed when the process exits before ready, with the stderr tail", async () => {
		const { transport, exits } = create({ FAKE_OMP_EXIT_BEFORE_READY: "7" });
		const error = await rejection(transport.start());
		expect(error.code).toBe("start_failed");
		expect(error.details).toMatchObject({ code: 7 });
		expect((error.details as { stderrTail: string }).stderrTail).toContain("exiting before ready");
		await waitFor(() => exits.length === 1, "exit");
		expect(exits[0]).toMatchObject({ code: 7, expected: false });
	});

	it("rejects start_failed on ready timeout and kills the process", async () => {
		const { transport, exits } = create({ FAKE_OMP_READY_DELAY_MS: "10000" }, { startTimeoutMs: 150 });
		const error = await rejection(transport.start());
		expect(error.code).toBe("start_failed");
		expect(error.message).toContain("ready");
		await waitFor(() => exits.length === 1, "exit");
		expect(exits[0]?.signal).toBe("SIGKILL");
	});

	it("rejects pending requests with process_exited when the process crashes, and fires onExit once", async () => {
		const { transport, frames, exits } = create();
		await transport.start();
		const pending = transport.request("predict_word", { text: "slow", cursor: 4 });
		await transport.request("prompt", { message: "__crash__" }, { id: "crash" });
		const error = await rejection(pending);
		expect(error.code).toBe("process_exited");
		await waitFor(() => exits.length === 1, "exit");
		expect(exits[0]).toMatchObject({ code: 137, expected: false });
		// Everything buffered before the crash was delivered first.
		expect(types(frames)).toEqual(["agent_start", "turn_start", "message_start", "message_end"]);
		expect(transport.state).toBe("exited");
		expect((await rejection(transport.request("get_state"))).code).toBe("invalid_state");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(exits).toHaveLength(1);
	});

	it("captures stderr", async () => {
		const { transport } = create({ FAKE_OMP_STDERR: "warming up: hello stderr" });
		await transport.start();
		await waitFor(() => transport.stderrTail().includes("hello stderr"), "stderr");
	});

	it("keeps only the stderr tail", async () => {
		const { transport } = create({ FAKE_OMP_STDERR: `${"x".repeat(400)}END` }, { stderrTailBytes: 64 });
		await transport.start();
		await waitFor(() => transport.stderrTail().endsWith("END\n"), "stderr tail");
		expect(Buffer.byteLength(transport.stderrTail())).toBeLessThanOrEqual(64);
	});

	for (const kind of ["json", "chunk-gap", "oversize", "interleave", "array"]) {
		it(`treats an invalid frame (${kind}) as a fatal protocol error`, async () => {
			const { transport, exits } = create({ FAKE_OMP_INVALID_FRAME: kind, FAKE_OMP_MAX_FRAME_BYTES: "4096" });
			await transport.start();
			const error = await rejection(transport.request("get_state"));
			expect(error.code).toBe("protocol");
			await waitFor(() => exits.length === 1, "exit");
			expect(exits[0]?.error).toBeInstanceOf(Error);
			expect(exits[0]?.expected).toBe(false);
			expect(exits[0]?.signal).toBe("SIGKILL");
			expect(transport.state).toBe("exited");
		});
	}
});

describe("OmpTransport shutdown", () => {
	it("close() ends stdin, keeps draining stdout and exits 0", async () => {
		const { transport, frames, exits } = create();
		await transport.start();
		await transport.request("prompt", { message: "drain me" }, { id: "d1" });
		let framesAtExit = 0;
		transport.onExit(() => {
			framesAtExit = frames.length;
		});
		const exit = await transport.close();
		expect(exit).toMatchObject({ code: 0, signal: null, expected: true });
		expect(exit.error).toBeUndefined();
		expect(framesAtExit).toBe(frames.length);
		expect(types(frames)).toContain("prompt_result");
		expect(types(frames).at(-1)).toBe("session_settled");
		expect(exits).toEqual([exit]);
		expect(transport.state).toBe("exited");
	});

	it("close() is idempotent and rejects new requests while closing", async () => {
		const { transport, exits } = create();
		await transport.start();
		const first = transport.close();
		expect(transport.state).toBe("closing");
		expect((await rejection(transport.request("get_state"))).code).toBe("invalid_state");
		const second = transport.close();
		expect(second).toBe(first);
		await first;
		expect((await transport.close()).code).toBe(0);
		expect(exits).toHaveLength(1);
	});

	it("close() before start resolves without spawning", async () => {
		const { transport, exits } = create();
		const exit = await transport.close();
		expect(exit).toMatchObject({ code: null, expected: true });
		expect(exits).toHaveLength(1);
		expect(transport.state).toBe("exited");
	});

	it("escalates to SIGTERM when stdin close is ignored", async () => {
		const { transport } = create({ FAKE_OMP_IGNORE_STDIN_CLOSE: "1" });
		await transport.start();
		const started = Date.now();
		const exit = await transport.close({ graceMs: 600 });
		expect(exit.expected).toBe(true);
		expect(exit.code).toBe(143);
		expect(Date.now() - started).toBeGreaterThanOrEqual(250);
		expect(Date.now() - started).toBeLessThan(580);
	});

	it("escalates to SIGKILL when SIGTERM is ignored too", async () => {
		const { transport } = create({ FAKE_OMP_IGNORE_STDIN_CLOSE: "1", FAKE_OMP_IGNORE_SIGTERM: "1" });
		await transport.start();
		const exit = await transport.close({ graceMs: 400 });
		expect(exit).toMatchObject({ signal: "SIGKILL", code: null, expected: true });
	});

	it("kill() terminates immediately and marks the exit expected", async () => {
		const { transport, exits } = create({ FAKE_OMP_IGNORE_STDIN_CLOSE: "1" });
		await transport.start();
		const pending = transport.request("predict_word", { text: "slow", cursor: 4 });
		transport.kill();
		expect((await rejection(pending)).code).toBe("process_exited");
		await waitFor(() => exits.length === 1, "exit");
		expect(exits[0]).toMatchObject({ signal: "SIGKILL", expected: true });
	});

	it("does not crash the host when writing after the process exited", async () => {
		const { transport, exits } = create({ FAKE_OMP_EXIT_AFTER_MS: "50", FAKE_OMP_EXIT_AFTER_CODE: "0" });
		await transport.start();
		await waitFor(() => exits.length === 1, "exit");
		expect(() => transport.send({ type: "get_state" })).toThrow(AgentRuntimeError);
	});
});
