import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, encodeSseComment, encodeSseEvent, SSE_KEEPALIVE, SseParser, toBase64Url } from "../src/index.ts";

function parseAll(text: string, chunkSize = text.length || 1) {
	const parser = new SseParser();
	const frames = [];
	for (let i = 0; i < text.length; i += chunkSize) frames.push(...parser.push(text.slice(i, i + chunkSize)));
	return frames;
}

describe("encodeSseEvent", () => {
	it("writes id/event/data (one line of JSON) and a blank line", () => {
		const frame = encodeSseEvent({ id: "cur-1", event: "node.event", data: { stream: "node", seq: 1, payload: { a: "x\ny" } } });
		expect(frame).toBe('id: cur-1\nevent: node.event\ndata: {"stream":"node","seq":1,"payload":{"a":"x\\ny"}}\n\n');
		expect(frame.match(/\n/g)?.length).toBe(4);
	});

	it("round-trips through the parser, even with embedded newlines and unicode", () => {
		const data = { text: "line1\nline2\r\nline3 — é 🙂", n: [1, 2, 3] };
		const frames = parseAll(encodeSseEvent({ id: "i", event: "e", data }));
		expect(frames).toHaveLength(1);
		expect(JSON.parse(frames[0]?.data as string)).toEqual(data);
		expect(frames[0]).toMatchObject({ id: "i", event: "e" });
	});

	it("encodes undefined as null and refuses line breaks in id/event", () => {
		expect(encodeSseEvent({ id: "1", event: "e", data: undefined })).toContain("data: null\n");
		expect(() => encodeSseEvent({ id: "a\nb", event: "e", data: 1 })).toThrow();
		expect(() => encodeSseEvent({ id: "a", event: "e\r", data: 1 })).toThrow();
		expect(() => encodeSseEvent({ id: "a", event: "", data: 1 })).toThrow();
	});

	it("comments and the keepalive are single-line comments", () => {
		expect(SSE_KEEPALIVE).toBe(": ping\n\n");
		expect(encodeSseComment("hello")).toBe(": hello\n\n");
		expect(() => encodeSseComment("a\nb")).toThrow();
	});
});

describe("SseParser", () => {
	const stream =
		`: ping\n\nid: 1\nevent: agents_changed\ndata: {"seq":1}\n\n` +
		`: keepalive\n\n` +
		`id: 2\nevent: health\ndata: {"seq":\ndata: 2}\n\n` +
		`data: bare\n\n`;
	const expected = [
		{ id: "1", event: "agents_changed", data: '{"seq":1}' },
		{ id: "2", event: "health", data: '{"seq":\n2}' },
		{ event: "message", data: "bare" },
	];

	it("parses whole streams: comments ignored, multi-line data joined with \\n, default event 'message'", () => {
		expect(parseAll(stream)).toEqual(expected);
	});

	it("is independent of where the chunks split, including mid-line and mid-field", () => {
		for (let size = 1; size <= stream.length; size++) expect(parseAll(stream, size)).toEqual(expected);
	});

	it("handles CRLF and CR line endings, including a CR/LF split across chunks", () => {
		const crlf = stream.replace(/\n/g, "\r\n");
		const cr = stream.replace(/\n/g, "\r");
		expect(parseAll(crlf)).toEqual(expected);
		for (let size = 1; size <= 9; size++) expect(parseAll(crlf, size)).toEqual(expected);
		// A lone trailing CR may be the first half of CRLF, so the last blank line waits for the next byte.
		const parser = new SseParser();
		expect(parser.push(cr)).toEqual(expected.slice(0, 2));
		expect(parser.push("x")).toEqual(expected.slice(2));
		const mixed = new SseParser();
		expect(mixed.push("data: a\r\ndata: b\rdata: c\n\r\n")).toEqual([{ event: "message", data: "a\nb\nc" }]);
	});

	it("never dispatches comments, data-less frames or incomplete frames", () => {
		expect(parseAll(": ping\n\n: ping\n\n")).toEqual([]);
		expect(parseAll("id: 5\nevent: x\n\n")).toEqual([]);
		expect(parseAll('id: 1\nevent: x\ndata: {"a"')).toEqual([]);
		expect(parseAll("data: a\n")).toEqual([]);
	});

	it("keepalives between frames do not disturb parsing and can arrive mid-stream", () => {
		const parser = new SseParser();
		expect(parser.push(SSE_KEEPALIVE + SSE_KEEPALIVE)).toEqual([]);
		expect(parser.push("id: 7\nevent: e\nda")).toEqual([]);
		expect(parser.push("ta: 1\n\n: ping\n")).toEqual([{ id: "7", event: "e", data: "1" }]);
		expect(parser.push("\n")).toEqual([]);
		expect(parser.push("data: 2\n\n")).toEqual([{ event: "message", data: "2" }]);
	});

	it("strips exactly one leading space and a BOM, keeps colons in values, treats a bare field as empty", () => {
		expect(parseAll("\uFEFFdata:  two spaces\n\n")).toEqual([{ event: "message", data: " two spaces" }]);
		expect(parseAll("data:nospace\n\n")).toEqual([{ event: "message", data: "nospace" }]);
		expect(parseAll("data: a:b:c\n\n")).toEqual([{ event: "message", data: "a:b:c" }]);
		expect(parseAll("data\n\n")).toEqual([{ event: "message", data: "" }]);
		expect(parseAll("data: x\nretry: 1000\nunknown: y\n\n")).toEqual([{ event: "message", data: "x" }]);
	});

	it("ignores ids containing NUL and resets state between frames", () => {
		expect(parseAll("id: a\0b\ndata: 1\n\n")).toEqual([{ event: "message", data: "1" }]);
		expect(parseAll("id: 1\nevent: x\ndata: 1\n\ndata: 2\n\n")).toEqual([
			{ id: "1", event: "x", data: "1" },
			{ event: "message", data: "2" },
		]);
	});

	it("refuses unbounded frames", () => {
		const parser = new SseParser();
		expect(() => parser.push(`data: ${"x".repeat(2 * 1024 * 1024)}`)).toThrow();
	});
});

describe("cursor", () => {
	it("round-trips and is url-safe and order independent", () => {
		const cursor = encodeCursor({ "task:b": 3, node: 12, "task:a": 0 });
		expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(cursor).toBe(encodeCursor({ node: 12, "task:a": 0, "task:b": 3 }));
		expect(decodeCursor(cursor)).toEqual({ node: 12, "task:a": 0, "task:b": 3 });
	});

	it("rejects anything that is not a cursor", () => {
		for (const bad of ["", "!!", "bm90LWpzb24", toBase64Url(Buffer.from("[1]")), toBase64Url(Buffer.from('{"a":-1}')), toBase64Url(Buffer.from('{"a":1.5}')), toBase64Url(Buffer.from('{"a":"1"}')), toBase64Url(Buffer.from("null"))]) {
			expect(decodeCursor(bad)).toBeNull();
		}
	});
});
