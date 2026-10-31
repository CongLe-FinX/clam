import { type ChildProcess, spawn } from "node:child_process";
import { scanForSecrets } from "@clam/git-engine";

export interface RunSetupOptions {
	command: string;
	cwd: string;
	/** Wall-clock limit; the whole process group is killed when it passes. */
	timeoutMs: number;
	signal?: AbortSignal;
	/** Called per output line (stdout and stderr), already secret-scrubbed. */
	onOutput?: (line: string, stream: "stdout" | "stderr") => void;
	/** Extra environment on top of `process.env`. */
	env?: Record<string, string | undefined>;
	/** Output lines kept for `outputTail` (default 200). */
	maxTailLines?: number;
	/** SIGTERM → SIGKILL grace after a timeout/abort (default 2000 ms). */
	killGraceMs?: number;
}

export interface RunSetupResult {
	/** Null when the process was killed by a signal or never started. */
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	aborted: boolean;
	durationMs: number;
	/** Last lines of combined output, secret-scrubbed. */
	outputTail: string;
	/** Spawn failure message, when the shell could not be started. */
	error: string | null;
}

/** Replaces a whole line with a marker when the shared scanner finds a credential in it. */
export function scrubOutputLine(line: string): string {
	const hits = scanForSecrets(line, "output.txt");
	if (hits.length === 0) return line;
	const rules = [...new Set(hits.map((h) => h.rule))].join(", ");
	return `[line redacted: possible secret (${rules})]`;
}

const POSIX = process.platform !== "win32";

/**
 * Runs `command` through the shell in `cwd`. On POSIX the child is its own process-group leader
 * (`detached`), so a timeout/abort kills exactly the group this call spawned (`kill(-pid)`) — the shell
 * and everything it started — and nothing else. Never rejects: failures are reported in the result.
 */
export function runSetupCommand(opts: RunSetupOptions): Promise<RunSetupResult> {
	const { promise, resolve } = Promise.withResolvers<RunSetupResult>();
	const started = Date.now();
	const maxTail = opts.maxTailLines ?? 200;
	const grace = opts.killGraceMs ?? 2000;
	const tail: string[] = [];
	let timedOut = false;
	let aborted = false;
	let settled = false;

	const finish = (exitCode: number | null, signal: NodeJS.Signals | null, error: string | null) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		clearTimeout(killTimer);
		clearTimeout(closeTimer);
		opts.signal?.removeEventListener("abort", onAbort);
		for (const stream of ["stdout", "stderr"] as const) flush(stream);
		resolve({ exitCode, signal, timedOut, aborted, durationMs: Date.now() - started, outputTail: tail.join("\n"), error });
	};

	if (opts.signal?.aborted) {
		resolve({ exitCode: null, signal: null, timedOut: false, aborted: true, durationMs: 0, outputTail: "", error: null });
		return promise;
	}

	let child: ChildProcess;
	try {
		child = spawn(opts.command, {
			cwd: opts.cwd,
			shell: true,
			detached: POSIX,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ...opts.env },
			windowsHide: true,
		});
	} catch (err) {
		// e.g. ENOTDIR/ENOENT for `cwd` is thrown synchronously by spawn
		resolve({ exitCode: null, signal: null, timedOut: false, aborted: false, durationMs: Date.now() - started, outputTail: "", error: err instanceof Error ? err.message : String(err) });
		return promise;
	}
	const { stdout, stderr } = child;
	if (!stdout || !stderr) throw new Error("spawn without piped stdio");

	const partial = { stdout: "", stderr: "" };
	const emit = (stream: "stdout" | "stderr", raw: string) => {
		const line = scrubOutputLine(raw.replace(/\r$/, ""));
		tail.push(line);
		if (tail.length > maxTail) tail.shift();
		opts.onOutput?.(line, stream);
	};
	const flush = (stream: "stdout" | "stderr") => {
		if (partial[stream] !== "") emit(stream, partial[stream]);
		partial[stream] = "";
	};
	const onData = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
		const parts = (partial[stream] + chunk.toString("utf8")).split("\n");
		partial[stream] = parts.pop() ?? "";
		for (const line of parts) emit(stream, line);
	};
	stdout.on("data", onData("stdout"));
	stderr.on("data", onData("stderr"));

	const killGroup = (signal: NodeJS.Signals) => {
		const pid = child.pid;
		if (pid === undefined) return;
		try {
			if (POSIX) process.kill(-pid, signal);
			else child.kill(signal);
		} catch {
			// group already gone
		}
	};
	let killTimer: NodeJS.Timeout | undefined;
	const terminate = () => {
		killGroup("SIGTERM");
		killTimer = setTimeout(() => killGroup("SIGKILL"), grace);
	};
	const timer = setTimeout(() => {
		timedOut = true;
		terminate();
	}, opts.timeoutMs);
	const onAbort = () => {
		aborted = true;
		terminate();
	};
	opts.signal?.addEventListener("abort", onAbort, { once: true });

	// A grandchild that outlives the shell can keep the pipes (and 'close') open: bound the wait after 'exit'.
	let closeTimer: NodeJS.Timeout | undefined;
	let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
	child.on("error", (err) => finish(null, null, err.message));
	child.on("exit", (code, signal) => {
		exited = { code, signal };
		closeTimer = setTimeout(() => {
			stdout.destroy();
			stderr.destroy();
			finish(code, signal, null);
		}, 1000);
	});
	child.on("close", (code, signal) => finish(exited?.code ?? code, exited?.signal ?? signal, null));
	return promise;
}
