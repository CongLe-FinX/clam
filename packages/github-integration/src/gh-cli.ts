import { execFile } from "node:child_process";
import { GithubError } from "./errors.ts";

export interface ExecResult {
	code: number | null;
	stdout: string;
	stderr: string;
	missing: boolean;
}

export type RunGh = (args: string[]) => Promise<ExecResult>;

const CANDIDATES = ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"];

function exec(bin: string, args: string[]): Promise<ExecResult> {
	return new Promise((resolve) => {
		execFile(bin, args, { timeout: 15_000, windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } }, (err, stdout, stderr) => {
			const e = err as (NodeJS.ErrnoException & { code?: string | number }) | null;
			if (e && e.code === "ENOENT") return resolve({ code: null, stdout: "", stderr: "", missing: true });
			resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), missing: false });
		});
	});
}

/** Default `gh` runner: tries PATH first, then common install locations (the server may start with a minimal PATH). */
export function createGhRunner(): RunGh {
	let resolved: string | null = null;
	return async (args) => {
		const order = resolved ? [resolved] : CANDIDATES;
		for (const bin of order) {
			const res = await exec(bin, args);
			if (!res.missing) {
				resolved = bin;
				return res;
			}
		}
		return { code: null, stdout: "", stderr: "", missing: true };
	};
}

/** Scopes listed on the `Token scopes:` line of `gh auth status`. */
export function parseGhStatusScopes(output: string): string[] {
	const line = output.split("\n").find((l) => /token scopes:/i.test(l));
	if (!line) return [];
	return [...line.matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
}

export interface GhCredentials {
	token: string;
	scopes: string[];
}

/** Reads the active github.com token + scopes from the user's `gh` login. The `gh` login itself is never modified. */
export async function readGhCredentials(runGh: RunGh): Promise<GhCredentials> {
	const tokenRes = await runGh(["auth", "token", "--hostname", "github.com"]);
	if (tokenRes.missing) throw new GithubError(409, "gh_unavailable", "The GitHub CLI (gh) is not installed.");
	const token = tokenRes.stdout.trim();
	if (tokenRes.code !== 0 || !token) {
		throw new GithubError(409, "gh_unavailable", "The GitHub CLI is not logged in to github.com. Run `gh auth login` first.");
	}
	const statusRes = await runGh(["auth", "status", "--hostname", "github.com"]);
	return { token, scopes: parseGhStatusScopes(`${statusRes.stdout}\n${statusRes.stderr}`) };
}

export async function ghLoggedIn(runGh: RunGh): Promise<boolean> {
	const res = await runGh(["auth", "status", "--hostname", "github.com"]);
	return !res.missing && res.code === 0;
}
