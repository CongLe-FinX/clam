import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createGzip } from "node:zlib";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterAll } from "vitest";

const dirs: string[] = [];

export async function tmp(prefix = "wf-"): Promise<string> {
	const d = await mkdtemp(join(tmpdir(), prefix));
	dirs.push(d);
	return d;
}

export function registerCleanup(): void {
	afterAll(async () => {
		await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
	});
}

export async function put(root: string, files: Record<string, string | Buffer>, mode?: Record<string, number>): Promise<void> {
	for (const [path, content] of Object.entries(files)) {
		const abs = join(root, path);
		await mkdir(dirname(abs), { recursive: true });
		await writeFile(abs, content, { mode: mode?.[path] ?? 0o644 });
	}
}

export async function text(root: string, path: string): Promise<string> {
	return readFile(join(root, path), "utf8");
}

export const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

// --- Hand-rolled tar for building malicious / tampered archives -------------------------------------------------

export interface RawEntry {
	name: string;
	data?: Buffer;
	type?: string; // typeflag
	linkname?: string;
}

function block(entry: RawEntry): Buffer {
	const data = entry.data ?? Buffer.alloc(0);
	const buf = Buffer.alloc(512);
	buf.write(entry.name, 0, 100, "utf8");
	buf.write("0000644\0", 100, 8, "ascii");
	buf.write("0000000\0", 108, 8, "ascii");
	buf.write("0000000\0", 116, 8, "ascii");
	buf.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
	buf.write("00000000000\0", 136, 12, "ascii");
	buf.fill(0x20, 148, 156);
	buf.write(entry.type ?? "0", 156, 1, "ascii");
	if (entry.linkname) buf.write(entry.linkname, 157, 100, "utf8");
	buf.write("ustar\0", 257, 6, "ascii");
	buf.write("00", 263, 2, "ascii");
	let sum = 0;
	for (const b of buf) sum += b;
	buf.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
	const pad = data.length % 512 === 0 ? 0 : 512 - (data.length % 512);
	return Buffer.concat([buf, data, Buffer.alloc(pad)]);
}

export function rawTarGz(entries: RawEntry[]): Buffer {
	return gzipSync(Buffer.concat([...entries.map(block), Buffer.alloc(1024)]));
}

export function manifestFor(files: Record<string, string | Buffer>, extra: Record<string, unknown> = {}): Buffer {
	const list = Object.entries(files).map(([path, c]) => ({
		path,
		size: Buffer.byteLength(c),
		sha256: sha(c),
		executable: false,
	}));
	return Buffer.from(
		JSON.stringify({ version: 1, files: list, skipped: [], totalSize: list.reduce((s, f) => s + f.size, 0), ...extra }),
	);
}

/** Archive whose manifest honestly describes `files` (path → content) plus extra raw entries. */
export function craftedBundle(files: Record<string, string | Buffer>, extras: RawEntry[] = [], manifestExtra = {}): Buffer {
	return rawTarGz([
		{ name: "manifest.json", data: manifestFor(files, manifestExtra) },
		...Object.entries(files).map(([path, c]) => ({ name: `files/${path}`, data: Buffer.from(c) })),
		...extras,
	]);
}

export { gunzipSync, gzipSync, createGzip };
