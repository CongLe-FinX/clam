import { type ChildProcess, spawn } from "node:child_process";
import { GitEngineError, classifyFailure, scrub } from "./errors.ts";
import type { AskpassBroker, GitAuth } from "./askpass.ts";

export interface RunOptions {
	cwd?: string;
	/** Written to stdin, then stdin is closed. */
	input?: string | Buffer;
	/** Extra environment variables (e.g. GIT_AUTHOR_NAME). */
	env?: Record<string, string>;
	timeoutMs?: number;
	signal?: AbortSignal;
	maxStdout?: number;
	/** Exit codes that are not failures (default `[0]`). */
	okCodes?: number[];
	/** Network command: disables credential helpers and wires askpass when `auth` is set. */
	network?: boolean;
	auth?: GitAuth;
	/** Called for every stderr line / carriage-return progress update. */
	onStderrLine?: (line: string) => void;
}

export interface RunResult {
	code: number;
	stdout: Buffer;
	/** Credential-scrubbed. */
	stderr: string;
	/** stdout hit `maxStdout` and the process was stopped. */
	truncated: boolean;
}

export interface Runner {
	run(argv: string[], opts?: RunOptions): Promise<RunResult>;
	/** Like `run` but returns stdout as UTF-8 text and throws for non-ok exit codes. */
	text(argv: string[], opts?: RunOptions): Promise<string>;
}

const DEFAULT_TIMEOUT = 60_000;
const NETWORK_TIMEOUT = 15 * 60_000;
const DEFAULT_MAX_STDOUT = 32 * 1024 * 1024;
const MAX_STDERR = 1024 * 1024;

/** Variables that would redirect git to a different repository or inject identity/config behind our back. */
const STRIPPED_ENV = new Set([
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_PREFIX",
	"GIT_NAMESPACE",
	"GIT_ASKPASS",
	"GIT_AUTHOR_NAME",
	"GIT_AUTHOR_EMAIL",
	"GIT_AUTHOR_DATE",
	"GIT_COMMITTER_NAME",
	"GIT_COMMITTER_EMAIL",
	"GIT_COMMITTER_DATE",
	"GIT_CONFIG_COUNT",
	"GIT_CONFIG_PARAMETERS",
	"GIT_EDITOR",
	"GIT_SEQUENCE_EDITOR",
	"GIT_PAGER",
	"GIT_TERMINAL_PROMPT",
	"SSH_ASKPASS",
	"CLAM_ASKPASS_NONCE",
	"CLAM_ASKPASS_SOCKET",
]);

function baseEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v === undefined || STRIPPED_ENV.has(k) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)) continue;
		env[k] = v;
	}
	return env;
}

export function createRunner(gitBinary: string, broker: AskpassBroker, log?: { debug(o: object, m?: string): void }): Runner {
	const run = (argv: string[], opts: RunOptions = {}): Promise<RunResult> => {
		const full: string[] = [];
		if (opts.network) {
			// Never let a credential helper (osxkeychain, manager, …) read or *store* the token.
			full.push("-c", "credential.helper=", "-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=120");
		}
		// Never let user config stash or sign behind an automation's back.
		full.push("-c", "merge.autoStash=false", "-c", "rebase.autoStash=false", "-c", "commit.gpgSign=false", "-c", "core.fsmonitor=false");
		full.push(...argv);

		const env: Record<string, string> = {
			...baseEnv(),
			LC_ALL: "C",
			LANGUAGE: "C",
			GIT_TERMINAL_PROMPT: "0",
			GIT_OPTIONAL_LOCKS: "0",
			GIT_EDITOR: "true",
			GIT_SEQUENCE_EDITOR: "true",
			GIT_PAGER: "cat",
			GIT_MERGE_AUTOEDIT: "no",
			...opts.env,
		};
		const lease = opts.network && opts.auth ? broker.lease(opts.auth) : null;
		if (lease) Object.assign(env, lease.env);

		const maxStdout = opts.maxStdout ?? DEFAULT_MAX_STDOUT;
		const timeoutMs = opts.timeoutMs ?? (opts.network ? NETWORK_TIMEOUT : DEFAULT_TIMEOUT);
		log?.debug({ argv: full, cwd: opts.cwd }, "git");

		return new Promise<RunResult>((resolve, reject) => {
			let child: ChildProcess;
			try {
				child = spawn(gitBinary, full, {
					cwd: opts.cwd,
					env,
					stdio: ["pipe", "pipe", "pipe"],
					windowsHide: true,
					shell: false,
				});
			} catch (err) {
				lease?.release();
				reject(spawnError(err));
				return;
			}
			const out: Buffer[] = [];
			let outLen = 0;
			let truncated = false;
			const errChunks: Buffer[] = [];
			let errLen = 0;
			let pending = "";
			let timedOut = false;
			let aborted = false;
			let settled = false;
			let killTimer: NodeJS.Timeout | undefined;

			const kill = () => {
				if (child.exitCode !== null || child.signalCode !== null) return;
				child.kill("SIGTERM");
				killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
			};
			const timer = setTimeout(() => {
				timedOut = true;
				kill();
			}, timeoutMs);
			const onAbort = () => {
				aborted = true;
				kill();
			};
			if (opts.signal) {
				if (opts.signal.aborted) onAbort();
				else opts.signal.addEventListener("abort", onAbort, { once: true });
			}

			let finishSecrets: Set<string> | undefined;
			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (killTimer) clearTimeout(killTimer);
				opts.signal?.removeEventListener("abort", onAbort);
				const secrets = lease ? new Set(lease.secrets) : undefined;
				lease?.release();
				finishSecrets = secrets;
				fn();
			};

			child.stdout?.on("data", (chunk: Buffer) => {
				if (truncated) return;
				if (outLen + chunk.length > maxStdout) {
					out.push(chunk.subarray(0, maxStdout - outLen));
					outLen = maxStdout;
					truncated = true;
					kill();
					return;
				}
				out.push(chunk);
				outLen += chunk.length;
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				if (errLen < MAX_STDERR) {
					errChunks.push(chunk);
					errLen += chunk.length;
				}
				if (opts.onStderrLine) {
					pending += chunk.toString("utf8");
					const parts = pending.split(/[\r\n]/);
					pending = parts.pop() ?? "";
					for (const line of parts) if (line) opts.onStderrLine(scrub(line, lease?.secrets));
				}
			});
			child.stdin?.on("error", () => {});
			if (opts.input !== undefined) child.stdin?.end(opts.input);
			else child.stdin?.end();

			child.on("error", (err) => finish(() => reject(spawnError(err))));
			child.on("close", (code, signal) => {
				finish(() => {
					if (opts.onStderrLine && pending) opts.onStderrLine(scrub(pending, finishSecrets));
					const stderr = scrub(Buffer.concat(errChunks).toString("utf8"), finishSecrets);
					if (timedOut) {
						reject(new GitEngineError("timeout", `git ${argv[0] ?? ""} timed out after ${Math.round(timeoutMs / 1000)}s`, stderr));
						return;
					}
					if (aborted) {
						reject(new GitEngineError("failed", `git ${argv[0] ?? ""} was aborted`, stderr, { cause: opts.signal?.reason }));
						return;
					}
					const exit = code ?? (signal ? 128 : 1);
					const stdout = Buffer.concat(out);
					resolve({ code: exit, stdout: finishSecrets?.size ? Buffer.from(scrub(stdout.toString("utf8"), finishSecrets)) : stdout, stderr, truncated });
				});
			});
		});
	};

	return {
		run,
		async text(argv, opts) {
			const r = await run(argv, opts);
			const ok = opts?.okCodes ?? [0];
			if (!ok.includes(r.code)) throw failure(argv, r);
			return r.stdout.toString("utf8");
		},
	};
}

function spawnError(err: unknown): GitEngineError {
	const e = err as NodeJS.ErrnoException;
	if (e?.code === "ENOENT") return new GitEngineError("git_missing", "git executable not found", "", { cause: err });
	return new GitEngineError("failed", e?.message ?? "failed to start git", "", { cause: err });
}

/** Builds the error for a non-ok result. */
export function failure(argv: string[], r: RunResult): GitEngineError {
	const detail = r.stderr.trim() || r.stdout.toString("utf8").trim();
	const code = classifyFailure(r.stderr);
	return new GitEngineError(code, `git ${argv[0] ?? ""} failed (exit ${r.code})${detail ? `: ${firstLines(detail, 6)}` : ""}`, r.stderr);
}

function firstLines(text: string, n: number): string {
	return text.split("\n").slice(0, n).join("\n");
}
