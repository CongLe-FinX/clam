import { i18nMsg } from "@clam/contracts";
import { createWriteStream } from "node:fs";
import { constants, copyFile, link, lstat, mkdir, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ApiError } from "../http/errors.ts";
import { normalizeRelativePath } from "./files.ts";

/** The version-control directory is never served or written through the file routes (it can hold remote URLs and credentials). */
export function refuseGitDir(rel: string): void {
	if (rel.split("/").some((segment) => segment.toLowerCase() === ".git")) throw new ApiError(403, "path_outside_project", i18nMsg("The .git directory is not available through the file routes"));
}

/**
 * Where a NEW file may be written: the parent directories are created, one level at a time, and every existing level is
 * resolved with `realpath`, so a symlinked directory that leads outside the project is refused (403). Returns the real
 * absolute target path (not yet existing, or existing when overwriting).
 */
export async function resolveWritableTarget(root: string, relInput: string): Promise<{ rel: string; abs: string }> {
	const rel = normalizeRelativePath(relInput);
	if (rel === "") throw ApiError.badRequest(i18nMsg("path must name a file"));
	refuseGitDir(rel);
	let realRoot: string;
	try {
		realRoot = await realpath(root);
	} catch {
		throw new ApiError(404, "project_path_missing", i18nMsg("Project directory no longer exists on this node"));
	}
	const segments = rel.split("/");
	const name = segments.pop() as string;
	let dir = realRoot;
	for (const segment of segments) {
		const next = path.join(dir, segment);
		let info;
		try {
			info = await lstat(next);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			await mkdir(next);
			dir = next;
			continue;
		}
		const real = info.isSymbolicLink() ? await realpath(next).catch(() => null) : next;
		if (real === null) throw new ApiError(403, "path_outside_project", i18nMsg("Path resolves outside the project root"));
		const inside = path.relative(realRoot, real);
		if (inside.startsWith("..") || path.isAbsolute(inside)) throw new ApiError(403, "path_outside_project", i18nMsg("Path resolves outside the project root"));
		if (!(await stat(real)).isDirectory()) throw ApiError.conflict(i18nMsg('"{segment}" is a file, not a folder', { segment }));
		dir = real;
	}
	return { rel, abs: path.join(dir, name) };
}

/** Counts bytes and fails once more than `max` arrive (an upload has no declared length it must be trusted on). */
export function limitBytes(max: number): Transform {
	let seen = 0;
	return new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			seen += chunk.length;
			if (seen > max) return callback(new ApiError(413, "payload_too_large", i18nMsg("The file is larger than the {mb} MB limit", { mb: Math.round(max / 1024 / 1024) })));
			callback(null, chunk);
		},
	});
}

/** The request body of a raw-bytes route: Fastify hands the untouched request stream over (see `rawBodyScope`), no body = an empty file. */
export function bodyStream(body: unknown): Readable {
	return body instanceof Readable ? body : Readable.from([]);
}

/**
 * Stream a request body into `tmp` (a fresh file next to the target), failing with 413 above `max`. Returns the byte count.
 * The temporary file is removed on any failure.
 */
export async function receiveToFile(body: unknown, tmp: string, max: number, contentLength: string | undefined): Promise<number> {
	const declared = contentLength !== undefined && /^\d{1,16}$/.test(contentLength) ? Number(contentLength) : null;
	if (declared !== null && declared > max) throw new ApiError(413, "payload_too_large", i18nMsg("The file is larger than the {mb} MB limit", { mb: Math.round(max / 1024 / 1024) }));
	let size = 0;
	const meter = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			size += chunk.length;
			callback(null, chunk);
		},
	});
	try {
		await pipeline(bodyStream(body), limitBytes(max), meter, createWriteStream(tmp, { mode: 0o644, flags: "wx" }));
	} catch (error) {
		await rm(tmp, { force: true });
		throw error;
	}
	return size;
}


/**
 * Put a finished temporary file at `abs`. Without `overwrite` the target must not exist (the check is the atomic
 * `link`, so two uploads of one name cannot both win: the later one gets 409); with it the target is replaced by rename.
 */
export async function commitNew(tmp: string, abs: string, rel: string, overwrite: boolean): Promise<void> {
	try {
		if (overwrite) await rename(tmp, abs);
		else await link(tmp, abs).finally(() => rm(tmp, { force: true }));
	} catch (error) {
		await rm(tmp, { force: true });
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw ApiError.conflict(i18nMsg('"{rel}" already exists; send overwrite=1 to replace it', { rel }));
		throw error;
	}
}

/** `report.pdf` → `report (2).pdf` */
function suffixed(rel: string, n: number): string {
	const ext = path.posix.extname(rel);
	return `${rel.slice(0, rel.length - ext.length)} (${n})${ext}`;
}

/**
 * Copy `source` into a project folder at `rel` (parent folders created, confined like an upload), never replacing a file:
 * when the name is taken a ` (2)`, ` (3)` … suffix is added. Returns the relative path that was written.
 */
export async function copyIntoFolder(root: string, rel: string, source: string): Promise<string> {
	for (let n = 1; n < 1000; n++) {
		const candidate = n === 1 ? rel : suffixed(rel, n);
		const { rel: safe, abs } = await resolveWritableTarget(root, candidate);
		try {
			// Copy-on-write where the filesystem offers it: a 2 GB video does not need to take twice the disk.
			await copyFile(source, abs, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
			return safe;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	throw ApiError.conflict(i18nMsg('Too many files named like "{rel}" in the folder', { rel }));
}
