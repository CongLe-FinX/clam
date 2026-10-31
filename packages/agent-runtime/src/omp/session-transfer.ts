import { realpathSync } from "node:fs";
import { cp, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { AgentRuntimeError } from "../types.ts";

/** File-system operations used by `placeSessionFile`; injectable so the cross-device fallback can be tested. */
export interface SessionTransferFs {
	rename(from: string, to: string): Promise<void>;
}

const DEFAULT_FS: SessionTransferFs = { rename };

/**
 * Move an unpacked OMP session into a CLAM session directory so a runtime opened on that directory resumes it.
 *
 * Moves `<name>.jsonl` and, if present, its sibling artifacts directory `<name>/` into `targetDir` (created
 * recursively, mode 0o700) and returns the new absolute path of the jsonl. Uses `rename`, falling back to
 * copy-then-remove across devices (`EXDEV`). Refuses (`invalid_argument`) when `sessionFile` is not an existing
 * `.jsonl` file or when `targetDir` already contains a `*.jsonl`: a CLAM session directory must hold exactly
 * one conversation, because `open_session` resumes the newest journal found there. Only the moved source files
 * are ever removed.
 */
export async function placeSessionFile(sessionFile: string, targetDir: string, fs: SessionTransferFs = DEFAULT_FS): Promise<string> {
	if (typeof sessionFile !== "string" || !sessionFile.endsWith(".jsonl")) {
		throw new AgentRuntimeError("invalid_argument", `Not a session journal (.jsonl): ${JSON.stringify(sessionFile)}`);
	}
	if (typeof targetDir !== "string" || targetDir.length === 0) {
		throw new AgentRuntimeError("invalid_argument", "targetDir must not be empty");
	}
	const source = resolve(sessionFile);
	const target = resolve(targetDir);
	const info = await stat(source).catch(() => null);
	if (!info?.isFile()) throw new AgentRuntimeError("invalid_argument", `Session file does not exist: ${source}`);

	const name = basename(source, ".jsonl");
	const sourceArtifacts = join(resolve(source, ".."), name);
	const artifactsInfo = await stat(sourceArtifacts).catch(() => null);
	const hasArtifacts = artifactsInfo?.isDirectory() === true;

	await mkdir(target, { recursive: true, mode: 0o700 });
	const existing = (await readdir(target)).filter((entry) => entry.endsWith(".jsonl"));
	if (existing.length > 0) {
		throw new AgentRuntimeError("invalid_argument", `Session directory already contains a session: ${join(target, existing[0] as string)}`, {
			targetDir: target,
		});
	}

	const placed = join(target, basename(source));
	await move(fs, source, placed, false);
	if (hasArtifacts) await move(fs, sourceArtifacts, join(target, name), true);
	return placed;
}

async function move(fs: SessionTransferFs, from: string, to: string, directory: boolean): Promise<void> {
	try {
		await fs.rename(from, to);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
		await cp(from, to, { recursive: directory, errorOnExist: true, force: false });
		await rm(from, { recursive: directory, force: false });
	}
}

/**
 * The spelling OMP gives a project directory in a session header (`standardizeMacOSPath` in its `dirs.ts`): on macOS a
 * leading `/private` is dropped when the shorter path resolves to the same place (`/private/tmp/x` → `/tmp/x`). A session
 * resumes only when its header cwd equals OMP's own spelling of the process cwd, so `omp session unpack --cwd` must be given
 * this form even though CLAM stores real paths. Other platforms and unrelated paths are returned unchanged.
 */
export function standardizeProjectDir(dir: string, platform: NodeJS.Platform = process.platform, realpath: (p: string) => string = realpathSync): string {
	if (platform !== "darwin" || !dir.startsWith("/private/")) return dir;
	const stripped = dir.slice("/private".length);
	try {
		if (realpath(dir) === realpath(stripped)) return stripped;
	} catch {
		// A path that cannot be resolved keeps its spelling.
	}
	return dir;
}
