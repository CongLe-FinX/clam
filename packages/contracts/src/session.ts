import { z } from "zod";
import { I18nText, IsoDate } from "./common.ts";
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
	/**
	 * Addresses the folder this session works in, for the git, file and terminal routes: `<projectId>` (the project's own folder) or
	 * `<projectId>~<sharedSessionId>` (the git worktree of the shared session it drives on this node).
	 */
	checkoutId: z.string(),
	/** Set when the work continued on another node (takeover / transfer); this copy is then read-only. */
	movedTo: z.object({ nodeId: z.string(), nodeName: z.string(), url: z.string().nullable(), sessionId: z.string().nullable(), at: IsoDate }).nullable(),
	/** Questions and approvals the agent is waiting on (drives the badge in session lists). */
	pendingRequests: z.number().int().default(0),
	createdAt: IsoDate,
	updatedAt: IsoDate,
});
export type AgentSession = z.infer<typeof AgentSession>;

/** `provider/id` (optionally `:thinking`), e.g. `anthropic/claude-haiku-4-5`. A bare id is rejected: OMP would ignore it silently. */
export const ModelSelector = z.string().regex(/^[^/\s]+\/\S+$/, "Use provider/id, e.g. anthropic/claude-haiku-4-5");

export const CreateSessionBody = z.object({
	/**
	 * Omit to start a plain chat with no repository: the node creates a managed folder for it (Project.origin `chat`)
	 * where the agent keeps its notes, reports, media and other outputs.
	 */
	projectId: z.string().min(1).optional(),
	/** Workspace for a chat without `projectId` (defaults to the node's first workspace). */
	workspaceId: z.string().min(1).optional(),
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

/** Image types a prompt can carry to the model (what vision models accept). */
export const PROMPT_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
/** At most this many images per prompt. */
export const PROMPT_IMAGES_MAX_COUNT = 8;
/**
 * All images of one prompt together, as base64 characters. OMP reads each command as one unchunked JSONL frame of at most 1 MiB
 * (`maxFrameBytes` of its ready frame) and echoes the user message back in a frame of its own, so the images leave room for the text.
 */
export const PROMPT_IMAGES_MAX_BASE64_BYTES = 768 * 1024;

export const PromptImage = z.object({
	mimeType: z.enum(PROMPT_IMAGE_MIME_TYPES),
	/** Base64 of the image bytes, no `data:` prefix. */
	data: z.string().min(1).max(PROMPT_IMAGES_MAX_BASE64_BYTES).regex(/^[A-Za-z0-9+/]+={0,2}$/, "Image data must be base64"),
});
export type PromptImage = z.infer<typeof PromptImage>;

export const PromptImages = z
	.array(PromptImage)
	.max(PROMPT_IMAGES_MAX_COUNT)
	.superRefine((images, ctx) => {
		const total = images.reduce((sum, image) => sum + image.data.length, 0);
		if (total > PROMPT_IMAGES_MAX_BASE64_BYTES) ctx.addIssue({ code: "custom", message: `Images together exceed ${PROMPT_IMAGES_MAX_BASE64_BYTES} bytes of base64` });
	});

export const PromptBody = z.object({
	message: z.string().min(1),
	/** Images the model sees (vision input) next to the text. The client also saves them in the project folder so tools can use the files. */
	images: PromptImages.optional(),
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
	/**
	 * Structured result data of a `todo` (`{ phases }`) or `ask` (`{ results }`) tool call, copied from OMP's tool result
	 * `details` so the UI can render a diff / the answers without parsing the text. Absent for every other tool.
	 */
	toolDetails: z.unknown().optional(),
});
export type UiMessage = z.infer<typeof UiMessage>;

export const MessagesPage = z.object({
	messages: z.array(UiMessage),
	total: z.number(),
	nextCursor: z.string().nullable(),
});
export type MessagesPage = z.infer<typeof MessagesPage>;

// ---------------------------------------------------------------- turn outputs

/** One file an agent turn created or modified in the session's project folder. */
export const TurnOutputFile = z.object({
	/** Posix path relative to the project root (`projectRaw` takes it as `?path=`). */
	path: z.string(),
	name: z.string(),
	size: z.number().int(),
	mimeType: z.string(),
	/** Epoch ms. */
	modifiedAt: z.number(),
	change: z.enum(["created", "modified"]),
});
export type TurnOutputFile = z.infer<typeof TurnOutputFile>;

/**
 * The files one agent turn (agent_start → agent_end) produced, detected by diffing a (path, size, mtime) snapshot of the
 * project folder taken at turn start against one taken when the turn ends, plus the paths the turn's write/edit tool calls
 * named. Persisted per turn (`turn_outputs` table) so a reload or another device shows the same strip; pushed live as
 * `SessionEvent` `turn_outputs`. The strip belongs under the turn's last assistant message (`anchorMessageId`; match
 * `anchorTimestamp` against message timestamps when ids differ after a runtime restart).
 */
export const TurnOutputs = z.object({
	id: z.string(),
	sessionId: z.string(),
	/** Checkout id of the folder the turn ran in (`<projectId>` or `<projectId>~<sharedSessionId>`); pass it to the file routes. */
	projectId: z.string(),
	anchorMessageId: z.string().nullable(),
	anchorTimestamp: z.number().nullable(),
	startedAt: z.number(),
	endedAt: z.number(),
	files: z.array(TurnOutputFile),
	/** More files changed than `files` lists (capped). */
	truncated: z.boolean(),
});
export type TurnOutputs = z.infer<typeof TurnOutputs>;

/** `GET /sessions/:id/outputs`: the files of every turn that produced some, oldest → newest (newest 500 turns). */
export const SessionOutputsPage = z.object({ outputs: z.array(TurnOutputs) });
export type SessionOutputsPage = z.infer<typeof SessionOutputsPage>;

export const TodoItem = z.object({ content: z.string(), status: z.string() });
export const TodoPhase = z.object({ name: z.string(), tasks: z.array(TodoItem) });
export type TodoPhase = z.infer<typeof TodoPhase>;

// ---------------------------------------------------------------- subagents

export const SubagentStatus = z.enum(["pending", "running", "completed", "failed", "aborted"]);
export type SubagentStatus = z.infer<typeof SubagentStatus>;

/** One tool call a subagent finished recently (newest last). */
export const SubagentToolRun = z.object({
	tool: z.string(),
	args: z.string(),
	intent: z.string().optional(),
	isError: z.boolean().optional(),
	endedAt: z.number(),
});
export type SubagentToolRun = z.infer<typeof SubagentToolRun>;

/**
 * A subagent the session's agent spawned with the `task` tool, as last reported by the runtime (`subagent_lifecycle` /
 * `subagent_progress` frames). `id` is unique within the session. Finished subagents stay listed.
 */
export const Subagent = z.object({
	id: z.string(),
	/** Spawn order within the session. */
	index: z.number().int(),
	/** Agent definition that runs it (`task`, `scout`, ...). */
	agent: z.string(),
	/** The `task` tool call that spawned it: render the subagent under that call. */
	parentToolCallId: z.string().nullable(),
	status: SubagentStatus,
	/** One-line summary of what it was asked to do. */
	description: z.string().nullable(),
	/** What it was asked to do (the assignment text). */
	assignment: z.string().nullable(),
	/** `provider/id[:thinking]` it runs on, when known. */
	model: z.string().nullable(),
	/** Its own intent line / current step in words. */
	stage: z.string().nullable(),
	currentTool: z.string().nullable(),
	currentToolArgs: z.string().nullable(),
	recentTools: z.array(SubagentToolRun),
	/** Last lines of text it produced. */
	recentOutput: z.array(z.string()),
	toolCount: z.number().int(),
	requests: z.number().int(),
	tokens: z.number(),
	cost: z.number(),
	contextTokens: z.number().nullable(),
	contextWindow: z.number().nullable(),
	/** Its own estimate of completion, 0..100. */
	completionPercent: z.number().nullable(),
	/** Runs as a background job (the parent turn keeps going). */
	detached: z.boolean(),
	/** Runtime-reported run time so far (ms). */
	durationMs: z.number(),
	/** Epoch ms the spawn was first seen here / the last update was received (drive elapsed timers and ordering). */
	startedAt: z.number(),
	updatedAt: z.number(),
	/** A transcript can be read (`GET .../subagents/:id/messages`). */
	hasTranscript: z.boolean(),
	/** Why it ended badly, when the runtime said so. */
	error: z.string().nullable(),
});
export type Subagent = z.infer<typeof Subagent>;

/** `GET /sessions/:id/subagents`. `live` is false when the runtime is stopped and the list is the last known snapshot. */
export const SubagentsPage = z.object({ subagents: z.array(Subagent), live: z.boolean() });
export type SubagentsPage = z.infer<typeof SubagentsPage>;

export const SubagentMessagesQuery = z.object({ fromByte: z.coerce.number().int().min(0).optional() });

/**
 * `GET /sessions/:id/subagents/:subId/messages?fromByte=`: the subagent's own transcript, incrementally. Pass `nextByte`
 * as the next `fromByte`; `reset` means the file shrank/restarted and `messages` is the whole transcript again.
 */
export const SubagentMessagesPage = z.object({
	fromByte: z.number(),
	nextByte: z.number(),
	reset: z.boolean(),
	messages: z.array(UiMessage),
});
export type SubagentMessagesPage = z.infer<typeof SubagentMessagesPage>;

export const SteerSubagentBody = z.object({ message: z.string().trim().min(1).max(20_000) });
export const CancelSubagentResult = z.object({ cancelled: z.boolean() });
export type CancelSubagentResult = z.infer<typeof CancelSubagentResult>;

// ---------------------------------------------------------------- questions (OMP `ask`)

export const AskOption = z.object({
	label: z.string(),
	description: z.string().optional(),
	/** Markdown or code shown beside / below the options while this one is highlighted. */
	preview: z.string().optional(),
});
export type AskOption = z.infer<typeof AskOption>;

export const AskQuestion = z.object({
	id: z.string(),
	question: z.string(),
	/** Short chip label ("Database"). */
	header: z.string().optional(),
	/** Never includes "Other": the UI always offers free text. */
	options: z.array(AskOption),
	multi: z.boolean().optional(),
	/** Index into `options` the agent suggests. */
	recommended: z.number().int().optional(),
});
export type AskQuestion = z.infer<typeof AskQuestion>;

/** One answer, exactly as OMP takes it: exact option labels (no duplicates) and/or trimmed free text. */
export const AskAnswer = z.object({
	id: z.string(),
	selectedOptions: z.array(z.string()),
	customInput: z.string().optional(),
});
export type AskAnswer = z.infer<typeof AskAnswer>;

export const UiRequestOutcome = z.enum(["answered", "cancelled", "timed_out", "abandoned"]);
export type UiRequestOutcome = z.infer<typeof UiRequestOutcome>;

/** Who gave the answer of a shared session's request: a person at the UI of machine `machine` (`nodeId`). */
export const UiRequestAnswerer = z.object({ nodeId: z.string(), machine: z.string() });
export type UiRequestAnswerer = z.infer<typeof UiRequestAnswerer>;

/** How a request ended (kept by the driver for a while, replicated to participants inside `SessionLiveState.requests`). */
export const UiRequestResolution = z.object({
	requestId: z.string(),
	outcome: UiRequestOutcome,
	answers: z.array(AskAnswer).optional(),
	/** Absent when nobody answered (timeout, the agent cancelled) or the answerer is not known. */
	answeredBy: UiRequestAnswerer.optional(),
	at: z.number(),
});
export type UiRequestResolution = z.infer<typeof UiRequestResolution>;

/** An unanswered approval/question; also listed by GET /sessions/:id/ui-requests for reconnecting clients. */
export const PendingUiRequest = z.object({
	requestId: z.string(),
	method: z.string(),
	title: z.string(),
	message: z.string().optional(),
	options: z.array(z.string()).optional(),
	/** `select` only: the description of each option, aligned with `options`. */
	optionDetails: z.array(z.object({ description: z.string().optional() })).optional(),
	/** `ask` only: every question of the tool call. */
	questions: z.array(AskQuestion).optional(),
	/** The agent gives up waiting after this long and uses the defaults (ms). */
	timeoutMs: z.number().optional(),
	/** Epoch ms the request was raised on this node; `raisedAt + timeoutMs` is when the agent's timer ends. */
	raisedAt: z.number().optional(),
});
export type PendingUiRequest = z.infer<typeof PendingUiRequest>;

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
	/**
	 * The agent is waiting for a human (a question or an approval). Mirrors get it through the forwarded `state` event, so a
	 * read-only copy can say "waiting for an answer on <machine>" without being able to answer. Null/absent = nothing pending.
	 */
	awaiting: z.object({ method: z.string(), title: z.string(), count: z.number().int() }).nullable().optional(),
	/**
	 * Shared sessions only: the DRIVER's pending questions/approvals in full, plus how the latest ones ended. It rides the
	 * forwarded `state` (old nodes strip the unknown key), so a participant machine can show the same answerable card and
	 * learn who answered. `at` is the driver's clock when it was published (the receiver rebases `raisedAt` onto its own clock).
	 */
	requests: z.object({ pending: z.array(PendingUiRequest), resolved: z.array(UiRequestResolution), at: z.number() }).optional(),
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
	| { type: "tool_end"; toolCallId: string; isError: boolean; result: string; toolDetails?: unknown }
	| { type: "prompt_result"; promptId: string; clientId: string; status: "completed" | "aborted" | "error"; error?: string }
	| { type: "settled" }
	/** `i18n` is the structured twin of `message` when the text is ours (not passed through from OMP). */
	| { type: "notice"; level: "info" | "warning" | "error"; message: string; i18n?: I18nText | undefined }
	/** Files the turn that just ended produced (only emitted when there are some). */
	| { type: "turn_outputs"; outputs: TurnOutputs }
	/** Tool/extension approval or question that needs a human. Answer via POST /sessions/:id/ui-response. */
	| ({ type: "ui_request" } & PendingUiRequest)
	/**
	 * The request is closed: answered (here or on another device), cancelled by the agent, or timed out. For an `ask`
	 * `answers` holds what the agent received (the submitted ones, or the defaults it used on timeout/cancel).
	 */
	| { type: "ui_request_resolved"; requestId: string; outcome?: UiRequestOutcome; answers?: AskAnswer[]; answeredBy?: UiRequestAnswerer }
	/** A subagent appeared or changed (lifecycle or progress). The payload is the whole current snapshot. */
	| { type: "subagent_upsert"; subagent: Subagent }
	| { type: "subagent_remove"; subagentId: string };

export const UiResponseBody = z
	.object({
		requestId: z.string(),
		/** confirm → boolean; select → option string; input/editor → text; cancelled → null. Omit for an `ask` (use `answers`). */
		value: z.union([z.boolean(), z.string(), z.null()]).optional(),
		/** `ask`: one entry per question in request order, with each `id` equal to the question's `id` (OMP rejects anything else). */
		answers: z.array(AskAnswer).optional(),
	})
	.refine((body) => (body.value === undefined) !== (body.answers === undefined), { message: "Send exactly one of `value` and `answers`" });
