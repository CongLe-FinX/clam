import { ERROR_CODES, NetworkError } from "./errors.ts";
import { fromBase64Url, toBase64Url } from "./encoding.ts";

/**
 * Server-Sent Events framing for `GET /api/v1/events` (docs/agent-network-protocol.md §8): each
 * frame is `id:` / `event:` / `data:` (one line of JSON) followed by a blank line; `: comment`
 * lines are keepalives.
 */

/** Keepalive frame; sent every 15 s. Consumers treat 45 s of silence as a dead connection. */
export const SSE_KEEPALIVE = ": ping\n\n";

export function encodeSseComment(text: string): string {
	if (/[\r\n]/.test(text)) throw new TypeError("SSE comment must be a single line");
	return `: ${text}\n\n`;
}

export function encodeSseEvent(e: { id: string; event: string; data: unknown }): string {
	if (/[\r\n]/.test(e.id)) throw new TypeError("SSE id must not contain line breaks");
	if (e.event === "" || /[\r\n]/.test(e.event)) throw new TypeError("SSE event name must be a non-empty single line");
	const data = JSON.stringify(e.data === undefined ? null : e.data);
	return `id: ${e.id}\nevent: ${e.event}\ndata: ${data}\n\n`;
}

export interface SseFrame {
	/** The frame's own `id:` field when it carried one. */
	id?: string;
	event: string;
	data: string;
}

const MAX_PENDING = 1 << 20;

/**
 * Incremental parser: feed decoded text in arbitrary chunks (splits may fall mid-line, even between
 * a CR and its LF). Handles LF/CRLF/CR line ends, multi-line `data`, comments, and a leading BOM.
 * A frame is dispatched at its blank line and only if it has `data` (per the SSE specification).
 */
export class SseParser {
	#buffer = "";
	#started = false;
	#event = "";
	#data: string[] = [];
	#id: string | undefined;
	#pendingBytes = 0;

	push(chunk: string): SseFrame[] {
		if (!this.#started && chunk.length > 0) {
			this.#started = true;
			if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
		}
		this.#buffer += chunk;
		const frames: SseFrame[] = [];
		let pos = 0;
		for (;;) {
			let end = -1;
			for (let i = pos; i < this.#buffer.length; i++) {
				const c = this.#buffer.charCodeAt(i);
				if (c === 0x0a || c === 0x0d) {
					end = i;
					break;
				}
			}
			if (end === -1) break;
			let next = end + 1;
			if (this.#buffer.charCodeAt(end) === 0x0d) {
				// A trailing CR may be the first half of CRLF: wait for the next chunk to know.
				if (end + 1 >= this.#buffer.length) break;
				if (this.#buffer.charCodeAt(end + 1) === 0x0a) next = end + 2;
			}
			const frame = this.#line(this.#buffer.slice(pos, end));
			if (frame) frames.push(frame);
			pos = next;
		}
		this.#buffer = this.#buffer.slice(pos);
		if (this.#buffer.length + this.#pendingBytes > MAX_PENDING) {
			throw new NetworkError("SSE frame too large", { code: ERROR_CODES.invalidRequest });
		}
		return frames;
	}

	#line(line: string): SseFrame | null {
		if (line === "") {
			const had = this.#data.length > 0;
			const frame: SseFrame | null = had
				? { event: this.#event === "" ? "message" : this.#event, data: this.#data.join("\n"), ...(this.#id !== undefined ? { id: this.#id } : {}) }
				: null;
			this.#event = "";
			this.#data = [];
			this.#id = undefined;
			this.#pendingBytes = 0;
			return frame;
		}
		if (line.startsWith(":")) return null;
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		this.#pendingBytes += line.length;
		if (field === "event") this.#event = value;
		else if (field === "data") this.#data.push(value);
		else if (field === "id" && !value.includes("\0")) this.#id = value;
		return null;
	}
}

/** Opaque, URL-safe resume cursor: the last `seq` seen per stream (`SSE id:` / `Last-Event-ID`). */
export function encodeCursor(positions: Record<string, number>): string {
	const sorted = Object.fromEntries(Object.entries(positions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
	return toBase64Url(Buffer.from(JSON.stringify(sorted), "utf8"));
}

/** Inverse of {@link encodeCursor}; null for anything that is not a well-formed cursor. */
export function decodeCursor(cursor: string): Record<string, number> | null {
	const bytes = fromBase64Url(cursor);
	if (bytes === null) return null;
	try {
		const parsed: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		const out: Record<string, number> = {};
		for (const [stream, seq] of Object.entries(parsed)) {
			if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) return null;
			out[stream] = seq;
		}
		return out;
	} catch {
		return null;
	}
}
