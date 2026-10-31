import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

export interface CloudflaredInfo {
	installed: boolean;
	version: string | null;
	binaryPath: string | null;
}

const WELL_KNOWN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/opt/local/bin", "/snap/bin"];

async function isExecutable(path: string): Promise<boolean> {
	try {
		await access(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Resolve the cloudflared executable: explicit path, PATH entries, then well-known install dirs. */
export async function resolveCloudflaredBinary(binary?: string): Promise<string | null> {
	const name = binary ?? "cloudflared";
	if (isAbsolute(name) || name.includes("/")) return (await isExecutable(name)) ? name : null;
	const dirs = [...(process.env.PATH ?? "").split(delimiter).filter(Boolean), ...WELL_KNOWN_DIRS];
	for (const dir of new Set(dirs)) {
		const candidate = join(dir, name);
		if (await isExecutable(candidate)) return candidate;
	}
	return null;
}

/** Extract the version token from `cloudflared --version` output, e.g. "cloudflared version 2026.10.5 (built ...)". */
export function parseCloudflaredVersion(output: string): string | null {
	const match = /cloudflared\s+version\s+(\S+)/i.exec(output);
	return match?.[1] ?? null;
}

function runVersion(binaryPath: string): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(binaryPath, ["--version"], { timeout: 5_000, windowsHide: true }, (err, stdout, stderr) => {
			if (err) return resolve(null);
			resolve(parseCloudflaredVersion(`${stdout}\n${stderr}`));
		});
	});
}

export async function detectCloudflared(o: { binary?: string } = {}): Promise<CloudflaredInfo> {
	const binaryPath = await resolveCloudflaredBinary(o.binary);
	if (!binaryPath) return { installed: false, version: null, binaryPath: null };
	const version = await runVersion(binaryPath);
	// A file that cannot report a version is not a usable cloudflared.
	if (!version) return { installed: false, version: null, binaryPath };
	return { installed: true, version, binaryPath };
}
