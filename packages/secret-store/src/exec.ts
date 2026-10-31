import { spawn } from "node:child_process";

export interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
	/** True when the binary could not be started (ENOENT, EACCES). */
	spawnFailed: boolean;
}

/**
 * Runs a binary without a shell. `input` is written to stdin, so secrets never
 * appear in argv (visible to other local users via `ps`).
 */
export function run(
	command: string,
	args: readonly string[],
	opts: { input?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
	return new Promise((resolve) => {
		const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (result: RunResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish({ code: null, stdout, stderr: `${stderr}timed out`.trim(), spawnFailed: false });
		}, opts.timeoutMs ?? 15_000);
		child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
		child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
		child.on("error", (err) => finish({ code: null, stdout, stderr: String(err), spawnFailed: true }));
		child.on("close", (code) => finish({ code, stdout, stderr, spawnFailed: false }));
		// EPIPE when the child exits before reading stdin is reported via exit code instead.
		child.stdin.on("error", () => {});
		child.stdin.end(opts.input ?? "");
	});
}
