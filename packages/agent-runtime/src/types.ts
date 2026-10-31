import type { z } from "zod";
import type {
	MessagesPage,
	NodeSettings,
	RuntimeKind,
	RuntimeStatus,
	SessionEvent,
	SessionLiveState,
	SessionStats,
	TokenTotals,
	UiResponseBody as UiResponseBodySchema,
} from "@clam/contracts";

export type UiResponseBody = z.infer<typeof UiResponseBodySchema>;

/**
 * Provider-agnostic agent runtime contract (spec FR-04: "Runtime interface must be pluggable, OMP first").
 *
 * A runtime owns the lifecycle of one external agent process per active CLAM session and normalizes
 * everything it emits into contracts `SessionEvent`s / `UiMessage`s. Nothing outside `src/<runtime>/`
 * may know a runtime's wire protocol. The OMP implementation lives in `./omp`.
 */

export type ApprovalMode = NodeSettings["approvalMode"];

export interface RuntimeSessionSpec {
	/** CLAM session id. Key of everything in the runtime layer. */
	sessionId: string;
	/** Project working directory the agent works in. */
	cwd: string;
	/**
	 * Directory the runtime persists this conversation in. Reopening the same directory resumes the
	 * conversation, which is what makes sessions survive idle reaping, crashes and server restarts.
	 */
	sessionDir: string;
	/** `provider/id` to bind when the conversation is new; ignored when an existing one is resumed. */
	model?: string | null;
	/**
	 * Approval mode for this session's process, overriding the node-wide `SupervisorSettings.approvalMode`. Applied at
	 * every spawn of the session's process (including crash restarts); the caller computes the effective value (for
	 * example the stricter of the node setting and a task constraint). `--no-ui` is passed only when it is `yolo`.
	 */
	approvalMode?: ApprovalMode;
	/** Spend cap in USD for this session's process (`--max-cost`; OMP stops sending model requests once reached). Finite and > 0. */
	maxCostUsd?: number;
}

/** A tool CLAM exposes to the agent that is executed by the host (CLAM) rather than by the agent process. */
export interface HostToolDefinition {
	/** Unique per session; `[A-Za-z0-9_-]{1,64}` (the LLM providers' tool name grammar). Must not clash with a built-in tool. */
	name: string;
	label: string;
	description: string;
	/** JSON Schema object describing the tool arguments. */
	parameters: Record<string, unknown>;
	loadMode?: "essential" | "discoverable";
}

export interface HostToolCall {
	/** CLAM session id of the runtime that is calling. */
	sessionId: string;
	/** The model's tool call id. */
	toolCallId: string;
	toolName: string;
	arguments: unknown;
	/** Aborted when the agent cancels the call (`host_tool_cancel`), the session is stopped or the process exits. */
	signal: AbortSignal;
	/** Stream partial output to the agent while the call runs. Ignored once the call has been cancelled or has finished. */
	update(text: string): void;
}

export interface HostToolResult {
	/** Concise text the model can act on. */
	text: string;
	/** Surfaces `text` to the model as a tool error. */
	isError?: boolean;
}

export interface HostToolProvider {
	/** Tools to register for a session. Called at every (re)start of its process and by `refreshHostTools`. */
	definitions(sessionId: string): HostToolDefinition[];
	/**
	 * Run one call. Calls run concurrently. A throw becomes an error result carrying the message (no stack); after
	 * `call.signal` aborted the outcome is discarded.
	 */
	execute(call: HostToolCall): Promise<HostToolResult>;
}

export interface PromptInput {
	message: string;
	/** Client-generated id echoed back on the user message and the `prompt_result` event. */
	clientId: string;
	/** How to deliver while the agent is busy. Ignored when idle. */
	streamingBehavior?: "steer" | "followUp";
}

export interface MessagesQuery {
	/** Opaque cursor from a previous page; absent = newest page. */
	cursor?: string;
	/** 1..256, default 50. */
	limit?: number;
}

/** Runtime-side identifiers of the bound conversation, known once the runtime has opened it. */
export interface RuntimeBinding {
	runtimeSessionId: string | null;
	runtimeSessionFile: string | null;
}

/** Error raised by a runtime operation. `code` is stable and machine-readable. */
export class AgentRuntimeError extends Error {
	constructor(
		readonly code: RuntimeErrorCode,
		message: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "AgentRuntimeError";
	}
}

export type RuntimeErrorCode =
	/** The runtime executable is not installed / not found. */
	| "not_installed"
	/** Process failed to start or the handshake failed. */
	| "start_failed"
	/** Concurrency cap reached and no idle runtime could be reaped. */
	| "capacity"
	/** Runtime is stopped/crashed and did not become ready in time. */
	| "not_ready"
	/** A request timed out. */
	| "timeout"
	/** The runtime process exited while a request was pending. */
	| "process_exited"
	/** The runtime rejected the command (`details.runtimeCode` may carry its own code). */
	| "rejected"
	/** The runtime violated its wire protocol. */
	| "protocol"
	/** The session is not known to the runtime. */
	| "unknown_session"
	/** The operation is invalid in the current state (e.g. stop during shutdown, no such pending request). */
	| "invalid_state"
	/** The caller supplied a value the runtime cannot accept (e.g. an option that was not offered). */
	| "invalid_argument"
	/** `omp session pack/moved` refused because another live omp process holds the session's ownership lease. */
	| "session_locked"
	/** A session archive is missing, malformed or fails its integrity check (`omp session pack/unpack`). */
	| "invalid_archive";

/** Usage of one model, accumulated from assistant messages that finished since the last `takeUsage()`. */
export interface UsageDelta {
	provider: string;
	model: string;
	tokens: TokenTotals;
	/** USD as reported by the runtime. */
	cost: number;
}

export interface RuntimeSession {
	readonly sessionId: string;
	status(): RuntimeStatus;
	binding(): RuntimeBinding;

	/**
	 * Resolves once the process is up and the conversation is open, waiting through crash recovery up to
	 * `timeoutMs` (default 30 s). Rejects with `not_ready` / `start_failed`.
	 */
	whenReady(timeoutMs?: number): Promise<void>;

	/**
	 * Submit a prompt. Resolves with the runtime's prompt id once the runtime has *admitted* it
	 * (not when the turn completes); completion arrives as a `prompt_result` event carrying `clientId`.
	 */
	prompt(input: PromptInput): Promise<{ promptId: string }>;
	abort(): Promise<void>;
	setModel(selector: string): Promise<void>;
	setThinkingLevel(level: string): Promise<void>;
	/** Fresh live state (always asks the runtime; also publishes a `state` event). */
	getState(): Promise<SessionLiveState>;
	/** Cumulative statistics of this conversation as reported by the runtime. */
	getStats(): Promise<SessionStats & { sessionId: string | null }>;
	/**
	 * Transcript page, newest page first. `messages` inside a page are chronological; `nextCursor`
	 * points at the older page. Served from an in-memory transcript that includes the in-flight message.
	 */
	messages(query?: MessagesQuery): Promise<MessagesPage>;
	/** Answer an approval/question raised by the agent (`ui_request` event). */
	respondToUiRequest(body: UiResponseBody): Promise<void>;
	/** Currently unanswered `ui_request`s, so a reconnecting client can render them. */
	pendingUiRequests(): Array<Extract<SessionEvent, { type: "ui_request" }>>;
	/** Per-model usage of messages finished since the previous call (attribution for usage accounting); clears the buffer. */
	takeUsage(): UsageDelta[];
}

export interface AgentRuntime {
	readonly kind: RuntimeKind;
	/**
	 * Start (or reuse) the runtime process for a session and resolve once it is ready. When the node is
	 * at its concurrency cap, the least recently active idle+settled runtime is stopped to make room;
	 * if none is idle, rejects with `capacity`.
	 */
	open(spec: RuntimeSessionSpec): Promise<RuntimeSession>;
	/** The live runtime session (any state), if one exists. */
	get(sessionId: string): RuntimeSession | undefined;
	list(): RuntimeStatus[];
	/** Stop the process; the conversation stays on disk and can be reopened. Idempotent. */
	stop(sessionId: string): Promise<void>;
	/** Stop and start again, reopening the same conversation. */
	restart(sessionId: string): Promise<RuntimeStatus>;
	/** Events of every session. `settled` is delivered after the run's final `prompt_result`. */
	onEvent(listener: (sessionId: string, event: SessionEvent) => void): () => void;
	onStatus(listener: (status: RuntimeStatus) => void): () => void;
	/** Apply changed node settings (idle timeout, concurrency cap, approval mode) to the live supervisor. Approval mode changes reach processes started afterwards; a session's own `approvalMode` override always wins. */
	updateOptions(options: Partial<SupervisorSettings>): void;
	/**
	 * Install (or with `null` remove) the provider of host tools. Applied at once to every live session
	 * (`set_host_tools`) and registered after `open_session` on every later (re)start, so every process has the
	 * tools before its first prompt. Registration failures surface as `notice` events of the session and in the log.
	 */
	setHostToolProvider(provider: HostToolProvider | null): void;
	/**
	 * Re-read `provider.definitions(sessionId)` and replace the tools registered in the session's live process.
	 * Resolves once the process acknowledged them, immediately when nothing changed or when the session has no live
	 * runtime (a stopped session registers the current definitions at its next start); rejects when the definitions
	 * are invalid or the process rejected them (a `notice` event is published as well).
	 */
	refreshHostTools(sessionId: string): Promise<void>;
	/**
	 * Snapshot cycle: release the OMP ownership lease of a session's conversation, run `work`, then resume.
	 *
	 * 1. If the session has a live runtime process, wait until it is idle and settled (polling, up to
	 *    `options.idleTimeoutMs`, default 60 000); if it does not settle in time, reject with `invalid_state`
	 *    (busy) without having stopped anything. Then stop the process, which releases the lease.
	 * 2. Run `work()`; its result or error is passed through to the caller.
	 * 3. If a process was running before, reopen the conversation in the background (same spec, normal start
	 *    path incl. the concurrency cap); the call does not wait for it and a start failure is logged and
	 *    leaves the session stopped/crashed like any other failed start. Without a prior process nothing starts.
	 *
	 * While `work` runs, `open(spec)` for the same session waits until `work` has finished and then returns the
	 * (re)starting session, so a prompt issued meanwhile simply waits (hence `work` must not `open` this session:
	 * it would wait for itself). Cycles of one session are serialized. `stop`/`shutdown` during a cycle do not
	 * deadlock; after either, no restart happens.
	 */
	withReleased<T>(sessionId: string, work: () => Promise<T>, options?: { idleTimeoutMs?: number }): Promise<T>;
	/** Graceful shutdown of every process (close stdin, drain, SIGTERM, SIGKILL after grace). */
	shutdown(): Promise<void>;
}

/** Node settings that drive supervision; mirrors the relevant `NodeSettings` fields. */
export interface SupervisorSettings {
	maxConcurrentRuntimes: number;
	/** Stop an idle, settled runtime after this many ms. */
	idleTimeoutMs: number;
	approvalMode: ApprovalMode;
}

export interface RuntimeLogger {
	debug(obj: object | string, msg?: string): void;
	info(obj: object | string, msg?: string): void;
	warn(obj: object | string, msg?: string): void;
	error(obj: object | string, msg?: string): void;
	child?(bindings: Record<string, unknown>): RuntimeLogger;
}
