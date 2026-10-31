import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function isExecutable(path: string): Promise<boolean> {
	try {
		if (!(await stat(path)).isFile()) return false;
		await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Find `name` on PATH (honouring PATHEXT on Windows) and a few user-level install dirs. No shelling out. */
export async function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
	const names =
		process.platform === "win32"
			? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((ext) => `${name}${ext.toLowerCase()}`)
			: [name];
	const home = env.HOME ?? env.USERPROFILE ?? homedir();
	const dirs = [...(env.PATH ?? env.Path ?? "").split(delimiter), "/usr/local/bin", "/opt/homebrew/bin", join(home, ".local", "bin")];
	const seen = new Set<string>();
	for (const raw of dirs) {
		const dir = raw.trim();
		if (!dir || !isAbsolute(dir) || seen.has(dir)) continue;
		seen.add(dir);
		for (const candidate of names) {
			const full = join(dir, candidate);
			if (await isExecutable(full)) return full;
		}
	}
	return null;
}

/** First non-empty line of `<binary> <args>` output, or null on failure/timeout. */
export async function readVersionLine(binary: string, args: string[], timeoutMs = 5000): Promise<string | null> {
	try {
		const { stdout, stderr } = await execFileAsync(binary, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 });
		const line = `${stdout}\n${stderr}`.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
		return line ?? null;
	} catch {
		return null;
	}
}
