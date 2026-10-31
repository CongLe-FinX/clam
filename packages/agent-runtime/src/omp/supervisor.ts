import type { RuntimeKind, RuntimeStatus, SessionEvent } from "@clam/contracts";
import {
	AgentRuntimeError,
	type AgentRuntime,
	type ApprovalMode,
	type HostToolProvider,
	type RuntimeLogger,
	type RuntimeSessionSpec,
	type SupervisorSettings,
} from "../types.ts";
import { OmpSessionRuntime } from "./session-runtime.ts";

export interface OmpRuntimeOptions {
	/** Resolved at every start; null = omp is not installed. */
	binary: () => string | null;
	/** Passed as `--profile` to every omp process; null = OMP's default profile. */
	profile?: string | null;
	settings: SupervisorSettings;
	log?: RuntimeLogger;
	env?: Record<string, string | undefined>;
	startTimeoutMs?: number;
	requestTimeoutMs?: number;
	/** Grace between closing stdin and SIGTERM/SIGKILL on stop. Default 5000. */
	closeGraceMs?: number;
	stateRefreshMs?: number;
	/** Crash recovery policy: delay = min(maxDelayMs, baseDelayMs * 2^(attempt-1)) with +-20% jitter. */
	restart?: {
		baseDelayMs?: number;
		maxDelayMs?: number;
		/** Consecutive failed recoveries before giving up (state stays `crashed`). Default 8. */
		maxAttempts?: number;
		/** A runtime that stayed up this long before crashing starts the attempt count over. Default 60 s. */
		stableAfterMs?: number;
	};
	/** How often idle runtimes are looked for. Default 15 s. */
	reapIntervalMs?: number;
}

interface Backoff {
	attempts: number;
	timer: NodeJS.Timeout | null;
}

const NOOP_LOGGER: RuntimeLogger = { debug() {}, info() {}, warn() {}, error() {} };
const DEFAULT_RELEASE_IDLE_MS = 60_000;
const RELEASE_POLL_MS = 20;
const APPROVAL_MODES: readonly ApprovalMode[] = ["always-ask", "always-ask-cached", "write", "yolo"];

/**
 * Supervises one OMP RPC process per active CLAM session: concurrency cap with LRU eviction of idle
 * runtimes, idle+settled reaping, crash detection with exponential-backoff recovery that reopens the
 * same session directory, and graceful shutdown.
 */
export class OmpSupervisor implements AgentRuntime {
	readonly kind: RuntimeKind = "omp";

	private readonly opts: OmpRuntimeOptions;
	private readonly log: RuntimeLogger;
	private settings: SupervisorSettings;
	private readonly sessions = new Map<string, OmpSessionRuntime>();
	private readonly opening = new Map<string, Promise<OmpSessionRuntime>>();
	private readonly backoff = new Map<string, Backoff>();
	/** Tail of the queued snapshot cycles per session (serializes `withReleased`). */
	private readonly releaseTails = new Map<string, Promise<void>>();
	/** Present while a session's process is released and `work` runs; `open` waits for it. */
	private readonly releaseGates = new Map<string, Promise<void>>();
	private readonly eventListeners = new Set<(sessionId: string, event: SessionEvent) => void>();
	private readonly statusListeners = new Set<(status: RuntimeStatus) => void>();
	private hostToolProvider: HostToolProvider | null = null;
	private slotLock: Promise<unknown> = Promise.resolve();
	private reaper: NodeJS.Timeout | null = null;
	private closing = false;

	constructor(options: OmpRuntimeOptions) {
		this.opts = options;
		this.log = options.log ?? NOOP_LOGGER;
		this.settings = { ...options.settings };
		this.reaper = setInterval(() => this.reapIdle(), options.reapIntervalMs ?? 15_000);
		this.reaper.unref();
	}

	// ------------------------------------------------------------------ AgentRuntime

	async open(spec: RuntimeSessionSpec): Promise<OmpSessionRuntime> {
		if (this.closing) throw new AgentRuntimeError("invalid_state", "The runtime supervisor is shutting down");
		validateSpec(spec);
		await this.whenNotReleasing(spec.sessionId);
		if (this.closing) throw new AgentRuntimeError("invalid_state", "The runtime supervisor is shutting down");
		return this.openShared(spec);
	}

	/** Join an in-flight open of the session or start one. Not gated by snapshot cycles (their own reopen uses it). */
	private openShared(spec: RuntimeSessionSpec): Promise<OmpSessionRuntime> {
		const pending = this.opening.get(spec.sessionId);
		if (pending) return pending;
		const opening = this.openInternal(spec).finally(() => this.opening.delete(spec.sessionId));
		this.opening.set(spec.sessionId, opening);
		return opening;
	}

	private async openInternal(spec: RuntimeSessionSpec): Promise<OmpSessionRuntime> {
		const existing = this.sessions.get(spec.sessionId);
		if (existing && existing.state !== "stopped") {
			if (existing.state === "crashed" && !existing.restartPending) await this.recover(existing);
			await existing.whenReady();
			return existing;
		}
		const session = existing ?? this.createSession(spec);
		let started!: Promise<void>;
		await this.withSlotLock(async () => {
			await this.makeRoom(spec.sessionId);
			started = session.start("start");
		});
		try {
			await started;
		} catch (error) {
			await session.stop().catch(() => {});
			this.sessions.delete(spec.sessionId);
			throw error;
		}
		return session;
	}

	get(sessionId: string): OmpSessionRuntime | undefined {
		return this.sessions.get(sessionId);
	}

	list(): RuntimeStatus[] {
		return [...this.sessions.values()].map((s) => s.status());
	}

	async stop(sessionId: string): Promise<void> {
		this.clearBackoff(sessionId);
		const session = this.sessions.get(sessionId);
		if (!session) return;
		await session.stop();
		if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
	}

	async restart(sessionId: string): Promise<RuntimeStatus> {
		const session = this.sessions.get(sessionId);
		if (!session) throw new AgentRuntimeError("unknown_session", `No runtime for session ${sessionId}`);
		this.clearBackoff(sessionId);
		await session.stop();
		await this.withSlotLock(() => this.makeRoom(sessionId));
		await session.start("restart");
		return session.status();
	}

	onEvent(listener: (sessionId: string, event: SessionEvent) => void): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	onStatus(listener: (status: RuntimeStatus) => void): () => void {
		this.statusListeners.add(listener);
		return () => this.statusListeners.delete(listener);
	}

	updateOptions(options: Partial<SupervisorSettings>): void {
		this.settings = { ...this.settings, ...options };
	}

	setHostToolProvider(provider: HostToolProvider | null): void {
		this.hostToolProvider = provider;
		for (const session of this.sessions.values()) {
			// Sessions without a live process, and sessions still starting, pick the provider up when they register their tools.
			session.syncHostTools().catch((error: unknown) => this.log.warn({ err: error, sessionId: session.sessionId }, "host tool refresh failed"));
		}
	}

	async refreshHostTools(sessionId: string): Promise<void> {
		await this.sessions.get(sessionId)?.syncHostTools();
	}

	async shutdown(): Promise<void> {
		this.closing = true;
		clearInterval(this.reaper ?? undefined);
		this.reaper = null;
		for (const sessionId of [...this.backoff.keys()]) this.clearBackoff(sessionId);
		const sessions = [...this.sessions.values()];
		await Promise.allSettled(sessions.map((s) => s.shutdown()));
		this.sessions.clear();
	}

	async withReleased<T>(sessionId: string, work: () => Promise<T>, options: { idleTimeoutMs?: number } = {}): Promise<T> {
		const previous = this.releaseTails.get(sessionId) ?? Promise.resolve();
		const run = previous.then(() => this.releaseCycle(sessionId, work, options.idleTimeoutMs ?? DEFAULT_RELEASE_IDLE_MS));
		const done = () => {
			if (this.releaseTails.get(sessionId) === tail) this.releaseTails.delete(sessionId);
		};
		const tail: Promise<void> = run.then(done, done);
		this.releaseTails.set(sessionId, tail);
		return run;
	}

	private async releaseCycle<T>(sessionId: string, work: () => Promise<T>, idleTimeoutMs: number): Promise<T> {
		if (this.closing) throw new AgentRuntimeError("invalid_state", "The runtime supervisor is shutting down");
		const session = this.sessions.get(sessionId);
		const live = session !== undefined && (session.occupiesSlot || (session.state === "crashed" && session.restartPending));
		const gate = Promise.withResolvers<void>();
		let gated = false;
		// Raised synchronously with the decision to stop, so no `open` can slip in between.
		const raise = () => {
			if (gated) return;
			gated = true;
			this.releaseGates.set(sessionId, gate.promise);
		};
		let reopen: RuntimeSessionSpec | null = null;
		try {
			if (live) {
				await this.stopWhenSettled(session, idleTimeoutMs, raise);
				reopen = session.spec;
			}
			raise();
			return await work();
		} finally {
			if (reopen && !this.closing && this.sessions.get(sessionId) === session) {
				// Registered in `opening` before the gate lifts, so waiting `open` calls join this start.
				this.openShared(reopen).catch((error: unknown) => this.log.warn({ err: error, sessionId }, "reopening session after release failed"));
			}
			if (gated) {
				this.releaseGates.delete(sessionId);
				gate.resolve();
			}
		}
	}

	/** Wait until `session` is idle and settled, then stop it (releasing OMP's lease). `raise` runs right before the stop. */
	private async stopWhenSettled(session: OmpSessionRuntime, idleTimeoutMs: number, raise: () => void): Promise<void> {
		const deadline = Date.now() + idleTimeoutMs;
		for (;;) {
			if (this.closing) throw new AgentRuntimeError("invalid_state", "The runtime supervisor is shutting down");
			if (this.sessions.get(session.sessionId) !== session || session.state === "stopped") return;
			if (session.reapable || session.state === "crashed") {
				raise();
				this.clearBackoff(session.sessionId);
				await session.stop();
				return;
			}
			if (Date.now() >= deadline) {
				throw new AgentRuntimeError("invalid_state", `Session ${session.sessionId} is busy: it did not become idle within ${idleTimeoutMs} ms`, {
					state: session.state,
				});
			}
			const tick = Promise.withResolvers<void>();
			setTimeout(tick.resolve, RELEASE_POLL_MS);
			await tick.promise;
		}
	}

	private async whenNotReleasing(sessionId: string): Promise<void> {
		for (let gate = this.releaseGates.get(sessionId); gate; gate = this.releaseGates.get(sessionId)) await gate;
	}

	// ------------------------------------------------------------------ internals

	private createSession(spec: RuntimeSessionSpec): OmpSessionRuntime {
		const session = new OmpSessionRuntime({
			spec,
			binary: this.opts.binary,
			profile: this.opts.profile ?? null,
			settings: () => this.settings,
			hostTools: () => this.hostToolProvider,
			log: this.log.child ? this.log.child({ sessionId: spec.sessionId }) : this.log,
			env: this.opts.env,
			startTimeoutMs: this.opts.startTimeoutMs,
			requestTimeoutMs: this.opts.requestTimeoutMs,
			closeGraceMs: this.opts.closeGraceMs,
			stateRefreshMs: this.opts.stateRefreshMs,
			callbacks: {
				onEvent: (sessionId, event) => {
					for (const listener of [...this.eventListeners]) this.safe(() => listener(sessionId, event));
				},
				onStatus: (status) => {
					for (const listener of [...this.statusListeners]) this.safe(() => listener(status));
				},
				onCrash: (crashed) => this.scheduleRecovery(crashed),
			},
		});
		this.sessions.set(spec.sessionId, session);
		return session;
	}

	private safe(fn: () => void): void {
		try {
			fn();
		} catch (error) {
			this.log.error({ err: error }, "runtime listener failed");
		}
	}

	private withSlotLock<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.slotLock.then(fn, fn);
		this.slotLock = run.catch(() => {});
		return run;
	}

	/** Stop least-recently-active idle runtimes until a slot is free for `forSessionId`. Throws `capacity` if none can go. */
	private async makeRoom(forSessionId: string): Promise<void> {
		const occupied = () => [...this.sessions.values()].filter((s) => s.sessionId !== forSessionId && s.occupiesSlot);
		while (occupied().length >= this.settings.maxConcurrentRuntimes) {
			const victim = occupied()
				.filter((s) => s.reapable)
				.sort((a, b) => (a.lastActivityMs ?? 0) - (b.lastActivityMs ?? 0))[0];
			if (!victim) {
				throw new AgentRuntimeError(
					"capacity",
					`The node is running ${this.settings.maxConcurrentRuntimes} agent runtimes and none is idle. Stop one or raise the limit in Settings.`,
					{ max: this.settings.maxConcurrentRuntimes },
				);
			}
			this.log.info({ sessionId: victim.sessionId }, "stopping least recently used idle runtime to free a slot");
			await this.stop(victim.sessionId);
		}
	}

	private reapIdle(): void {
		const now = Date.now();
		for (const session of this.sessions.values()) {
			if (!session.reapable || session.lastActivityMs === null) continue;
			if (now - session.lastActivityMs < this.settings.idleTimeoutMs) continue;
			this.log.info({ sessionId: session.sessionId }, "stopping idle runtime");
			void this.stop(session.sessionId).catch((error) => this.log.warn({ err: error, sessionId: session.sessionId }, "idle stop failed"));
		}
	}

	// ------------------------------------------------------------------ crash recovery

	private clearBackoff(sessionId: string): void {
		const entry = this.backoff.get(sessionId);
		if (!entry) return;
		clearTimeout(entry.timer ?? undefined);
		this.backoff.delete(sessionId);
		const session = this.sessions.get(sessionId);
		if (session) session.restartPending = false;
	}

	/** User-initiated recovery of a runtime that exhausted its automatic restarts. */
	private async recover(session: OmpSessionRuntime): Promise<void> {
		this.clearBackoff(session.sessionId);
		await this.withSlotLock(() => this.makeRoom(session.sessionId));
		await session.start("restart");
	}

	private scheduleRecovery(session: OmpSessionRuntime): void {
		if (this.closing) return;
		const policy = this.opts.restart ?? {};
		const entry = this.backoff.get(session.sessionId) ?? { attempts: 0, timer: null };
		this.backoff.set(session.sessionId, entry);
		const startedAt = session.status().startedAt;
		const stableAfterMs = policy.stableAfterMs ?? 60_000;
		if (startedAt && Date.now() - Date.parse(startedAt) >= stableAfterMs) entry.attempts = 0;
		entry.attempts++;
		const maxAttempts = policy.maxAttempts ?? 8;
		if (entry.attempts > maxAttempts) {
			session.restartPending = false;
			session.rejectWaiters(new AgentRuntimeError("not_ready", `The agent runtime kept crashing and was not restarted again: ${session.status().lastError ?? "unknown error"}`));
			this.log.error({ sessionId: session.sessionId, attempts: entry.attempts - 1 }, "giving up restarting runtime");
			return;
		}
		const base = policy.baseDelayMs ?? 500;
		const max = policy.maxDelayMs ?? 30_000;
		const delay = Math.min(max, base * 2 ** (entry.attempts - 1)) * (0.8 + Math.random() * 0.4);
		session.restartPending = true;
		this.log.warn({ sessionId: session.sessionId, attempt: entry.attempts, delayMs: Math.round(delay) }, "scheduling runtime restart");
		entry.timer = setTimeout(() => {
			entry.timer = null;
			void this.attemptRestart(session);
		}, delay);
		entry.timer.unref();
	}

	private async attemptRestart(session: OmpSessionRuntime): Promise<void> {
		if (this.closing || this.sessions.get(session.sessionId) !== session) return;
		try {
			await session.start("restart");
			session.restartPending = false;
			this.log.info({ sessionId: session.sessionId }, "runtime recovered");
		} catch (error) {
			if (this.closing || this.sessions.get(session.sessionId) !== session) return;
			this.log.warn({ sessionId: session.sessionId, err: error }, "runtime restart failed");
			if (error instanceof AgentRuntimeError && error.code === "not_installed") {
				session.restartPending = false;
				session.rejectWaiters(error);
				return;
			}
			this.scheduleRecovery(session);
		}
	}
}

function validateSpec(spec: RuntimeSessionSpec): void {
	if (spec.approvalMode !== undefined && !APPROVAL_MODES.includes(spec.approvalMode)) {
		throw new AgentRuntimeError("invalid_argument", `Unknown approval mode "${String(spec.approvalMode)}"`);
	}
	if (spec.maxCostUsd !== undefined && !(typeof spec.maxCostUsd === "number" && Number.isFinite(spec.maxCostUsd) && spec.maxCostUsd > 0)) {
		throw new AgentRuntimeError("invalid_argument", "maxCostUsd must be a finite number greater than 0");
	}
}

export function createOmpRuntime(options: OmpRuntimeOptions): OmpSupervisor {
	return new OmpSupervisor(options);
}
