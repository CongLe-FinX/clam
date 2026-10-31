const BLOCK_BYTES = 64 * 1024;
/** How far into a truncated scrollback we look for a clean place to start the replay. */
const ALIGN_WINDOW = 4096;

interface Block {
	buf: Buffer;
	start: number;
	end: number;
}

/**
 * Byte ring of a terminal's most recent output, replayed to a browser that (re)attaches.
 * Small PTY chunks (a keystroke echo is one byte) are packed into 64 KiB blocks so memory and the block list stay small;
 * the oldest bytes drop first. Once anything has been dropped the replay starts at a clean boundary (never inside a UTF-8
 * character; at a line start or an escape sequence when one is near) so the terminal does not begin with half a sequence.
 */
export class Scrollback {
	private readonly blocks: Block[] = [];
	private total = 0;
	private truncated = false;

	constructor(private readonly limit: number) {}

	get size(): number {
		return this.total;
	}

	push(data: Uint8Array): void {
		let offset = 0;
		while (offset < data.length) {
			let tail = this.blocks[this.blocks.length - 1];
			if (!tail || tail.end === tail.buf.length) {
				tail = { buf: Buffer.allocUnsafe(BLOCK_BYTES), start: 0, end: 0 };
				this.blocks.push(tail);
			}
			const n = Math.min(data.length - offset, tail.buf.length - tail.end);
			tail.buf.set(data.subarray(offset, offset + n), tail.end);
			tail.end += n;
			offset += n;
			this.total += n;
		}
		this.trim();
	}

	private trim(): void {
		while (this.total > this.limit) {
			const first = this.blocks[0];
			if (!first) return;
			const excess = this.total - this.limit;
			const have = first.end - first.start;
			this.truncated = true;
			if (have <= excess) {
				this.blocks.shift();
				this.total -= have;
			} else {
				first.start += excess;
				this.total -= excess;
			}
		}
	}

	/** Views over the retained bytes, oldest first (safe to hold while output continues: later writes never touch these ranges). */
	snapshot(): Buffer[] {
		const views = this.blocks.map((b) => b.buf.subarray(b.start, b.end));
		if (!this.truncated || views.length === 0) return views;
		const skip = this.alignment(views);
		return skip === 0 ? views : dropBytes(views, skip);
	}

	private alignment(views: Buffer[]): number {
		const head = Buffer.concat(views.slice(0, 2)).subarray(0, ALIGN_WINDOW);
		let skip = 0;
		while (skip < head.length && ((head[skip] ?? 0) & 0xc0) === 0x80) skip += 1; // UTF-8 continuation bytes
		const newline = head.indexOf(0x0a, skip);
		if (newline !== -1) return newline + 1;
		const escape = head.indexOf(0x1b, skip);
		return escape === -1 ? skip : escape;
	}

	clear(): void {
		this.blocks.length = 0;
		this.total = 0;
		this.truncated = false;
	}
}

function dropBytes(views: Buffer[], count: number): Buffer[] {
	const out: Buffer[] = [];
	let left = count;
	for (const view of views) {
		if (left >= view.length) {
			left -= view.length;
			continue;
		}
		out.push(left > 0 ? view.subarray(left) : view);
		left = 0;
	}
	return out;
}
