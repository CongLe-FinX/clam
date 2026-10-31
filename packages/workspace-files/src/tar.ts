import { BundleError } from "./errors.ts";
import { assertSafeRelPath } from "./paths.ts";

/** A tiny deterministic ustar (+PAX path) writer and a strict streaming reader. */

const BLOCK = 512;

function writeString(buf: Buffer, offset: number, length: number, value: string): void {
	buf.write(value, offset, length, "utf8");
}

function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
	const s = value.toString(8).padStart(length - 1, "0");
	buf.write(s, offset, length - 1, "ascii");
	buf[offset + length - 1] = 0;
}

function header(name: string, size: number, mode: number, typeflag: string): Buffer {
	const buf = Buffer.alloc(BLOCK);
	writeString(buf, 0, 100, name);
	writeOctal(buf, 100, 8, mode);
	writeOctal(buf, 108, 8, 0); // uid
	writeOctal(buf, 116, 8, 0); // gid
	if (size > 0o77777777777) throw new BundleError("too_large", `tar entry too large: ${name}`);
	writeOctal(buf, 124, 12, size);
	writeOctal(buf, 136, 12, 0); // mtime fixed → deterministic archives
	buf.fill(0x20, 148, 156); // checksum placeholder
	buf.write(typeflag, 156, 1, "ascii");
	buf.write("ustar\0", 257, 6, "ascii");
	buf.write("00", 263, 2, "ascii");
	let sum = 0;
	for (const byte of buf) sum += byte;
	buf.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
	return buf;
}

function paxRecord(key: string, value: string): Buffer {
	const body = ` ${key}=${value}\n`;
	let len = Buffer.byteLength(body) + 1;
	while (Buffer.byteLength(`${len}${body}`) !== len) len = Buffer.byteLength(`${len}${body}`);
	return Buffer.from(`${len}${body}`);
}

function padding(size: number): Buffer {
	const rem = size % BLOCK;
	return rem === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rem);
}

/** Header blocks (and a PAX header when the path is long / non-ASCII) for a regular file of `size` bytes. */
export function fileHeader(path: string, size: number, executable: boolean): Buffer {
	const mode = executable ? 0o755 : 0o644;
	const needsPax = Buffer.byteLength(path) > 100 || /[^\x20-\x7e]/.test(path);
	if (!needsPax) return header(path, size, mode, "0");
	const record = paxRecord("path", path);
	const paxHeader = header("PaxHeader/entry", record.length, 0o644, "x");
	// The regular header carries a harmless ASCII placeholder; the PAX `path` wins in every reader.
	const placeholder = `pax/${path.replace(/[^\x20-\x7e]/g, "_").slice(-90)}`;
	return Buffer.concat([paxHeader, record, padding(record.length), header(placeholder, size, mode, "0")]);
}

export function entryPadding(size: number): Buffer {
	return padding(size);
}

export function endOfArchive(): Buffer {
	return Buffer.alloc(BLOCK * 2);
}

export interface TarEntry {
	/** Entry name after PAX/ustar-prefix resolution. */
	name: string;
	size: number;
	mode: number;
	/** Async body chunks; MUST be fully consumed or skipped via `reader.next()`. */
	body: AsyncGenerator<Buffer, void, void>;
}

function parseOctal(buf: Buffer, offset: number, length: number, what: string): number {
	const raw = buf.toString("ascii", offset, offset + length).replace(/\0.*$/s, "").trim();
	if (raw === "") return 0;
	if (!/^[0-7]+$/.test(raw)) throw new BundleError("invalid_archive", `bad tar ${what} field`);
	return Number.parseInt(raw, 8);
}

function cString(buf: Buffer, offset: number, length: number): string {
	const slice = buf.subarray(offset, offset + length);
	const nul = slice.indexOf(0);
	return slice.toString("utf8", 0, nul === -1 ? slice.length : nul);
}

function parsePax(data: Buffer): Map<string, string> {
	const out = new Map<string, string>();
	let pos = 0;
	while (pos < data.length) {
		const space = data.indexOf(0x20, pos);
		if (space === -1) throw new BundleError("invalid_archive", "bad PAX header");
		const len = Number.parseInt(data.toString("ascii", pos, space), 10);
		if (!Number.isFinite(len) || len <= space - pos + 1 || pos + len > data.length) {
			throw new BundleError("invalid_archive", "bad PAX record length");
		}
		const record = data.toString("utf8", space + 1, pos + len - 1);
		const eq = record.indexOf("=");
		if (eq === -1) throw new BundleError("invalid_archive", "bad PAX record");
		out.set(record.slice(0, eq), record.slice(eq + 1));
		pos += len;
	}
	return out;
}

const MAX_META_BYTES = 1 << 20;

export class TarReader {
	private pending: Buffer = Buffer.alloc(0);
	private ended = false;
	private sawEnd = false;
	private remaining = 0; // body bytes of the current entry not yet consumed
	private pad = 0;
	private readonly iterator: AsyncIterator<Buffer>;

	constructor(source: AsyncIterable<Buffer>) {
		this.iterator = source[Symbol.asyncIterator]();
	}

	private async pull(): Promise<boolean> {
		if (this.ended) return false;
		const { value, done } = await this.iterator.next();
		if (done) {
			this.ended = true;
			return false;
		}
		this.pending = this.pending.length === 0 ? value : Buffer.concat([this.pending, value]);
		return true;
	}

	private async readExact(n: number): Promise<Buffer | null> {
		while (this.pending.length < n) {
			if (!(await this.pull())) return this.pending.length === 0 ? null : this.fail("truncated archive");
		}
		const out = this.pending.subarray(0, n);
		this.pending = this.pending.subarray(n);
		return out;
	}

	private fail(message: string): never {
		throw new BundleError("invalid_archive", message);
	}

	private async skip(n: number): Promise<void> {
		while (n > 0) {
			if (this.pending.length === 0 && !(await this.pull())) this.fail("truncated archive");
			const take = Math.min(n, this.pending.length);
			this.pending = this.pending.subarray(take);
			n -= take;
		}
	}

	private async *bodyChunks(): AsyncGenerator<Buffer, void, void> {
		while (this.remaining > 0) {
			if (this.pending.length === 0 && !(await this.pull())) this.fail("truncated archive");
			const take = Math.min(this.remaining, this.pending.length);
			const chunk = this.pending.subarray(0, take);
			this.pending = this.pending.subarray(take);
			this.remaining -= take;
			yield chunk;
		}
	}

	private async readBody(size: number): Promise<Buffer> {
		if (size > MAX_META_BYTES) this.fail("tar metadata entry too large");
		const data = await this.readExact(size);
		if (data === null && size > 0) this.fail("truncated archive");
		await this.skip(padding(size).length);
		return data ?? Buffer.alloc(0);
	}

	/** Next regular-file entry, or `null` at the end-of-archive marker. Throws on links/devices/unsafe names. */
	async next(): Promise<TarEntry | null> {
		// Drain whatever the caller did not consume.
		await this.skip(this.remaining + this.pad);
		this.remaining = 0;
		this.pad = 0;
		let paxPath: string | undefined;
		let paxSize: number | undefined;
		let gnuLongName: string | undefined;
		for (;;) {
			const block = await this.readExact(BLOCK);
			if (block === null) return this.sawEnd ? null : this.fail("missing end-of-archive marker");
			if (block.every((b) => b === 0)) {
				const second = await this.readExact(BLOCK);
				if (second === null || !second.every((b) => b === 0)) this.fail("bad end-of-archive marker");
				this.sawEnd = true;
				return null;
			}
			const expected = parseOctal(block, 148, 8, "checksum");
			let sum = 0;
			for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (block[i] as number);
			if (sum !== expected) this.fail("tar header checksum mismatch");
			const magic = block.toString("ascii", 257, 262);
			if (magic !== "ustar") this.fail("unsupported tar format (not ustar)");
			const typeflag = String.fromCharCode(block[156] as number);
			const size = parseOctal(block, 124, 12, "size");
			const mode = parseOctal(block, 100, 8, "mode");
			if (typeflag === "x") {
				const pax = parsePax(await this.readBody(size));
				paxPath = pax.get("path") ?? paxPath;
				const sz = pax.get("size");
				if (sz !== undefined) {
					if (!/^\d+$/.test(sz)) this.fail("bad PAX size");
					paxSize = Number.parseInt(sz, 10);
				}
				continue;
			}
			if (typeflag === "g") {
				await this.readBody(size);
				continue;
			}
			if (typeflag === "L") {
				gnuLongName = cString(await this.readBody(size), 0, size);
				continue;
			}
			const prefix = cString(block, 345, 155);
			let name = cString(block, 0, 100);
			if (prefix) name = `${prefix}/${name}`;
			if (paxPath !== undefined) name = paxPath;
			else if (gnuLongName !== undefined) name = gnuLongName;
			const entrySize = paxSize ?? size;
			if (typeflag === "1" || typeflag === "2") {
				throw new BundleError("unsafe_path", `link entry rejected: ${name}`);
			}
			if (typeflag === "3" || typeflag === "4" || typeflag === "6") {
				throw new BundleError("unsafe_path", `device/fifo entry rejected: ${name}`);
			}
			if (typeflag === "5") {
				assertSafeRelPath(name.replace(/\/+$/, ""), "archive entry");
				paxPath = paxSize = gnuLongName = undefined;
				this.pad = 0;
				this.remaining = 0;
				continue; // directories carry no data; files create their own parents
			}
			if (typeflag !== "0" && typeflag !== "\0" && typeflag !== "7") {
				this.fail(`unsupported tar entry type '${typeflag}': ${name}`);
			}
			this.remaining = entrySize;
			this.pad = padding(entrySize).length;
			return { name, size: entrySize, mode, body: this.bodyChunks() };
		}
	}
}
