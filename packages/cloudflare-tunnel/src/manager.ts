import { type ChildProcess, spawn } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { type I18nMessage, type I18nText, i18nMsg, plainMsg } from "@clam/contracts";
import { resolveCloudflaredBinary } from "./detect.ts";

export type TunnelRunConfig = { mode: "quick" } | { mode: "named"; token: string; hostname: string };

export interface TunnelRuntimeState {
	state: "stopped" | "starting" | "running" | "reconnecting" | "error";
	mode: "off" | "quick" | "named";
	publicUrl: string | null;
	pid: number | null;
	connections: number;
	lastError: string | null;
	/** Structured twin of `lastError` for localisation when the error is our own text (cloudflared's own log lines have none). */
	lastErrorI18n?: I18nText | null;
	startedAt: string | null;
}

export interface TunnelManager {
	start(c: TunnelRunConfig): Promise<TunnelRuntimeState>;
	stop(): Promise<TunnelRuntimeState>;
	state(): TunnelRuntimeState;
	onChange(l: (s: TunnelRuntimeState) => void): () => void;
	dispose(): Promise<void>;
}

export interface CreateTunnelManagerOptions {
	binary?: string;
	/** Directory for the 0600 token file (`<runtimeDir>/tunnel-token`). */
	runtimeDir: string;
	/** Local origin for quick tunnels, e.g. `http://127.0.0.1:4318`. Named tunnels route via the Cloudflare dashboard. */
	originUrl: string;
	log?: { info(o: object, m?: string): void; warn(o: object, m?: string): void };
	/** Metrics `/ready` poll interval while not yet running / reconnecting. Default 500 ms. */
	readyPollMs?: number;
	/** Metrics `/ready` poll interval while running (connection count refresh). Default 5 s. */
	runningPollMs?: number;
	/** Give up on an attempt that is not ready after this long and restart it. Default 90 s. */
	startTimeoutMs?: number;
	/** SIGTERM → SIGKILL grace on stop. Default 5 s. */
	stopGraceMs?: number;
	/** Restart backoff: `min(maxMs, baseMs * 2^failures)`. Defaults 1 s / 60 s. */
	backoffBaseMs?: number;
	backoffMaxMs?: number;
	/** A run that stayed healthy this long resets the backoff. Default 5 min. */
	healthyResetMs?: number;
}

const QUICK_URL_RE = /https:\/\/([a-z0-9][a-z0-9-]*)\.trycloudflare\.com\b/gi;
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const TOKEN_RE = /^[A-Za-z0-9+/_=.-]+$/;

/** Output lines after which restarting cannot help. */
const FATAL_PATTERNS: RegExp[] = [
	/Provided Tunnel token is not valid/i,
	/Invalid tunnel (secret|token|credentials)/i,
	/failed to unmarshal tunnel (token|credentials)/i,
	/Unauthorized: Failed to get tunnel/i,
	/Register tunnel error from server side.*Failed to get tunnel/i,
	/Register tunnel error from server side.*Unauthorized/i,
];

const MAX_ERROR_LEN = 300;

function stoppedState(): TunnelRuntimeState {
	return { state: "stopped", mode: "off", publicUrl: null, pid: null, connections: 0, lastError: null, lastErrorI18n: null, startedAt: null };
}

/** `lastError` + its twin from one message (or cleared). */
function errorFields(m: I18nMessage | null): Pick<TunnelRuntimeState, "lastError" | "lastErrorI18n"> {
	return { lastError: m?.text ?? null, lastErrorI18n: m?.i18n ?? null };
}

async function freeLoopbackPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.unref();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			srv.close(() => (port ? resolve(port) : reject(new Error("could not allocate a metrics port"))));
		});
	});
}

/** Thrown for a tunnel config the manager refuses; `detail` carries the localisable twin of the message. */
export class TunnelConfigError extends TypeError {
	constructor(readonly detail: I18nMessage) {
		super(detail.text);
		this.name = "TunnelConfigError";
	}
}

function validateConfig(c: TunnelRunConfig): void {
	if (c.mode === "quick") return;
	if (c.mode !== "named") throw new TunnelConfigError(i18nMsg("unknown tunnel mode"));
	if (typeof c.token !== "string" || c.token.length === 0 || !TOKEN_RE.test(c.token)) throw new TunnelConfigError(i18nMsg("invalid tunnel token"));
	if (typeof c.hostname !== "string" || !HOSTNAME_RE.test(c.hostname)) throw new TunnelConfigError(i18nMsg("invalid tunnel hostname"));
}

/** Environment for the child: the parent's, minus every cloudflared option variable (TUNNEL_TOKEN, TUNNEL_URL, ...). */
function childEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v === undefined) continue;
		if (k.startsWith("TUNNEL_") || k.startsWith("CLOUDFLARED_")) continue;
		env[k] = v;
	}
	return env;
}

interface Attempt {
	/** Non-null when restarting cannot help. */
	fatal: I18nMessage | null;
	error: I18nMessage | null;
	/** How long the process stayed ready before exiting (0 if it never became ready). */
	healthyMs: number;
}

interface Session {
	cancelled: boolean;
	child: ChildProcess | null;
	wake: (() => void) | null;
	settleStart: (() => void) | null;
	done: Promise<void>;
}

export function createTunnelManager(o: CreateTunnelManagerOptions): TunnelManager {
	const readyPollMs = o.readyPollMs ?? 500;
	const runningPollMs = o.runningPollMs ?? 5_000;
	const startTimeoutMs = o.startTimeoutMs ?? 90_000;
	const stopGraceMs = o.stopGraceMs ?? 5_000;
	const backoffBaseMs = o.backoffBaseMs ?? 1_000;
	const backoffMaxMs = o.backoffMaxMs ?? 60_000;
	const healthyResetMs = o.healthyResetMs ?? 5 * 60_000;
	const tokenPath = join(o.runtimeDir, "tunnel-token");

	let current: TunnelRuntimeState = stoppedState();
	let session: Session | null = null;
	let disposed = false;
	let disposePromise: Promise<void> | null = null;
	let queue: Promise<unknown> = Promise.resolve();
	const listeners = new Set<(s: TunnelRuntimeState) => void>();

	function serial<T>(fn: () => Promise<T>): Promise<T> {
		const next = queue.then(fn, fn);
		queue = next.catch(() => undefined);
		return next;
	}

	function snapshot(): TunnelRuntimeState {
		return { ...current };
	}

	function setState(patch: Partial<TunnelRuntimeState>): void {
		const next = { ...current, ...patch };
		const changed = (Object.keys(next) as (keyof TunnelRuntimeState)[]).some((k) => next[k] !== current[k]);
		if (!changed) return;
		current = next;
		const snap = snapshot();
		for (const l of [...listeners]) {
			try {
				l(snap);
			} catch {
				// a faulty listener must not break the supervisor
			}
		}
		if (session && (next.state === "running" || next.state === "error")) session.settleStart?.();
	}

	function sleep(s: Session, ms: number): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		const timer = setTimeout(() => {
			s.wake = null;
			resolve();
		}, ms);
		s.wake = () => {
			clearTimeout(timer);
			s.wake = null;
			resolve();
		};
		return promise;
	}

	async function terminate(child: ChildProcess): Promise<void> {
		if (child.exitCode !== null || child.signalCode !== null) return;
		const exited = new Promise<void>((resolve) => {
			child.once("exit", () => resolve());
			child.once("error", () => resolve());
		});
		child.kill("SIGTERM");
		let timer: NodeJS.Timeout | undefined;
		const killed = await Promise.race([
			exited.then(() => false),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(true), stopGraceMs);
			}),
		]);
		clearTimeout(timer);
		if (killed) {
			child.kill("SIGKILL");
			await exited;
		}
	}

	async function removeTokenFile(): Promise<void> {
		await rm(tokenPath, { force: true }).catch(() => undefined);
	}

	async function writeTokenFile(token: string): Promise<void> {
		await mkdir(o.runtimeDir, { recursive: true, mode: 0o700 });
		await rm(tokenPath, { force: true });
		await writeFile(tokenPath, token, { flag: "wx", mode: 0o600 });
		await chmod(tokenPath, 0o600);
	}

	async function runOnce(s: Session, config: TunnelRunConfig, binary: string, everRan: boolean): Promise<Attempt> {
		const named = config.mode === "named";
		const namedUrl = config.mode === "named" ? `https://${config.hostname.toLowerCase()}` : null;
		const secret = config.mode === "named" ? config.token : null;
		const scrub = (line: string): string => {
			let out = secret ? line.split(secret).join("[redacted]") : line;
			out = out.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
			return out;
		};

		let metricsPort: number;
		try {
			metricsPort = await freeLoopbackPort();
			if (config.mode === "named") await writeTokenFile(config.token);
		} catch (err) {
			return { fatal: null, error: i18nMsg("failed to prepare cloudflared: {reason}", { reason: (err as Error).message }), healthyMs: 0 };
		}
		if (s.cancelled) {
			await removeTokenFile();
			return { fatal: null, error: null, healthyMs: 0 };
		}

		const args = ["tunnel", "--no-autoupdate", "--metrics", `127.0.0.1:${metricsPort}`];
		if (config.mode === "named") args.push("run", "--token-file", tokenPath);
		else args.push("--url", o.originUrl);

		let child: ChildProcess;
		try {
			child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"], env: childEnv(), windowsHide: true });
		} catch (err) {
			await removeTokenFile();
			return { fatal: i18nMsg("cannot start cloudflared: {reason}", { reason: (err as Error).message }), error: null, healthyMs: 0 };
		}
		s.child = child;
		o.log?.info({ pid: child.pid, mode: config.mode, metricsPort }, "cloudflared spawned");
		setState({
			state: everRan ? "reconnecting" : "starting",
			pid: child.pid ?? null,
			connections: 0,
			publicUrl: namedUrl,
			startedAt: null,
		});

		let publicUrl: string | null = namedUrl;
		let fatal: I18nMessage | null = null;
		let lastErrLine: I18nMessage | null = null;
		let timeoutError: I18nMessage | null = null;
		let readySince: number | null = null;
		let spawnError: Error | null = null;

		const killForFatal = (reason: string): void => {
			if (fatal) return;
			fatal = plainMsg(reason);
			void terminate(child);
		};

		if (child.stderr) {
			const rl = createInterface({ input: child.stderr, crlfDelay: Number.POSITIVE_INFINITY });
			rl.on("line", (raw) => {
				const line = scrub(raw).trim();
				if (!line) return;
				o.log?.info({ cloudflared: line.slice(0, 500) }, "cloudflared");
				if (/\b(ERR|FTL)\b/.test(line) || FATAL_PATTERNS.some((re) => re.test(line))) {
					lastErrLine = plainMsg(line.replace(/^\S+Z\s+/, "").slice(0, MAX_ERROR_LEN));
				}
				if (!named && !publicUrl) {
					for (const m of line.matchAll(QUICK_URL_RE)) {
						if (m[1]?.toLowerCase() === "api") continue;
						publicUrl = `https://${m[1]?.toLowerCase()}.trycloudflare.com`;
						setState({ publicUrl });
						void poll();
						break;
					}
				}
				if (FATAL_PATTERNS.some((re) => re.test(line))) {
					killForFatal(line.replace(/^\S+Z\s+/, "").slice(0, MAX_ERROR_LEN));
				}
			});
		}

		let pollTimer: NodeJS.Timeout | null = null;
		let polling = false;
		let finished = false;

		async function poll(): Promise<void> {
			if (polling || finished || s.cancelled) return;
			polling = true;
			try {
				let ready = 0;
				try {
					const res = await fetch(`http://127.0.0.1:${metricsPort}/ready`, { signal: AbortSignal.timeout(2_000) });
					const body: unknown = await res.json().catch(() => null);
					const rc = body !== null && typeof body === "object" && "readyConnections" in body ? body.readyConnections : undefined;
					const n = typeof rc === "number" ? rc : res.ok ? 1 : 0;
					ready = res.ok ? n : 0;
				} catch {
					return; // metrics server not up (yet) or momentarily unreachable
				}
				// A stop drains cloudflared's connections before it exits; that must not surface as "reconnecting".
				if (finished || s.cancelled) return;
				if (ready > 0 && publicUrl) {
					if (readySince === null) readySince = Date.now();
					setState({
						state: "running",
						connections: ready,
						publicUrl,
						...errorFields(null),
						startedAt: current.startedAt ?? new Date().toISOString(),
					});
				} else if (current.state === "running") {
					setState({ state: "reconnecting", connections: 0 });
				} else {
					setState({ connections: ready });
				}
			} finally {
				polling = false;
			}
		}

		function schedulePoll(): void {
			if (finished) return;
			pollTimer = setTimeout(
				async () => {
					await poll();
					schedulePoll();
				},
				current.state === "running" ? runningPollMs : readyPollMs,
			);
		}
		schedulePoll();

		const startTimer = setTimeout(() => {
			if (readySince === null && !finished) {
				timeoutError = i18nMsg("timed out waiting for the tunnel to become ready");
				void terminate(child);
			}
		}, startTimeoutMs);

		const closed = Promise.withResolvers<void>();
		child.once("error", (err) => {
			spawnError = err;
			closed.resolve();
		});
		child.once("close", () => closed.resolve());
		await closed.promise;

		finished = true;
		clearTimeout(startTimer);
		clearTimeout(pollTimer ?? undefined);
		s.child = null;
		await removeTokenFile();

		const healthyMs = readySince === null ? 0 : Date.now() - readySince;
		if (spawnError) {
			const err = spawnError as NodeJS.ErrnoException;
			const msg = err.code === "ENOENT" ? i18nMsg("cloudflared executable not found") : i18nMsg("cannot start cloudflared: {reason}", { reason: err.message });
			return { fatal: msg, error: null, healthyMs: 0 };
		}
		if (fatal) return { fatal, error: null, healthyMs };
		const exit = child.exitCode !== null ? i18nMsg("cloudflared exited unexpectedly (exit code {code})", { code: child.exitCode }) : i18nMsg("cloudflared exited unexpectedly (signal {signal})", { signal: String(child.signalCode) });
		const error = timeoutError ?? lastErrLine ?? exit;
		return { fatal: null, error, healthyMs };
	}

	async function supervise(s: Session, config: TunnelRunConfig, binary: string): Promise<void> {
		let failures = 0;
		let everRan = false;
		while (!s.cancelled) {
			const attempt = await runOnce(s, config, binary, everRan);
			if (s.cancelled) return;
			if (attempt.healthyMs > 0) everRan = true;
			if (attempt.fatal) {
				o.log?.warn({ error: attempt.fatal.text }, "cloudflared failed fatally; not restarting");
				setState({ state: "error", pid: null, connections: 0, publicUrl: null, startedAt: null, ...errorFields(attempt.fatal) });
				return;
			}
			if (attempt.healthyMs >= healthyResetMs) failures = 0;
			const delay = Math.min(backoffMaxMs, backoffBaseMs * 2 ** failures);
			failures = Math.min(failures + 1, 30);
			o.log?.warn({ error: attempt.error?.text, restartInMs: delay }, "cloudflared exited; restarting");
			setState({
				state: everRan ? "reconnecting" : "starting",
				pid: null,
				connections: 0,
				publicUrl: config.mode === "named" ? `https://${config.hostname.toLowerCase()}` : null,
				startedAt: null,
				...errorFields(attempt.error),
			});
			s.settleStart?.();
			await sleep(s, delay);
		}
	}

	async function stopInternal(): Promise<void> {
		const s = session;
		if (s) {
			s.cancelled = true;
			s.wake?.();
			if (s.child) await terminate(s.child);
			await s.done;
			session = null;
		}
		await removeTokenFile();
		setState(stoppedState());
		s?.settleStart?.();
	}

	function start(config: TunnelRunConfig): Promise<TunnelRuntimeState> {
		return serial(async () => {
			if (disposed) throw new Error("tunnel manager is disposed");
			validateConfig(config);
			await stopInternal();

			const binary = await resolveCloudflaredBinary(o.binary);
			if (!binary) {
				setState({
					...stoppedState(),
					state: "error",
					mode: config.mode,
					...errorFields(i18nMsg("cloudflared executable not found")),
				});
				return snapshot();
			}

			const { promise: settled, resolve: settle } = Promise.withResolvers<void>();
			const s: Session = { cancelled: false, child: null, wake: null, settleStart: settle, done: Promise.resolve() };
			session = s;
			setState({ ...stoppedState(), state: "starting", mode: config.mode });
			s.done = supervise(s, config, binary).catch((err: unknown) => {
				if (s.cancelled) return;
				setState({ state: "error", pid: null, connections: 0, publicUrl: null, ...errorFields(plainMsg((err as Error).message)) });
			});
			await settled;
			return snapshot();
		});
	}

	function stop(): Promise<TunnelRuntimeState> {
		return serial(async () => {
			await stopInternal();
			return snapshot();
		});
	}

	function dispose(): Promise<void> {
		disposePromise ??= (async () => {
			disposed = true;
			await serial(stopInternal);
			listeners.clear();
		})();
		return disposePromise;
	}

	return {
		start,
		stop,
		state: snapshot,
		onChange(l) {
			listeners.add(l);
			return () => {
				listeners.delete(l);
			};
		},
		dispose,
	};
}
