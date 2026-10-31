import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";

export interface LocateOmpOptions {
	/** Explicit binary path (e.g. from settings / `CLAM_OMP_BIN`). Must exist and be executable; no fallback when set. */
	override?: string | null;
	env?: NodeJS.ProcessEnv;
}

async function isExecutableFile(path: string): Promise<boolean> {
	try {
		const info = await stat(path);
		if (!info.isFile()) return false;
		await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function executableNames(env: NodeJS.ProcessEnv): string[] {
	if (process.platform !== "win32") return ["omp"];
	const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
		.split(";")
		.map((ext) => ext.trim())
		.filter((ext) => ext.length > 0);
	return exts.map((ext) => `omp${ext.toLowerCase()}`);
}

/**
 * Find the `omp` executable without shelling out: explicit override, then `PATH`, then the usual
 * user-level install directories. Returns an absolute path or `null`.
 */
export async function locateOmpBinary(options: LocateOmpOptions = {}): Promise<string | null> {
	const env = options.env ?? process.env;
	const override = options.override?.trim();
	if (override) {
		const candidate = isAbsolute(override) ? override : resolve(override);
		return (await isExecutableFile(candidate)) ? candidate : null;
	}

	const home = env.HOME ?? env.USERPROFILE ?? homedir();
	const dirs = [
		...(env.PATH ?? env.Path ?? "").split(delimiter),
		join(home, ".bun", "bin"),
		join(home, ".local", "bin"),
		join(home, ".npm-global", "bin"),
		"/usr/local/bin",
		"/opt/homebrew/bin",
	];
	const names = executableNames(env);
	const seen = new Set<string>();
	for (const raw of dirs) {
		const dir = raw.trim();
		if (!dir || !isAbsolute(dir) || seen.has(dir)) continue;
		seen.add(dir);
		for (const name of names) {
			const candidate = join(dir, name);
			if (await isExecutableFile(candidate)) return candidate;
		}
	}
	return null;
}
