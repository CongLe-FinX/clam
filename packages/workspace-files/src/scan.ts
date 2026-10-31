import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import type { BundleFile, BundleManifest } from "@clam/contracts";
import { DEFAULT_EXCLUDES } from "./excludes.ts";
import { BundleError, toBundleError } from "./errors.ts";
import { IgnoreMatcher, parseIgnoreLines } from "./ignore.ts";
import { comparePaths, normalizeRelPath } from "./paths.ts";

export interface BundleOptions {
	/** Extra gitignore-style globs to leave out (cannot be re-included by a .gitignore). */
	exclude?: string[];
	/** Per-file cap; larger files are reported in `skipped` as `too_large`. Default 25 MiB. */
	maxFileBytes?: number;
	/** Cap for the sum of file sizes; files that would exceed it are reported as `too_large`. Default 200 MiB. */
	maxTotalBytes?: number;
	/** Honor root + nested `.gitignore` files. Default true. */
	respectGitignore?: boolean;
}

export const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const DEFAULT_MAX_TOTAL_BYTES = 200 * 1024 * 1024;

/** Manifest as written inside the archive: the contract shape plus optional delta/scope information. */
export type ExtendedManifest = BundleManifest & {
	/** Delta bundles: base paths that no longer exist in the folder. */
	deleted?: string[];
	/** Bundles limited with `paths`: the selection (so a missing file outside it is not a deletion). */
	paths?: string[];
};

export interface ScannedFile extends BundleFile {
	abs: string;
	/** Exact bytes that were hashed, kept for small files when `keepSmall` is set (saves a second read when archiving). */
	data?: Buffer;
}

const SMALL_FILE_BYTES = 64 * 1024;
const KEEP_BUDGET_BYTES = 64 * 1024 * 1024;

const HARD = new IgnoreMatcher();
HARD.add(parseIgnoreLines(DEFAULT_EXCLUDES));

interface Candidate {
	path: string;
	abs: string;
	size: number;
	executable: boolean;
}

function isRelevant(rel: string, isDir: boolean, selected: string[] | null): boolean {
	if (selected === null) return true;
	return selected.some((p) =>
		isDir ? p === rel || p.startsWith(`${rel}/`) || rel.startsWith(`${p}/`) : p === rel || rel.startsWith(`${p}/`),
	);
}

export async function hashFile(
	abs: string,
	o: { sizeHint?: number; keep?: boolean } = {},
): Promise<{ sha256: string; size: number; data?: Buffer }> {
	const handle = await fsp.open(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	try {
		const hash = createHash("sha256");
		let size = 0;
		// +1 so a short read reliably signals EOF; sized to the file to avoid a 256 KiB allocation per tiny file.
		const buf = Buffer.allocUnsafe(Math.min(256 * 1024, Math.max(1, (o.sizeHint ?? 256 * 1024) + 1)));
		for (;;) {
			const { bytesRead } = await handle.read(buf, 0, buf.length, null);
			if (bytesRead === 0) break;
			hash.update(buf.subarray(0, bytesRead));
			size += bytesRead;
			if (bytesRead < buf.length) break; // short read on a regular file = EOF
		}
		const sha256 = hash.digest("hex");
		// A single short read means the whole file is at the start of `buf`.
		if (o.keep && size < buf.length) return { sha256, size, data: Buffer.from(buf.subarray(0, size)) };
		return { sha256, size };
	} finally {
		await handle.close();
	}
}

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		for (;;) {
			const i = next++;
			if (i >= items.length) return;
			results[i] = await fn(items[i] as T, i);
		}
	});
	await Promise.all(workers);
	return results;
}

export async function scanFiles(
	dir: string,
	o: BundleOptions & { paths?: string[]; keepSmall?: boolean } = {},
): Promise<{ files: ScannedFile[]; skipped: BundleManifest["skipped"]; selected: string[] | null }> {
	const maxFile = o.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
	const maxTotal = o.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
	const respectGitignore = o.respectGitignore ?? true;
	const selected = o.paths ? [...new Set(o.paths.map(normalizeRelPath))].sort(comparePaths) : null;
	const extra = new IgnoreMatcher();
	if (o.exclude?.length) extra.add(parseIgnoreLines(o.exclude));

	const candidates: Candidate[] = [];
	const skipped: BundleManifest["skipped"] = [];

	try {
		const root = await fsp.lstat(dir);
		if (!root.isDirectory()) throw new BundleError("io", `not a directory: ${dir}`);
	} catch (error) {
		throw toBundleError(error);
	}

	async function visit(relDir: string, git: IgnoreMatcher): Promise<void> {
		const absDir = relDir === "" ? dir : join(dir, relDir);
		const entries = await fsp.readdir(absDir, { withFileTypes: true });
		entries.sort((a, b) => comparePaths(a.name, b.name));
		let matcher = git;
		if (respectGitignore) {
			const own = entries.find((e) => e.name === ".gitignore" && e.isFile());
			if (own) {
				try {
					const text = await fsp.readFile(join(absDir, ".gitignore"), "utf8");
					matcher = git.fork(parseIgnoreLines(text.split("\n"), relDir));
				} catch {
					// unreadable .gitignore → behave as if absent
				}
			}
		}
		const stats = await Promise.all(
			entries.map(async (e) => {
				const rel = relDir === "" ? e.name : `${relDir}/${e.name}`;
				if (!isRelevant(rel, e.isDirectory(), selected)) return null;
				if (e.isDirectory() || e.isFile()) return { rel, entry: e, st: e.isFile() ? await fsp.lstat(join(dir, rel)) : null };
				return { rel, entry: e, st: null };
			}),
		);
		for (const item of stats) {
			if (item === null) continue;
			const { rel, entry, st } = item;
			const isDir = entry.isDirectory();
			if (HARD.ignores(rel, isDir) || extra.ignores(rel, isDir) || matcher.ignores(rel, isDir)) {
				skipped.push({ path: isDir ? `${rel}/` : rel, reason: "excluded" });
			} else if (entry.isSymbolicLink()) {
				skipped.push({ path: rel, reason: "symlink" });
			} else if (isDir) {
				await visit(rel, matcher);
			} else if (entry.isFile() && st) {
				if (st.size > maxFile) skipped.push({ path: rel, reason: "too_large" });
				else candidates.push({ path: rel, abs: join(dir, rel), size: st.size, executable: (st.mode & 0o100) !== 0 });
			} else {
				skipped.push({ path: rel, reason: "special" });
			}
		}
	}

	try {
		await visit("", new IgnoreMatcher());
	} catch (error) {
		throw toBundleError(error);
	}

	candidates.sort((a, b) => comparePaths(a.path, b.path));
	let total = 0;
	const kept: Candidate[] = [];
	for (const c of candidates) {
		if (total + c.size > maxTotal) {
			skipped.push({ path: c.path, reason: "too_large" });
			continue;
		}
		total += c.size;
		kept.push(c);
	}
	skipped.sort((a, b) => comparePaths(a.path, b.path));

	let hashed: ScannedFile[];
	try {
		let keptBytes = 0;
		hashed = await mapLimit(kept, 32, async (c) => {
			const keep = o.keepSmall === true && c.size <= SMALL_FILE_BYTES && keptBytes + c.size <= KEEP_BUDGET_BYTES;
			if (keep) keptBytes += c.size;
			const { sha256, size, data } = await hashFile(c.abs, { sizeHint: c.size, keep });
			return { path: c.path, size, sha256, executable: c.executable, abs: c.abs, ...(data ? { data } : {}) };
		});
	} catch (error) {
		throw toBundleError(error);
	}
	return { files: hashed, skipped, selected };
}

export function buildManifest(files: BundleFile[], skipped: BundleManifest["skipped"]): BundleManifest {
	return {
		version: 1,
		files: files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256, executable: f.executable })),
		skipped,
		totalSize: files.reduce((sum, f) => sum + f.size, 0),
	};
}

/** Manifest only (sha256 per file); no archive. */
export async function scanFolder(dir: string, o: BundleOptions = {}): Promise<BundleManifest> {
	const { files, skipped } = await scanFiles(dir, o);
	return buildManifest(files, skipped);
}
