import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BundleFile, BundleManifest, FilesApplyResult, FilesPreview } from "@clam/contracts";
import { scanForSecrets } from "@clam/git-engine";
import { applyBundle, BundleError, isBinary, previewBundle, textDiff } from "@clam/workspace-files";
import { ApiError } from "../http/errors.ts";

/** Largest text file a unified diff is built for, and the largest one the credential scan reads. */
const TEXT_LIMIT = 256 * 1024;
const SCAN_LIMIT = 1024 * 1024;
const MAX_DIFFS = 200;

/** A bundle problem as the API error the user should see. */
export function bundleErrorToApi(error: unknown): unknown {
	if (!(error instanceof BundleError)) return error;
	switch (error.code) {
		case "too_large":
			return new ApiError(413, "files_too_large", error.message);
		case "unsafe_path":
			return new ApiError(400, "unsafe_path", error.message);
		case "invalid_archive":
			return new ApiError(422, "invalid_bundle", error.message);
		default:
			return new ApiError(500, "files_io_error", error.message);
	}
}

/** Run a workspace-files call and surface its failures as API errors. */
export async function guardBundle<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		throw bundleErrorToApi(error);
	}
}

/**
 * Credential scan of the text files of a folder that are about to leave this node in a bundle (task inputs and results).
 * Returns the offending paths with their rule names only: a finding's content is never reported.
 */
export async function findSecrets(dir: string, files: readonly Pick<BundleFile, "path" | "size">[]): Promise<Array<{ path: string; rules: string[] }>> {
	const out: Array<{ path: string; rules: string[] }> = [];
	for (const file of files) {
		if (file.size === 0 || file.size > SCAN_LIMIT) continue;
		let bytes: Buffer;
		try {
			bytes = await readFile(path.join(dir, ...file.path.split("/")));
		} catch {
			continue;
		}
		if (isBinary(bytes)) continue;
		const findings = scanForSecrets(bytes.toString("utf8"), file.path);
		if (findings.length > 0) out.push({ path: file.path, rules: [...new Set(findings.map((f) => f.rule))] });
	}
	return out;
}

/** What applying `archive` to `dir` would do, with unified diffs for the text files that would change. */
export async function previewFiles(projectId: string, archive: string, dir: string, base?: BundleManifest): Promise<FilesPreview> {
	const files = await guardBundle(() => previewBundle(archive, dir, base ? { base } : {}));
	const diffs: Record<string, string> = {};
	const wanted = files.filter((f) => (f.status === "update" || f.status === "conflict") && f.size <= TEXT_LIMIT).slice(0, MAX_DIFFS);
	if (wanted.length > 0) {
		const scratch = await mkdtemp(path.join(tmpdir(), "clam-preview-"));
		try {
			await guardBundle(() => applyBundle(archive, scratch, { paths: wanted.map((f) => f.path) }));
			for (const file of wanted) {
				const parts = file.path.split("/");
				const [local, incoming] = await Promise.all([readFile(path.join(dir, ...parts)).catch(() => null), readFile(path.join(scratch, ...parts)).catch(() => null)]);
				if (!local || !incoming || isBinary(local) || isBinary(incoming)) continue;
				diffs[file.path] = textDiff(local.toString("utf8"), incoming.toString("utf8"), file.path);
			}
		} finally {
			await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
		}
	}
	return { projectId, files, diffs };
}

/** Apply `archive` to `dir`: new and unchanged-locally files are written, a conflicting file only when listed in `overwrite`. Never deletes. */
export async function applyFiles(archive: string, dir: string, body: { paths?: string[] | undefined; overwrite: string[] }, base?: BundleManifest): Promise<FilesApplyResult> {
	const result = await guardBundle(() => applyBundle(archive, dir, { ...(base && { base }), ...(body.paths && { paths: body.paths }), overwrite: body.overwrite }));
	return { written: result.written, skipped: result.skipped };
}
