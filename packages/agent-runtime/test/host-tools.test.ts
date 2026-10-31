import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeStatus, SessionEvent } from "@clam/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostToolDispatcher, MAX_HOST_TOOL_TEXT_CHARS, validateHostToolDefinitions } from "../src/omp/host-tools.ts";
import { type OmpRuntimeOptions, type OmpSupervisor, createOmpRuntime } from "../src/omp/index.ts";
import {
	AgentRuntimeError,
	type HostToolCall,
	type HostToolDefinition,
	type HostToolProvider,
	type HostToolResult,
	type RuntimeLogger,
	type RuntimeSession,
	type RuntimeSessionSpec,
} from "../src/types.ts";

const FAKE_OMP = fileURLToPath(new URL("./fixtures/fake-omp.mjs", import.meta.url));

let tmp: string;
const supervisors: OmpSupervisor[] = [];

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "clam-host-tools-"));
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
		reapIntervalMs: 1000,
		...options,
	});
	supervisors.push(supervisor);
	const events: SessionEvent[] = [];
	const statuses: RuntimeStatus[] = [];
	supervisor.onEvent((_sessionId, event) => events.push(event));
	supervisor.onStatus((status) => statuses.push(status));
	return { supervisor, events, statuses };
}

function spec(id: string, extra: Partial<RuntimeSessionSpec> = {}): RuntimeSessionSpec {
	const cwd = join(tmp, "project");
	mkdirSync(cwd, { recursive: true });
	return { sessionId: id, cwd, sessionDir: join(tmp, "sessions", id), ...extra };
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 10);
		await promise;
	}
}

/** Resolves when `signal` aborts. */
function whenAborted(signal: AbortSignal): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	signal.addEventListener("abort", () => resolve(), { once: true });
	return promise;
}

/** Resolves after everything already queued (microtasks included) ran. */
function flush(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

interface Frame {
	type: string;
	id?: string;
	isError?: boolean;
	partialResult?: { content: Array<{ text: string }> };
	result?: { content: Array<{ text: string }> };
}

/** One line of the fake omp's FAKE_OMP_LOG. */
interface LogRecord {
	kind: string;
	/** `command`: a frame the fake received. */
	frame?: Frame;
	/** `spawn` */
	argv?: string[];
	/** `host_tools` */
	names?: string[];
	tools?: Array<Record<string, unknown>>;
	/** `host_tool_call` / `host_tool_cancel` */
	id?: string;
	targetId?: string;
	arguments?: { n?: number };
}

function logRecords(): LogRecord[] {
	return readFileSync(join(tmp, "fake.log"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line): LogRecord => JSON.parse(line));
}

/** Frames of `type` the fake received from the host, in order. */
function received(type: string): Frame[] {
	return logRecords().flatMap((r) => (r.kind === "command" && r.frame?.type === type ? [r.frame] : []));
}

function hostToolRecords(): LogRecord[] {
	return logRecords().filter((r) => r.kind === "host_tools");
}

function ofKind(kind: string): LogRecord[] {
	return logRecords().filter((r) => r.kind === kind);
}

/** Command types received by each spawned process, in order. */
function commandsPerProcess(): string[][] {
	const out: string[][] = [];
	for (const record of logRecords()) {
		if (record.kind === "spawn") out.push([]);
		else if (record.kind === "command" && record.frame) out.at(-1)?.push(record.frame.type);
	}
	return out;
}

function spawnArgv(): string[][] {
	return ofKind("spawn").map((r) => r.argv ?? []);
}

function def(name: string, extra: Partial<HostToolDefinition> = {}): HostToolDefinition {
	return {
		name,
		label: `Label ${name}`,
		description: `Does ${name}`,
		parameters: { type: "object", properties: { message: { type: "string" } }, additionalProperties: true },
		...extra,
	};
}

interface TestProvider extends HostToolProvider {
	defs: HostToolDefinition[];
	calls: HostToolCall[];
}

function provider(names: string[], run: (call: HostToolCall) => Promise<HostToolResult>): TestProvider {
	const self: TestProvider = {
		defs: names.map((name) => def(name)),
		calls: [],
		definitions: () => self.defs,
		execute: (call) => {
			self.calls.push(call);
			return run(call);
		},
	};
	return self;
}

async function echoTool(call: HostToolCall): Promise<HostToolResult> {
	const args = call.arguments as { message?: string } | null;
	return { text: `echo:${args?.message ?? ""}` };
}

async function assistantText(session: RuntimeSession): Promise<string> {
	const last = (await session.messages({ limit: 50 })).messages.filter((m) => m.role === "assistant").at(-1);
	return (last?.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("");
}

/** Sends `message`, waits for the run to settle and returns the final assistant text. */
async function runPrompt(session: RuntimeSession, events: SessionEvent[], message: string): Promise<string> {
	events.length = 0;
	await session.prompt({ message, clientId: `c-${Math.random().toString(36).slice(2)}` });
	await waitFor(() => events.some((e) => e.type === "settled"), `settled after ${message.split("\n")[0]}`);
	return assistantText(session);
}

describe("host tool registration", () => {
	it("registers the definitions after open_session on start and again after a crash restart", async () => {
		const { supervisor, events, statuses } = create();
		const tools = provider(["echo_host", "mesh_agents"], echoTool);
		tools.defs[1] = def("mesh_agents", { loadMode: "essential" });
		supervisor.setHostToolProvider(tools);

		const session = await supervisor.open(spec("reg"));
		const first = commandsPerProcess()[0] ?? [];
		expect(first.indexOf("open_session")).toBeGreaterThan(-1);
		expect(first.indexOf("set_host_tools")).toBeGreaterThan(first.indexOf("open_session"));
		expect(hostToolRecords()).toHaveLength(1);
		expect(hostToolRecords()[0]?.names).toEqual(["echo_host", "mesh_agents"]);
		expect(received("set_host_tools")[0]).toMatchObject({
			tools: [
				{ name: "echo_host", label: "Label echo_host", description: "Does echo_host", parameters: { type: "object" } },
				{ name: "mesh_agents", loadMode: "essential" },
			],
		});

		const text = await runPrompt(session, events, '@@fake-tool echo_host {"message":"ping"}');
		expect(text).toBe("FAKE_TOOL_RESULT echo_host: echo:ping");
		expect(tools.calls).toHaveLength(1);
		expect(tools.calls[0]).toMatchObject({ sessionId: "reg", toolName: "echo_host", arguments: { message: "ping" } });
		expect(tools.calls[0]?.toolCallId).toBe("call_fake_h1");
		// The call is visible to the UI like any other tool run.
		expect(events.find((e) => e.type === "tool_start")).toMatchObject({ toolName: "echo_host", args: { message: "ping" } });
		expect(events.find((e) => e.type === "tool_end")).toMatchObject({ isError: false, result: expect.stringContaining("echo:ping") });

		const pid = session.status().pid as number;
		statuses.length = 0;
		process.kill(pid, "SIGKILL");
		await waitFor(() => statuses.some((s) => s.state === "crashed"), "crashed");
		await session.whenReady();
		expect(session.status().pid).not.toBe(pid);

		const second = commandsPerProcess()[1] ?? [];
		expect(second.indexOf("set_host_tools")).toBeGreaterThan(second.indexOf("open_session"));
		expect(hostToolRecords()).toHaveLength(2);
		expect(await runPrompt(session, events, '@@fake-tool echo_host {"message":"again"}')).toBe("FAKE_TOOL_RESULT echo_host: echo:again");
	});

	it("registers the tools exactly once when the provider is installed while the process is still starting", async () => {
		const { supervisor, events } = create({ env: { FAKE_OMP_LOG: join(tmp, "fake.log"), FAKE_OMP_EVENT_DELAY_MS: "1", FAKE_OMP_READY_DELAY_MS: "200" } });
		const opening = supervisor.open(spec("racing"));
		await waitFor(() => supervisor.get("racing")?.status().state === "starting", "starting");
		const tools = provider(["echo_host"], echoTool);
		supervisor.setHostToolProvider(tools);
		const session = await opening;
		await supervisor.refreshHostTools("racing"); // flushes any sync queued behind the start
		expect(hostToolRecords()).toHaveLength(1);
		expect(hostToolRecords()[0]?.names).toEqual(["echo_host"]);
		expect(await runPrompt(session, events, '@@fake-tool echo_host {"message":"raced"}')).toBe("FAKE_TOOL_RESULT echo_host: echo:raced");
	});

	it("sends nothing when there is nothing to register, and clears the tools when the provider goes away", async () => {
		const { supervisor, events } = create();
		const session = await supervisor.open(spec("none"));
		expect(received("set_host_tools")).toHaveLength(0);

		const tools = provider(["echo_host"], echoTool);
		supervisor.setHostToolProvider(tools);
		await waitFor(() => hostToolRecords().length === 1, "tools registered on the live session");
		expect(hostToolRecords()[0]?.names).toEqual(["echo_host"]);
		expect(await runPrompt(session, events, '@@fake-tool echo_host {"message":"live"}')).toBe("FAKE_TOOL_RESULT echo_host: echo:live");

		supervisor.setHostToolProvider(null);
		await waitFor(() => hostToolRecords().length === 2, "tools cleared");
		expect(hostToolRecords()[1]?.names).toEqual([]);
		expect(await runPrompt(session, events, '@@fake-tool echo_host {"message":"gone"}')).toBe(
			'FAKE_TOOL_RESULT echo_host: ERROR Host tool "echo_host" is unavailable: no host tool provider is configured',
		);
	});

	it("refreshHostTools re-reads the definitions, skips unchanged ones, and ignores sessions without a live runtime", async () => {
		const { supervisor } = create();
		const tools = provider(["a"], echoTool);
		supervisor.setHostToolProvider(tools);
		await supervisor.open(spec("refresh"));
		expect(hostToolRecords()).toHaveLength(1);

		await supervisor.refreshHostTools("refresh");
		expect(hostToolRecords()).toHaveLength(1); // unchanged

		tools.defs = [def("a"), def("b")];
		await supervisor.refreshHostTools("refresh");
		expect(hostToolRecords()).toHaveLength(2);
		expect(hostToolRecords()[1]?.names).toEqual(["a", "b"]);

		await expect(supervisor.refreshHostTools("ghost")).resolves.toBeUndefined();
		await supervisor.stop("refresh");
		await expect(supervisor.refreshHostTools("refresh")).resolves.toBeUndefined();
		expect(hostToolRecords()).toHaveLength(2);
	});

	it("surfaces a registration refused by omp as a notice without failing the session, and refresh rejects", async () => {
		const { supervisor, events } = create();
		const tools = provider(["read"], echoTool); // clashes with a built-in tool
		supervisor.setHostToolProvider(tools);
		const session = await supervisor.open(spec("clash"));
		expect(session.status().state).toBe("ready");
		expect(events.find((e) => e.type === "notice")).toMatchObject({ level: "error", message: expect.stringContaining("conflicts with an existing tool") });
		expect(hostToolRecords()).toHaveLength(0);

		const rejection = await supervisor.refreshHostTools("clash").catch((e: unknown) => e);
		expect(rejection).toBeInstanceOf(AgentRuntimeError);
		expect((rejection as AgentRuntimeError).code).toBe("rejected");
		expect(events.filter((e) => e.type === "notice")).toHaveLength(2);

		tools.defs = [def("fine")];
		await supervisor.refreshHostTools("clash");
		expect(hostToolRecords()[0]?.names).toEqual(["fine"]);
	});

	it("validates definitions locally: duplicates, names, schema, provider failures", async () => {
		const { supervisor, events } = create();
		const tools = provider(["dup", "dup"], echoTool);
		supervisor.setHostToolProvider(tools);
		await supervisor.open(spec("invalid"));
		expect(events.find((e) => e.type === "notice")).toMatchObject({ level: "error", message: expect.stringContaining('"dup" is defined more than once') });
		expect(received("set_host_tools")).toHaveLength(0);

		const invalid: Array<[HostToolDefinition[], string]> = [
			[[def("bad name")], "invalid name"],
			[[def("ok", { description: "  " })], "non-empty description"],
			[[def("ok", { parameters: [] as unknown as Record<string, unknown> })], "JSON Schema object"],
			[[def("ok", { loadMode: "eager" as "essential" })], "invalid loadMode"],
		];
		for (const [defs, fragment] of invalid) {
			tools.defs = defs;
			const error = await supervisor.refreshHostTools("invalid").catch((e: unknown) => e);
			expect(error).toBeInstanceOf(AgentRuntimeError);
			expect((error as AgentRuntimeError).code).toBe("invalid_argument");
			expect((error as AgentRuntimeError).message).toContain(fragment);
		}
		expect(received("set_host_tools")).toHaveLength(0);

		tools.definitions = () => {
			throw new Error("directory offline");
		};
		await expect(supervisor.refreshHostTools("invalid")).rejects.toThrow("directory offline");
		expect(received("set_host_tools")).toHaveLength(0);
	});
});

describe("host tool calls", () => {
	it("answers concurrent calls with the matching ids", async () => {
		const { supervisor, events } = create();
		let started = 0;
		const allStarted = Promise.withResolvers<void>();
		const release = [1, 2, 3].map(() => Promise.withResolvers<void>());
		const tools = provider(["echo"], async (call) => {
			const n = (call.arguments as { n: number }).n;
			if (++started === 3) allStarted.resolve();
			await release[n - 1]?.promise;
			return { text: `result-${n}` };
		});
		supervisor.setHostToolProvider(tools);
		const session = await supervisor.open(spec("concurrent"));

		events.length = 0;
		const message = ["@@fake-parallel", '@@fake-tool echo {"n":1}', '@@fake-tool echo {"n":2}', '@@fake-tool echo {"n":3}'].join("\n");
		await session.prompt({ message, clientId: "c-par" });
		await allStarted.promise; // proves the three calls run at the same time
		for (const n of [3, 1, 2]) release[n - 1]?.resolve(); // answered out of order
		await waitFor(() => events.some((e) => e.type === "settled"), "settled");
		expect(await assistantText(session)).toBe(["FAKE_TOOL_RESULT echo: result-1", "FAKE_TOOL_RESULT echo: result-2", "FAKE_TOOL_RESULT echo: result-3"].join("\n"));

		const calls = ofKind("host_tool_call");
		expect(calls).toHaveLength(3);
		expect(new Set(calls.map((c) => c.id)).size).toBe(3);
		const results = received("host_tool_result");
		expect(results).toHaveLength(3);
		for (const call of calls) {
			const result = results.find((r) => r.id === call.id);
			expect(result?.result?.content[0]?.text).toBe(`result-${call.arguments?.n}`);
		}
	});

	it("streams updates before the result and never after it", async () => {
		const { supervisor, events } = create();
		let leaked: HostToolCall | undefined;
		const tools = provider(["work"], async (call) => {
			call.update("step 1");
			call.update("step 2");
			leaked = call;
			return { text: "done" };
		});
		supervisor.setHostToolProvider(tools);
		const session = await supervisor.open(spec("updates"));

		expect(await runPrompt(session, events, "@@fake-tool work {}")).toBe("FAKE_TOOL_RESULT work: done");
		leaked?.update("too late");
		await runPrompt(session, events, "@@fake-tool work {}"); // a later round trip proves the late update was not written in between
		const frames = logRecords().flatMap((r) =>
			r.kind === "command" && r.frame && (r.frame.type === "host_tool_update" || r.frame.type === "host_tool_result") ? [r.frame] : [],
		);
		const firstId = frames[0]?.id;
		const ofFirst = frames.filter((f) => f.id === firstId);
		expect(ofFirst.map((f) => f.type)).toEqual(["host_tool_update", "host_tool_update", "host_tool_result"]);
		expect(ofFirst.slice(0, 2).map((f) => f.partialResult?.content[0]?.text)).toEqual(["step 1", "step 2"]);
		expect(ofKind("host_tool_orphan")).toHaveLength(0);
	});

	it("turns throws and isError results into error results carrying the message only", async () => {
		const { supervisor, events } = create();
		const names = ["boom", "syncboom", "strboom", "flag"];
		const tools: HostToolProvider = {
			definitions: () => names.map((n) => def(n)),
			execute: (call) => {
				switch (call.toolName) {
					case "boom":
						return Promise.reject(new Error("boom: bad input"));
					case "syncboom":
						throw new Error("sync boom");
					case "strboom":
						return Promise.reject("just a string");
					default:
						return Promise.resolve({ text: "nope", isError: true });
				}
			},
		};
		supervisor.setHostToolProvider(tools);
		const session = await supervisor.open(spec("errors"));

		const text = await runPrompt(session, events, names.map((n) => `@@fake-tool ${n} {}`).join("\n"));
		expect(text.split("\n")).toEqual([
			"FAKE_TOOL_RESULT boom: ERROR boom: bad input",
			"FAKE_TOOL_RESULT syncboom: ERROR sync boom",
			"FAKE_TOOL_RESULT strboom: ERROR just a string",
			"FAKE_TOOL_RESULT flag: ERROR nope",
		]);
		const results = received("host_tool_result");
		expect(results.map((r) => r.isError)).toEqual([true, true, true, true]);
		expect(results.every((r) => !r.result?.content[0]?.text.includes("\n    at "))).toBe(true);
		expect(events.flatMap((e) => (e.type === "tool_end" ? [e.isError] : []))).toEqual([true, true, true, true]);
	});

	it("answers with an error, without calling the provider, for unknown tools and calls before any provider exists", async () => {
		const { supervisor, events } = create();
		const session = await supervisor.open(spec("unknown"));
		expect(await runPrompt(session, events, '@@fake-tool echo_host {"message":"x"}')).toBe(
			'FAKE_TOOL_RESULT echo_host: ERROR Host tool "echo_host" is unavailable: no host tool provider is configured',
		);

		const tools = provider(["echo_host"], echoTool);
		supervisor.setHostToolProvider(tools);
		await waitFor(() => hostToolRecords().length === 1, "registered");
		const message = ["@@fake-tool ghost {}", '@@fake-tool echo_host {"message":"ok"}'].join("\n");
		expect(await runPrompt(session, events, message)).toBe(
			['FAKE_TOOL_RESULT ghost: ERROR Host tool "ghost" is not registered', "FAKE_TOOL_RESULT echo_host: echo:ok"].join("\n"),
		);
		expect(tools.calls.map((c) => c.toolName)).toEqual(["echo_host"]);
		expect(received("host_tool_result").map((r) => r.isError === true)).toEqual([true, true, false]);
	});

	it("aborts the handler's signal on host_tool_cancel and drops its late result", async () => {
		const { supervisor, events } = create();
		const started = Promise.withResolvers<HostToolCall>();
		const lateReturn = Promise.withResolvers<boolean>();
		const tools = provider(["block", "echo_host"], async (call) => {
			if (call.toolName !== "block") return echoTool(call);
			started.resolve(call);
			await whenAborted(call.signal);
			lateReturn.resolve(call.signal.aborted);
			return { text: "late result" };
		});
		supervisor.setHostToolProvider(tools);
		const session = await supervisor.open(spec("cancel"));

		events.length = 0;
		await session.prompt({ message: "@@fake-tool block {}", clientId: "c-block" });
		const call = await started.promise;
		expect(call.signal.aborted).toBe(false);
		await session.abort();
		expect(await lateReturn.promise).toBe(true);
		await waitFor(() => events.some((e) => e.type === "settled"), "aborted turn settled");
		expect(events.find((e) => e.type === "prompt_result")).toMatchObject({ status: "aborted" });

		// A later round trip: anything written for the cancelled call would have arrived before it.
		expect(await runPrompt(session, events, '@@fake-tool echo_host {"message":"after"}')).toBe("FAKE_TOOL_RESULT echo_host: echo:after");
		const cancelled = ofKind("host_tool_cancel");
		expect(cancelled).toHaveLength(1);
		const blockCall = ofKind("host_tool_call")[0];
		expect(cancelled[0]?.targetId).toBe(blockCall?.id);
		const resultIds = received("host_tool_result").map((r) => r.id);
		expect(resultIds).not.toContain(blockCall?.id);
		expect(resultIds).toHaveLength(1);
		expect(ofKind("host_tool_orphan")).toHaveLength(0);
	});

	it("aborts in-flight calls when the process dies, and the restarted process works", async () => {
		const { supervisor, events, statuses } = create();
		const started = Promise.withResolvers<HostToolCall>();
		const aborted = Promise.withResolvers<unknown>();
		const tools = provider(["block", "echo_host"], async (call) => {
			if (call.toolName !== "block") return echoTool(call);
			started.resolve(call);
			await whenAborted(call.signal);
			aborted.resolve(call.signal.reason);
			return { text: "never delivered" };
		});
		supervisor.setHostToolProvider(tools);
		const session = await supervisor.open(spec("exit"));

		await session.prompt({ message: "@@fake-tool block {}", clientId: "c-exit" });
		const call = await started.promise;
		process.kill(session.status().pid as number, "SIGKILL");
		const reason = await aborted.promise;
		expect(call.signal.aborted).toBe(true);
		expect(reason).toBeInstanceOf(AgentRuntimeError);
		expect((reason as AgentRuntimeError).code).toBe("process_exited");
		await waitFor(() => statuses.some((s) => s.state === "crashed"), "crashed");
		await session.whenReady();
		expect(await runPrompt(session, events, '@@fake-tool echo_host {"message":"back"}')).toBe("FAKE_TOOL_RESULT echo_host: echo:back");
	});

	it("aborts in-flight calls when the session is stopped", async () => {
		const { supervisor } = create();
		const started = Promise.withResolvers<HostToolCall>();
		const aborted = Promise.withResolvers<unknown>();
		const tools = provider(["block"], async (call) => {
			started.resolve(call);
			await whenAborted(call.signal);
			aborted.resolve(call.signal.reason);
			return { text: "never delivered" };
		});
		supervisor.setHostToolProvider(tools);
		const session = await supervisor.open(spec("stop"));
		await session.prompt({ message: "@@fake-tool block {}", clientId: "c-stop" });
		await started.promise;
		await supervisor.stop("stop");
		expect(await aborted.promise).toMatchObject({ code: "process_exited", message: "Agent runtime stopped" });
		expect(received("host_tool_result")).toHaveLength(0);
	});
});

describe("fixture directives", () => {
	it("runs @@fake-sh and @@fake-tool lines in text order and replaces {{taskId}}", async () => {
		const { supervisor, events } = create();
		const tools = provider(["mesh_task"], async (call) => ({ text: `task=${(call.arguments as { taskId: string }).taskId}` }));
		supervisor.setHostToolProvider(tools);
		const session = await supervisor.open(spec("directives"));
		const message = ["[CL Agent Mesh] task tsk_abc-123 started", "@@fake-sh echo hello", '@@fake-tool mesh_task {"taskId":"{{taskId}}"}', "@@fake-sh exit 3"].join("\n");
		expect(await runPrompt(session, events, message)).toBe(["FAKE_TOOL_RESULT sh: exit=0 hello", "FAKE_TOOL_RESULT mesh_task: task=tsk_abc-123", "FAKE_TOOL_RESULT sh: exit=3"].join("\n"));
		expect(events.flatMap((e) => (e.type === "tool_start" ? [e.toolName] : []))).toEqual(["bash", "mesh_task", "bash"]);
	});
});

describe("per-session spawn arguments", () => {
	it("applies the session approval mode over the node setting, and --no-ui only for an effective yolo", async () => {
		const { supervisor } = create({ settings: { maxConcurrentRuntimes: 4, idleTimeoutMs: 60_000, approvalMode: "yolo" } });
		await supervisor.open(spec("strict", { approvalMode: "always-ask" }));
		await supervisor.open(spec("node"));
		supervisor.updateOptions({ approvalMode: "write" });
		await supervisor.open(spec("lax", { approvalMode: "yolo" }));
		await supervisor.open(spec("follows"));
		const [strict, node, lax, follows] = spawnArgv();
		expect(strict).not.toContain("--no-ui");
		expect(strict).toEqual(expect.arrayContaining(["--approval-mode", "always-ask"]));
		expect(node).toContain("--no-ui");
		expect(node).toEqual(expect.arrayContaining(["--approval-mode", "yolo"]));
		expect(lax).toContain("--no-ui");
		expect(lax).toEqual(expect.arrayContaining(["--approval-mode", "yolo"]));
		expect(follows).not.toContain("--no-ui");
		expect(follows).toEqual(expect.arrayContaining(["--approval-mode", "write"]));
	});

	it("passes --max-cost, keeps both settings across a crash restart, and omits the flag by default", async () => {
		const { supervisor, statuses } = create();
		const session = await supervisor.open(spec("capped", { approvalMode: "always-ask-cached", maxCostUsd: 0.25 }));
		await supervisor.open(spec("uncapped"));
		const [capped, uncapped] = spawnArgv();
		const index = capped?.indexOf("--max-cost") ?? -1;
		expect(index).toBeGreaterThan(-1);
		expect(capped?.[index + 1]).toBe("0.25");
		expect(capped).toEqual(expect.arrayContaining(["--approval-mode", "always-ask-cached"]));
		expect(uncapped).not.toContain("--max-cost");

		statuses.length = 0;
		process.kill(session.status().pid as number, "SIGKILL");
		await waitFor(() => statuses.some((s) => s.state === "crashed"), "crashed");
		await session.whenReady();
		const sameSession = spawnArgv().filter((argv) => argv.includes("always-ask-cached"));
		expect(sameSession).toHaveLength(2);
		expect(sameSession[1]).toEqual(sameSession[0]);
	});

	it("rejects an invalid spend cap or approval mode before spawning anything", async () => {
		const { supervisor } = create();
		for (const maxCostUsd of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			await expect(supervisor.open(spec("bad", { maxCostUsd }))).rejects.toMatchObject({ code: "invalid_argument" });
		}
		await expect(supervisor.open(spec("bad", { approvalMode: "sometimes" as "yolo" }))).rejects.toMatchObject({ code: "invalid_argument" });
		expect(() => readFileSync(join(tmp, "fake.log"), "utf8")).toThrow(); // no process was ever started
	});
});

describe("validateHostToolDefinitions", () => {
	it("normalizes labels and keeps only the wire fields", () => {
		expect(validateHostToolDefinitions([{ ...def("a"), label: " ", extra: 1 }])).toEqual([
			{ name: "a", label: "a", description: "Does a", parameters: { type: "object", properties: { message: { type: "string" } }, additionalProperties: true } },
		]);
	});

	it("rejects non-arrays, non-objects and bad names", () => {
		expect(() => validateHostToolDefinitions("x")).toThrow("must be an array");
		expect(() => validateHostToolDefinitions([null])).toThrow("must be an object");
		expect(() => validateHostToolDefinitions([def("x".repeat(65))])).toThrow("invalid name");
		expect(() => validateHostToolDefinitions([def("")])).toThrow("invalid name");
	});
});

describe("HostToolDispatcher", () => {
	const silent: RuntimeLogger = { debug() {}, info() {}, warn() {}, error() {} };

	function setup(execute: (call: HostToolCall) => Promise<HostToolResult>) {
		const sent: Array<Record<string, unknown>> = [];
		const calls: HostToolCall[] = [];
		const dispatcher = new HostToolDispatcher({
			sessionId: "unit",
			provider: () => ({
				definitions: () => [],
				execute: (call) => {
					calls.push(call);
					return execute(call);
				},
			}),
			send: (frame) => {
				sent.push(frame);
			},
			log: silent,
		});
		dispatcher.setRegistered(["t"]);
		const call = (id: string, extra: Record<string, unknown> = {}) =>
			dispatcher.handleFrame({ type: "host_tool_call", id, toolCallId: `tc-${id}`, toolName: "t", arguments: {}, ...extra });
		return { dispatcher, sent, calls, call };
	}

	it("clips oversized results, substitutes empty ones, and rejects malformed calls and results", async () => {
		const outputs = ["x".repeat(MAX_HOST_TOOL_TEXT_CHARS + 50), "", undefined as unknown as string];
		const { sent, call } = setup(async () => ({ text: outputs.shift() as string }));
		call("big");
		call("empty");
		call("invalid");
		call("malformed", { toolName: undefined });
		await waitFor(() => sent.length === 4, "four answers");
		const byId = new Map(sent.map((f) => [f.id as string, f as unknown as Frame]));
		const bigText = byId.get("big")?.result?.content[0]?.text ?? "";
		expect(bigText.length).toBeLessThan(MAX_HOST_TOOL_TEXT_CHARS + 100);
		expect(bigText).toContain("50 characters cut");
		expect(byId.get("empty")?.result?.content[0]?.text).toBe("(no output)");
		expect(byId.get("invalid")?.isError).toBe(true);
		expect(byId.get("malformed")?.isError).toBe(true);
	});

	it("ignores duplicate call ids and frames it does not handle", async () => {
		const gate = Promise.withResolvers<void>();
		const { sent, calls, call, dispatcher } = setup(async () => {
			await gate.promise;
			return { text: "ok" };
		});
		expect(call("same")).toBe(true);
		call("same");
		expect(dispatcher.handleFrame({ type: "agent_start" })).toBe(false);
		expect(dispatcher.inFlight).toBe(1);
		gate.resolve();
		await waitFor(() => sent.length === 1, "answer");
		expect(calls).toHaveLength(1);
		expect(dispatcher.inFlight).toBe(0);
	});

	it("drops updates and results of a cancelled call, and aborts everything on abortAll", async () => {
		const gate = Promise.withResolvers<void>();
		const finished = Promise.withResolvers<void>();
		let returned = 0;
		const { sent, calls, call, dispatcher } = setup(async (c) => {
			c.update("before cancel");
			await gate.promise;
			c.update("after cancel");
			if (++returned === 2) finished.resolve();
			return { text: "late" };
		});
		call("c1");
		call("c2");
		expect(sent).toHaveLength(2);
		dispatcher.handleFrame({ type: "host_tool_cancel", id: "x", targetId: "c1" });
		expect(calls[0]?.signal.aborted).toBe(true);
		expect(calls[1]?.signal.aborted).toBe(false);
		dispatcher.abortAll("gone");
		expect(calls[1]?.signal.aborted).toBe(true);
		expect(dispatcher.inFlight).toBe(0);
		gate.resolve();
		await finished.promise;
		await flush();
		expect(sent.map((f) => f.type)).toEqual(["host_tool_update", "host_tool_update"]);
	});
});
