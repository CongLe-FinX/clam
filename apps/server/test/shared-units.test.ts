import type { UiMessage } from "@clam/contracts";
import { describe, expect, it } from "vitest";
import { pageOf } from "../src/shared/store.ts";
import { TranscriptReducer } from "../src/shared/transcript.ts";

const message = (id: string, text = id, role: UiMessage["role"] = "assistant"): UiMessage => ({ id, role, timestamp: 1, content: [{ type: "text", text }] });

describe("TranscriptReducer", () => {
	it("message_start adds a message, message_end replaces it by id and keeps its place", () => {
		const reducer = new TranscriptReducer();
		expect(reducer.apply({ type: "message_start", message: message("a", "") })).toEqual({ changed: ["a"], removed: [] });
		reducer.apply({ type: "message_start", message: message("b", "second") });
		expect(reducer.apply({ type: "message_end", message: message("a", "final") })).toEqual({ changed: ["a"], removed: [] });
		expect(reducer.messages().map((m) => m.id)).toEqual(["a", "b"]);
		expect(reducer.get("a")?.content).toEqual([{ type: "text", text: "final" }]);
		expect(reducer.size).toBe(2);
	});

	it("message_end for an id never started simply appends it", () => {
		const reducer = new TranscriptReducer();
		reducer.apply({ type: "message_end", message: message("x") });
		expect(reducer.messages().map((m) => m.id)).toEqual(["x"]);
	});

	it("ignores start/end events without a message id", () => {
		const reducer = new TranscriptReducer();
		expect(reducer.apply({ type: "message_start" })).toEqual({ changed: [], removed: [] });
		expect(reducer.apply({ type: "message_end", message: { role: "user" } })).toEqual({ changed: [], removed: [] });
		expect(reducer.size).toBe(0);
	});

	it("message_delta grows a text block, creating missing blocks up to the index", () => {
		const reducer = new TranscriptReducer([message("a", "Hel")]);
		expect(reducer.apply({ type: "message_delta", messageId: "a", contentIndex: 0, kind: "text", delta: "lo" })).toEqual({ changed: ["a"], removed: [] });
		expect(reducer.get("a")?.content).toEqual([{ type: "text", text: "Hello" }]);
		reducer.apply({ type: "message_delta", messageId: "a", contentIndex: 1, kind: "text", delta: "!" });
		expect(reducer.get("a")?.content).toEqual([
			{ type: "text", text: "Hello" },
			{ type: "text", text: "!" },
		]);
	});

	it("message_delta grows thinking blocks and keeps their other properties", () => {
		const start: UiMessage = { id: "t", role: "assistant", timestamp: 1, content: [{ type: "thinking", text: "hm", redacted: false }, { type: "text", text: "" }] };
		const reducer = new TranscriptReducer([start]);
		reducer.apply({ type: "message_delta", messageId: "t", contentIndex: 0, kind: "thinking", delta: "mm" });
		reducer.apply({ type: "message_delta", messageId: "t", contentIndex: 1, kind: "text", delta: "answer" });
		expect(reducer.get("t")?.content).toEqual([
			{ type: "thinking", text: "hmmm", redacted: false },
			{ type: "text", text: "answer" },
		]);
		// a thinking delta creates a thinking block when none exists yet
		reducer.apply({ type: "message_delta", messageId: "t", contentIndex: 2, kind: "thinking", delta: "later" });
		expect(reducer.get("t")?.content[2]).toEqual({ type: "thinking", text: "later" });
	});

	it("ignores toolCall deltas (arguments arrive whole with message_end) and deltas of an unknown kind", () => {
		const reducer = new TranscriptReducer([message("a", "x")]);
		expect(reducer.apply({ type: "message_delta", messageId: "a", contentIndex: 1, kind: "toolCall", delta: '{"a":' })).toEqual({ changed: [], removed: [] });
		expect(reducer.apply({ type: "message_delta", messageId: "a", contentIndex: 0, kind: "image", delta: "zz" })).toEqual({ changed: [], removed: [] });
		expect(reducer.get("a")?.content).toEqual([{ type: "text", text: "x" }]);
		const call: UiMessage = { id: "c", role: "assistant", timestamp: 1, content: [{ type: "toolCall", id: "tc", name: "bash", arguments: { command: "ls" } }] };
		reducer.apply({ type: "message_end", message: call });
		// a text delta on an index that holds a tool call does not corrupt it
		expect(reducer.apply({ type: "message_delta", messageId: "c", contentIndex: 0, kind: "text", delta: "oops" })).toEqual({ changed: [], removed: [] });
		expect(reducer.get("c")?.content).toEqual(call.content);
	});

	it("ignores a delta that arrives before its message started, and malformed deltas", () => {
		const reducer = new TranscriptReducer();
		expect(reducer.apply({ type: "message_delta", messageId: "ghost", contentIndex: 0, kind: "text", delta: "x" })).toEqual({ changed: [], removed: [] });
		expect(reducer.size).toBe(0);
		reducer.apply({ type: "message_start", message: message("a", "") });
		for (const bad of [{ contentIndex: -1 }, { contentIndex: 1.5 }, { contentIndex: "0" }, { delta: 3 }, { messageId: 7 }]) {
			expect(reducer.apply({ type: "message_delta", messageId: "a", contentIndex: 0, kind: "text", delta: "x", ...bad })).toEqual({ changed: [], removed: [] });
		}
		expect(reducer.get("a")?.content).toEqual([{ type: "text", text: "" }]);
	});

	it("message_removed drops a message and reports it; a second removal or unknown id is a no-op", () => {
		const reducer = new TranscriptReducer([message("a"), message("b"), message("c")]);
		expect(reducer.apply({ type: "message_removed", messageId: "b" })).toEqual({ changed: [], removed: ["b"] });
		expect(reducer.messages().map((m) => m.id)).toEqual(["a", "c"]);
		expect(reducer.apply({ type: "message_removed", messageId: "b" })).toEqual({ changed: [], removed: [] });
		expect(reducer.apply({ type: "message_removed", messageId: 4 })).toEqual({ changed: [], removed: [] });
		expect(reducer.get("b")).toBeUndefined();
	});

	it("ignores events that are not part of the transcript", () => {
		const reducer = new TranscriptReducer([message("a")]);
		for (const type of ["state", "tool_start", "tool_update", "tool_end", "settled", "agent_start", "notice"]) expect(reducer.apply({ type })).toEqual({ changed: [], removed: [] });
		expect(reducer.size).toBe(1);
	});

	it("replace swaps the whole transcript (duplicates collapse onto the first position, last content wins)", () => {
		const reducer = new TranscriptReducer([message("old")]);
		reducer.replace([message("a", "one"), message("b"), message("a", "two")]);
		expect(reducer.messages().map((m) => [m.id, m.content[0]])).toEqual([
			["a", { type: "text", text: "two" }],
			["b", { type: "text", text: "b" }],
		]);
		expect(reducer.get("old")).toBeUndefined();
		reducer.replace([]);
		expect(reducer.size).toBe(0);
	});

	it("a copy of messages() stays valid while events keep arriving (messages are replaced, not mutated)", () => {
		const reducer = new TranscriptReducer([message("a", "x")]);
		const copy = reducer.messages();
		reducer.apply({ type: "message_delta", messageId: "a", contentIndex: 0, kind: "text", delta: "y" });
		reducer.apply({ type: "message_end", message: message("b") });
		expect(copy).toHaveLength(1);
		expect(copy[0]?.content).toEqual([{ type: "text", text: "x" }]);
	});
});

describe("pageOf", () => {
	const all = Array.from({ length: 10 }, (_, i) => message(`m${i}`));
	const ids = (messages: UiMessage[]): string[] => messages.map((m) => m.id);

	it("serves the newest messages first (oldest-first inside the page) with a cursor for the next older page", () => {
		const first = pageOf(all, { limit: 4 });
		expect(ids(first.messages)).toEqual(["m6", "m7", "m8", "m9"]);
		expect(first).toMatchObject({ total: 10, nextCursor: "4" });
		const second = pageOf(all, { limit: 4, cursor: first.nextCursor as string });
		expect(ids(second.messages)).toEqual(["m2", "m3", "m4", "m5"]);
		expect(second.nextCursor).toBe("8");
		const third = pageOf(all, { limit: 4, cursor: second.nextCursor as string });
		expect(ids(third.messages)).toEqual(["m0", "m1"]);
		expect(third.nextCursor).toBeNull();
	});

	it("nextCursor is null when the page reaches the start exactly", () => {
		expect(pageOf(all, { limit: 10 })).toMatchObject({ nextCursor: null, total: 10 });
		expect(ids(pageOf(all, { limit: 6, cursor: "4" }).messages)).toEqual(["m0", "m1", "m2", "m3", "m4", "m5"]);
		expect(pageOf(all, { limit: 6, cursor: "4" }).nextCursor).toBeNull();
	});

	it("defaults to 50, clamps the limit to 1..256 and treats a missing, malformed or negative cursor as the newest page", () => {
		const long = Array.from({ length: 300 }, (_, i) => message(`n${i}`));
		expect(pageOf(long, {}).messages).toHaveLength(50);
		expect(pageOf(long, { limit: 0 }).messages).toHaveLength(1);
		expect(pageOf(long, { limit: -5 }).messages).toHaveLength(1);
		expect(pageOf(long, { limit: 100_000 }).messages).toHaveLength(256);
		for (const cursor of ["abc", "-3", "1.5", "", "1234567890", "4 "]) expect(ids(pageOf(all, { limit: 2, cursor }).messages), cursor).toEqual(["m8", "m9"]);
		expect(pageOf(long, { limit: 256 }).nextCursor).toBe("256");
	});

	it("a cursor at or beyond the start yields an empty last page; an empty transcript is one empty page", () => {
		expect(pageOf(all, { cursor: "10" })).toEqual({ messages: [], total: 10, nextCursor: null });
		expect(pageOf(all, { cursor: "999" })).toEqual({ messages: [], total: 10, nextCursor: null });
		expect(pageOf([], {})).toEqual({ messages: [], total: 0, nextCursor: null });
	});

	it("walking every page reassembles the transcript without gaps or repeats", () => {
		const collected: string[][] = [];
		let cursor: string | undefined;
		do {
			const page = pageOf(all, { limit: 3, ...(cursor ? { cursor } : {}) });
			collected.unshift(ids(page.messages));
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		expect(collected.flat()).toEqual(ids(all));
	});
});
