import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { MessagesPage, RuntimeState, RuntimeStatus, SessionEvent, SessionLiveState, SessionStats } from "@clam/contracts";
import {
	AgentRuntimeError,
	type HostToolProvider,
	type MessagesQuery,
	type PromptInput,
	type RuntimeBinding,
	type RuntimeLogger,
	type RuntimeSession,
	type RuntimeSessionSpec,
	type SupervisorSettings,
	type UiResponseBody,
	type UsageDelta,
} from "../types.ts";
import { OmpEventMapper } from "./events.ts";
import { HostToolDispatcher, validateHostToolDefinitions, type WireHostToolDefinition } from "./host-tools.ts";
import { isRecord, type OmpFrame, type OmpResponseFrame } from "./frames.ts";
import { toLiveState, toSessionStats } from "./messages.ts";
import { OmpTransport, type TransportExit } from "./transport.ts";

export interface OmpSessionRuntimeCallbacks {
	onEvent(sessionId: string, event: SessionEvent): void;
	onStatus(status: RuntimeStatus): void;
	/** The process died without being asked to. The supervisor decides whether and when to restart. */
	onCrash(session: OmpSessionRuntime): void;
}

export interface OmpSessionRuntimeOptions {
	spec: RuntimeSessionSpec;
	/** Resolved at every (re)start so a reinstalled omp is picked up. */
	binary: () => string | null;
	profile: string | null;
	settings: () => SupervisorSettings;
	log: RuntimeLogger;
	callbacks: OmpSessionRuntimeCallbacks;
	/** The current host tool provider (resolved at every use); null = no host tools. */
	hostTools: () => HostToolProvider | null;
	env?: Record<string, string | undefined>;
	startTimeoutMs?: number;
	requestTimeoutMs?: number;
	closeGraceMs?: number;
	/** Debounce for coalescing `get_state` refreshes triggered by events. Default 80 ms. */
	stateRefreshMs?: number;
}

interface OpenSessionResult {
	cancelled: boolean;
	resumed: boolean;
	sessionId: string;
	sessionFile?: string;
}

interface Waiter {
	resolve(): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
}

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const HISTORY_PAGE_LIMIT = 256;
const HISTORY_RETRIES = 3;

function runtimeCodeOf(error: unknown): string | undefined {
	if (error instanceof AgentRuntimeError && isRecord(error.details)) {
		const code = error.details.runtimeCode;
		return typeof code === "string" ? code : undefined;
	}
	return undefined;
}

function describeExit(exit: TransportExit): string {
	const how = exit.error
		? exit.error.message
		: exit.signal
			? `killed by ${exit.signal}`
			: `exited with code ${exit.code ?? "unknown"}`;
	const tail = exit.stderrTail.trim();
	return tail ? `Agent runtime ${how}: ${tail.slice(-500)}` : `Agent runtime ${how}`;
}

/**
 * One OMP RPC process bound to one CLAM session. It owns the transport, the transcript/event mapper
 * and the process lifecycle states; restart policy and capacity live in the supervisor.
 */
export class OmpSessionRuntime implements RuntimeSession {
	readonly sessionId: string;
	readonly spec: RuntimeSessionSpec;

	private readonly opts: OmpSessionRuntimeOptions;
	private readonly log: RuntimeLogger;
	private readonly mapper = new OmpEventMapper();
	private transport: OmpTransport | null = null;
	private stateName: RuntimeState = "stopped";
	private pid: number | null = null;
	private startedAt: string | null = null;
	private restartCount = 0;
	private lastError: string | null = null;
	private lastActivity: number | null = null;
	private bound: RuntimeBinding = { runtimeSessionId: null, runtimeSessionFile: null };
	private levels: string[] = [];
	/** Configured thinking selector when it differs from the effective level (`auto`), learned from `thinking_level_changed`. */
	private thinkingSelector: string | null = null;
	private starting: Promise<void> | null = null;
	private stopRequested = false;
	private shuttingDown = false;
	private agentRunning = false;
	private settled = true;
	private readonly inflight = new Map<string, string>();
	private readonly waiters = new Set<Waiter>();
	private refreshTimer: NodeJS.Timeout | null = null;
	private refreshing: Promise<void> | null = null;
	private refreshAgain = false;
	/** Set by the supervisor while it has a restart scheduled, so `whenReady` keeps waiting through backoff. */
	restartPending = false;
	/** Host tool calls of the current process. Replaced on every start. */
	private hostCalls: HostToolDispatcher | null = null;
	/** Signature of the definitions OMP acknowledged for the current process (null = none registered yet). */
	private hostToolSignature: string | null = null;
	private hostToolChain: Promise<void> = Promise.resolve();

	constructor(options: OmpSessionRuntimeOptions) {
		this.opts = options;
		this.spec = options.spec;
		this.sessionId = options.spec.sessionId;
		this.log = options.log;
	}

	// ------------------------------------------------------------------ introspection

	status(): RuntimeStatus {
		return {
			sessionId: this.sessionId,
			state: this.stateName,
			pid: this.pid,
			startedAt: this.startedAt,
			restarts: this.restartCount,
			lastError: this.lastError,
			lastActivityAt: this.lastActivity === null ? null : new Date(this.lastActivity).toISOString(),
		};
	}

	binding(): RuntimeBinding {
		return this.bound;
	}

	get state(): RuntimeState {
		return this.stateName;
	}

	get lastActivityMs(): number | null {
		return this.lastActivity;
	}

	/** Process alive (or being started) and therefore counting against the concurrency cap. */
	get occupiesSlot(): boolean {
		return this.stateName === "starting" || this.stateName === "ready" || this.stateName === "busy" || this.stateName === "restarting";
	}

	/** Safe to stop without losing work: running, nothing streaming, queued, awaiting approval or in flight. */
	get reapable(): boolean {
		return this.stateName === "ready" && this.settled && !this.agentRunning && this.inflight.size === 0 && this.mapper.pendingUiRequests().length === 0;
	}

	get hasPendingStart(): boolean {
		return this.starting !== null;
	}

	// ------------------------------------------------------------------ lifecycle

	/**
	 * Spawn the process and open the conversation. Resolves when ready; rejects `start_failed`
	 * (or `not_installed`). `mode: "restart"` marks the attempt as crash recovery (state `restarting`).
	 */
	start(mode: "start" | "restart" = "start"): Promise<void> {
		if (this.starting) return this.starting;
		this.stopRequested = false;
		if (mode === "restart") this.restartCount++;
		const attempt = this.doStart(mode).finally(() => {
			this.starting = null;
		});
		// A caller that abandons the promise (supervisor retry loop) must not trigger unhandledRejection.
		attempt.catch(() => {});
		this.starting = attempt;
		return attempt;
	}

	private async doStart(mode: "start" | "restart"): Promise<void> {
		const binary = this.opts.binary();
		if (!binary) {
			const error = new AgentRuntimeError("not_installed", "The omp executable was not found. Install OMP or set CLAM_OMP_BIN.");
			this.lastError = error.message;
			this.transition("stopped");
			throw error;
		}
		this.transition(mode === "restart" ? "restarting" : "starting");
		const transport = new OmpTransport({
			command: binary,
			args: this.buildArgs(),
			cwd: this.spec.cwd,
			env: { NO_COLOR: "1", ...this.opts.env },
			startTimeoutMs: this.opts.startTimeoutMs,
			requestTimeoutMs: this.opts.requestTimeoutMs,
			log: this.log,
		});
		this.transport = transport;
		this.hostCalls = new HostToolDispatcher({
			sessionId: this.sessionId,
			provider: this.opts.hostTools,
			send: (frame) => transport.send(frame),
			log: this.log,
		});
		this.hostToolSignature = null;
		transport.onFrame((frame) => this.onFrame(transport, frame));
		transport.onExit((exit) => this.onExit(transport, exit));
		try {
			await transport.start();
			this.pid = transport.pid ?? null;
			this.startedAt = new Date().toISOString();
			this.mapper.reset();
			this.thinkingSelector = null;
			this.agentRunning = false;
			this.settled = true;
			this.inflight.clear();
			await transport.request("set_event_filter", { events: null, messageUpdates: "delta" });
			const model = this.spec.model ? splitSelector(this.spec.model) : null;
			const opened = await transport.request<OpenSessionResult>("open_session", {
				sessionDir: this.spec.sessionDir,
				...(model ? { provider: model.provider, modelId: model.modelId } : {}),
			});
			if (!isRecord(opened) || opened.cancelled === true) {
				throw new AgentRuntimeError("start_failed", "omp refused to open the session directory");
			}
			this.bound = {
				runtimeSessionId: typeof opened.sessionId === "string" ? opened.sessionId : null,
				runtimeSessionFile: typeof opened.sessionFile === "string" ? opened.sessionFile : null,
			};
			// A failure is a notice, not a failed start: the agent still works, only without the mesh tools.
			await this.registerHostTools(transport).catch(() => {});
			await this.loadHistory(transport);
			await this.fetchState(transport);
			if (this.stopRequested || transport !== this.transport) {
				throw new AgentRuntimeError("invalid_state", "Runtime was stopped while starting");
			}
			this.lastError = null;
			this.touch();
			this.transition("ready");
		} catch (error) {
			const wasStopped = this.stopRequested;
			this.hostCalls?.abortAll("The agent runtime failed to start");
			transport.kill();
			if (this.transport === transport) {
				this.transport = null;
				this.pid = null;
			}
			const detail = error instanceof Error ? error.message : String(error);
			const stderr = transport.stderrTail().trim();
			this.lastError = wasStopped ? this.lastError : stderr ? `${detail} (${stderr.slice(-300)})` : detail;
			this.transition(wasStopped ? "stopped" : "crashed");
			if (error instanceof AgentRuntimeError && (error.code === "not_installed" || error.code === "invalid_state")) throw error;
			throw new AgentRuntimeError("start_failed", `Failed to start the agent runtime: ${this.lastError}`, {
				cause: detail,
				stderr,
			});
		}
	}

	private buildArgs(): string[] {
		const settings = this.opts.settings();
		const approvalMode = this.spec.approvalMode ?? settings.approvalMode;
		const args: string[] = [];
		if (this.opts.profile) args.push("--profile", this.opts.profile);
		args.push("--mode", "rpc");
		// Under --no-ui tools that need approval fail closed instead of asking. Only yolo never asks,
		// so every other mode must keep the extension UI so approvals surface as ui_request events.
		if (approvalMode === "yolo") args.push("--no-ui");
		args.push("--cwd", this.spec.cwd, "--approval-mode", approvalMode);
		if (this.spec.maxCostUsd !== undefined) args.push("--max-cost", String(this.spec.maxCostUsd));
		return args;
	}

	private async loadHistory(transport: OmpTransport): Promise<void> {
		for (let attempt = 0; attempt < HISTORY_RETRIES; attempt++) {
			const collected: unknown[] = [];
			let cursor: string | undefined;
			try {
				do {
					const page = await transport.request<{ messages?: unknown[]; nextCursor?: string }>(
						"get_messages_page",
						{ limit: HISTORY_PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
						{ timeoutMs: 60_000 },
					);
					if (Array.isArray(page?.messages)) collected.push(...page.messages);
					cursor = typeof page?.nextCursor === "string" ? page.nextCursor : undefined;
				} while (cursor);
				this.mapper.loadHistory(collected);
				return;
			} catch (error) {
				const code = runtimeCodeOf(error);
				if (code === "stale_cursor" || code === "session_busy") {
					await sleep(150);
					continue;
				}
				throw error;
			}
		}
		// Paging kept failing (session changing underneath us): fall back to the monolithic snapshot.
		const all = await transport.request<{ messages?: unknown[] }>("get_messages", {}, { timeoutMs: 60_000 });
		this.mapper.loadHistory(Array.isArray(all?.messages) ? all.messages : []);
	}

	// ------------------------------------------------------------------ host tools

	/**
	 * Replace the host tools registered in the live process with the provider's current definitions (`set_host_tools`).
	 * Serialized with other syncs; resolves at once when there is no live process (the next start registers them)
	 * or nothing changed. Rejects, after publishing a `notice`, when the definitions are invalid or OMP refuses them.
	 */
	syncHostTools(): Promise<void> {
		const task = this.hostToolChain.then(() => this.syncHostToolsNow());
		this.hostToolChain = task.catch(() => {});
		return task;
	}

	private async syncHostToolsNow(): Promise<void> {
		// A start registers the tools itself; wait for it so this sync sees the final process.
		if (this.starting) await this.starting.catch(() => {});
		const transport = this.transport;
		if (!transport || transport.state !== "ready" || (this.stateName !== "ready" && this.stateName !== "busy")) return;
		await this.registerHostTools(transport);
	}

	private async registerHostTools(transport: OmpTransport): Promise<void> {
		let wire: WireHostToolDefinition[];
		try {
			const provider = this.opts.hostTools();
			let definitions: unknown;
			try {
				definitions = provider ? provider.definitions(this.sessionId) : [];
			} catch (error) {
				throw new AgentRuntimeError("invalid_argument", `The host tool provider failed to list its tools: ${error instanceof Error ? error.message : String(error)}`);
			}
			wire = validateHostToolDefinitions(definitions);
		} catch (error) {
			this.reportHostToolFailure(transport, error);
			throw error;
		}
		const signature = JSON.stringify(wire);
		// Nothing registered yet and nothing to register: a fresh process has no host tools to clear.
		if (signature === this.hostToolSignature || (wire.length === 0 && this.hostToolSignature === null)) {
			this.hostToolSignature = signature;
			return;
		}
		try {
			const data = await transport.request<{ toolNames?: unknown } | undefined>("set_host_tools", { tools: wire });
			if (transport !== this.transport) return;
			const acknowledged = isRecord(data) && Array.isArray(data.toolNames) ? data.toolNames.filter((n): n is string => typeof n === "string") : wire.map((t) => t.name);
			this.hostToolSignature = signature;
			this.hostCalls?.setRegistered(acknowledged);
			this.log.debug({ sessionId: this.sessionId, tools: acknowledged }, "host tools registered");
		} catch (error) {
			this.reportHostToolFailure(transport, error);
			throw error;
		}
	}

	private reportHostToolFailure(transport: OmpTransport, error: unknown): void {
		const detail = error instanceof Error ? error.message : String(error);
		this.log.warn({ sessionId: this.sessionId, err: detail }, "host tools were not registered");
		if (transport !== this.transport) return; // the process is gone; the next start registers them again
		this.emit({ type: "notice", level: "error", message: `Mesh host tools were not registered: ${detail}` });
	}

	/** Graceful stop; the conversation stays on disk. Idempotent. */
	async stop(): Promise<void> {
		this.stopRequested = true;
		this.restartPending = false;
		this.clearRefreshTimer();
		const transport = this.transport;
		this.transport = null;
		this.hostCalls?.abortAll("Agent runtime stopped");
		if (transport && transport.state !== "exited") {
			await transport.close({ graceMs: this.opts.closeGraceMs });
		}
		// A start in flight fails by itself once its transport is closed; wait so callers see a settled state.
		if (this.starting) await this.starting.catch(() => {});
		this.abandonInFlightWork("Agent runtime stopped", "aborted");
		this.pid = null;
		this.transition("stopped");
		this.rejectWaiters(new AgentRuntimeError("not_ready", "The agent runtime was stopped"));
	}

	/** Called by the supervisor at shutdown: like stop but never restarts and never emits more events. */
	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		await this.stop();
	}

	// ------------------------------------------------------------------ process events

	private onFrame(transport: OmpTransport, frame: OmpFrame | OmpResponseFrame): void {
		if (transport !== this.transport) return;
		this.touch();
		if (this.hostCalls?.handleFrame(frame as OmpFrame)) return;
		if (frame.type === "response") {
			this.log.debug({ sessionId: this.sessionId, frame }, "unmatched omp response");
			return;
		}
		if (frame.type === "thinking_level_changed") {
			this.thinkingSelector = typeof frame.configured === "string" && frame.configured !== frame.thinkingLevel ? frame.configured : null;
		}
		const result = this.mapper.handleFrame(frame as OmpFrame);
		for (const event of result.events) {
			if (!this.track(event)) continue;
			this.emit(event);
		}
		if (result.stateDirty) this.scheduleRefresh();
	}

	/** Update run-state bookkeeping for an outgoing event. Returns false to suppress a duplicate. */
	private track(event: SessionEvent): boolean {
		switch (event.type) {
			case "agent_start":
				this.agentRunning = true;
				this.settled = false;
				this.refreshRunState();
				break;
			case "agent_end":
				this.agentRunning = false;
				break;
			case "prompt_result":
				this.inflight.delete(event.promptId);
				break;
			case "settled":
				if (this.settled) return false;
				this.settled = true;
				this.agentRunning = false;
				this.refreshRunState();
				break;
		}
		return true;
	}

	private onExit(transport: OmpTransport, exit: TransportExit): void {
		if (transport !== this.transport) return;
		this.hostCalls?.abortAll("The agent runtime process exited");
		if (exit.expected || this.stopRequested || this.shuttingDown) return;
		if (this.stateName === "starting" || this.stateName === "restarting") return; // doStart reports it
		this.transport = null;
		this.pid = null;
		this.clearRefreshTimer();
		this.lastError = describeExit(exit);
		this.log.warn({ sessionId: this.sessionId, code: exit.code, signal: exit.signal, stderr: exit.stderrTail.slice(-500) }, "omp runtime crashed");
		this.abandonInFlightWork("Agent runtime crashed; the run was interrupted", "error");
		this.emit({ type: "notice", level: "error", message: this.lastError });
		this.transition("crashed");
		this.opts.callbacks.onCrash(this);
	}

	/** Close out everything that can no longer complete: prompts, open approvals, the streaming flag. */
	private abandonInFlightWork(reason: string, status: "aborted" | "error"): void {
		for (const promptId of this.inflight.keys()) {
			// The mapper withdraws a pending message that OMP never echoed, then reports the outcome.
			for (const event of this.mapper.failPrompt(promptId, status, status === "error" ? reason : undefined)) this.emit(event);
		}
		this.inflight.clear();
		for (const request of this.mapper.pendingUiRequests()) {
			const resolved = this.mapper.markUiResolved(request.requestId);
			if (resolved) this.emit(resolved);
		}
		if (this.agentRunning) this.emit({ type: "agent_end" });
		this.agentRunning = false;
		this.settled = true;
	}

	// ------------------------------------------------------------------ state

	private transition(next: RuntimeState): void {
		if (this.stateName === next) return;
		this.stateName = next;
		if (next === "ready" || next === "busy") this.resolveWaiters();
		if (!this.shuttingDown) this.opts.callbacks.onStatus(this.status());
	}

	private refreshRunState(): void {
		if (this.stateName !== "ready" && this.stateName !== "busy") return;
		const busy = this.agentRunning || !this.settled || this.inflight.size > 0;
		this.transition(busy ? "busy" : "ready");
	}

	private touch(): void {
		this.lastActivity = Date.now();
	}

	private emit(event: SessionEvent): void {
		if (this.shuttingDown) return;
		try {
			this.opts.callbacks.onEvent(this.sessionId, event);
		} catch (error) {
			this.log.error({ sessionId: this.sessionId, err: error }, "event listener failed");
		}
	}

	private scheduleRefresh(): void {
		if (this.refreshTimer || this.stateName === "stopped" || this.stateName === "crashed") return;
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = null;
			void this.runRefresh();
		}, this.opts.stateRefreshMs ?? 80);
		this.refreshTimer.unref?.();
	}

	private clearRefreshTimer(): void {
		clearTimeout(this.refreshTimer ?? undefined);
		this.refreshTimer = null;
	}

	private runRefresh(): Promise<void> {
		if (this.refreshing) {
			this.refreshAgain = true;
			return this.refreshing;
		}
		const transport = this.transport;
		if (!transport || transport.state !== "ready") return Promise.resolve();
		this.refreshing = this.fetchState(transport)
			.then((state) => {
				if (transport !== this.transport) return;
				this.reconcileSettled(state);
				this.emit({ type: "state", state });
			})
			.catch((error) => this.log.debug({ sessionId: this.sessionId, err: error }, "state refresh failed"))
			.finally(() => {
				this.refreshing = null;
				if (this.refreshAgain) {
					this.refreshAgain = false;
					this.scheduleRefresh();
				}
			});
		return this.refreshing;
	}

	/** `get_state.isSettled` is the source of truth if the `session_settled` frame was missed or never sent. */
	private reconcileSettled(state: SessionLiveState): void {
		if (this.settled || !state.isSettled || state.isStreaming || this.agentRunning || this.inflight.size > 0) return;
		this.settled = true;
		this.refreshRunState();
		this.emit({ type: "settled" });
	}

	private async fetchState(transport: OmpTransport): Promise<SessionLiveState> {
		const data = await transport.request("get_state");
		if (this.levels.length === 0) await this.fetchLevels(transport);
		return {
			...toLiveState({
				sessionId: this.sessionId,
				runtime: this.status(),
				state: data,
				availableThinkingLevels: this.levels,
			}),
			thinkingSelector: this.thinkingSelector,
		};
	}

	private async fetchLevels(transport: OmpTransport): Promise<void> {
		try {
			const data = await transport.request<unknown>("get_available_thinking_levels");
			const raw = isRecord(data) ? (data.levels ?? data.thinkingLevels) : data;
			if (Array.isArray(raw)) this.levels = raw.filter((x): x is string => typeof x === "string");
		} catch (error) {
			this.log.debug({ sessionId: this.sessionId, err: error }, "get_available_thinking_levels failed");
		}
	}

	// ------------------------------------------------------------------ readiness

	whenReady(timeoutMs: number = DEFAULT_READY_TIMEOUT_MS): Promise<void> {
		if (this.stateName === "ready" || this.stateName === "busy") return Promise.resolve();
		const recovering = this.stateName === "starting" || this.stateName === "restarting" || this.restartPending;
		if (!recovering) {
			return Promise.reject(
				new AgentRuntimeError(
					"not_ready",
					this.stateName === "crashed" ? (this.lastError ?? "The agent runtime crashed") : "The agent runtime is not running",
					{ state: this.stateName },
				),
			);
		}
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const waiter: Waiter = {
			resolve: () => {
				clearTimeout(waiter.timer);
				this.waiters.delete(waiter);
				resolve();
			},
			reject: (error) => {
				clearTimeout(waiter.timer);
				this.waiters.delete(waiter);
				reject(error);
			},
			timer: setTimeout(
				() =>
					waiter.reject(
						new AgentRuntimeError("not_ready", `The agent runtime did not become ready within ${Math.round(timeoutMs / 1000)}s`, {
							state: this.stateName,
							lastError: this.lastError,
						}),
					),
				timeoutMs,
			),
		};
		this.waiters.add(waiter);
		return promise;
	}

	private resolveWaiters(): void {
		for (const waiter of [...this.waiters]) waiter.resolve();
	}

	/** Used by the supervisor when it gives up restarting. */
	rejectWaiters(error: Error): void {
		for (const waiter of [...this.waiters]) waiter.reject(error);
	}

	private async connected(): Promise<OmpTransport> {
		await this.whenReady();
		const transport = this.transport;
		if (!transport || transport.state !== "ready") {
			throw new AgentRuntimeError("not_ready", "The agent runtime is not running", { state: this.stateName });
		}
		return transport;
	}

	// ------------------------------------------------------------------ operations

	async prompt(input: PromptInput): Promise<{ promptId: string }> {
		const transport = await this.connected();
		const promptId = `p_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
		// Nothing running and not a slash command (which may never echo): show the prompt at once instead of when OMP echoes it.
		const idle = this.settled && !this.agentRunning && this.inflight.size === 0;
		const showPending = idle && !input.message.trimStart().startsWith("/");
		for (const event of this.mapper.registerPrompt(promptId, input.clientId, input.message, { showPending })) this.emit(event);
		this.inflight.set(promptId, input.clientId);
		this.settled = false;
		this.touch();
		this.refreshRunState();
		try {
			const ack = await transport.request<{ agentInvoked?: boolean } | undefined>(
				"prompt",
				{ message: input.message, ...(input.streamingBehavior ? { streamingBehavior: input.streamingBehavior } : {}) },
				{ id: promptId },
			);
			if (isRecord(ack) && ack.agentInvoked === false) {
				// Finished locally (e.g. a slash command): no prompt_result frame will follow.
				this.inflight.delete(promptId);
				for (const event of this.mapper.completePrompt(promptId)) this.emit(event);
				this.settled = this.inflight.size === 0 && !this.agentRunning;
				this.refreshRunState();
				this.scheduleRefresh();
			}
		} catch (error) {
			this.inflight.delete(promptId);
			// Never reached the agent: withdraw the pending message and tell subscribers how it ended.
			const reason = error instanceof Error ? error.message : String(error);
			for (const event of this.mapper.failPrompt(promptId, "error", reason)) this.emit(event);
			if (this.inflight.size === 0 && !this.agentRunning) this.settled = true;
			this.refreshRunState();
			throw error;
		}
		return { promptId };
	}

	async abort(): Promise<void> {
		const transport = this.transport;
		if (!transport || transport.state !== "ready" || (this.stateName !== "ready" && this.stateName !== "busy")) return;
		await transport.request("abort");
		this.touch();
	}

	async setModel(selector: string): Promise<void> {
		const transport = await this.connected();
		const model = splitSelector(selector);
		if (!model) throw new AgentRuntimeError("invalid_argument", `Model selector must look like provider/id, got "${selector}"`);
		await transport.request("set_model", { provider: model.provider, modelId: model.modelId });
		this.levels = [];
		this.touch();
		await this.getState();
	}

	async setThinkingLevel(level: string): Promise<void> {
		const transport = await this.connected();
		await transport.request("set_thinking_level", { level });
		this.thinkingSelector = null; // an explicit level replaces `auto`
		this.touch();
		await this.getState();
	}

	async getState(): Promise<SessionLiveState> {
		const transport = await this.connected();
		const state = await this.fetchState(transport);
		this.reconcileSettled(state);
		this.emit({ type: "state", state });
		return state;
	}

	async getStats(): Promise<SessionStats & { sessionId: string | null }> {
		const transport = await this.connected();
		return toSessionStats(await transport.request("get_session_stats"));
	}

	async messages(query: MessagesQuery = {}): Promise<MessagesPage> {
		if (this.stateName === "starting" || this.stateName === "restarting") await this.whenReady();
		this.touch();
		return this.mapper.page(query);
	}

	async respondToUiRequest(body: UiResponseBody): Promise<void> {
		const pending = this.mapper.pendingUiRequests().find((r) => r.requestId === body.requestId);
		if (!pending) throw new AgentRuntimeError("invalid_state", `No pending request ${body.requestId}`);
		const transport = this.transport;
		if (!transport || transport.state !== "ready") {
			throw new AgentRuntimeError("not_ready", "The agent runtime is not running", { state: this.stateName });
		}
		let frame: Record<string, unknown>;
		if (body.value === null) {
			frame = { type: "extension_ui_response", id: pending.requestId, cancelled: true };
		} else if (pending.method === "confirm") {
			if (typeof body.value !== "boolean") throw new AgentRuntimeError("invalid_argument", "A confirmation needs a boolean value");
			frame = { type: "extension_ui_response", id: pending.requestId, confirmed: body.value };
		} else if (pending.method === "select") {
			if (typeof body.value !== "string" || !(pending.options ?? []).includes(body.value)) {
				throw new AgentRuntimeError("invalid_argument", "The value must be one of the offered options", { options: pending.options });
			}
			frame = { type: "extension_ui_response", id: pending.requestId, value: body.value };
		} else if (pending.method === "input" || pending.method === "editor") {
			if (typeof body.value !== "string") throw new AgentRuntimeError("invalid_argument", "A text value is required");
			frame = { type: "extension_ui_response", id: pending.requestId, value: body.value };
		} else {
			throw new AgentRuntimeError("invalid_argument", `Requests of kind "${pending.method}" cannot be answered from the web UI`);
		}
		transport.send(frame);
		this.touch();
		const resolved = this.mapper.markUiResolved(pending.requestId);
		if (resolved) this.emit(resolved);
	}

	pendingUiRequests(): Array<Extract<SessionEvent, { type: "ui_request" }>> {
		return this.mapper.pendingUiRequests();
	}

	takeUsage(): UsageDelta[] {
		return this.mapper.takeUsage();
	}
}

/** `provider/id` -> parts. The provider is everything before the first slash; ids may contain slashes. A `:thinking` suffix is not part of the id. */
export function splitSelector(selector: string): { provider: string; modelId: string } | null {
	const slash = selector.indexOf("/");
	if (slash <= 0 || slash === selector.length - 1) return null;
	return { provider: selector.slice(0, slash), modelId: selector.slice(slash + 1) };
}
