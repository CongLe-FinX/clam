import { z } from "zod";
import { IsoDate } from "./common.ts";
import { TokenTotals } from "./usage.ts";

export const RuntimeKind = z.enum(["omp"]);
export type RuntimeKind = z.infer<typeof RuntimeKind>;

export const Agent = z.object({
	id: z.string(),
	nodeId: z.string(),
	name: z.string(),
	/** Free-text role, e.g. "Backend". Never interpreted by orchestration logic. */
	role: z.string(),
	runtime: RuntimeKind,
	capabilities: z.array(z.string()),
	status: z.enum(["online", "busy", "offline"]),
	activeSessions: z.number().int(),
	createdAt: IsoDate,
});
export type Agent = z.infer<typeof Agent>;
export const UpdateAgentBody = z.object({
	name: z.string().trim().min(1).max(64).optional(),
	role: z.string().max(120).optional(),
	capabilities: z.array(z.string().max(40)).max(32).optional(),
});

export const RuntimeState = z.enum(["stopped", "starting", "ready", "busy", "crashed", "restarting"]);
export type RuntimeState = z.infer<typeof RuntimeState>;

export const RuntimeStatus = z.object({
	sessionId: z.string(),
	state: RuntimeState,
	pid: z.number().nullable(),
	startedAt: IsoDate.nullable(),
	restarts: z.number().int(),
	lastError: z.string().nullable(),
	lastActivityAt: IsoDate.nullable(),
});
export type RuntimeStatus = z.infer<typeof RuntimeStatus>;

export const SessionStatus = z.enum(["idle", "running", "error", "stopped"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const ContextUsage = z.object({
	tokens: z.number(),
	contextWindow: z.number(),
	percent: z.number(),
});
export type ContextUsage = z.infer<typeof ContextUsage>;

export const SessionStats = z.object({
	userMessages: z.number(),
	assistantMessages: z.number(),
	toolCalls: z.number(),
	tokens: TokenTotals,
	cost: z.number(),
	contextUsage: ContextUsage.nullable(),
});
export type SessionStats = z.infer<typeof SessionStats>;

export const AgentSession = z.object({
	id: z.string(),
	projectId: z.string(),
	agentId: z.string(),
	title: z.string(),
	/** OMP session id once the runtime has opened it. */
	runtimeSessionId: z.string().nullable(),
	runtimeSessionFile: z.string().nullable(),
	model: z.string().nullable(),
	thinkingLevel: z.string().nullable(),
	status: SessionStatus,
	stats: SessionStats.nullable(),
	archived: z.boolean(),
	/**
	 * `local` = an OMP session running on this node. `mirror` = a read-only live copy of a session that runs on
	 * another node (shared sessions); it has no runtime here and rejects prompts.
	 */
	kind: z.enum(["local", "mirror"]),
	/** Set when this session belongs to a shared session (see `@clam/contracts` shared.ts). */
	sharedSessionId: z.string().nullable(),
	/** Set when the work continued on another node (takeover / transfer); this copy is then read-only. */
	movedTo: z.object({ nodeId: z.string(), nodeName: z.string(), url: z.string().nullable(), sessionId: z.string().nullable(), at: IsoDate }).nullable(),
	createdAt: IsoDate,
	updatedAt: IsoDate,
});
export type AgentSession = z.infer<typeof AgentSession>;

/** `provider/id` (optionally `:thinking`), e.g. `anthropic/claude-haiku-4-5`. A bare id is rejected: OMP would ignore it silently. */
export const ModelSelector = z.string().regex(/^[^/\s]+\/\S+$/, "Use provider/id, e.g. anthropic/claude-haiku-4-5");

export const CreateSessionBody = z.object({
	projectId: z.string().min(1),
	title: z.string().max(120).optional(),
	/** Defaults to OMP's default role. */
	model: ModelSelector.optional(),
	/** Optional first prompt, sent once the runtime is ready. */
	prompt: z.string().optional(),
});
export const UpdateSessionBody = z.object({
	title: z.string().trim().min(1).max(120).optional(),
	archived: z.boolean().optional(),
});

export const PromptBody = z.object({
	message: z.string().min(1),
	/** How to deliver while the agent is busy. Ignored when idle. */
	streamingBehavior: z.enum(["steer", "followUp"]).optional(),
	/** Client-generated id for optimistic rendering + idempotency. */
	clientId: z.string().min(1),
});
export const PromptAccepted = z.object({ promptId: z.string(), clientId: z.string() });
export const SetModelBody = z.object({ selector: ModelSelector });
export const SetThinkingBody = z.object({ level: z.string().min(1) });

// ---------------------------------------------------------------- messages

export const UiBlock = z.discriminatedUnion("type", [
	z.object({ type: z.literal("text"), text: z.string() }),
	z.object({ type: z.literal("thinking"), text: z.string(), redacted: z.boolean().optional() }),
	z.object({ type: z.literal("toolCall"), id: z.string(), name: z.string(), arguments: z.unknown(), intent: z.string().optional() }),
	z.object({ type: z.literal("image"), mimeType: z.string(), data: z.string() }),
]);
export type UiBlock = z.infer<typeof UiBlock>;

export const UiMessage = z.object({
	/** Stable within a session view (server-assigned). */
	id: z.string(),
	role: z.enum(["user", "assistant", "toolResult", "custom"]),
	timestamp: z.number(),
	content: z.array(UiBlock),
	// assistant
	provider: z.string().optional(),
	model: z.string().optional(),
	usage: z.object({ tokens: TokenTotals, cost: z.number() }).optional(),
	stopReason: z.string().optional(),
	errorMessage: z.string().optional(),
	// toolResult
	toolCallId: z.string().optional(),
	toolName: z.string().optional(),
	isError: z.boolean().optional(),
	// user optimistic echo
	clientId: z.string().optional(),
	// custom
	customType: z.string().optional(),
});
export type UiMessage = z.infer<typeof UiMessage>;

export const MessagesPage = z.object({
	messages: z.array(UiMessage),
	total: z.number(),
	nextCursor: z.string().nullable(),
});
export type MessagesPage = z.infer<typeof MessagesPage>;

export const TodoItem = z.object({ content: z.string(), status: z.string() });
export const TodoPhase = z.object({ name: z.string(), tasks: z.array(TodoItem) });
export type TodoPhase = z.infer<typeof TodoPhase>;

/** Live state of a session's runtime (subset of RPC get_state). */
export const SessionLiveState = z.object({
	sessionId: z.string(),
	runtime: RuntimeStatus,
	model: z.object({ provider: z.string(), id: z.string(), name: z.string().optional() }).nullable(),
	/** Effective level OMP reports (`get_state.thinkingLevel`). With selector `auto` this is what `auto` resolved to for the latest turn, so it can change between turns. */
	thinkingLevel: z.string().nullable(),
	/** The user-configured selector when it differs from the effective level (currently only `"auto"`); null/absent = same as `thinkingLevel` or not known yet (OMP reports it only after a turn). */
	thinkingSelector: z.string().nullable().optional(),
	availableThinkingLevels: z.array(z.string()),
	isStreaming: z.boolean(),
	isSettled: z.boolean(),
	contextUsage: ContextUsage.nullable(),
	queued: z.object({ steering: z.array(z.string()), followUp: z.array(z.string()) }),
	todoPhases: z.array(TodoPhase),
	tokensPerSecond: z.number().nullable(),
});
export type SessionLiveState = z.infer<typeof SessionLiveState>;

/** Normalized runtime events pushed on topic `session:<id>`. */
export type SessionEvent =
	| { type: "state"; state: SessionLiveState }
	| { type: "agent_start" }
	| { type: "agent_end" }
	| { type: "message_start"; message: UiMessage }
	| { type: "message_delta"; messageId: string; contentIndex: number; kind: "text" | "thinking" | "toolCall"; delta: string }
	| { type: "message_end"; message: UiMessage }
	/** A message shown for a prompt that never reached the agent (rejected, aborted or crashed before OMP echoed it) is withdrawn. */
	| { type: "message_removed"; messageId: string }
	| { type: "tool_start"; toolCallId: string; toolName: string; args: unknown; intent?: string }
	| { type: "tool_update"; toolCallId: string; preview: string }
	| { type: "tool_end"; toolCallId: string; isError: boolean; result: string }
	| { type: "prompt_result"; promptId: string; clientId: string; status: "completed" | "aborted" | "error"; error?: string }
	| { type: "settled" }
	| { type: "notice"; level: "info" | "warning" | "error"; message: string }
	/** Tool/extension approval or question that needs a human. Answer via POST /sessions/:id/ui-response. */
	| ({ type: "ui_request" } & PendingUiRequest)
	| { type: "ui_request_resolved"; requestId: string };

/** An unanswered approval/question; also listed by GET /sessions/:id/ui-requests for reconnecting clients. */
export interface PendingUiRequest {
	requestId: string;
	method: string;
	title: string;
	message?: string;
	options?: string[];
}

export const UiResponseBody = z.object({
	requestId: z.string(),
	/** confirm → boolean; select → option string; input → text; cancelled → null. */
	value: z.union([z.boolean(), z.string(), z.null()]),
});
