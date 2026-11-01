import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderI18n, type SessionEvent, type UiMessage } from "@clam/contracts";
import { OmpEventMapper, type OmpFrame } from "../src/omp/index.ts";

interface RawAssistant {
	role: string;
	usage: Record<string, number> & { cost: { total: number } };
}

interface TraceLine {
	dir: "in" | "out";
	t: number;
	frame: OmpFrame & { id?: string; command?: string; data?: unknown };
}

const here = dirname(fileURLToPath(import.meta.url));
const trace: TraceLine[] = readFileSync(join(here, "fixtures", "trace-real.jsonl"), "utf8")
	.trim()
	.split("\n")
	.map((l) => JSON.parse(l) as TraceLine);
const inbound = trace.filter((l) => l.dir === "in").map((l) => l.frame);
const promptOut = trace.find((l) => l.dir === "out" && l.frame.type === "prompt")!.frame as OmpFrame & { id: string; message: string };
const historyPage = inbound.find((f) => f.type === "response" && f.command === "get_messages_page")!.data as { messages: unknown[]; totalMessages: number };

function replay(mapper: OmpEventMapper, frames: OmpFrame[]) {
	const events: SessionEvent[] = [];
	let dirty = 0;
	for (const f of frames) {
		const r = mapper.handleFrame(f);
		events.push(...r.events);
		if (r.stateDirty) dirty++;
	}
	return { events, dirty };
}

function live() {
	const mapper = new OmpEventMapper();
	mapper.registerPrompt(promptOut.id, "client-1", promptOut.message);
	const result = replay(mapper, inbound);
	return { mapper, ...result };
}

function text(m: UiMessage): string {
	return m.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

const assistant = (content: unknown[], extra: Record<string, unknown> = {}) => ({
	role: "assistant",
	content,
	provider: "anthropic",
	model: "m1",
	usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: { total: 0.5 } },
	stopReason: "stop",
	timestamp: 5,
	...extra,
});

describe("real trace replay", () => {
	it("builds the transcript in order with stable ids", () => {
		const { mapper } = live();
		const page = mapper.page({});
		expect(page.total).toBe(4);
		expect(page.nextCursor).toBeNull();
		expect(page.messages.map((m) => [m.id, m.role])).toEqual([
			["m1", "user"],
			["m2", "assistant"],
			["m3", "toolResult"],
			["m4", "assistant"],
		]);
	});

	it("attaches clientId to the echoed user message", () => {
		const { mapper, events } = live();
		const user = mapper.page({}).messages[0]!;
		expect(user.clientId).toBe("client-1");
		expect(text(user)).toBe(promptOut.message);
		const started = events.find((e) => e.type === "message_start");
		expect(started && started.type === "message_start" && started.message.clientId).toBe("client-1");
	});

	it("keeps toolCall id/name/arguments/intent", () => {
		const { mapper } = live();
		const block = mapper.page({}).messages[1]!.content[0]!;
		expect(block).toEqual({
			type: "toolCall",
			id: expect.stringMatching(/^toolu_/),
			name: "read",
			arguments: { path: "hello.txt", i: "Reading hello.txt" },
			intent: "Reading hello.txt",
		});
	});

	it("maps the tool result message and tool_* events", () => {
		const { mapper, events } = live();
		const toolResult = mapper.page({}).messages[2]!;
		expect(toolResult).toMatchObject({ role: "toolResult", toolName: "read", isError: false });
		expect(text(toolResult)).toContain("hello");
		const start = events.find((e) => e.type === "tool_start");
		const end = events.find((e) => e.type === "tool_end");
		expect(start).toMatchObject({ type: "tool_start", toolName: "read", args: { path: "hello.txt" }, intent: "Reading hello.txt" });
		expect(end).toMatchObject({ type: "tool_end", isError: false, result: text(toolResult) });
	});

	it("streams deltas that add up to the final assistant text", () => {
		const { mapper, events } = live();
		const final = mapper.page({}).messages[3]!;
		expect(text(final)).toBe("OK");
		const textDeltas = events.filter((e) => e.type === "message_delta" && e.kind === "text");
		expect(textDeltas).toEqual([{ type: "message_delta", messageId: "m4", contentIndex: 0, kind: "text", delta: "OK" }]);
		const toolDeltas = events.filter((e) => e.type === "message_delta" && e.kind === "toolCall");
		expect(toolDeltas.map((e) => (e.type === "message_delta" ? e.delta : "")).join("")).toBe('{"path": "hello.txt", "i": "Reading hello.txt"}');
		expect(final).toMatchObject({ provider: "anthropic", stopReason: "stop" });
	});

	it("emits agent/prompt/settled events and marks state dirty", () => {
		const { events, dirty } = live();
		expect(events.filter((e) => ["agent_start", "agent_end", "settled"].includes(e.type)).map((e) => e.type)).toEqual(["agent_start", "agent_end", "settled"]);
		expect(events).toContainEqual({ type: "prompt_result", promptId: promptOut.id, clientId: "client-1", status: "completed" });
		expect(dirty).toBeGreaterThanOrEqual(3);
	});

	it("message_end events carry the authoritative message", () => {
		const { events } = live();
		const ends = events.filter((e): e is Extract<SessionEvent, { type: "message_end" }> => e.type === "message_end");
		expect(ends.map((e) => e.message.id)).toEqual(["m1", "m2", "m3", "m4"]);
		expect(ends[1]!.message.content[0]).toMatchObject({ type: "toolCall", name: "read", intent: "Reading hello.txt" });
	});

	it("takeUsage totals equal the assistant message usage, then clear", () => {
		const { mapper } = live();
		const raw = (historyPage.messages as RawAssistant[]).filter((m) => m.role === "assistant");
		const sum = (k: string) => raw.reduce((a, m) => a + (m.usage[k] ?? 0), 0);
		const usage = mapper.takeUsage();
		expect(usage).toHaveLength(1);
		expect(usage[0]).toMatchObject({ provider: "anthropic", model: "claude-opus-5-5" });
		expect(usage[0]!.tokens).toEqual({
			input: sum("input"),
			output: sum("output"),
			cacheRead: sum("cacheRead"),
			cacheWrite: sum("cacheWrite"),
			total: sum("totalTokens"),
		});
		expect(usage[0]!.cost).toBeCloseTo(raw.reduce((a, m) => a + m.usage.cost.total, 0), 9);
		expect(mapper.takeUsage()).toEqual([]);
	});

	it("history loaded from get_messages_page equals the live transcript", () => {
		const hist = new OmpEventMapper();
		hist.loadHistory(historyPage.messages);
		expect(hist.messageCount).toBe(historyPage.totalMessages);
		const strip = (ms: UiMessage[]) => ms.map(({ clientId: _c, ...rest }) => rest);
		expect(strip(hist.page({}).messages)).toEqual(strip(live().mapper.page({}).messages));
		expect(hist.takeUsage()).toEqual([]);
	});

	it("pages newest first with cursors", () => {
		const { mapper } = live();
		const p1 = mapper.page({ limit: 3 });
		expect(p1.messages.map((m) => m.id)).toEqual(["m2", "m3", "m4"]);
		expect(p1.nextCursor).not.toBeNull();
		const p2 = mapper.page({ limit: 3, cursor: p1.nextCursor! });
		expect(p2.messages.map((m) => m.id)).toEqual(["m1"]);
		expect(p2.nextCursor).toBeNull();
		expect(p2.total).toBe(4);
	});

	it("never throws on garbage frames", () => {
		const mapper = new OmpEventMapper();
		const garbage: unknown[] = [
			null,
			42,
			"x",
			{},
			{ type: 5 },
			{ type: "message_start" },
			{ type: "message_start", message: 3 },
			{ type: "message_update" },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: "a" } },
			{ type: "message_end", message: "nope" },
			{ type: "tool_execution_start" },
			{ type: "tool_execution_end", toolCallId: 1 },
			{ type: "prompt_result" },
			{ type: "extension_ui_request", method: "select" },
			{ type: "extension_ui_request", id: "x", method: "ask", questions: "bad" },
			{ type: "notice" },
			{ type: "unknown_future_frame", a: 1 },
			{ type: "subagent_event" },
			{ type: "available_commands_update", commands: [] },
		];
		for (const g of garbage) expect(() => mapper.handleFrame(g as OmpFrame)).not.toThrow();
		expect(mapper.messageCount).toBe(0);
	});
});

describe("hand-built streams", () => {
	it("handles the full (non-delta) projection by diffing snapshots", () => {
		const m = new OmpEventMapper();
		const a = (content: unknown[]) => ({ type: "message_update", message: assistant(content), assistantMessageEvent: { type: "text_delta" } });
		const { events } = replay(m, [
			{ type: "message_start", message: assistant([]), messageId: "x1" },
			a([{ type: "text", text: "He" }]),
			a([{ type: "text", text: "Hello" }]),
			a([{ type: "text", text: "Hello" }, { type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } }]),
			{ type: "message_end", message: assistant([{ type: "text", text: "Hello" }]), messageId: "x1" },
		]);
		const deltas = events.filter((e) => e.type === "message_delta");
		expect(deltas.map((e) => (e.type === "message_delta" ? [e.contentIndex, e.kind, e.delta] : null))).toEqual([
			[0, "text", "He"],
			[0, "text", "llo"],
			[1, "toolCall", '{"path":"a"}'],
		]);
		expect(text(m.page({}).messages[0]!)).toBe("Hello");
		expect(m.page({}).messages[0]!.content).toHaveLength(1);
	});

	it("ignores late updates after message_end and agent_end, and duplicate message_end", () => {
		const m = new OmpEventMapper();
		const delta = (id: string) => ({ type: "message_update", message: { role: "assistant" }, messageId: id, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "zz" } });
		const end = { type: "message_end", message: assistant([{ type: "text", text: "A" }]), messageId: "x1" };
		const { events } = replay(m, [
			{ type: "message_start", message: assistant([]), messageId: "x1" },
			delta("x1"),
			end,
			delta("x1"),
			end,
			{ type: "agent_end", messages: [] },
			delta("x1"),
			{ type: "agent_end", messages: [] },
		]);
		expect(events.filter((e) => e.type === "message_end")).toHaveLength(1);
		expect(events.filter((e) => e.type === "message_delta")).toHaveLength(1);
		expect(events.filter((e) => e.type === "agent_end")).toHaveLength(2);
		expect(m.messageCount).toBe(1);
		expect(text(m.page({}).messages[0]!)).toBe("A");
	});

	it("closes a message left open by agent_end", () => {
		const m = new OmpEventMapper();
		const { events } = replay(m, [
			{ type: "message_start", message: assistant([]), messageId: "x1" },
			{ type: "message_update", message: { role: "assistant" }, messageId: "x1", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial" } },
			{ type: "agent_end", messages: [] },
		]);
		expect(events.map((e) => e.type)).toEqual(["message_start", "message_delta", "message_end", "agent_end"]);
		const end = events[2] as Extract<SessionEvent, { type: "message_end" }>;
		expect(text(end.message)).toBe("partial");
	});

	it("creates blocks defensively and keeps wire indexes aligned", () => {
		const m = new OmpEventMapper();
		replay(m, [
			{ type: "message_start", message: assistant([]), messageId: "x1" },
			{ type: "message_update", messageId: "x1", message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "hmm" } },
		]);
		const msg = m.page({}).messages[0]!;
		expect(msg.content).toEqual([
			{ type: "text", text: "" },
			{ type: "thinking", text: "hmm" },
		]);
	});

	it("approval select request resolves via cancel or markUiResolved", () => {
		const m = new OmpEventMapper();
		const req = { type: "extension_ui_request", id: "u1", method: "select", title: "Allow bash?", options: ["Allow", "Deny"] };
		const r1 = m.handleFrame(req);
		expect(r1.events).toEqual([{ type: "ui_request", requestId: "u1", method: "select", title: "Allow bash?", options: ["Allow", "Deny"] }]);
		expect(m.pendingUiRequests()).toHaveLength(1);
		const r2 = m.handleFrame({ type: "extension_ui_request", id: "c1", method: "cancel", targetId: "u1" });
		expect(r2.events).toEqual([{ type: "ui_request_resolved", requestId: "u1", outcome: "cancelled" }]);
		expect(m.pendingUiRequests()).toHaveLength(0);
		expect(m.handleFrame({ type: "extension_ui_request", id: "c2", method: "cancel", targetId: "u1" }).events).toEqual([]);

		m.handleFrame({ type: "extension_ui_request", id: "u2", method: "confirm", title: "Sure?", message: "really" });
		expect(m.markUiResolved("u2")).toEqual({ type: "ui_request_resolved", requestId: "u2", outcome: "answered" });
		expect(m.markUiResolved("u2")).toBeNull();
	});

	it("maps input, ask, notify and ignores presentation methods", () => {
		const m = new OmpEventMapper();
		expect(m.handleFrame({ type: "extension_ui_request", id: "i", method: "input", title: "Name", placeholder: "your name" }).events).toEqual([
			{ type: "ui_request", requestId: "i", method: "input", title: "Name", message: "your name" },
		]);
		const ask = m.handleFrame({
			type: "extension_ui_request",
			id: "a",
			method: "ask",
			questions: [
				{ id: "q1", question: "Which?", header: "Pick", options: [{ label: "A" }, { label: "B" }] },
				{ id: "q2", question: "Why?", options: [] },
			],
		});
		expect(ask.events).toEqual([
			{
				type: "ui_request",
				requestId: "a",
				method: "ask",
				title: "Pick",
				message: "Which?\nWhy?",
				questions: [
					{ id: "q1", question: "Which?", header: "Pick", options: [{ label: "A" }, { label: "B" }] },
					{ id: "q2", question: "Why?", options: [] },
				],
			},
		]);
		expect(m.handleFrame({ type: "extension_ui_request", id: "n", method: "notify", message: "hi", notifyType: "warning" }).events).toEqual([
			{ type: "notice", level: "warning", message: "hi" },
		]);
		for (const method of ["setStatus", "setWidget", "setTitle", "set_editor_text", "open_url"]) {
			expect(m.handleFrame({ type: "extension_ui_request", id: "z", method }).events).toEqual([]);
		}
	});

	it("maps notice, rpc_frame_error and extension_error", () => {
		const m = new OmpEventMapper();
		expect(m.handleFrame({ type: "notice", level: "error", message: "boom", source: "x" }).events).toEqual([{ type: "notice", level: "error", message: "boom" }]);
		expect(m.handleFrame({ type: "rpc_frame_error", error: "too big" }).events).toMatchObject([{ type: "notice", level: "warning" }]);
		expect(m.handleFrame({ type: "extension_error", event: "tool_call", error: "bad" }).events).toMatchObject([{ type: "notice", level: "warning" }]);
	});

	it("notices that are our own text carry an i18n twin that renders to the message; OMP's own notice text does not", () => {
		const m = new OmpEventMapper();
		const ours = [
			m.handleFrame({ type: "rpc_frame_error", error: "too big" }).events[0],
			m.handleFrame({ type: "extension_error", event: "tool_call", error: "bad" }).events[0],
			m.handleFrame({ type: "extension_error", error: "bad" }).events[0],
			m.handleFrame({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage: "overloaded" }).events[0],
			m.handleFrame({ type: "auto_compaction_end", errorMessage: "too long" }).events[0],
		];
		for (const e of ours) {
			if (e?.type !== "notice") throw new Error(`expected a notice, got ${JSON.stringify(e)}`);
			expect(e.i18n, e.message).toBeDefined();
			expect(renderI18n(e.i18n!.key, e.i18n!.params)).toBe(e.message);
		}
		expect(m.handleFrame({ type: "notice", level: "error", message: "boom" }).events[0]).not.toHaveProperty("i18n");
	});

	it("state-dirty frames and ignored frames", () => {
		const m = new OmpEventMapper();
		for (const type of ["queue_update", "goal_updated", "auto_compaction_start", "manual_compaction_end", "model_changed", "thinking_level_changed", "todo_auto_clear"]) {
			expect(m.handleFrame({ type })).toEqual({ events: [], stateDirty: true });
		}
		for (const type of ["available_commands_update", "config_update", "session_info_update", "advisor_cost_changed", "subagent_start", "live_x", "btw_x", "dictation_x", "command_output"]) {
			expect(m.handleFrame({ type })).toEqual({ events: [], stateDirty: false });
		}
		expect(m.handleFrame({ type: "tool_execution_end", toolCallId: "t", toolName: "todo", result: {} }).stateDirty).toBe(true);
	});

	it("prompt_result for unknown ids is dropped; known maps status and error", () => {
		const m = new OmpEventMapper();
		expect(m.handleFrame({ type: "prompt_result", id: "nope", status: "completed" })).toEqual({ events: [], stateDirty: false });
		m.registerPrompt("p1", "c1", "hi");
		expect(m.handleFrame({ type: "prompt_result", id: "p1", status: "error", error: "bad key" })).toEqual({
			events: [{ type: "prompt_result", promptId: "p1", clientId: "c1", status: "error", error: "bad key" }],
			stateDirty: true,
		});
	});

	it("matches queued user echoes FIFO by text", () => {
		const m = new OmpEventMapper();
		m.registerPrompt("p1", "c1", "first");
		m.registerPrompt("p2", "c2", "second");
		const user = (t: string, id: string) => ({ type: "message_start", messageId: id, message: { role: "user", content: [{ type: "text", text: t }], timestamp: 1 } });
		replay(m, [user("second", "a"), user("first", "b"), user("other", "c")]);
		expect(m.page({}).messages.map((x) => x.clientId)).toEqual(["c2", "c1", undefined]);
	});

	it("tool_update previews are bounded; stream updates map too", () => {
		const m = new OmpEventMapper();
		const big = "x".repeat(10_000);
		const r = m.handleFrame({ type: "tool_execution_update", toolCallId: "t", toolName: "bash", args: {}, partialResult: { content: [{ type: "text", text: big }] } });
		const ev = r.events[0] as Extract<SessionEvent, { type: "tool_update" }>;
		expect(ev.preview.length).toBeLessThan(5000);
		expect(m.handleFrame({ type: "tool_stream_update", toolCallId: "t", toolName: "edit", update: { diff: "d" } }).events).toEqual([
			{ type: "tool_update", toolCallId: "t", preview: '{"diff":"d"}' },
		]);
	});

	it("converts redacted thinking, unknown blocks, narration and images", () => {
		const m = new OmpEventMapper();
		m.loadHistory([
			assistant([
				{ type: "redactedThinking", data: "zzz" },
				{ type: "anthropicServerTool", block: {} },
				{ type: "fallback", from: {}, to: {} },
				{ type: "thinking", thinking: "talk", narration: true },
				{ type: "thinking", thinking: "deep", thinkingSignature: "s" },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
				{ type: "toolCall", id: "t", name: "n", arguments: { a: 1 }, intent: "i" },
			]),
		]);
		expect(m.page({}).messages[0]!.content).toEqual([
			{ type: "thinking", text: "", redacted: true },
			{ type: "text", text: "talk" },
			{ type: "thinking", text: "deep" },
			{ type: "image", mimeType: "image/png", data: "AAAA" },
			{ type: "toolCall", id: "t", name: "n", arguments: { a: 1 }, intent: "i" },
		]);
		expect(m.page({}).messages[0]!.usage).toEqual({ tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 }, cost: 0.5 });
	});

	it("converts custom-family history messages and skips hidden ones", () => {
		const m = new OmpEventMapper();
		m.loadHistory([
			{ role: "developer", content: "secret", timestamp: 1 },
			{ role: "custom", customType: "note", content: "hello", display: false, timestamp: 1 },
			{ role: "custom", customType: "note", content: "shown", display: true, timestamp: 2 },
			{ role: "hookMessage", customType: "hook", content: [{ type: "text", text: "h" }], display: true, timestamp: 3 },
			{ role: "bashExecution", command: "ls", output: "a\nb", cancelled: false, truncated: false, exitCode: 0, timestamp: 4 },
			{ role: "pythonExecution", code: "1+1", output: "2", cancelled: false, truncated: false, timestamp: 5 },
			{ role: "branchSummary", summary: "branch", fromId: "x", timestamp: 6 },
			{ role: "compactionSummary", summary: "compacted", tokensBefore: 10, timestamp: 7 },
			{ role: "fileMention", files: [{ path: "a.ts", content: "", lineCount: 3 }], timestamp: 8 },
			{ role: "weird" },
			null,
		]);
		const msgs = m.page({}).messages;
		expect(msgs.map((x) => [x.id, x.role, x.customType])).toEqual([
			["m1", "custom", "note"],
			["m2", "custom", "hook"],
			["m3", "custom", "bashExecution"],
			["m4", "custom", "pythonExecution"],
			["m5", "custom", "branchSummary"],
			["m6", "custom", "compactionSummary"],
			["m7", "custom", "fileMention"],
		]);
		expect(text(msgs[0]!)).toBe("shown");
		expect(text(msgs[2]!)).toBe("$ ls\na\nb\n[exit 0]");
		expect(text(msgs[5]!)).toBe("compacted");
		expect(text(msgs[6]!)).toBe("a.ts (3 lines)");
	});

	it("hidden live messages produce no events", () => {
		const m = new OmpEventMapper();
		const { events } = replay(m, [
			{ type: "message_start", messageId: "h", message: { role: "developer", content: "x", timestamp: 1 } },
			{ type: "message_end", messageId: "h", message: { role: "developer", content: "x", timestamp: 1 } },
		]);
		expect(events).toEqual([]);
		expect(m.messageCount).toBe(0);
	});

	it("includes the in-flight message in page() as a snapshot", () => {
		const m = new OmpEventMapper();
		replay(m, [
			{ type: "message_start", messageId: "x", message: assistant([]) },
			{ type: "message_update", messageId: "x", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "so far" } },
		]);
		const page = m.page({});
		expect(text(page.messages[0]!)).toBe("so far");
		m.handleFrame({ type: "message_update", messageId: "x", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "!" } });
		expect(text(page.messages[0]!)).toBe("so far");
	});

	it("nests external messages inside a streaming reply by messageId", () => {
		const m = new OmpEventMapper();
		const { events } = replay(m, [
			{ type: "message_start", messageId: "a", message: assistant([]) },
			{ type: "message_start", messageId: "n", message: { role: "custom", customType: "card", content: "c", display: true, timestamp: 1 } },
			{ type: "message_end", messageId: "n", message: { role: "custom", customType: "card", content: "c", display: true, timestamp: 1 } },
			{ type: "message_update", messageId: "a", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" } },
			{ type: "message_end", messageId: "a", message: assistant([{ type: "text", text: "x" }]) },
		]);
		expect(events.filter((e) => e.type === "message_delta")).toMatchObject([{ messageId: "m1" }]);
		expect(m.page({}).messages.map((x) => x.role)).toEqual(["assistant", "custom"]);
	});

	it("reset clears transcript, counters and pending requests", () => {
		const { mapper } = live();
		mapper.handleFrame({ type: "extension_ui_request", id: "u", method: "confirm", title: "t", message: "m" });
		mapper.reset();
		expect(mapper.messageCount).toBe(0);
		expect(mapper.pendingUiRequests()).toEqual([]);
		mapper.loadHistory([{ role: "user", content: "again", timestamp: 1 }]);
		expect(mapper.page({}).messages[0]!.id).toBe("m1");
	});
});

describe("page cursors", () => {
	function filled(n: number) {
		const m = new OmpEventMapper();
		m.loadHistory(Array.from({ length: n }, (_, i) => ({ role: "user", content: `u${i}`, timestamp: i })));
		return m;
	}

	it("returns an empty page for an empty transcript", () => {
		expect(new OmpEventMapper().page({})).toEqual({ messages: [], total: 0, nextCursor: null });
	});

	it("walks every message exactly once, newest page first", () => {
		const m = filled(10);
		const seen: string[] = [];
		let cursor: string | undefined;
		for (let guard = 0; guard < 10; guard++) {
			const p = m.page({ limit: 4, ...(cursor ? { cursor } : {}) });
			seen.unshift(...p.messages.map((x) => x.id));
			if (!p.nextCursor) break;
			cursor = p.nextCursor;
		}
		expect(seen).toEqual(Array.from({ length: 10 }, (_, i) => `m${i + 1}`));
	});

	it("clamps limit to 1..256 and treats garbage as the default", () => {
		const m = filled(300);
		expect(m.page({ limit: 0 }).messages).toHaveLength(50);
		expect(m.page({ limit: -5 }).messages).toHaveLength(1);
		expect(m.page({ limit: 10_000 }).messages).toHaveLength(256);
		expect(m.page({ limit: 1 }).messages.map((x) => x.id)).toEqual(["m300"]);
		expect(m.page({ limit: Number.NaN }).messages).toHaveLength(50);
	});

	it("treats invalid cursors as the newest page", () => {
		const m = filled(5);
		const newest = m.page({ limit: 2 });
		expect(m.page({ limit: 2, cursor: "!!!" })).toEqual(newest);
		expect(m.page({ limit: 2, cursor: Buffer.from("u999").toString("base64url") })).toEqual(newest);
		expect(m.page({ limit: 2, cursor: Buffer.from("junk").toString("base64url") })).toEqual(newest);
	});

	it("cursor stays valid while the transcript grows", () => {
		const m = filled(6);
		const p1 = m.page({ limit: 2 });
		m.loadHistory([{ role: "user", content: "late", timestamp: 99 }]);
		const p2 = m.page({ limit: 2, cursor: p1.nextCursor! });
		expect(p2.messages.map((x) => x.id)).toEqual(["m3", "m4"]);
	});
});

describe("pending prompt message (shown before OMP echoes it)", () => {
	const userFrame = (type: "message_start" | "message_end", messageId: string, content: string, extra: Record<string, unknown> = {}): OmpFrame => ({
		type,
		messageId,
		message: { role: "user", content, timestamp: 1234, ...extra },
	});
	const roles = (mapper: OmpEventMapper) => mapper.page({}).messages.map((m) => `${m.id}:${m.role}`);

	it("is served by page() and published immediately with the prompt's clientId", () => {
		const mapper = new OmpEventMapper();
		const events = mapper.registerPrompt("p1", "init_ses1", "hello there", { showPending: true });
		expect(events.map((e) => e.type)).toEqual(["message_start", "message_end"]);
		expect(events[0]).toMatchObject({ message: { id: "m1", role: "user", clientId: "init_ses1", content: [{ type: "text", text: "hello there" }] } });
		expect(events[1]).toMatchObject({ message: { id: "m1", clientId: "init_ses1" } });
		const page = mapper.page({});
		expect(page.total).toBe(1);
		expect(page.messages[0]).toMatchObject({ id: "m1", role: "user", clientId: "init_ses1" });
	});

	it("folds OMP's echo into the same message id: no duplicate, authoritative content, later messages continue the ids", () => {
		const mapper = new OmpEventMapper();
		mapper.registerPrompt("p1", "c1", "hello there", { showPending: true });
		const start = mapper.handleFrame(userFrame("message_start", "msg-1", "hello there"));
		expect(start.events).toEqual([]); // already published when the prompt was admitted
		const end = mapper.handleFrame(userFrame("message_end", "msg-1", "hello there"));
		expect(end.events).toHaveLength(1);
		expect(end.events[0]).toMatchObject({ type: "message_end", message: { id: "m1", clientId: "c1", timestamp: 1234 } });
		expect(roles(mapper)).toEqual(["m1:user"]);
		const next = mapper.handleFrame({ type: "message_start", messageId: "msg-2", message: assistant([]) });
		expect(next.events[0]).toMatchObject({ message: { id: "m2", role: "assistant" } });
		expect(roles(mapper)).toEqual(["m1:user", "m2:assistant"]);
		const result = mapper.handleFrame({ type: "prompt_result", id: "p1", agentInvoked: true, status: "completed", sessionSettled: true });
		expect(result.events).toEqual([{ type: "prompt_result", promptId: "p1", clientId: "c1", status: "completed" }]);
		expect(roles(mapper)).toEqual(["m1:user", "m2:assistant"]); // a finished prompt keeps its message
	});

	it("matches an echo whose text OMP rewrote to the oldest pending prompt, but never an agent-authored message", () => {
		const mapper = new OmpEventMapper();
		mapper.registerPrompt("p1", "c1", "review ^fast the diff", { showPending: true });
		const injected = mapper.handleFrame(userFrame("message_start", "msg-1", "[goal continuation]", { attribution: "agent" }));
		expect(injected.events[0]).toMatchObject({ message: { id: "m2", role: "user" } });
		expect(injected.events[0]).not.toMatchObject({ message: { clientId: "c1" } });
		mapper.handleFrame(userFrame("message_end", "msg-1", "[goal continuation]", { attribution: "agent" }));
		const echo = mapper.handleFrame(userFrame("message_start", "msg-2", "review the diff (fast model)"));
		expect(echo.events).toEqual([]);
		const end = mapper.handleFrame(userFrame("message_end", "msg-2", "review the diff (fast model)"));
		expect(end.events[0]).toMatchObject({ message: { id: "m1", clientId: "c1", content: [{ type: "text", text: "review the diff (fast model)" }] } });
		expect(roles(mapper)).toEqual(["m1:user", "m2:user"]);
	});

	it("withdraws the message when the prompt fails or is aborted before any echo, then reports the outcome", () => {
		const mapper = new OmpEventMapper();
		mapper.registerPrompt("p1", "c1", "doomed", { showPending: true });
		mapper.registerPrompt("p2", "c2", "dropped", { showPending: true });
		expect(roles(mapper)).toEqual(["m1:user", "m2:user"]);
		const rejected = mapper.failPrompt("p1", "error", "Model not found");
		expect(rejected).toEqual([
			{ type: "message_removed", messageId: "m1" },
			{ type: "prompt_result", promptId: "p1", clientId: "c1", status: "error", error: "Model not found" },
		]);
		const aborted = mapper.handleFrame({ type: "prompt_result", id: "p2", agentInvoked: true, status: "aborted", sessionSettled: true });
		expect(aborted.events).toEqual([
			{ type: "message_removed", messageId: "m2" },
			{ type: "prompt_result", promptId: "p2", clientId: "c2", status: "aborted" },
		]);
		expect(mapper.page({}).total).toBe(0);
		expect(mapper.failPrompt("p1", "error")).toEqual([]); // unknown now
	});

	it("keeps the message when a prompt that already ran ends aborted or with an error, and reads OMP's error object", () => {
		const mapper = new OmpEventMapper();
		mapper.registerPrompt("p1", "c1", "ran", { showPending: true });
		mapper.handleFrame(userFrame("message_start", "msg-1", "ran"));
		mapper.handleFrame(userFrame("message_end", "msg-1", "ran"));
		const result = mapper.handleFrame({ type: "prompt_result", id: "p1", agentInvoked: true, status: "error", error: { message: "429 rate limited", retryable: true }, sessionSettled: true });
		expect(result.events).toEqual([{ type: "prompt_result", promptId: "p1", clientId: "c1", status: "error", error: "429 rate limited" }]);
		expect(roles(mapper)).toEqual(["m1:user"]);
	});

	it("shows nothing extra for prompts that are not pending (queued behind a run) or finish locally", () => {
		const mapper = new OmpEventMapper();
		expect(mapper.registerPrompt("p1", "c1", "queued follow-up")).toEqual([]);
		expect(mapper.page({}).total).toBe(0);
		const echo = mapper.handleFrame(userFrame("message_start", "msg-1", "queued follow-up"));
		expect(echo.events[0]).toMatchObject({ type: "message_start", message: { id: "m1", clientId: "c1" } }); // unchanged behaviour
		expect(mapper.completePrompt("p1")).toEqual([{ type: "prompt_result", promptId: "p1", clientId: "c1", status: "completed" }]);
		expect(mapper.completePrompt("p1")).toEqual([]);
	});

	it("drops the pending message with the rest of the transcript on reset", () => {
		const mapper = new OmpEventMapper();
		mapper.registerPrompt("p1", "c1", "x", { showPending: true });
		mapper.reset();
		expect(mapper.page({}).total).toBe(0);
		expect(mapper.failPrompt("p1", "error")).toEqual([]);
	});
});
