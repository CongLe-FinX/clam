import { describe, expect, it } from "vitest";
import { RpcFrameDecoder, RpcFrameError } from "../src/omp/frame-decoder.ts";

interface ChunkFrame {
	type: "rpc_chunk";
	chunkId: string;
	index: number;
	count: number;
	byteLength: number;
	data: string;
}

function toChunks(bytes: Buffer, size: number, chunkId = "rpc-1"): ChunkFrame[] {
	const count = Math.ceil(bytes.length / size);
	return Array.from({ length: count }, (_, index) => ({
		type: "rpc_chunk" as const,
		chunkId,
		index,
		count,
		byteLength: bytes.length,
		data: bytes.subarray(index * size, (index + 1) * size).toString("base64"),
	}));
}

function chunksOf(value: unknown, size: number, chunkId?: string): ChunkFrame[] {
	return toChunks(Buffer.from(JSON.stringify(value), "utf8"), size, chunkId);
}

function decoder(maxReassembledBytes = 1024 * 1024) {
	return new RpcFrameDecoder({ maxReassembledBytes });
}

describe("RpcFrameDecoder", () => {
	it("passes non-chunk frames straight through", () => {
		const d = decoder();
		const frame = { type: "agent_start" };
		expect(d.push(frame)).toBe(frame);
		expect(d.pending).toBe(false);
	});

	it("reassembles a multi-chunk frame", () => {
		const d = decoder();
		const logical = { type: "response", id: "r1", command: "get_messages", success: true, data: { text: "x".repeat(500) } };
		const chunks = chunksOf(logical, 100);
		expect(chunks.length).toBeGreaterThan(3);
		for (const chunk of chunks.slice(0, -1)) {
			expect(d.push(chunk)).toBeNull();
			expect(d.pending).toBe(true);
		}
		expect(d.push(chunks.at(-1))).toEqual(logical);
		expect(d.pending).toBe(false);
	});

	it("reassembles multi-byte UTF-8 split across chunk boundaries", () => {
		const d = decoder();
		const logical = { type: "message_end", text: "héllo 🌍 wörld ✓ 日本語".repeat(20) };
		// 7-byte chunks are guaranteed to cut inside multi-byte sequences.
		const chunks = chunksOf(logical, 7);
		let out: object | null = null;
		for (const chunk of chunks) out = d.push(chunk);
		expect(out).toEqual(logical);
	});

	it("accepts a single-chunk sequence and a following normal frame", () => {
		const d = decoder();
		const logical = { type: "x", n: 1 };
		const [only] = chunksOf(logical, 1000);
		expect(d.push(only)).toEqual(logical);
		expect(d.push({ type: "y" })).toEqual({ type: "y" });
	});

	it("allows consecutive sequences with different chunk ids", () => {
		const d = decoder();
		for (const id of ["a", "b"]) {
			let out: object | null = null;
			for (const chunk of chunksOf({ type: "t", id }, 5, id)) out = d.push(chunk);
			expect(out).toEqual({ type: "t", id });
		}
	});

	const logical = { type: "response", data: "y".repeat(200) };

	it("rejects a sequence that does not start at index 0", () => {
		const d = decoder();
		const chunks = chunksOf(logical, 50);
		expect(() => d.push(chunks[1])).toThrow(RpcFrameError);
	});

	it("rejects an index gap", () => {
		const d = decoder();
		const chunks = chunksOf(logical, 50);
		d.push(chunks[0]);
		expect(() => d.push(chunks[2])).toThrow(RpcFrameError);
	});

	it("rejects a duplicate index", () => {
		const d = decoder();
		const chunks = chunksOf(logical, 50);
		d.push(chunks[0]);
		expect(() => d.push(chunks[0])).toThrow(RpcFrameError);
	});

	it("rejects a count change mid-sequence", () => {
		const d = decoder();
		const chunks = chunksOf(logical, 50);
		d.push(chunks[0]);
		expect(() => d.push({ ...chunks[1], count: (chunks[1]?.count ?? 0) + 1 })).toThrow(RpcFrameError);
	});

	it("rejects a chunkId change mid-sequence", () => {
		const d = decoder();
		const chunks = chunksOf(logical, 50);
		d.push(chunks[0]);
		expect(() => d.push({ ...chunks[1], chunkId: "other" })).toThrow(/chunkId/);
	});

	it("rejects an interleaved non-chunk frame", () => {
		const d = decoder();
		const chunks = chunksOf(logical, 50);
		d.push(chunks[0]);
		expect(() => d.push({ type: "agent_start" })).toThrow(/interrupted/);
	});

	it("rejects a byteLength that does not match the decoded size", () => {
		const d = decoder();
		const chunks = chunksOf(logical, 50).map((c) => ({ ...c, byteLength: c.byteLength + 3 }));
		let thrown: unknown;
		try {
			for (const chunk of chunks) d.push(chunk);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(RpcFrameError);
	});

	it("rejects when chunks carry more bytes than declared", () => {
		const d = decoder();
		const chunks = chunksOf(logical, 50).map((c) => ({ ...c, byteLength: 60 }));
		expect(() => {
			for (const chunk of chunks) d.push(chunk);
		}).toThrow(RpcFrameError);
	});

	it("rejects a declared length over the limit before reading data", () => {
		const d = decoder(1000);
		expect(() =>
			d.push({ type: "rpc_chunk", chunkId: "big", index: 0, count: 2, byteLength: 1001, data: "AAAA" }),
		).toThrow(/reassembly limit/);
		expect(d.pending).toBe(false);
	});

	it("rejects invalid base64", () => {
		const d = decoder();
		for (const data of ["@@@@", "abc", "AAAA=", "", 12, undefined]) {
			expect(() =>
				new RpcFrameDecoder({ maxReassembledBytes: 1000 }).push({ type: "rpc_chunk", chunkId: "c", index: 0, count: 1, byteLength: 3, data }),
			).toThrow(RpcFrameError);
		}
		expect(d.pending).toBe(false);
	});

	it("rejects invalid UTF-8", () => {
		const d = decoder();
		const bytes = Buffer.from([0x7b, 0xff, 0xfe, 0x7d]);
		const [chunk] = toChunks(bytes, 100);
		expect(() => d.push(chunk)).toThrow(/UTF-8/);
	});

	it("rejects non-object JSON payloads", () => {
		for (const value of [[1, 2], 42, "str", null]) {
			const [chunk] = chunksOf(value, 1000);
			expect(() => decoder().push(chunk)).toThrow(RpcFrameError);
		}
	});

	it("rejects payloads that are not JSON", () => {
		const [chunk] = toChunks(Buffer.from("not json"), 100);
		expect(() => decoder().push(chunk)).toThrow(/JSON/);
	});

	it("rejects zero count, negative or fractional metadata", () => {
		const base = { type: "rpc_chunk", chunkId: "c", index: 0, count: 1, byteLength: 3, data: "AAAA" };
		for (const patch of [{ count: 0 }, { index: -1 }, { index: 1.5 }, { count: 2.5 }, { byteLength: 0 }, { chunkId: "" }, { chunkId: 5 }, { index: 1 }]) {
			expect(() => decoder().push({ ...base, ...patch })).toThrow(RpcFrameError);
		}
	});

	it("caps the chunk count", () => {
		const d = new RpcFrameDecoder({ maxReassembledBytes: 1_000_000, maxChunkCount: 4 });
		expect(() => d.push({ type: "rpc_chunk", chunkId: "c", index: 0, count: 5, byteLength: 100, data: "AAAA" })).toThrow(RpcFrameError);
	});

	it("rejects non-object frames", () => {
		for (const value of [null, 1, "x", [1]]) expect(() => decoder().push(value)).toThrow(RpcFrameError);
	});
});
