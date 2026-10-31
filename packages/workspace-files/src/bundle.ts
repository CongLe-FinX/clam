import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, createReadStream, createWriteStream } from "node:fs";
import * as fsp from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createGunzip, createGzip } from "node:zlib";
import { BundleFile, BundleManifest } from "@clam/contracts";
import { BundleError, toBundleError } from "./errors.ts";
import { assertSafeRelPath, comparePaths } from "./paths.ts";
import { type BundleOptions, type ExtendedManifest, type ScannedFile, buildManifest, hashFile, mapLimit, scanFiles } from "./scan.ts";
import { TarReader, endOfArchive, entryPadding, fileHeader } from "./tar.ts";
import { z } from "zod";

const MANIFEST_ENTRY = "manifest.json";
const FILES_PREFIX = "files/";
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
/** Hard ceilings on what `applyBundle` accepts, independent of the creator's options (decompression-bomb guard). */
const SMALL_FILE_BYTES = 1024 * 1024;
const MAX_APPLY_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;

const ManifestSchema = BundleManifest.extend({
	deleted: z.array(z.string()).optional(),
	paths: z.array(z.string()).optional(),
});

export type PreviewStatus = "new" | "unchanged" | "update" | "conflict";

function manifestJson(m: ExtendedManifest): Buffer {
	const ordered: Record<string, unknown> = {
		version: 1,
		files: m.files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256, executable: f.executable })),
		skipped: m.skipped.map((s) => ({ path: s.path, reason: s.reason })),
		totalSize: m.totalSize,
	};
	if (m.deleted) ordered.deleted = m.deleted;
	if (m.paths) ordered.paths = m.paths;
	return Buffer.from(JSON.stringify(ordered));
}

function parseManifest(data: Buffer): ExtendedManifest {
	let json: unknown;
	try {
		json = JSON.parse(data.toString("utf8"));
	} catch (error) {
		throw new BundleError("invalid_archive", "manifest.json is not valid JSON", { cause: error });
	}
	const parsed = ManifestSchema.safeParse(json);
	if (!parsed.success) throw new BundleError("invalid_archive", `invalid manifest: ${parsed.error.message}`);
	const manifest = parsed.data as ExtendedManifest;
	const seen = new Set<string>();
	let total = 0;
	for (const f of manifest.files) {
		assertSafeRelPath(f.path, "manifest path");
		if (seen.has(f.path)) throw new BundleError("invalid_archive", `duplicate manifest path: ${f.path}`);
		seen.add(f.path);
		if (f.size < 0 || !/^[0-9a-f]{64}$/.test(f.sha256)) {
			throw new BundleError("invalid_archive", `invalid manifest entry: ${f.path}`);
		}
		total += f.size;
	}
	for (const p of manifest.deleted ?? []) assertSafeRelPath(p, "manifest deleted path");
	for (const p of manifest.paths ?? []) assertSafeRelPath(p, "manifest scope path");
	if (total !== manifest.totalSize) throw new BundleError("invalid_archive", "manifest totalSize does not match files");
	return manifest;
}

async function* openArchive(archivePath: string): AsyncGenerator<Buffer, void, void> {
	const src = createReadStream(archivePath);
	const gunzip = createGunzip();
	src.on("error", (error) => gunzip.destroy(error));
	src.pipe(gunzip);
	try {
		for await (const chunk of gunzip) yield chunk as Buffer;
	} finally {
		src.destroy();
		gunzip.destroy();
	}
}

async function withReader<T>(archivePath: string, fn: (reader: TarReader) => Promise<T>): Promise<T> {
	const source = openArchive(archivePath);
	try {
		return await fn(new TarReader(source));
	} catch (error) {
		throw toBundleError(error);
	} finally {
		await source.return(undefined);
	}
}

async function collect(body: AsyncGenerator<Buffer, void, void>, limit: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let n = 0;
	for await (const chunk of body) {
		n += chunk.length;
		if (n > limit) throw new BundleError("too_large", "manifest too large");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

async function readManifestFrom(reader: TarReader): Promise<ExtendedManifest> {
	const entry = await reader.next();
	if (entry === null || entry.name !== MANIFEST_ENTRY) {
		throw new BundleError("invalid_archive", "archive does not start with manifest.json");
	}
	if (entry.size > MAX_MANIFEST_BYTES) throw new BundleError("too_large", "manifest too large");
	return parseManifest(await collect(entry.body, MAX_MANIFEST_BYTES));
}

export function readBundleManifest(archivePath: string): Promise<BundleManifest> {
	return withReader(archivePath, readManifestFrom);
}

async function* readFileChecked(abs: string, expected: BundleFile): AsyncGenerator<Buffer, void, void> {
	const handle = await fsp.open(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	try {
		const hash = createHash("sha256");
		let remaining = expected.size;
		while (remaining > 0) {
			const buf = Buffer.allocUnsafe(Math.min(remaining, 256 * 1024));
			const { bytesRead } = await handle.read(buf, 0, buf.length, null);
			if (bytesRead === 0) break;
			const chunk = bytesRead === buf.length ? buf : buf.subarray(0, bytesRead);
			hash.update(chunk);
			remaining -= bytesRead;
			yield chunk;
		}
		const probe = await handle.read(Buffer.allocUnsafe(1), 0, 1, null);
		if (remaining !== 0 || probe.bytesRead !== 0 || hash.digest("hex") !== expected.sha256) {
			throw new BundleError("io", `file changed while bundling: ${expected.path}`);
		}
		const pad = entryPadding(expected.size);
		if (pad.length) yield pad;
	} finally {
		await handle.close();
	}
}

async function* tarStream(manifest: ExtendedManifest, files: ScannedFile[]): AsyncGenerator<Buffer, void, void> {
	const json = manifestJson(manifest);
	yield fileHeader(MANIFEST_ENTRY, json.length, false);
	yield json;
	yield entryPadding(json.length);
	for (const f of files) {
		yield fileHeader(`${FILES_PREFIX}${f.path}`, f.size, f.executable);
		if (f.data) {
			// Exactly the bytes that were hashed into the manifest.
			if (f.data.length) yield f.data;
			const pad = entryPadding(f.size);
			if (pad.length) yield pad;
		} else {
			yield* readFileChecked(f.abs, f);
		}
	}
	yield endOfArchive();
}

/** Deterministic tar.gz: `manifest.json` then `files/<path>` sorted; fixed mtimes/owners so equal folders → equal sha256. */
export async function createBundle(
	dir: string,
	outPath: string,
	o: BundleOptions & { paths?: string[]; base?: BundleManifest } = {},
): Promise<{ manifest: BundleManifest; sha256: string; size: number }> {
	const scanned = await scanFiles(dir, { ...o, keepSmall: true });
	let included = scanned.files;
	let deleted: string[] | undefined;
	if (o.base) {
		const base = new Map(o.base.files.map((f) => [f.path, f]));
		included = scanned.files.filter((f) => {
			const b = base.get(f.path);
			return !b || b.sha256 !== f.sha256 || b.executable !== f.executable;
		});
		const present = new Set(scanned.files.map((f) => f.path));
		const sel = scanned.selected;
		const inScope = (p: string) => sel === null || sel.some((s) => p === s || p.startsWith(`${s}/`));
		const covered = (p: string) =>
			scanned.skipped.some((s) => (s.path.endsWith("/") ? p.startsWith(s.path) : p === s.path));
		deleted = o.base.files
			.map((f) => f.path)
			.filter((p) => !present.has(p) && inScope(p) && !covered(p))
			.sort(comparePaths);
	}
	const extended: ExtendedManifest = buildManifest(included, scanned.skipped);
	if (deleted) extended.deleted = deleted;
	if (scanned.selected) extended.paths = scanned.selected;

	const tmp = `${outPath}.tmp-${randomBytes(6).toString("hex")}`;
	const hash = createHash("sha256");
	let size = 0;
	try {
		await fsp.mkdir(dirname(outPath), { recursive: true });
		await pipeline(
			Readable.from(tarStream(extended, included), { objectMode: false }),
			createGzip({ level: 6 }),
			async function* (source: AsyncIterable<Buffer>) {
				for await (const chunk of source) {
					hash.update(chunk);
					size += chunk.length;
					yield chunk;
				}
			},
			createWriteStream(tmp),
		);
		await fsp.rename(tmp, outPath);
	} catch (error) {
		await fsp.rm(tmp, { force: true }).catch(() => {});
		throw toBundleError(error);
	}
	return { manifest: extended, sha256: hash.digest("hex"), size };
}

// ---------------------------------------------------------------------------------------------------------------
// Local state classification (preview + apply)

type Local = { kind: "missing" } | { kind: "file"; size: number; abs: string; executable: boolean } | { kind: "blocked" };

/** lstat the target without following symlinks anywhere in the path; blocked = symlinked ancestor, non-dir ancestor or dir/special target. */
function makeInspector(dir: string): (rel: string) => Promise<Local> {
	const ancestors = new Map<string, Promise<"ok" | "missing" | "blocked">>();
	const checkDir = (rel: string): Promise<"ok" | "missing" | "blocked"> => {
		const cached = ancestors.get(rel);
		if (cached) return cached;
		const result = (async () => {
			if (rel === "") return "ok" as const;
			const parent = await checkDir(rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
			if (parent !== "ok") return parent;
			try {
				const st = await fsp.lstat(join(dir, rel));
				return st.isDirectory() ? ("ok" as const) : ("blocked" as const);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ENOENT" || code === "ENOTDIR") return "missing" as const;
				throw error;
			}
		})();
		ancestors.set(rel, result);
		return result;
	};
	return async (rel) => {
		const parent = await checkDir(rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
		if (parent === "blocked") return { kind: "blocked" };
		if (parent === "missing") return { kind: "missing" };
		const abs = join(dir, rel);
		try {
			const st = await fsp.lstat(abs);
			return st.isFile() ? { kind: "file", size: st.size, abs, executable: (st.mode & 0o100) !== 0 } : { kind: "blocked" };
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
			throw error;
		}
	};
}

interface Classified {
	file: BundleFile;
	status: PreviewStatus;
	/** Cannot be written safely at all (symlinked parent, directory in the way). */
	blocked: boolean;
}

async function classify(dir: string, files: BundleFile[], base: BundleManifest | undefined): Promise<Classified[]> {
	const baseMap = new Map((base?.files ?? []).map((f) => [f.path, f]));
	const inspect = makeInspector(dir);
	return mapLimit(files, 32, async (file): Promise<Classified> => {
		const local = await inspect(file.path);
		if (local.kind === "missing") return { file, status: "new", blocked: false };
		if (local.kind === "blocked") return { file, status: "conflict", blocked: true };
		const b = baseMap.get(file.path);
		const sizeMayMatch = local.size === file.size || (b !== undefined && local.size === b.size);
		if (!sizeMayMatch) return { file, status: "conflict", blocked: false };
		const { sha256 } = await hashFile(local.abs, { sizeHint: local.size });
		if (sha256 === file.sha256) {
			// Same content; only a differing exec bit is left to apply (never lose a local edit: content is identical).
			return { file, status: local.executable === file.executable ? "unchanged" : "update", blocked: false };
		}
		if (b && sha256 === b.sha256) return { file, status: "update", blocked: false };
		return { file, status: "conflict", blocked: false };
	});
}

export async function previewBundle(
	archivePath: string,
	dir: string,
	o: { base?: BundleManifest } = {},
): Promise<Array<{ path: string; status: PreviewStatus; size: number }>> {
	const manifest = await readBundleManifest(archivePath);
	try {
		const classified = await classify(dir, manifest.files, o.base);
		return classified.map((c) => ({ path: c.file.path, status: c.status, size: c.file.size }));
	} catch (error) {
		throw toBundleError(error);
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Apply

export interface ApplyResult {
	written: string[];
	skipped: Array<{ path: string; reason: "unchanged" | "conflict" | "not_selected" }>;
	deleted: string[];
}

/** Runs up to `limit` promises concurrently; a failure surfaces from the next `add`/`drain`. */
class BoundedPool {
	private readonly active = new Set<Promise<void>>();
	private failure: unknown = null;
	constructor(private readonly limit: number) {}

	async add(task: Promise<void>): Promise<void> {
		const tracked: Promise<void> = task.then(
			() => {
				this.active.delete(tracked);
			},
			(error: unknown) => {
				this.active.delete(tracked);
				this.failure ??= error;
			},
		);
		this.active.add(tracked);
		if (this.active.size >= this.limit) await Promise.race(this.active);
		if (this.failure !== null) throw this.failure;
	}

	async drain(): Promise<void> {
		await Promise.all(this.active);
		if (this.failure !== null) throw this.failure;
	}
}

async function ensureParents(dir: string, rel: string, made: Set<string>): Promise<void> {
	const parts = rel.split("/").slice(0, -1);
	let cur = dir;
	for (const part of parts) {
		cur = join(cur, part);
		if (made.has(cur)) continue;
		made.add(cur);
		try {
			await fsp.mkdir(cur);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const st = await fsp.lstat(cur);
			if (!st.isDirectory()) throw new BundleError("unsafe_path", `not a real directory: ${cur}`);
		}
	}
}

async function pruneEmptyParents(dir: string, rel: string): Promise<void> {
	let cur = rel;
	while (cur.includes("/")) {
		cur = cur.slice(0, cur.lastIndexOf("/"));
		try {
			await fsp.rmdir(join(dir, cur));
		} catch {
			return;
		}
	}
}

export async function applyBundle(
	archivePath: string,
	dir: string,
	o: { base?: BundleManifest; paths?: string[]; overwrite?: string[]; deleteMissing?: boolean } = {},
): Promise<ApplyResult> {
	const selected = o.paths ? new Set(o.paths.map((p) => p.replace(/^(?:\.\/)+/, ""))) : null;
	const overwrite = new Set((o.overwrite ?? []).map((p) => p.replace(/^(?:\.\/)+/, "")));
	let staging: string | null = null;
	const inflight = new BoundedPool(32);
	try {
		const manifest = await withReader(archivePath, readManifestFrom);
		if (manifest.totalSize > MAX_APPLY_TOTAL_BYTES) throw new BundleError("too_large", "bundle too large to apply");
		await fsp.mkdir(dir, { recursive: true });

		const classified = await classify(dir, manifest.files, o.base);
		const skipped: ApplyResult["skipped"] = [];
		const toWrite = new Map<string, Classified>();
		for (const c of classified) {
			const path = c.file.path;
			if (selected && !selected.has(path)) skipped.push({ path, reason: "not_selected" });
			else if (c.status === "unchanged") skipped.push({ path, reason: "unchanged" });
			else if (c.status === "conflict" && (c.blocked || !overwrite.has(path))) skipped.push({ path, reason: "conflict" });
			else toWrite.set(path, c);
		}

		// Pass 1 over the archive: verify EVERY entry against the manifest; stage the files that will be written.
		const byPath = new Map(manifest.files.map((f) => [f.path, f]));
		const seen = new Set<string>();
		let index = 0;
		const staged = new Map<string, string>();
		await withReader(archivePath, async (reader) => {
			await readManifestFrom(reader);
			for (;;) {
				const entry = await reader.next();
				if (entry === null) break;
				if (!entry.name.startsWith(FILES_PREFIX)) {
					throw new BundleError("invalid_archive", `unexpected archive entry: ${entry.name}`);
				}
				const path = entry.name.slice(FILES_PREFIX.length);
				assertSafeRelPath(path, "archive entry");
				const expected = byPath.get(path);
				if (!expected) throw new BundleError("invalid_archive", `entry not in manifest: ${path}`);
				if (seen.has(path)) throw new BundleError("invalid_archive", `duplicate entry: ${path}`);
				seen.add(path);
				if (entry.size !== expected.size) throw new BundleError("invalid_archive", `size mismatch: ${path}`);
				const hash = createHash("sha256");
				const target = toWrite.has(path);
				const mode = expected.executable ? 0o755 : 0o644;
				if (expected.size <= SMALL_FILE_BYTES) {
					// Small files: verify in memory first, then one writeFile into staging.
					const data = await collect(entry.body, SMALL_FILE_BYTES);
					hash.update(data);
					if (hash.digest("hex") !== expected.sha256) {
						throw new BundleError("invalid_archive", `sha256 mismatch: ${path}`);
					}
					if (target) {
						if (staging === null) staging = await fsp.mkdtemp(join(dir, ".clam-apply-"));
						const tmpPath = join(staging, String(index++));
						staged.set(path, tmpPath);
						await inflight.add(fsp.writeFile(tmpPath, data, { flag: "wx", mode }));
					}
					continue;
				}
				let handle: fsp.FileHandle | null = null;
				try {
					if (target) {
						if (staging === null) staging = await fsp.mkdtemp(join(dir, ".clam-apply-"));
						const tmpPath = join(staging, String(index++));
						handle = await fsp.open(tmpPath, "wx", mode);
						staged.set(path, tmpPath);
					}
					for await (const chunk of entry.body) {
						hash.update(chunk);
						if (handle) await handle.write(chunk);
					}
				} finally {
					await handle?.close();
				}
				if (hash.digest("hex") !== expected.sha256) {
					throw new BundleError("invalid_archive", `sha256 mismatch: ${path}`);
				}
			}
		});
		await inflight.drain();
		for (const path of byPath.keys()) {
			if (!seen.has(path)) throw new BundleError("invalid_archive", `entry missing from archive: ${path}`);
		}

		// Pass 2: move verified files into place.
		const written: string[] = [];
		const madeDirs = new Set<string>();
		const order = [...toWrite.keys()].sort(comparePaths);
		for (const path of order) await ensureParents(dir, path, madeDirs);
		await mapLimit(order, 32, (path) => fsp.rename(staged.get(path) as string, join(dir, path)));
		written.push(...order);

		// Deletions (only with `deleteMissing`, only unchanged-since-base files, never conflicts).
		const deleted: string[] = [];
		if (o.deleteMissing) {
			const baseMap = new Map((o.base?.files ?? []).map((f) => [f.path, f]));
			let removed: string[];
			if (manifest.deleted) {
				removed = manifest.deleted;
			} else {
				const scope = manifest.paths;
				const inScope = (p: string) => !scope || scope.some((s) => p === s || p.startsWith(`${s}/`));
				const covered = (p: string) =>
					manifest.skipped.some((s) => (s.path.endsWith("/") ? p.startsWith(s.path) : p === s.path));
				removed = [...baseMap.keys()].filter((p) => !byPath.has(p) && inScope(p) && !covered(p));
			}
			const inspect = makeInspector(dir);
			for (const path of [...removed].sort(comparePaths)) {
				if (selected && !selected.has(path)) {
					skipped.push({ path, reason: "not_selected" });
					continue;
				}
				const local = await inspect(path);
				if (local.kind === "missing") continue;
				if (local.kind === "blocked") {
					skipped.push({ path, reason: "conflict" });
					continue;
				}
				const baseEntry = baseMap.get(path);
				const unchanged = baseEntry !== undefined && (await hashFile(local.abs, { sizeHint: local.size })).sha256 === baseEntry.sha256;
				if (!unchanged && !overwrite.has(path)) {
					skipped.push({ path, reason: "conflict" });
					continue;
				}
				await fsp.rm(local.abs, { force: true });
				await pruneEmptyParents(dir, path);
				deleted.push(path);
			}
		}
		skipped.sort((a, b) => comparePaths(a.path, b.path));
		return { written, skipped, deleted };
	} catch (error) {
		throw toBundleError(error);
	} finally {
		await inflight.drain().catch(() => {}); // no staging write may outlive the cleanup below
		if (staging) await fsp.rm(staging, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
	}
}

