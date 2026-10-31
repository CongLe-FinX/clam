import { execFile } from "node:child_process";
import { UsageError } from "./errors.ts";

const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Runs `omp <args>` (no shell) and parses its stdout as JSON.
 * Both `omp stats --json` and `omp usage --json` print a single JSON document.
 */
export function runOmpJson(binary: string, args: readonly string[], timeoutMs: number): Promise<unknown> {
	return new Promise((resolve, reject) => {
		execFile(
			binary,
			[...args],
			{ timeout: timeoutMs, maxBuffer: MAX_BUFFER, windowsHide: true, env: { ...process.env, NO_COLOR: "1" } },
			(err, stdout, stderr) => {
				if (err) {
					const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
					if (e.code === "ENOENT") return reject(new UsageError("omp_missing", `omp binary not found at ${binary}`));
					if (e.killed && e.signal) {
						return reject(new UsageError("omp_timeout", `omp ${args.join(" ")} timed out after ${Math.round(timeoutMs / 1000)}s`));
					}
					const detail = (String(stderr).trim() || e.message).split("\n").slice(-3).join(" ").slice(0, 400);
					return reject(new UsageError("omp_failed", `omp ${args.join(" ")} failed: ${detail}`));
				}
				try {
					resolve(parseJsonDocument(String(stdout)));
				} catch {
					reject(new UsageError("bad_output", `omp ${args.join(" ")} did not print valid JSON`));
				}
			},
		);
	});
}

/** `omp stats --json` prints "Syncing session files…" lines first; the document starts at the first line beginning with `{`. */
export function parseJsonDocument(text: string): unknown {
	const trimmed = text.trim();
	try {
		return JSON.parse(trimmed);
	} catch {
		const start = trimmed.search(/^\{/m);
		if (start <= 0) throw new Error("no JSON");
		return JSON.parse(trimmed.slice(start));
	}
}
