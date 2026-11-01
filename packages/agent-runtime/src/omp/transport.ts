import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { AgentRuntimeError, type RuntimeLogger } from "../types.ts";
import { RpcFrameDecoder, RpcFrameError } from "./frame-decoder.ts";
import {
	isOmpReadyFrame,
	isOmpResponseFrame,
	type OmpFrame,
	type OmpReadyFrame,
	type OmpResponseFrame,
} from "./frames.ts";

export interface OmpTransportOptions {
	command: string;
	args: string[];
	cwd?: string;
	/** Merged over `process.env`; an `undefined` value removes the variable. */
	env?: Record<string, string | undefined>;
	/** Max wait for the `ready` frame. Default 30000. */
	startTimeoutMs?: number;
	/** Default per-request timeout. Default 30000. */
	requestTimeoutMs?: number;
	/** Bytes of stderr retained. Default 16384. */
	stderrTailBytes?: number;
	log?: RuntimeLogger;
}

export interface TransportExit {
	code: number | null;
	signal: NodeJS.Signals | null;
	/** Set for spawn errors / protocol violations. */
	error?: Error;
	/** True when the exit followed close()/kill(). */
	expected: boolean;
	stderrTail: string;
}

export type TransportState = "idle" | "starting" | "ready" | "closing" | "exited";

interface PendingRequest {
	command: string;
	resolve: (data: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STDERR_TAIL_BYTES = 16_384;
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;
/** Allowance above the advertised physical frame limit (newline, encoder rounding). */
const LINE_SLACK_BYTES = 4096;
/** How long to wait for stdio to close after the process exited before giving up on trailing output. */
const STDIO_CLOSE_GRACE_MS = 2000;
const MAX_REMEMBERED_TIMEOUTS = 256;
const NEWLINE = 0x0a;

/**
 * One `omp --mode rpc` child process spoken to over JSONL stdio: framing, protocol v2 chunk reassembly,
 * request/response correlation by id, graceful shutdown and exit accounting.
 */
export class OmpTransport {
	readonly #options: OmpTransportOptions;
	readonly #log: RuntimeLogger | undefined;
	readonly #startTimeoutMs: number;
	readonly #requestTimeoutMs: number;
	readonly #stderrTailBytes: number;

	#state: TransportState = "idle";
	#child: ChildProcessWithoutNullStreams | undefined;
	#protocolVersion: 1 | 2 = 1;
	#ready: OmpReadyFrame | undefined;
	#decoder = new RpcFrameDecoder({ maxReassembledBytes: DEFAULT_MAX_REASSEMBLED_BYTES });
	#lineLimit = DEFAULT_MAX_FRAME_BYTES + LINE_SLACK_BYTES;
	#partial: Buffer[] = [];
	#partialBytes = 0;

	#idCounter = 0;
	readonly #pending = new Map<string, PendingRequest>();
	readonly #timedOut = new Set<string>();
	readonly #frameListeners = new Set<(frame: OmpFrame | OmpResponseFrame) => void>();
	readonly #exitListeners = new Set<(exit: TransportExit) => void>();

	#stderr: Buffer = Buffer.alloc(0);
	#stderrLineRemainder = "";

	#startWaiter: { resolve: (frame: OmpReadyFrame) => void; reject: (error: Error) => void } | undefined;
	#startTimer: NodeJS.Timeout | undefined;
	#closeRequested = false;
	#killRequested = false;
	#fatal: Error | undefined;
	#exitCode: number | null = null;
	#exitSignal: NodeJS.Signals | null = null;
	#exitSeen = false;
	#stdioGraceTimer: NodeJS.Timeout | undefined;
	#termTimer: NodeJS.Timeout | undefined;
	#killTimer: NodeJS.Timeout | undefined;
	#exit: TransportExit | undefined;
	#closePromise: Promise<TransportExit> | undefined;
	#exitWaiters: Array<(exit: TransportExit) => void> = [];

	constructor(options: OmpTransportOptions) {
		this.#options = options;
		this.#log = options.log;
		this.#startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
		this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.#stderrTailBytes = options.stderrTailBytes ?? DEFAULT_STDERR_TAIL_BYTES;
	}

	get pid(): number | undefined {
		return this.#child?.pid;
	}

	get state(): TransportState {
		return this.#state;
	}

	/** Largest physical frame OMP accepts and sends, per its ready frame (1 MiB until the ready frame arrived). */
	get maxFrameBytes(): number {
		return this.#ready?.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
	}

	get protocolVersion(): 1 | 2 {
		return this.#protocolVersion;
	}

	/** Spawn, wait for the ready frame, then negotiate protocol v2 when advertised (falls back to v1 + log). */
	async start(): Promise<OmpReadyFrame> {
		if (this.#state !== "idle") {
			throw new AgentRuntimeError("invalid_state", `Transport cannot start from state "${this.#state}"`);
		}
		this.#state = "starting";
		const ready = await new Promise<OmpReadyFrame>((resolve, reject) => {
			this.#startWaiter = { resolve, reject };
			this.#startTimer = setTimeout(() => {
				this.#startTimer = undefined;
				this.#failStart(
					new AgentRuntimeError(
						"start_failed",
						`OMP did not send its ready frame within ${this.#startTimeoutMs} ms`,
						{ stderrTail: this.stderrTail() },
					),
				);
				this.#killChild();
			}, this.#startTimeoutMs);
			this.#startTimer.unref();
			this.#spawn();
		});

		if (ready.supportedProtocolVersions.includes(2)) {
			try {
				await this.#requestInternal("negotiate_protocol", { protocolVersion: 2 }, undefined, undefined);
				this.#protocolVersion = 2;
			} catch (error) {
				if ((this.#state as TransportState) !== "ready") {
					throw new AgentRuntimeError("start_failed", "OMP exited during protocol negotiation", {
						stderrTail: this.stderrTail(),
						cause: error instanceof Error ? error.message : String(error),
					});
				}
				this.#log?.warn({ err: error instanceof Error ? error.message : String(error) }, "omp protocol v2 negotiation failed; staying on v1");
			}
		}
		return ready;
	}

	/**
	 * Send a command and resolve with `response.data`. Rejects with AgentRuntimeError: `rejected`, `timeout`,
	 * `process_exited`, `invalid_state`. `opts.id` selects the wire id (prompt uses its promptId).
	 */
	request<T = unknown>(
		type: string,
		payload?: Record<string, unknown>,
		opts?: { timeoutMs?: number; id?: string },
	): Promise<T> {
		if (this.#state !== "ready") {
			return Promise.reject(
				new AgentRuntimeError("invalid_state", `Cannot send "${type}": transport is ${this.#state}`),
			);
		}
		return this.#requestInternal(type, payload, opts?.timeoutMs, opts?.id) as Promise<T>;
	}

	/** Fire-and-forget raw frame (e.g. extension_ui_response). Throws `invalid_state` when not writable. */
	send(frame: Record<string, unknown>): void {
		if (this.#state !== "ready" && this.#state !== "starting" && this.#state !== "closing") {
			throw new AgentRuntimeError("invalid_state", `Cannot send frame: transport is ${this.#state}`);
		}
		if (!this.#write(frame)) {
			throw new AgentRuntimeError("invalid_state", "Cannot send frame: stdin is closed");
		}
	}

	/** Every frame that is not a matched response, after reassembly, in wire order. */
	onFrame(listener: (frame: OmpFrame | OmpResponseFrame) => void): () => void {
		this.#frameListeners.add(listener);
		return () => {
			this.#frameListeners.delete(listener);
		};
	}

	/** Fires exactly once when the process is gone. A listener added after exit is invoked asynchronously. */
	onExit(listener: (exit: TransportExit) => void): () => void {
		if (this.#exit) {
			const exit = this.#exit;
			queueMicrotask(() => this.#callExitListener(listener, exit));
			return () => {};
		}
		this.#exitListeners.add(listener);
		return () => {
			this.#exitListeners.delete(listener);
		};
	}

	stderrTail(): string {
		return this.#stderr.toString("utf8");
	}

	/** Graceful: end stdin, keep reading stdout, SIGTERM after graceMs/2, SIGKILL after graceMs. Idempotent. */
	close(options?: { graceMs?: number }): Promise<TransportExit> {
		if (this.#closePromise) return this.#closePromise;
		const graceMs = options?.graceMs ?? 5000;
		this.#closePromise = new Promise<TransportExit>((resolve) => {
			if (this.#exit) {
				resolve(this.#exit);
				return;
			}
			this.#exitWaiters.push(resolve);
			if (this.#state === "idle" || !this.#child) {
				this.#closeRequested = true;
				this.#finalize();
				return;
			}
			this.#closeRequested = true;
			this.#state = "closing";
			try {
				this.#child.stdin.end();
			} catch {
				// stdin already gone; escalation below still applies.
			}
			this.#termTimer = setTimeout(() => {
				this.#termTimer = undefined;
				this.#log?.warn({ pid: this.pid }, "omp did not exit after stdin close; sending SIGTERM");
				this.#signal("SIGTERM");
			}, Math.floor(graceMs / 2));
			this.#killTimer = setTimeout(() => {
				this.#killTimer = undefined;
				this.#log?.warn({ pid: this.pid }, "omp did not exit after SIGTERM; sending SIGKILL");
				this.#signal("SIGKILL");
			}, graceMs);
			this.#termTimer.unref();
			this.#killTimer.unref();
		});
		return this.#closePromise;
	}

	/** Immediate SIGKILL. */
	kill(): void {
		this.#killRequested = true;
		if (this.#state === "idle") {
			this.#finalize();
			return;
		}
		if (this.#state !== "exited") this.#state = "closing";
		this.#signal("SIGKILL");
	}

	// --- internals -------------------------------------------------------------------------------------------

	#spawn(): void {
		const env: NodeJS.ProcessEnv = { ...process.env };
		for (const [key, value] of Object.entries(this.#options.env ?? {})) {
			if (value === undefined) delete env[key];
			else env[key] = value;
		}
		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn(this.#options.command, this.#options.args, {
				cwd: this.#options.cwd,
				env,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (error) {
			this.#fatal = error instanceof Error ? error : new Error(String(error));
			this.#finalize();
			return;
		}
		this.#child = child;
		child.on("error", (error: NodeJS.ErrnoException) => {
			if (child.pid === undefined) {
				// Spawn failure (ENOENT/EACCES/bad cwd); 'close' may or may not follow, so finalize directly.
				this.#fatal = error;
				this.#finalize();
				return;
			}
			this.#log?.warn({ err: error.message }, "omp child process error");
		});
		child.stdin.on("error", (error: NodeJS.ErrnoException) => {
			// EPIPE after the process exited is expected during shutdown/crash.
			this.#log?.debug({ code: error.code }, "omp stdin error");
		});
		child.stdout.on("data", (chunk: Buffer) => this.#onStdout(chunk));
		child.stdout.on("error", (error) => this.#log?.debug({ err: error.message }, "omp stdout error"));
		child.stderr.on("data", (chunk: Buffer) => this.#onStderr(chunk));
		child.stderr.on("error", (error) => this.#log?.debug({ err: error.message }, "omp stderr error"));
		child.on("exit", (code, signal) => {
			this.#exitSeen = true;
			this.#exitCode = code;
			this.#exitSignal = signal;
			// Keep draining stdout until the pipes close, but never wait forever on a leaked grandchild.
			this.#stdioGraceTimer = setTimeout(() => {
				this.#stdioGraceTimer = undefined;
				child.stdout.destroy();
				child.stderr.destroy();
				this.#finalize();
			}, STDIO_CLOSE_GRACE_MS);
			this.#stdioGraceTimer.unref();
		});
		child.on("close", (code, signal) => {
			if (!this.#exitSeen) {
				this.#exitCode = code;
				this.#exitSignal = signal;
			}
			this.#finalize();
		});
	}

	#onStdout(chunk: Buffer): void {
		if (this.#fatal || this.#exit) return;
		let start = 0;
		for (;;) {
			const newline = chunk.indexOf(NEWLINE, start);
			if (newline === -1) {
				const rest = chunk.subarray(start);
				if (rest.length > 0) {
					this.#partial.push(rest);
					this.#partialBytes += rest.length;
					if (this.#partialBytes > this.#lineLimit) {
						this.#protocolViolation(
							new RpcFrameError(`stdout line exceeds the frame limit of ${this.#lineLimit} bytes`),
						);
					}
				}
				return;
			}
			const piece = chunk.subarray(start, newline);
			start = newline + 1;
			let line: Buffer;
			if (this.#partial.length > 0) {
				this.#partial.push(piece);
				line = Buffer.concat(this.#partial);
				this.#partial = [];
				this.#partialBytes = 0;
			} else {
				line = piece;
			}
			if (line.length > this.#lineLimit) {
				this.#protocolViolation(
					new RpcFrameError(`stdout line of ${line.length} bytes exceeds the frame limit of ${this.#lineLimit}`),
				);
				return;
			}
			this.#handleLine(line);
			if (this.#fatal || this.#exit) return;
		}
	}

	#handleLine(raw: Buffer): void {
		let line = raw;
		if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
		if (line.length === 0) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
		} catch (error) {
			this.#protocolViolation(
				new RpcFrameError(`invalid JSON line on stdout: ${error instanceof Error ? error.message : String(error)}`),
			);
			return;
		}
		let frame: object | null;
		try {
			frame = this.#decoder.push(parsed);
		} catch (error) {
			this.#protocolViolation(error instanceof Error ? error : new RpcFrameError(String(error)));
			return;
		}
		if (frame === null) return;
		this.#dispatch(frame as Record<string, unknown>);
	}

	#dispatch(frame: Record<string, unknown>): void {
		if (this.#state === "starting" && this.#startWaiter && isOmpReadyFrame(frame)) {
			this.#ready = frame;
			this.#lineLimit = frame.maxFrameBytes + LINE_SLACK_BYTES;
			this.#decoder = new RpcFrameDecoder({ maxReassembledBytes: frame.maxReassembledFrameBytes });
			const waiter = this.#startWaiter;
			this.#startWaiter = undefined;
			clearTimeout(this.#startTimer);
			this.#startTimer = undefined;
			this.#state = "ready";
			waiter.resolve(frame);
			return;
		}
		if (isOmpResponseFrame(frame) && typeof frame.id === "string") {
			const pending = this.#pending.get(frame.id);
			if (pending) {
				this.#pending.delete(frame.id);
				clearTimeout(pending.timer);
				if (frame.success) {
					pending.resolve(frame.data);
				} else {
					pending.reject(
						new AgentRuntimeError(
							"rejected",
							frame.error ?? `OMP rejected "${pending.command}"`,
							{ command: frame.command, runtimeCode: frame.code, error: frame.error },
						),
					);
				}
				return;
			}
			if (this.#timedOut.delete(frame.id)) {
				this.#log?.debug({ id: frame.id, command: frame.command }, "ignoring late response to a timed-out request");
			}
		}
		this.#emitFrame(frame as OmpFrame | OmpResponseFrame);
	}

	#emitFrame(frame: OmpFrame | OmpResponseFrame): void {
		for (const listener of [...this.#frameListeners]) {
			try {
				listener(frame);
			} catch (error) {
				this.#log?.error({ err: error instanceof Error ? error.message : String(error) }, "omp frame listener threw");
			}
		}
	}

	#onStderr(chunk: Buffer): void {
		this.#stderr = Buffer.concat([this.#stderr, chunk]);
		if (this.#stderr.length > this.#stderrTailBytes) {
			this.#stderr = this.#stderr.subarray(this.#stderr.length - this.#stderrTailBytes);
		}
		if (!this.#log) return;
		const text = this.#stderrLineRemainder + chunk.toString("utf8");
		const lines = text.split("\n");
		this.#stderrLineRemainder = lines.pop() ?? "";
		if (this.#stderrLineRemainder.length > 8192) {
			lines.push(this.#stderrLineRemainder);
			this.#stderrLineRemainder = "";
		}
		for (const line of lines) {
			if (line.length > 0) this.#log.debug({ pid: this.pid, stderr: line }, "omp stderr");
		}
	}

	#requestInternal(
		type: string,
		payload: Record<string, unknown> | undefined,
		timeoutMs: number | undefined,
		id: string | undefined,
	): Promise<unknown> {
		const wireId = id ?? `r${++this.#idCounter}`;
		if (this.#pending.has(wireId)) {
			return Promise.reject(new AgentRuntimeError("invalid_state", `Duplicate request id "${wireId}"`));
		}
		return new Promise<unknown>((resolve, reject) => {
			const effectiveTimeout = timeoutMs ?? this.#requestTimeoutMs;
			const timer = setTimeout(() => {
				if (this.#pending.delete(wireId)) {
					this.#timedOut.add(wireId);
					if (this.#timedOut.size > MAX_REMEMBERED_TIMEOUTS) {
						const oldest = this.#timedOut.values().next().value;
						if (oldest !== undefined) this.#timedOut.delete(oldest);
					}
					reject(
						new AgentRuntimeError("timeout", `OMP did not answer "${type}" within ${effectiveTimeout} ms`, {
							command: type,
							id: wireId,
						}),
					);
				}
			}, effectiveTimeout);
			timer.unref();
			this.#pending.set(wireId, { command: type, resolve, reject, timer });
			if (!this.#write({ ...payload, id: wireId, type })) {
				this.#pending.delete(wireId);
				clearTimeout(timer);
				reject(new AgentRuntimeError("process_exited", `Cannot send "${type}": OMP stdin is closed`));
			}
		});
	}

	/** Returns false when stdin is not writable. Never throws. */
	#write(frame: Record<string, unknown>): boolean {
		const stdin = this.#child?.stdin;
		if (!stdin || stdin.destroyed || !stdin.writable || stdin.writableEnded) return false;
		try {
			// Node buffers writes internally when the pipe is full; the 'error' listener swallows EPIPE.
			stdin.write(`${JSON.stringify(frame)}\n`, "utf8");
			return true;
		} catch (error) {
			this.#log?.debug({ err: error instanceof Error ? error.message : String(error) }, "omp stdin write failed");
			return false;
		}
	}

	#protocolViolation(error: Error): void {
		if (this.#fatal) return;
		this.#fatal = error;
		this.#log?.error({ err: error.message }, "omp protocol violation; killing process");
		const failure = new AgentRuntimeError("protocol", error.message, { stderrTail: this.stderrTail() });
		this.#failStart(failure);
		this.#rejectPending(failure);
		this.#killChild();
	}

	#killChild(): void {
		if (this.#state !== "exited") this.#state = this.#state === "idle" ? "idle" : "closing";
		this.#signal("SIGKILL");
	}

	#signal(signal: NodeJS.Signals): void {
		const child = this.#child;
		if (!child || this.#exit || child.pid === undefined) return;
		try {
			child.kill(signal);
		} catch (error) {
			this.#log?.debug({ err: error instanceof Error ? error.message : String(error) }, "omp kill failed");
		}
	}

	#failStart(error: Error): void {
		const waiter = this.#startWaiter;
		if (!waiter) return;
		this.#startWaiter = undefined;
		clearTimeout(this.#startTimer);
		this.#startTimer = undefined;
		waiter.reject(error);
	}

	#rejectPending(error: Error): void {
		const pending = [...this.#pending.values()];
		this.#pending.clear();
		for (const entry of pending) {
			clearTimeout(entry.timer);
			entry.reject(error);
		}
	}

	#finalize(): void {
		if (this.#exit) return;
		// Trailing output without a final newline is still a frame if it parses.
		if (this.#partial.length > 0 && !this.#fatal) {
			const line = Buffer.concat(this.#partial);
			this.#partial = [];
			this.#partialBytes = 0;
			this.#handleLine(line);
		}
		clearTimeout(this.#stdioGraceTimer);
		clearTimeout(this.#termTimer);
		clearTimeout(this.#killTimer);
		this.#stdioGraceTimer = this.#termTimer = this.#killTimer = undefined;
		this.#state = "exited";

		const tail = this.stderrTail();
		const spawnFailed = this.#child === undefined || this.#child.pid === undefined;
		let startError: Error;
		if (spawnFailed) {
			const cause = this.#fatal as NodeJS.ErrnoException | undefined;
			const code = cause?.code;
			const hint =
				code === "ENOENT"
					? `executable "${this.#options.command}" (or working directory "${this.#options.cwd ?? process.cwd()}") not found`
					: code === "EACCES"
						? `executable "${this.#options.command}" is not executable (permission denied)`
						: (cause?.message ?? "spawn failed");
			startError = new AgentRuntimeError("start_failed", `Failed to start OMP: ${hint}`, {
				errno: code,
				command: this.#options.command,
				cwd: this.#options.cwd,
			});
		} else {
			startError = new AgentRuntimeError(
				"start_failed",
				`OMP exited before it was ready (code ${this.#exitCode ?? "null"}, signal ${this.#exitSignal ?? "none"})`,
				{ code: this.#exitCode, signal: this.#exitSignal, stderrTail: tail },
			);
		}
		this.#failStart(this.#fatal instanceof RpcFrameError ? this.#fatal : startError);
		this.#rejectPending(
			new AgentRuntimeError("process_exited", "OMP process exited while the request was pending", {
				code: this.#exitCode,
				signal: this.#exitSignal,
				stderrTail: tail,
			}),
		);

		const exit: TransportExit = {
			code: this.#exitCode,
			signal: this.#exitSignal,
			expected: (this.#closeRequested || this.#killRequested) && !(this.#fatal instanceof RpcFrameError),
			stderrTail: tail,
		};
		if (this.#fatal) exit.error = this.#fatal;
		this.#exit = exit;
		const listeners = [...this.#exitListeners];
		this.#exitListeners.clear();
		for (const listener of listeners) this.#callExitListener(listener, exit);
		const waiters = this.#exitWaiters;
		this.#exitWaiters = [];
		for (const waiter of waiters) waiter(exit);
	}

	#callExitListener(listener: (exit: TransportExit) => void, exit: TransportExit): void {
		try {
			listener(exit);
		} catch (error) {
			this.#log?.error({ err: error instanceof Error ? error.message : String(error) }, "omp exit listener threw");
		}
	}
}
