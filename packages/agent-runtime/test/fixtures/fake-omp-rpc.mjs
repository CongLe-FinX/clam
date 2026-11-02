// Test fixture: emulation of `omp --mode rpc` (JSONL over stdio, protocol v1/v2 with rpc_chunk framing).
// Plain Node ESM, no dependencies. Behaviour knobs are environment variables (FAKE_OMP_*), see README at the
// top of each handler below. Frame shapes follow rpc-types.ts / rpc-session-events.ts of oh-my-pi 18.14.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";

function realOrResolved(p) {
	try {
		return realpathSync(p);
	} catch {
		return resolve(p);
	}
}

const MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;

const MODELS = [
	model("alpha", "Fake Alpha"),
	model("beta", "Fake Beta"),
];

function model(id, name) {
	return {
		provider: "fake",
		id,
		name,
		api: "fake",
		contextWindow: 200000,
		maxTokens: 8192,
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
	};
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
	const out = { mode: undefined, noUi: false, cwd: undefined, approvalMode: undefined, maxCost: undefined, profile: undefined, model: undefined, noSession: false, sessionDir: undefined };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => argv[++i];
		if (arg === "--mode") out.mode = next();
		else if (arg === "--no-ui") out.noUi = true;
		else if (arg === "--cwd") out.cwd = next();
		else if (arg === "--approval-mode") out.approvalMode = next();
		else if (arg === "--profile") out.profile = next();
		else if (arg === "--model") out.model = next();
		else if (arg === "--no-session") out.noSession = true;
		else if (arg === "--session-dir") out.sessionDir = next();
		else if (arg === "--max-cost") out.maxCost = next();
	}
	return out;
}

/** Mirrors RpcSessionEventForwarder + toDelta from rpc-session-events.ts. */
function openedBlock(block) {
	switch (block?.type) {
		case "text":
			return { ...block, text: "" };
		case "thinking":
			return { ...block, thinking: "" };
		case "toolCall":
			return { ...block, arguments: {} };
		default:
			return block;
	}
}

function toDelta(event) {
	switch (event.type) {
		case "done":
		case "error":
			return event;
		case "start": {
			const { partial, ...rest } = event;
			return { ...rest, message: partial };
		}
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta": {
			const { partial: _p, ...increment } = event;
			return increment;
		}
		case "text_end": {
			const { partial, ...rest } = event;
			const block = partial.content[event.contentIndex];
			if (block?.type !== "text") return rest;
			const { text: _t, ...meta } = block;
			return { ...rest, block: meta };
		}
		case "thinking_end": {
			const { partial, ...rest } = event;
			const block = partial.content[event.contentIndex];
			if (block?.type !== "thinking") return rest;
			const { thinking: _t, ...meta } = block;
			return { ...rest, block: meta };
		}
		case "image_end":
		case "toolcall_end": {
			const { partial: _p, ...rest } = event;
			return rest;
		}
		default: {
			const { partial, ...rest } = event;
			const block = openedBlock(partial.content[event.contentIndex]);
			return block === undefined ? rest : { ...rest, block };
		}
	}
}

function shrink(value) {
	if (typeof value === "string") {
		return value.length > 1024 ? `${value.slice(0, 944)}\n…[${value.length - 944} chars elided for RPC frame]` : value;
	}
	if (Array.isArray(value)) return value.map(shrink);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shrink(v)]));
	}
	return value;
}

export async function runRpc(argv, env) {
	const args = parseArgs(argv);
	const logFile = env.FAKE_OMP_LOG;
	const maxFrameBytes = Number(env.FAKE_OMP_MAX_FRAME_BYTES ?? 65536);
	const eventDelayMs = Number(env.FAKE_OMP_EVENT_DELAY_MS ?? 5);
	const readyDelayMs = Number(env.FAKE_OMP_READY_DELAY_MS ?? 0);

	const log = (record) => {
		if (!logFile) return;
		appendFileSync(logFile, `${JSON.stringify(record)}\n`);
	};

	log({
		kind: "spawn",
		argv,
		args,
		cwd: process.cwd(),
		env: Object.fromEntries(
			Object.entries(env).filter(([k]) => /^(FAKE_OMP_|PI_|OMP_|NO_COLOR$)/.test(k)),
		),
	});

	if (env.FAKE_OMP_STDERR) process.stderr.write(`${env.FAKE_OMP_STDERR}\n`);
	if (env.FAKE_OMP_EXIT_BEFORE_READY !== undefined) {
		process.stderr.write("fake-omp: exiting before ready\n");
		return Number(env.FAKE_OMP_EXIT_BEFORE_READY);
	}
	if (args.maxCost !== undefined && !(Number.isFinite(Number(args.maxCost)) && Number(args.maxCost) > 0)) {
		process.stderr.write(`fake-omp: invalid --max-cost ${args.maxCost}\n`);
		return 2;
	}

	process.stdout.on("error", () => {});

	// --- output ---------------------------------------------------------------------------------------------
	let protocolVersion = 1;
	let chunkCounter = 0;

	const writeLine = (text) => {
		process.stdout.write(`${text}\n`);
	};

	function emit(frame, isResponse = frame.type === "response") {
		const json = JSON.stringify(frame);
		const bytes = Buffer.byteLength(json, "utf8");
		if (bytes + 1 <= maxFrameBytes) {
			writeLine(json);
			return;
		}
		if (protocolVersion >= 2) {
			if (bytes > MAX_REASSEMBLED_BYTES) {
				writeLine(JSON.stringify(isResponse ? { ...overflowResponse(frame) } : { type: "rpc_frame_error", error: "RPC frame exceeded the transport limit" }));
				return;
			}
			const payload = Math.max(64, Math.floor(((maxFrameBytes - 512) * 3) / 4));
			const buffer = Buffer.from(json, "utf8");
			const count = Math.ceil(bytes / payload);
			const chunkId = `rpc-${++chunkCounter}`;
			for (let index = 0; index < count; index++) {
				writeLine(
					JSON.stringify({
						type: "rpc_chunk",
						chunkId,
						index,
						count,
						byteLength: bytes,
						data: buffer.subarray(index * payload, (index + 1) * payload).toString("base64"),
					}),
				);
			}
			return;
		}
		if (isResponse) {
			writeLine(JSON.stringify(overflowResponse(frame)));
			return;
		}
		writeLine(JSON.stringify(shrink(frame)));
	}

	function overflowResponse(frame) {
		const out = { type: "response", command: frame.command, success: false, error: "RPC response exceeded the transport limit" };
		if (frame.id !== undefined) out.id = frame.id;
		return out;
	}

	function ok(id, command, data) {
		const frame = { type: "response", command, success: true };
		if (id !== undefined) frame.id = id;
		if (data !== undefined) frame.data = data;
		emit(frame, true);
	}

	function fail(id, command, error, code) {
		const frame = { type: "response", command, success: false, error };
		if (id !== undefined) frame.id = id;
		if (code !== undefined) frame.code = code;
		emit(frame, true);
	}

	// --- session event forwarder (messageId stamping + delta projection) -------------------------------------
	let messageUpdates = "full";
	let eventFilter = null;
	let messageCount = 0;
	const openMessageIds = [];

	function forward(event) {
		let frame = event;
		if (event.type === "message_start") {
			const messageId = `msg-${++messageCount}`;
			openMessageIds.push(messageId);
			frame = { ...event, messageId };
		} else if (event.type === "message_update") {
			let messageId = openMessageIds.at(-1);
			if (messageId === undefined) {
				messageId = `msg-${++messageCount}`;
				openMessageIds.push(messageId);
			}
			frame = { ...event, messageId };
		} else if (event.type === "message_end") {
			frame = { ...event, messageId: openMessageIds.pop() ?? `msg-${++messageCount}` };
		} else if (event.type === "agent_end") {
			openMessageIds.length = 0;
		}
		if (eventFilter && !eventFilter.has(frame.type)) return;
		if (frame.type === "message_update" && messageUpdates === "delta") {
			emit({ ...frame, message: { role: frame.message.role }, assistantMessageEvent: toDelta(frame.assistantMessageEvent) });
			return;
		}
		emit(frame);
	}

	// --- session state ----------------------------------------------------------------------------------------
	let currentModel = MODELS[0];
	if (args.model) {
		const [provider, id] = args.model.split("/");
		const found = MODELS.find((m) => m.provider === provider && m.id === id);
		if (found) currentModel = found;
	}
	let thinkingLevel = "medium";
	const THINKING_LEVELS = ["off", "low", "medium", "high"];
	let sessionId = randomUUID();
	let sessionDir;
	let sessionFile;
	let messages = [];
	let totals = { input: 0, output: 0 };
	const authenticated = new Set(["fake-key"]);
	let uiCounter = 0;

	// Sessions are JSON-lines journals `<sessionDir>/<ts>_<id>.jsonl`: a `{type:"session"}` header, then one
	// `{type:"message", message}` line per message. Like real omp, the process claims an ownership lease
	// (`<dir>/.<file>.lock.os` holding its pid) at its first WRITE to the journal and drops it on exit; a lock
	// whose pid is dead is stale (see fake-omp-cli.mjs `liveLockPid`).
	let header;
	let leaseHeld = false;
	const lockPath = () => join(dirname(sessionFile), `.${basename(sessionFile)}.lock.os`);

	function claimLease() {
		if (leaseHeld || !sessionFile) return;
		leaseHeld = true;
		writeFileSync(lockPath(), String(process.pid));
		log({ kind: "lease", action: "acquired", file: sessionFile, pid: process.pid });
	}

	function releaseLease() {
		if (!leaseHeld) return;
		leaseHeld = false;
		rmSync(lockPath(), { force: true });
		log({ kind: "lease", action: "released", file: sessionFile, pid: process.pid });
	}
	process.on("exit", releaseLease);

	function journalText() {
		return [header, ...messages.map((message) => ({ type: "message", message }))].map((line) => `${JSON.stringify(line)}\n`).join("");
	}

	function persist() {
		if (!sessionFile) return;
		claimLease();
		header.id = sessionId;
		writeFileSync(sessionFile, journalText());
	}

	function openSession(dir) {
		mkdirSync(dir, { recursive: true });
		sessionDir = dir;
		const newest = readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort().at(-1);
		if (newest) {
			const file = join(dir, newest);
			const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
			const found = lines.find((line) => line.type === "session");
			// Real omp compares its standardized spellings; real paths are the fake's equivalent.
			if (args.cwd && found?.cwd && realOrResolved(found.cwd) !== realOrResolved(args.cwd)) return null;
			sessionFile = file;
			header = found;
			messages = lines.filter((line) => line.type === "message").map((line) => line.message);
			sessionId = header.id;
			totals = { input: 0, output: 0 };
			for (const message of messages) {
				if (message.role === "assistant" && message.usage) {
					totals.input += message.usage.input;
					totals.output += message.usage.output;
				}
			}
			return true;
		}
		sessionId = randomUUID();
		messages = [];
		const now = new Date();
		header = { type: "session", version: 3, id: sessionId, timestamp: now.toISOString(), cwd: args.cwd ?? process.cwd() };
		sessionFile = join(dir, `${now.toISOString().replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
		// A freshly opened session has a journal but no lease yet: it can be packed until the first write.
		writeFileSync(sessionFile, journalText());
		return false;
	}

	if (args.sessionDir && !args.noSession) openSession(args.sessionDir);

	function contextUsage() {
		const tokens = totals.input + totals.output;
		return { tokens, contextWindow: currentModel.contextWindow, percent: (tokens / currentModel.contextWindow) * 100 };
	}

	function stateData() {
		const data = {
			model: currentModel,
			thinkingLevel,
			isStreaming: run !== undefined,
			isCompacting: false,
			steeringMode: "one-at-a-time",
			followUpMode: "one-at-a-time",
			interruptMode: "immediate",
			sessionId,
			autoCompactionEnabled: true,
			fastModeEnabled: false,
			fastModeActive: false,
			slowModeSupported: false,
			slowModeEnabled: false,
			tokensPerSecond: null,
			messageCount: messages.length,
			queuedMessageCount: queue.length,
			hasPendingAsyncWork: false,
			isSettled: run === undefined && queue.length === 0,
			queuedMessages: { steering: [], followUp: queue.map((q) => q.message), liveSteered: 0 },
			todoPhases: [],
			contextUsage: contextUsage(),
			goal: null,
		};
		if (sessionFile) data.sessionFile = sessionFile;
		return data;
	}

	function statsData() {
		const count = (role) => messages.filter((m) => m.role === role).length;
		const toolCalls = messages.reduce(
			(n, m) => n + (m.role === "assistant" ? m.content.filter((b) => b.type === "toolCall").length : 0),
			0,
		);
		return {
			sessionId,
			userMessages: count("user"),
			assistantMessages: count("assistant"),
			toolCalls,
			toolResults: count("toolResult"),
			totalMessages: messages.length,
			tokens: { input: totals.input, output: totals.output, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: totals.input + totals.output },
			cost: (totals.input * 1 + totals.output * 2) / 1_000_000,
			premiumRequests: 0,
			contextUsage: contextUsage(),
		};
	}

	// --- prompt runs -----------------------------------------------------------------------------------------
	let run;
	const queue = [];
	let aborted = false;
	let closing = false;
	let inflight = 0;
	let finishResolve;
	const finished = new Promise((resolve) => {
		finishResolve = resolve;
	});
	const uiWaiters = new Map();

	// --- host tools ---------------------------------------------------------------------------------------------
	// `set_host_tools` stores the definitions (and logs {kind:"host_tools", names, tools}). Prompt directives drive the
	// agent side of the Host Tool Sub-Protocol; one directive per line, executed in text order (all at once when the
	// prompt also has a `@@fake-parallel` line):
	//   @@fake-tool <toolName> <json-args>   host_tool_call (emitted even for unregistered names) awaiting host_tool_result;
	//                                        `{{taskId}}` in the JSON is replaced by the first `tsk_...` token of the prompt
	//   @@fake-sh <command>                  `sh -c` in the session cwd, reported as tool "bash"
	//   @@fake-final <text>                  the turn's final assistant text, instead of the FAKE_TOOL_RESULT lines
	// Without `@@fake-final` the turn's final assistant text has one `FAKE_TOOL_RESULT <name>: <result>` line per directive:
	// `<toolName>: [ERROR ]<text>` for host tools, `sh: exit=<code> <stdout>` for shell runs.
	// An `abort` command while host calls are pending emits `host_tool_cancel` for each and ends the turn as aborted.
	const BUILTIN_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "task", "web_search"];
	let hostTools = new Map();
	const hostCalls = new Map();
	let hostCallCounter = 0;
	let hostCancelCounter = 0;

	function parseHostDirectives(text) {
		const taskId = /tsk_[A-Za-z0-9_-]+/.exec(text)?.[0];
		const fill = (value) => value.replaceAll("{{taskId}}", taskId ?? "{{taskId}}");
		const items = [];
		let parallel = false;
		let final;
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (trimmed === "@@fake-parallel") {
				parallel = true;
				continue;
			}
			const tool = /^@@fake-tool\s+(\S+)(?:\s+(.*))?$/.exec(trimmed);
			if (tool) {
				items.push({ kind: "tool", toolName: tool[1], label: tool[1], raw: fill(tool[2] ?? "{}") });
				continue;
			}
			const finalText = /^@@fake-final\s+(.+)$/.exec(trimmed);
			if (finalText) {
				final = finalText[1];
				continue;
			}
			const sh = /^@@fake-sh\s+(.+)$/.exec(trimmed);
			if (sh) items.push({ kind: "sh", toolName: "bash", label: "sh", command: fill(sh[1]) });
		}
		return { items, parallel, final };
	}

	function runShell(command) {
		return new Promise((resolve) => {
			execFile("sh", ["-c", command], { cwd: args.cwd ?? process.cwd(), maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
				const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
				resolve({ text: `exit=${code} ${String(stdout).trim()}`.trimEnd(), isError: false });
			});
		});
	}

	/** Sends one host_tool_call and resolves with {text, isError} once the host answered (or the call was cancelled). */
	function requestHostTool(entry) {
		const callId = `host_${++hostCallCounter}`;
		return new Promise((resolve) => {
			hostCalls.set(callId, { toolName: entry.toolName, toolCallId: entry.toolCallId, args: entry.args, resolve });
			log({ kind: "host_tool_call", id: callId, toolName: entry.toolName, registered: hostTools.has(entry.toolName), arguments: entry.args });
			emit({ type: "host_tool_call", id: callId, toolCallId: entry.toolCallId, toolName: entry.toolName, arguments: entry.args });
		});
	}

	function cancelHostCalls() {
		for (const [id, call] of [...hostCalls]) {
			hostCalls.delete(id);
			log({ kind: "host_tool_cancel", targetId: id });
			emit({ type: "host_tool_cancel", id: `host_cancel_${++hostCancelCounter}`, targetId: id });
			call.resolve({ text: `Host tool "${call.toolName}" was aborted`, isError: true });
		}
	}

	function handleHostFrame(frame) {
		const payload = frame.type === "host_tool_result" ? frame.result : frame.partialResult;
		if (typeof frame.id !== "string" || !payload || !Array.isArray(payload.content)) {
			log({ kind: "host_tool_malformed", frame });
			return;
		}
		const call = hostCalls.get(frame.id);
		if (!call) {
			// Late or duplicate: OMP ignores frames for calls it no longer waits for.
			log({ kind: "host_tool_orphan", id: frame.id, type: frame.type });
			return;
		}
		if (frame.type === "host_tool_update") {
			forward({ type: "tool_execution_update", toolCallId: call.toolCallId, toolName: call.toolName, args: call.args, partialResult: payload });
			return;
		}
		hostCalls.delete(frame.id);
		const text = payload.content
			.filter((block) => block?.type === "text" && typeof block.text === "string")
			.map((block) => block.text)
			.join("\n");
		call.resolve({ text, isError: frame.isError === true });
	}

	/** One assistant message with a toolCall block per directive, their executions, then the tool results. */
	async function hostToolTurn(items, parallel, final, runMessages) {
		const entries = items.map((item, index) => {
			const entry = { ...item, toolCallId: `call_fake_h${index + 1}`, args: {}, parseError: undefined };
			if (item.kind === "sh") {
				entry.args = { command: item.command };
			} else {
				try {
					entry.args = JSON.parse(item.raw);
				} catch (cause) {
					entry.parseError = `Invalid JSON arguments: ${cause.message}`;
				}
			}
			return entry;
		});
		const blocks = (withArgs) =>
			entries.map((e) => ({ type: "toolCall", id: e.toolCallId, name: e.toolName, arguments: withArgs ? e.args : {}, intent: `Calling ${e.toolName}` }));
		const callMessage = (withArgs) => assistantMessage(blocks(withArgs), "toolUse");

		const initial = assistantMessage([], "toolUse");
		forward({ type: "message_start", message: initial });
		forward({ type: "message_update", message: structuredClone(initial), assistantMessageEvent: { type: "start", partial: structuredClone(initial) } });
		for (const [index, entry] of entries.entries()) {
			await pause();
			forward({ type: "message_update", message: callMessage(false), assistantMessageEvent: { type: "toolcall_start", contentIndex: index, partial: callMessage(false) } });
			await pause();
			forward({
				type: "message_update",
				message: callMessage(false),
				assistantMessageEvent: { type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(entry.args), partial: callMessage(false) },
			});
			await pause();
			forward({
				type: "message_update",
				message: callMessage(true),
				assistantMessageEvent: { type: "toolcall_end", contentIndex: index, toolCall: blocks(true)[index], partial: callMessage(true) },
			});
		}
		const finalCall = callMessage(true);
		forward({ type: "message_update", message: finalCall, assistantMessageEvent: { type: "done", reason: "toolUse", message: finalCall } });
		await pause();
		record(finalCall);
		runMessages.push(finalCall);
		forward({ type: "message_end", message: finalCall });

		const outcomes = new Array(entries.length);
		const execute = async (entry, index) => {
			if (aborted) {
				outcomes[index] = { text: "Skipped: the run was aborted", isError: true };
				return;
			}
			forward({ type: "tool_execution_start", toolCallId: entry.toolCallId, toolName: entry.toolName, args: entry.args, intent: `Calling ${entry.toolName}` });
			let outcome;
			if (entry.parseError) outcome = { text: entry.parseError, isError: true };
			else if (entry.kind === "sh") outcome = await runShell(entry.args.command);
			else outcome = await requestHostTool(entry);
			outcomes[index] = outcome;
			forward({
				type: "tool_execution_end",
				toolCallId: entry.toolCallId,
				toolName: entry.toolName,
				result: { content: [{ type: "text", text: outcome.text }] },
				isError: outcome.isError,
			});
		};
		if (parallel) await Promise.all(entries.map(execute));
		else for (const [index, entry] of entries.entries()) await execute(entry, index);

		const toolResults = [];
		for (const [index, entry] of entries.entries()) {
			const outcome = outcomes[index];
			const toolResult = {
				role: "toolResult",
				toolCallId: entry.toolCallId,
				toolName: entry.toolName,
				content: [{ type: "text", text: outcome.text }],
				isError: outcome.isError,
				timestamp: Date.now(),
			};
			forward({ type: "message_start", message: toolResult });
			record(toolResult);
			runMessages.push(toolResult);
			forward({ type: "message_end", message: toolResult });
			toolResults.push(toolResult);
		}
		forward({ type: "turn_end", message: finalCall, toolResults });
		forward({ type: "turn_start" });
		if (aborted) {
			const message = assistantMessage([{ type: "text", text: "" }], "aborted", { errorMessage: "Request was aborted" });
			await singleMessage(message);
			return { last: message, aborted: true };
		}
		const lines = entries.map((entry, index) => {
			const outcome = outcomes[index];
			return `FAKE_TOOL_RESULT ${entry.label}: ${entry.kind === "tool" && outcome.isError ? "ERROR " : ""}${outcome.text}`;
		});
		return { last: await streamText(wordDeltas(final ?? lines.join("\n"))), aborted: false };
	}

	function track(promise) {
		inflight++;
		promise
			.catch((error) => process.stderr.write(`fake-omp: task failed: ${error?.stack ?? error}\n`))
			.finally(() => {
				inflight--;
				maybeFinish();
			});
	}

	function maybeFinish() {
		if (closing && inflight === 0 && !ignoreStdinClose) finishResolve(0);
	}

	const ignoreStdinClose = env.FAKE_OMP_IGNORE_STDIN_CLOSE !== undefined;

	function usageFor(text) {
		const input = Math.max(1, Math.ceil(text.length / 4));
		const output = Math.max(1, Math.ceil(text.length / 4));
		return {
			input,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input + output,
			cost: { input: input / 1e6, output: (output * 2) / 1e6, cacheRead: 0, cacheWrite: 0, total: (input + output * 2) / 1e6 },
		};
	}

	function assistantMessage(content, stopReason, extra = {}) {
		const text = content.map((b) => (b.type === "text" ? b.text : JSON.stringify(b.arguments ?? {}))).join("");
		const usage = usageFor(text);
		return {
			role: "assistant",
			content,
			api: "fake",
			provider: "fake",
			model: currentModel.id,
			usage,
			stopReason,
			timestamp: Date.now(),
			...extra,
		};
	}

	function record(message) {
		messages.push(message);
		if (message.role === "assistant") {
			totals.input += message.usage.input;
			totals.output += message.usage.output;
		}
		persist();
	}

	const pause = () => sleep(eventDelayMs);

	function waitForUi(id) {
		return new Promise((resolve) => {
			uiWaiters.set(id, resolve);
		});
	}

	function emitUiRequest(request) {
		const id = `ui-${++uiCounter}`;
		emit({ type: "extension_ui_request", id, ...request });
		return id;
	}

	/** Streams one assistant text message; returns the final message. */
	async function streamText(deltas, { stopReason = "stop", deltaDelayMs = eventDelayMs, maxMs = 0 } = {}) {
		let text = "";
		const partial = () => assistantMessage([{ type: "text", text }], "stop");
		const initial = assistantMessage([], "stop");
		forward({ type: "message_start", message: initial });
		await pause();
		forward({ type: "message_update", message: structuredClone(initial), assistantMessageEvent: { type: "start", partial: structuredClone(initial) } });
		await pause();
		text = "";
		forward({
			type: "message_update",
			message: partial(),
			assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: partial() },
		});
		const started = Date.now();
		let wasAborted = false;
		for await (const delta of deltas) {
			if (aborted) {
				wasAborted = true;
				break;
			}
			await sleep(deltaDelayMs);
			if (aborted) {
				wasAborted = true;
				break;
			}
			text += delta;
			forward({
				type: "message_update",
				message: partial(),
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: partial() },
			});
			if (maxMs && Date.now() - started > maxMs) break;
		}
		if (wasAborted) {
			const message = assistantMessage([{ type: "text", text }], "aborted", { errorMessage: "Request was aborted" });
			forward({
				type: "message_update",
				message,
				assistantMessageEvent: { type: "error", reason: "aborted", error: message },
			});
			await pause();
			record(message);
			forward({ type: "message_end", message });
			return message;
		}
		forward({
			type: "message_update",
			message: partial(),
			assistantMessageEvent: { type: "text_end", contentIndex: 0, content: text, partial: partial() },
		});
		await pause();
		const message = assistantMessage([{ type: "text", text }], stopReason);
		forward({ type: "message_update", message, assistantMessageEvent: { type: "done", reason: stopReason, message } });
		await pause();
		record(message);
		forward({ type: "message_end", message });
		return message;
	}

	function* wordDeltas(text) {
		const words = text.split(/(\s+)/).filter((w) => w.length > 0);
		const per = Math.max(1, Math.ceil(words.length / 4));
		for (let i = 0; i < words.length; i += per) yield words.slice(i, i + per).join("");
	}

	async function* endlessDeltas() {
		for (let i = 0; ; i++) yield `tick ${i} `;
	}

	async function singleMessage(message) {
		forward({ type: "message_start", message: { ...message, content: [] } });
		await pause();
		record(message);
		forward({ type: "message_end", message });
	}

	async function userMessageEvents(text, images = []) {
		const message = { role: "user", content: [{ type: "text", text }, ...images], timestamp: Date.now() };
		forward({ type: "message_start", message });
		record(message);
		forward({ type: "message_end", message });
		return message;
	}

	// --- ask dialog + subagents ---------------------------------------------------------------------------------
	// Frames mirror what omp 18.14 emits (captured from the real binary). `__ask__` raises the two-question `ask` request, `__ask_timeout__`
	// the same with a short timeout, `__subagents__` spawns Alpha (finishes by itself) and Beta (runs until cancelled or steered to finish).
	let askDialog = false;
	let subLevel = "off";
	const subagents = new Map();

	const ASK_QUESTIONS = [
		{ id: "db", question: "Which database?", header: "Database", options: [{ label: "Postgres", description: "Relational" }, { label: "SQLite", description: "Embedded", preview: "```sql\nselect 1;\n```" }], recommended: 1 },
		{ id: "features", question: "Which features?", header: "Features", options: [{ label: "Auth" }, { label: "Billing" }, { label: "Search" }], multi: true },
	];

	function readSubagentFile(file, fromByte = 0) {
		let start = Math.max(0, Math.trunc(Number(fromByte) || 0));
		const text = existsSync(file) ? readFileSync(file, "utf8") : "";
		const size = Buffer.byteLength(text);
		let reset = false;
		if (start > size) {
			start = 0;
			reset = true;
		}
		const buffer = Buffer.from(text).subarray(start);
		const lastNewline = buffer.lastIndexOf(0x0a);
		const complete = lastNewline >= 0 ? buffer.subarray(0, lastNewline + 1).toString() : "";
		const entries = complete.split("\n").filter(Boolean).map((line) => JSON.parse(line));
		return { sessionFile: file, fromByte: start, nextByte: start + Buffer.byteLength(complete), reset, entries, messages: entries.filter((e) => e.type === "message").map((e) => e.message) };
	}

	function startSubagent(name, index, parentToolCallId, autoFinishAfter) {
		const dir = join(sessionDir, "subagents");
		mkdirSync(dir, { recursive: true });
		const sessionFile = join(dir, `${name}.jsonl`);
		const line = (entry) => appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
		writeFileSync(sessionFile, "");
		let entryCount = 0;
		const addMessage = (message) => line({ type: "message", id: `${name}-${++entryCount}`, parentId: null, timestamp: new Date().toISOString(), message });
		const sub = {
			status: "running",
			sessionFile,
			ticks: 0,
			timer: undefined,
			progress() {
				return {
					index,
					id: name,
					agent: "task",
					agentSource: "bundled",
					status: sub.status,
					task: `Complete assignment thoroughly:\n\nRun echo ${name}`,
					assignment: `Run echo ${name}`,
					description: `Echo ${name}`,
					lastIntent: `Running echo ${name}`,
					...(sub.status === "running" ? { currentTool: "bash", currentToolArgs: `echo ${name}` } : {}),
					recentTools: sub.ticks > 1 ? [{ tool: "bash", args: `echo ${name}`, argsKey: "command", intent: `Running echo ${name}`, isError: false, endMs: Date.now() }] : [],
					recentOutput: sub.ticks > 2 ? [`${name} says hi`] : [],
					toolCount: sub.ticks,
					requests: sub.ticks,
					tokens: sub.ticks * 1000,
					cost: sub.ticks * 0.004,
					durationMs: sub.ticks * 40,
					modelOverride: ["fake/alpha"],
					resolvedModel: "fake/alpha:low",
					contextTokens: 1200,
					contextWindow: 200000,
				};
			},
			snapshot() {
				return { id: name, index, agent: "task", agentSource: "bundled", description: `Echo ${name}`, status: sub.status, sessionFile, lastUpdate: Date.now(), parentToolCallId, progress: sub.progress() };
			},
			frame(type) {
				if (subLevel === "off") return;
				if (type === "progress") emit({ type: "subagent_progress", payload: { index, agent: "task", agentSource: "bundled", task: `Run echo ${name}`, parentToolCallId, assignment: `Run echo ${name}`, detached: true, progress: sub.progress(), sessionFile } });
				else emit({ type: "subagent_lifecycle", payload: { id: name, agent: "task", parentToolCallId, detached: true, agentSource: "bundled", status: type, ...(type !== "started" ? { description: `Echo ${name}` } : {}), sessionFile, index } });
			},
			finish(status) {
				if (sub.status !== "running") return;
				clearInterval(sub.timer);
				sub.status = status;
				addMessage({ role: "assistant", content: [{ type: "text", text: `${name} ${status}` }], timestamp: Date.now(), stopReason: "stop" });
				sub.frame("progress");
				sub.frame(status);
				sub.done?.();
			},
			steer(message) {
				addMessage({ role: "user", content: [{ type: "text", text: message }], attribution: "user", timestamp: Date.now() });
				if (/finish/i.test(message)) sub.finish("completed");
			},
		};
		subagents.set(name, sub);
		const done = new Promise((resolve) => {
			sub.done = resolve;
		});
		addMessage({ role: "user", content: [{ type: "text", text: `Complete assignment thoroughly:\n\nRun echo ${name}` }], attribution: "agent", timestamp: Date.now() });
		sub.frame("started");
		sub.timer = setInterval(() => {
			sub.ticks++;
			if (sub.ticks === 2) addMessage({ role: "assistant", content: [{ type: "toolCall", id: `call_${name}`, name: "bash", arguments: { command: `echo ${name}` }, intent: `Running echo ${name}` }], timestamp: Date.now(), stopReason: "toolUse" });
			sub.frame("progress");
			if (autoFinishAfter !== undefined && sub.ticks >= autoFinishAfter) sub.finish("completed");
		}, 40);
		return done;
	}

	async function runAskTool(timeoutMs) {
		const toolCall = { type: "toolCall", id: "call_fake_ask", name: "ask", arguments: { questions: ASK_QUESTIONS }, intent: "Gathering preferences" };
		const callMessage = assistantMessage([toolCall], "toolUse");
		forward({ type: "message_start", message: callMessage });
		await pause();
		record(callMessage);
		forward({ type: "message_end", message: callMessage });
		let result;
		if (args.mode !== "rpc-ui") {
			result = { content: [{ type: "text", text: "Tool ask not found" }], details: { isError: true, error: "Tool ask not found" } };
			forward({ type: "tool_execution_start", toolCallId: toolCall.id, toolName: "ask", args: toolCall.arguments, intent: toolCall.intent });
		} else if (askDialog) {
			const uiId = emitUiRequest({ method: "ask", questions: ASK_QUESTIONS, ...(timeoutMs ? { timeout: timeoutMs } : {}) });
			forward({ type: "tool_execution_start", toolCallId: toolCall.id, toolName: "ask", args: toolCall.arguments, intent: toolCall.intent });
			let response;
			if (timeoutMs) {
				response = await Promise.race([waitForUi(uiId), sleep(timeoutMs).then(() => ({ timedOut: true }))]);
				if (response.timedOut) {
					uiWaiters.delete(uiId);
					emit({ type: "extension_ui_request", id: `${uiId}-cancel`, method: "cancel", targetId: uiId });
					response = { answers: ASK_QUESTIONS.map((q) => ({ id: q.id, selectedOptions: [q.options[q.recommended ?? 0].label] })) };
				}
			} else {
				response = await waitForUi(uiId);
			}
			log({ kind: "ask_answers", response });
			const results = response.cancelled
				? []
				: ASK_QUESTIONS.map((q, i) => ({ id: q.id, question: q.question, options: q.options.map((o) => o.label), multi: q.multi === true, ...response.answers[i] }));
			const text = response.cancelled ? "User cancelled the question" : `User answers:\n${results.map((r) => `${r.id}: ${r.customInput ?? r.selectedOptions.join(", ")}`).join("\n")}`;
			result = { content: [{ type: "text", text }], details: { results } };
		} else {
			forward({ type: "tool_execution_start", toolCallId: toolCall.id, toolName: "ask", args: toolCall.arguments, intent: toolCall.intent });
			const picks = [];
			for (const q of ASK_QUESTIONS) {
				const uiId = emitUiRequest({ method: "select", title: q.question, options: q.options.map((o) => o.label), optionDetails: q.options.map((o) => (o.description ? { description: o.description } : {})) });
				const response = await waitForUi(uiId);
				picks.push(`${q.id}: ${response.value ?? "cancelled"}`);
			}
			result = { content: [{ type: "text", text: `User answers:\n${picks.join("\n")}` }], details: { results: [] } };
		}
		const isError = result.details.isError === true;
		forward({ type: "tool_execution_end", toolCallId: toolCall.id, toolName: "ask", result, isError });
		const toolResult = { role: "toolResult", toolCallId: toolCall.id, toolName: "ask", content: result.content, details: result.details, isError, timestamp: Date.now() };
		forward({ type: "message_start", message: toolResult });
		record(toolResult);
		forward({ type: "message_end", message: toolResult });
		return { callMessage, toolResult, text: result.content[0].text };
	}

	async function executePrompt(id, text, images = []) {
		const runMessages = [];
		let status = "completed";
		let error;
		const hostDirectives = parseHostDirectives(text);
		aborted = false;
		// Real omp only echoes the user message once the run starts, which can be a while after the prompt was admitted.
		if (Number(env.FAKE_OMP_PRE_RUN_DELAY_MS) > 0) await sleep(Number(env.FAKE_OMP_PRE_RUN_DELAY_MS));
		forward({ type: "agent_start" });
		if (text === "__auto__") {
			// `auto` thinking: OMP resolves a level per turn and reports it with the configured selector.
			thinkingLevel = "low";
			forward({ type: "thinking_level_changed", thinkingLevel: "low", configured: "auto", resolved: "low" });
		}
		forward({ type: "turn_start" });
		runMessages.push(await userMessageEvents(text, images));
		await pause();

		if (text === "__crash__") {
			await sleep(30);
			process.exit(137);
		}

		let last;
		if (text === "__slow__") {
			last = await streamText(endlessDeltas(), { deltaDelayMs: 40, maxMs: 10_000 });
			runMessages.push(last);
			forward({ type: "turn_end", message: last, toolResults: [] });
			if (last.stopReason === "aborted") status = "aborted";
		} else if (text === "__tool__") {
			const toolCall = { type: "toolCall", id: "call_fake_1", name: "read", arguments: { path: "x" }, intent: "Reading x" };
			const callMessage = (args, stop) =>
				assistantMessage([{ ...toolCall, arguments: args }], stop);
			const initial = assistantMessage([], "toolUse");
			forward({ type: "message_start", message: initial });
			forward({ type: "message_update", message: structuredClone(initial), assistantMessageEvent: { type: "start", partial: structuredClone(initial) } });
			await pause();
			forward({
				type: "message_update",
				message: callMessage({}, "toolUse"),
				assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: callMessage({}, "toolUse") },
			});
			for (const delta of ['{"path":', '"x"}']) {
				await pause();
				forward({
					type: "message_update",
					message: callMessage({}, "toolUse"),
					assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta, partial: callMessage({}, "toolUse") },
				});
			}
			await pause();
			forward({
				type: "message_update",
				message: callMessage(toolCall.arguments, "toolUse"),
				assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall, partial: callMessage(toolCall.arguments, "toolUse") },
			});
			const finalCall = callMessage(toolCall.arguments, "toolUse");
			forward({ type: "message_update", message: finalCall, assistantMessageEvent: { type: "done", reason: "toolUse", message: finalCall } });
			await pause();
			record(finalCall);
			runMessages.push(finalCall);
			forward({ type: "message_end", message: finalCall });
			forward({ type: "tool_execution_start", toolCallId: toolCall.id, toolName: "read", args: toolCall.arguments, intent: "Reading x" });
			await pause();
			forward({
				type: "tool_execution_update",
				toolCallId: toolCall.id,
				toolName: "read",
				args: toolCall.arguments,
				partialResult: { content: [{ type: "text", text: "file" }] },
			});
			await pause();
			const result = { content: [{ type: "text", text: "file body" }] };
			forward({ type: "tool_execution_end", toolCallId: toolCall.id, toolName: "read", result, isError: false });
			const toolResult = {
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: "read",
				content: result.content,
				isError: false,
				timestamp: Date.now(),
			};
			forward({ type: "message_start", message: toolResult });
			record(toolResult);
			runMessages.push(toolResult);
			forward({ type: "message_end", message: toolResult });
			forward({ type: "turn_end", message: finalCall, toolResults: [toolResult] });
			forward({ type: "turn_start" });
			last = await streamText(wordDeltas("FAKE: tool done"));
			runMessages.push(last);
			forward({ type: "turn_end", message: last, toolResults: [] });
		} else if (hostDirectives.items.length > 0) {
			const turn = await hostToolTurn(hostDirectives.items, hostDirectives.parallel, hostDirectives.final, runMessages);
			last = turn.last;
			runMessages.push(last);
			forward({ type: "turn_end", message: last, toolResults: [] });
			if (turn.aborted) status = "aborted";
		} else if (text === "__approve__") {
			const uiId = emitUiRequest({
				method: "select",
				title: "Allow tool: bash\nrm -rf /tmp/fake",
				options: ["Approve", "Approve bash for this session", "Deny"],
			});
			emitUiRequest({ method: "notify", message: "Fake notice", notifyType: "info" });
			emitUiRequest({ method: "setStatus", statusKey: "fake", statusText: "waiting for approval" });
			const response = await waitForUi(uiId);
			const chosen = response.cancelled ? "cancelled" : (response.value ?? String(response.confirmed));
			last = await streamText(wordDeltas(`FAKE: approval ${chosen}`));
			runMessages.push(last);
			forward({ type: "turn_end", message: last, toolResults: [] });
		} else if (text === "__ask__" || text === "__ask_timeout__") {
			const asked = await runAskTool(text === "__ask_timeout__" ? Number(env.FAKE_OMP_ASK_TIMEOUT_MS ?? 400) : 0);
			runMessages.push(asked.callMessage, asked.toolResult);
			forward({ type: "turn_end", message: asked.callMessage, toolResults: [asked.toolResult] });
			forward({ type: "turn_start" });
			last = await streamText(wordDeltas(`FAKE: ${asked.text.replaceAll("\n", " | ")}`));
			runMessages.push(last);
			forward({ type: "turn_end", message: last, toolResults: [] });
		} else if (text === "__subagents__") {
			await Promise.all([startSubagent("Alpha", 0, "call_fake_task", 3), startSubagent("Beta", 1, "call_fake_task")]);
			last = await streamText(wordDeltas("FAKE: team done"));
			runMessages.push(last);
			forward({ type: "turn_end", message: last, toolResults: [] });
		} else if (text === "__big__") {
			const big = assistantMessage([{ type: "text", text: "B".repeat(maxFrameBytes * 3) }], "stop");
			await singleMessage(big);
			last = big;
			runMessages.push(big);
			forward({ type: "turn_end", message: big, toolResults: [] });
		} else if (text === "__error__") {
			const message = assistantMessage([], "error", { errorMessage: "Fake provider failure" });
			await singleMessage(message);
			last = message;
			runMessages.push(message);
			forward({ type: "turn_end", message, toolResults: [] });
			status = "error";
			error = { message: "Fake provider failure", provider: "fake", model: currentModel.id, retryable: false };
		} else {
			last = await streamText(wordDeltas(`FAKE: ${text}`));
			runMessages.push(last);
			forward({ type: "turn_end", message: last, toolResults: [] });
			if (last.stopReason === "aborted") status = "aborted";
		}

		await pause();
		forward({ type: "agent_end", messages: runMessages });
		const settled = queue.length === 0;
		const result = { type: "prompt_result", agentInvoked: true, status, sessionSettled: settled };
		if (id !== undefined) result.id = id;
		if (error) result.error = error;
		emit(result);
		return { settled, slow: text === "__slow__" && status === "aborted" };
	}

	async function runLoop(first) {
		let item = first;
		while (item) {
			run = item;
			const outcome = await executePrompt(item.id, item.message, item.images);
			run = undefined;
			item = queue.shift();
			if (item) {
				emit({ type: "queue_update", steering: [], followUp: queue.map((q) => q.message) });
			} else {
				emit({ type: "session_settled" });
			}
			if (outcome.slow) {
				// Emulate late/duplicate events after the run settled.
				await sleep(30);
				const stale = assistantMessage([{ type: "text", text: "late" }], "stop");
				forward({
					type: "message_update",
					message: stale,
					assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " late", partial: stale },
				});
				forward({ type: "agent_end", messages: [] });
			}
		}
	}

	// --- login ------------------------------------------------------------------------------------------------
	const LOGIN_PROVIDERS = [
		{ id: "fake-oauth", name: "Fake OAuth" },
		{ id: "fake-key", name: "Fake API Key" },
		{ id: "fake-secret", name: "Fake Secret Input" },
		{ id: "fake-fail", name: "Fake Failing Login" },
	];

	async function doLogin(id, providerId) {
		const provider = LOGIN_PROVIDERS.find((p) => p.id === providerId);
		if (!provider) {
			fail(id, "login", `Unknown provider: ${providerId}`);
			return;
		}
		emitUiRequest({
			method: "open_url",
			url: `https://fake.example/oauth/authorize?provider=${providerId}&state=abc`,
			launchUrl: "http://127.0.0.1:1455/launch",
			instructions: "Open the URL and authorize",
		});
		if (providerId === "fake-fail") {
			await sleep(10);
			fail(id, "login", "Login failed: provider rejected the authorization");
			return;
		}
		if (providerId === "fake-secret") {
			emitUiRequest({ method: "input", title: "Paste your secret token", placeholder: "token", secret: true });
			await sleep(10);
			fail(id, "login", "Secret input is not supported over RPC; use the terminal UI to log in");
			return;
		}
		const uiId = emitUiRequest({ method: "input", title: "Paste the authorization code", placeholder: "code" });
		const response = await waitForUi(uiId);
		if (response.cancelled) {
			fail(id, "login", "Login cancelled");
			return;
		}
		authenticated.add(providerId);
		ok(id, "login", { providerId });
	}

	// --- command dispatch -------------------------------------------------------------------------------------
	function invalidFrame() {
		const kind = env.FAKE_OMP_INVALID_FRAME;
		if (kind === "json") writeLine("{this is not json");
		else if (kind === "chunk-gap") writeLine(JSON.stringify({ type: "rpc_chunk", chunkId: "bad", index: 1, count: 3, byteLength: 70000, data: "AAAA" }));
		else if (kind === "oversize") writeLine("a".repeat(maxFrameBytes + 16384));
		else if (kind === "interleave") {
			writeLine(JSON.stringify({ type: "rpc_chunk", chunkId: "x", index: 0, count: 2, byteLength: 8, data: "AAAA" }));
			writeLine(JSON.stringify({ type: "agent_start" }));
		} else writeLine("[1,2,3]");
	}

	function handleCommand(command) {
		const { id, type } = command;
		if (env.FAKE_OMP_INVALID_FRAME && type === (env.FAKE_OMP_INVALID_ON ?? "get_state")) {
			invalidFrame();
			return;
		}
		switch (type) {
			case "negotiate_protocol": {
				if (env.FAKE_OMP_NEGOTIATE_FAIL !== undefined) {
					fail(id, type, "Unsupported RPC protocol version: 2");
					return;
				}
				if (command.protocolVersion !== 2) {
					fail(id, type, `Unsupported RPC protocol version: ${command.protocolVersion}`);
					return;
				}
				ok(id, type, { protocolVersion: 2 });
				protocolVersion = 2;
				return;
			}
			case "set_event_filter": {
				eventFilter = command.events === null || command.events === undefined ? null : new Set(command.events);
				messageUpdates = command.messageUpdates ?? "full";
				ok(id, type, { events: eventFilter ? [...eventFilter] : null, messageUpdates });
				return;
			}
			case "open_session": {
				if (typeof command.sessionDir !== "string" || command.sessionDir.length === 0) {
					fail(id, type, "open_session requires sessionDir");
					return;
				}
				if (command.provider && command.modelId) {
					const found = MODELS.find((m) => m.provider === command.provider && m.id === command.modelId);
					if (!found) {
						fail(id, type, `Model not found: ${command.provider}/${command.modelId}`);
						return;
					}
					currentModel = found;
				}
				const resumed = openSession(command.sessionDir);
				if (resumed === null) {
					// Real omp refuses to resume a conversation recorded in another directory (SESSION_CWD_CHANGE_REJECTED → cancelled).
					ok(id, type, { cancelled: true, resumed: false, sessionId, sessionFile });
					return;
				}
				ok(id, type, { cancelled: false, resumed, sessionId, sessionFile });
				return;
			}
			case "new_session": {
				sessionId = randomUUID();
				messages = [];
				totals = { input: 0, output: 0 };
				persist();
				ok(id, type, { cancelled: false });
				return;
			}
			case "get_state":
				ok(id, type, stateData());
				return;
			case "get_available_thinking_levels":
				ok(id, type, { levels: THINKING_LEVELS });
				return;
			case "set_thinking_level": {
				if (!THINKING_LEVELS.includes(command.level)) {
					fail(id, type, `Invalid thinking level: ${command.level}`);
					return;
				}
				thinkingLevel = command.level;
				ok(id, type);
				return;
			}
			case "set_model": {
				const found = MODELS.find((m) => m.provider === command.provider && m.id === command.modelId);
				if (!found) {
					fail(id, type, `Model not found: ${command.provider}/${command.modelId}`);
					return;
				}
				currentModel = found;
				ok(id, type, found);
				return;
			}
			case "get_available_models":
				ok(id, type, { models: MODELS });
				return;
			case "set_ask_dialog": {
				if (env.FAKE_OMP_NO_ASK_DIALOG !== undefined) {
					fail(id, type, "Unknown command: set_ask_dialog");
					return;
				}
				askDialog = command.enabled === true;
				ok(id, type, { enabled: askDialog });
				return;
			}
			case "set_subagent_subscription": {
				if (!["off", "progress", "events"].includes(command.level)) {
					fail(id, type, `Invalid subagent subscription level: ${command.level}`);
					return;
				}
				subLevel = command.level;
				ok(id, type, { level: subLevel });
				return;
			}
			case "get_subagents": {
				ok(id, type, { subagents: [...subagents.values()].filter((s) => s.status === "running").map((s) => s.snapshot()) });
				return;
			}
			case "get_subagent_messages": {
				const sub = subagents.get(command.subagentId);
				if (!sub) {
					fail(id, type, `Unknown subagent or session file unavailable: ${command.subagentId}`);
					return;
				}
				ok(id, type, readSubagentFile(sub.sessionFile, command.fromByte));
				return;
			}
			case "cancel_subagent": {
				const sub = subagents.get(command.subagentId);
				const cancelled = sub?.status === "running";
				if (cancelled) sub.finish("aborted");
				ok(id, type, { cancelled });
				return;
			}
			case "steer_subagent": {
				const sub = subagents.get(command.subagentId);
				if (sub?.status !== "running") {
					fail(id, type, `Subagent not running: ${command.subagentId}`);
					return;
				}
				sub.steer(command.message);
				ok(id, type);
				return;
			}
			case "set_host_tools": {
				if (!Array.isArray(command.tools)) {
					fail(id, type, "set_host_tools requires a tools array");
					return;
				}
				const normalized = [];
				for (const [index, tool] of command.tools.entries()) {
					const name = typeof tool?.name === "string" ? tool.name.trim() : "";
					if (!name) {
						fail(id, type, `Host tool at index ${index} must provide a non-empty name`);
						return;
					}
					const description = typeof tool.description === "string" ? tool.description.trim() : "";
					if (!description) {
						fail(id, type, `Host tool "${name}" must provide a non-empty description`);
						return;
					}
					if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) {
						fail(id, type, `Host tool "${name}" must provide a JSON Schema object`);
						return;
					}
					normalized.push({ ...tool, name, description });
				}
				const names = normalized.map((tool) => tool.name);
				if (new Set(names).size !== names.length) {
					fail(id, type, "RPC host tool names must be unique");
					return;
				}
				const clash = names.find((name) => BUILTIN_TOOLS.includes(name));
				if (clash !== undefined) {
					fail(id, type, `RPC host tool "${clash}" conflicts with an existing tool`);
					return;
				}
				hostTools = new Map(normalized.map((tool) => [tool.name, tool]));
				log({ kind: "host_tools", names, tools: normalized });
				ok(id, type, { toolNames: names });
				return;
			}
			case "get_messages_page": {
				if (run !== undefined) {
					fail(id, type, "Cannot page messages while the session is changing", "session_busy");
					return;
				}
				const limit = command.limit ?? 100;
				if (!Number.isInteger(limit) || limit < 1 || limit > 256) {
					fail(id, type, "limit must be an integer from 1 through 256");
					return;
				}
				let offset = 0;
				if (command.cursor !== undefined) {
					let payload;
					try {
						payload = JSON.parse(Buffer.from(command.cursor, "base64url").toString("utf8"));
					} catch {
						fail(id, type, "Invalid RPC message cursor");
						return;
					}
					if (payload.sessionId !== sessionId || payload.count !== messages.length) {
						fail(id, type, "RPC message cursor is stale", "stale_cursor");
						return;
					}
					offset = payload.offset;
				}
				const page = messages.slice(offset, offset + limit);
				const data = { messages: page, totalMessages: messages.length };
				if (offset + limit < messages.length) {
					data.nextCursor = Buffer.from(JSON.stringify({ sessionId, count: messages.length, offset: offset + limit }), "utf8").toString("base64url");
				}
				ok(id, type, data);
				return;
			}
			case "get_session_stats":
				ok(id, type, statsData());
				return;
			case "abort": {
				aborted = run !== undefined;
				ok(id, type);
				if (aborted) cancelHostCalls();
				return;
			}
			case "predict_word": {
				const delay = String(command.text ?? "").includes("slow") ? 150 : 0;
				track(sleep(delay).then(() => ok(id, type, { suffix: null })));
				return;
			}
			case "get_login_providers":
				ok(id, type, {
					providers: LOGIN_PROVIDERS.map((p) => ({ ...p, available: true, authenticated: authenticated.has(p.id) })),
				});
				return;
			case "login":
				track(doLogin(id, command.providerId));
				return;
			case "get_logout_accounts": {
				const accounts = authenticated.has(command.providerId)
					? [{ credentialId: 1, provider: command.providerId, label: "fake@example.com", detail: "fake account", type: "oauth", active: true }]
					: [];
				ok(id, type, { accounts });
				return;
			}
			case "logout": {
				authenticated.delete(command.providerId);
				ok(id, type, {});
				return;
			}
			case "prompt": {
				const text = command.message;
				if (typeof text !== "string") {
					fail(id, type, "prompt requires a message string");
					return;
				}
				if (text === "__noack__") return;
				if (run !== undefined) {
					if (command.streamingBehavior !== "steer" && command.streamingBehavior !== "followUp") {
						fail(id, type, "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
						return;
					}
					queue.push({ id, message: text, images: command.images });
					ok(id, type, { agentInvoked: true });
					emit({ type: "queue_update", steering: [], followUp: queue.map((q) => q.message) });
					return;
				}
				// Reserve the slot synchronously so a following prompt is queued, not run concurrently.
				run = { id, message: text, images: command.images };
				ok(id, type, { agentInvoked: true });
				track(runLoop(run));
				return;
			}
			case "handoff": {
				// Like the real command: refused while a response is in progress or when there is nothing to summarise. The document is
				// deterministic: the last user prompts of the journal. FAKE_OMP_HANDOFF=null answers `null` (the user cancelled),
				// FAKE_OMP_HANDOFF=summary-message answers `{}` and leaves the document as a `compactionSummary` message only.
				if (run !== undefined) {
					fail(id, type, "Cannot hand off while a response is in progress");
					return;
				}
				if (messages.length < 2) {
					fail(id, type, "Nothing to hand off (no messages yet)");
					return;
				}
				if (env.FAKE_OMP_HANDOFF === "null") {
					ok(id, type, null);
					return;
				}
				const prompts = messages
					.filter((m) => m.role === "user")
					.slice(-3)
					.map((m) => m.content.filter((b) => b.type === "text").map((b) => b.text).join(" ").replace(/\s+/g, " ").trim().slice(0, 200));
				const document = [
					"# Handoff",
					"",
					`The conversation has ${messages.length} messages. Latest requests:`,
					...prompts.map((p) => `- ${p}`),
					command.customInstructions ? `\nExtra instructions: ${command.customInstructions}` : "",
				]
					.filter((line, i, all) => line !== "" || all[i - 1] !== "")
					.join("\n")
					.trim();
				messages.push({ role: "compactionSummary", summary: document, tokensBefore: contextUsage().tokens, timestamp: Date.now() });
				persist();
				if (env.FAKE_OMP_HANDOFF === "summary-message") {
					ok(id, type, {});
					return;
				}
				const savedPath = join(sessionDir, `handoff-${messages.length}.md`);
				writeFileSync(savedPath, `${document}\n`);
				ok(id, type, { savedPath });
				return;
			}
			default:
				fail(id, type, `Unknown command: ${type}`);
		}
	}

	function handleLine(line) {
		if (line.trim().length === 0) return;
		let parsed;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			log({ kind: "malformed", line });
			emit({ type: "response", command: "parse", success: false, error: `Failed to parse command: ${error.message}` }, true);
			return;
		}
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			log({ kind: "malformed", line });
			emit({ type: "response", command: "parse", success: false, error: "Failed to parse command: expected a JSON object" }, true);
			return;
		}
		log({ kind: "command", frame: parsed });
		if (parsed.type === "extension_ui_response") {
			const waiter = uiWaiters.get(parsed.id);
			if (waiter) {
				uiWaiters.delete(parsed.id);
				waiter(parsed);
			}
			return;
		}
		if (parsed.type === "host_tool_result" || parsed.type === "host_tool_update") {
			handleHostFrame(parsed);
			return;
		}
		handleCommand(parsed);
	}

	// --- lifecycle --------------------------------------------------------------------------------------------
	process.on("SIGTERM", () => {
		if (env.FAKE_OMP_IGNORE_SIGTERM === undefined) process.exit(143);
	});
	if (env.FAKE_OMP_EXIT_AFTER_MS !== undefined) {
		setTimeout(() => process.exit(Number(env.FAKE_OMP_EXIT_AFTER_CODE ?? 1)), Number(env.FAKE_OMP_EXIT_AFTER_MS)).unref();
	}

	let buffered = "";
	const lineQueue = [];
	let ready = false;

	function drainLines() {
		if (!ready) return;
		while (lineQueue.length > 0) handleLine(lineQueue.shift());
	}

	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk) => {
		buffered += chunk;
		let index;
		while ((index = buffered.indexOf("\n")) !== -1) {
			lineQueue.push(buffered.slice(0, index));
			buffered = buffered.slice(index + 1);
		}
		drainLines();
	});
	process.stdin.on("end", () => {
		if (buffered.length > 0) {
			lineQueue.push(buffered);
			buffered = "";
			drainLines();
		}
		if (ignoreStdinClose) return;
		closing = true;
		// Pending UI dialogs are rejected, running work is stopped, accepted work is drained.
		for (const [id, waiter] of uiWaiters) {
			uiWaiters.delete(id);
			waiter({ cancelled: true });
		}
		if (run !== undefined && run.message === "__slow__") aborted = true;
		if (hostCalls.size > 0) {
			aborted = true;
			cancelHostCalls();
		}
		maybeFinish();
	});

	if (readyDelayMs > 0) await sleep(readyDelayMs);
	const supported = env.FAKE_OMP_V1_ONLY !== undefined ? [1] : [1, 2];
	emit({
		type: "ready",
		protocolVersion: 1,
		supportedProtocolVersions: supported,
		maxFrameBytes,
		maxReassembledFrameBytes: MAX_REASSEMBLED_BYTES,
	});
	ready = true;
	drainLines();

	if (ignoreStdinClose) {
		// Keep the event loop alive: a real server wedged on stdin close.
		setInterval(() => {}, 1 << 30);
	}
	return finished;
}
