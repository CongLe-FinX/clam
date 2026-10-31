import { isRecord } from "./frames.ts";

/** Violation of the OMP RPC framing rules (invalid chunk sequence, bad payload). Fatal for the transport. */
export class RpcFrameError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RpcFrameError";
	}
}

/** Largest decoded payload of one chunk accepted (the real server emits 256 KiB payloads; frames are capped at 1 MiB). */
const MAX_CHUNK_PAYLOAD_BYTES = 1024 * 1024;
const MAX_CHUNK_ID_LENGTH = 128;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

interface PendingSequence {
	chunkId: string;
	count: number;
	byteLength: number;
	nextIndex: number;
	chunks: Buffer[];
	receivedBytes: number;
}

function decodeBase64(data: unknown): Buffer {
	if (typeof data !== "string" || data.length === 0 || !BASE64_PATTERN.test(data)) {
		throw new RpcFrameError("invalid rpc chunk data");
	}
	const bytes = Buffer.from(data, "base64");
	if (bytes.toString("base64") !== data) throw new RpcFrameError("invalid rpc chunk data");
	return bytes;
}

/**
 * Reassembles protocol v2 `rpc_chunk` sequences into logical frames, enforcing the validation rules of
 * omp://rpc.md "Transport and Framing". Non-chunk frames pass straight through.
 */
export class RpcFrameDecoder {
	readonly #maxReassembledBytes: number;
	readonly #maxChunkCount: number;
	#pending: PendingSequence | undefined;

	constructor(opts: { maxReassembledBytes: number; maxChunkCount?: number }) {
		this.#maxReassembledBytes = opts.maxReassembledBytes;
		this.#maxChunkCount = opts.maxChunkCount ?? 4096;
	}

	/** True when mid-sequence. */
	get pending(): boolean {
		return this.#pending !== undefined;
	}

	/**
	 * Feed one parsed JSON value. Returns the logical frame when complete (non-chunk frames pass straight through),
	 * `null` while mid-sequence. Throws `RpcFrameError` on any violation; the decoder must then be discarded.
	 */
	push(frame: unknown): object | null {
		if (!isRecord(frame)) {
			throw new RpcFrameError("rpc frame must be a JSON object");
		}
		if (frame.type !== "rpc_chunk") {
			if (this.#pending) throw new RpcFrameError("rpc chunk sequence interrupted by another frame");
			return frame;
		}
		const { chunkId, index, count, byteLength } = frame;
		if (
			typeof chunkId !== "string" ||
			chunkId.length === 0 ||
			chunkId.length > MAX_CHUNK_ID_LENGTH ||
			typeof index !== "number" ||
			typeof count !== "number" ||
			typeof byteLength !== "number" ||
			!Number.isSafeInteger(index) ||
			!Number.isSafeInteger(count) ||
			!Number.isSafeInteger(byteLength) ||
			index < 0 ||
			count < 1 ||
			count > this.#maxChunkCount ||
			index >= count ||
			byteLength < 1
		) {
			throw new RpcFrameError("invalid rpc chunk metadata");
		}
		if (byteLength > this.#maxReassembledBytes) {
			throw new RpcFrameError(`rpc chunk declared length ${byteLength} exceeds the reassembly limit`);
		}
		const bytes = decodeBase64(frame.data);
		if (bytes.byteLength > MAX_CHUNK_PAYLOAD_BYTES) {
			throw new RpcFrameError("rpc chunk payload exceeds the transport limit");
		}

		let pending = this.#pending;
		if (!pending) {
			if (index !== 0) throw new RpcFrameError("rpc chunk sequence must start at index 0");
			pending = { chunkId, count, byteLength, nextIndex: 0, chunks: [], receivedBytes: 0 };
			this.#pending = pending;
		}
		if (pending.chunkId !== chunkId) throw new RpcFrameError("rpc chunk sequence interrupted by another chunkId");
		if (pending.count !== count || pending.byteLength !== byteLength) {
			throw new RpcFrameError("rpc chunk metadata changed mid-sequence");
		}
		if (pending.nextIndex !== index) {
			throw new RpcFrameError(`rpc chunk index ${index} out of order (expected ${pending.nextIndex})`);
		}
		pending.chunks.push(bytes);
		pending.receivedBytes += bytes.byteLength;
		pending.nextIndex++;
		if (pending.receivedBytes > pending.byteLength) {
			throw new RpcFrameError("rpc chunk sequence exceeds declared length");
		}
		if (pending.nextIndex < pending.count) return null;
		if (pending.receivedBytes !== pending.byteLength) {
			throw new RpcFrameError("rpc chunk sequence length mismatch");
		}

		this.#pending = undefined;
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pending.chunks));
		} catch {
			throw new RpcFrameError("rpc chunk payload is not valid UTF-8");
		}
		let logical: unknown;
		try {
			logical = JSON.parse(text);
		} catch {
			throw new RpcFrameError("rpc chunk payload is not valid JSON");
		}
		if (!isRecord(logical)) throw new RpcFrameError("reassembled rpc frame must be a JSON object");
		return logical;
	}
}
