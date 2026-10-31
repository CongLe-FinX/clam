import { TaskConstraints, TaskDeliverAs, TaskResult, TaskStatus } from "@clam/contracts";
import { fingerprintOfPublicKey, nodeIdFromFingerprint } from "@clam/node-identity";
import { z } from "zod";
import { isValidPublicKey, publicKeyToBase64 } from "./encoding.ts";
import { FORMAT } from "./signing.ts";

/**
 * Zod schemas of every `/api/v1` wire payload implemented in M3 (docs/agent-network-protocol.md §4,
 * §5.1–5.4, §5.13, §11, §12 and the additive `/node/announce` and `/node/revoke`). Unknown fields are
 * ignored (protocol §13: changes within a version are additive), so these use plain `z.object`.
 * Imported as `wire.*` from the package root. Public keys are base64url on the wire; schemas also
 * accept padded/standard base64.
 */

const NodeId = z.string().regex(FORMAT.nodeId);
const PublicKey = z.string().refine(isValidPublicKey, { message: "not a canonical Ed25519 public key (32 bytes, base64/base64url)" });
const Fingerprint = z.string().regex(/^[0-9a-f]{64}$/);
const Nonce = z.string().regex(FORMAT.nonce);
const Proof = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const Signature = z.string().regex(FORMAT.signature);
const InvitationId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const CapabilityName = z.string().min(1).max(64);
const IsoDate = z.string().min(1).max(64);
const Name = z.string().min(1).max(128);
const PeerUrl = z.string().min(1).max(2048);
const Count = z.number().int().nonnegative();

export const HealthStatus = z.enum(["ok", "degraded", "down"]);
export type HealthStatus = z.infer<typeof HealthStatus>;

/** The `nodeId` and `fingerprint` of a key are derived, so a payload claiming otherwise is forged. */
function checkIdentityClaim(claim: { nodeId: string; publicKey: string; fingerprint?: string }, ctx: z.RefinementCtx): void {
	if (!isValidPublicKey(claim.publicKey)) return;
	const fingerprint = fingerprintOfPublicKey(publicKeyToBase64(claim.publicKey));
	if (claim.fingerprint !== undefined && claim.fingerprint !== fingerprint) {
		ctx.addIssue({ code: "custom", message: "fingerprint does not match publicKey", path: ["fingerprint"] });
	}
	if (claim.nodeId !== nodeIdFromFingerprint(fingerprint)) {
		ctx.addIssue({ code: "custom", message: "nodeId does not derive from publicKey", path: ["nodeId"] });
	}
}

// ---------------------------------------------------------------- errors

export const ApiErrorBody = z.object({
	error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

// ---------------------------------------------------------------- GET /node/info (public, §5.1)

export const NodeInfo = z
	.object({
		protocolVersions: z.array(z.number().int().positive()).min(1),
		nodeId: NodeId,
		name: Name,
		publicKey: PublicKey,
		fingerprint: Fingerprint,
		appVersion: z.string().max(64),
		platform: z.string().max(64),
		arch: z.string().max(64),
		publicUrl: PeerUrl.nullable(),
		capabilities: z.array(CapabilityName).max(64),
		runtimes: z.array(z.string().max(64)).max(32),
		startedAt: IsoDate,
	})
	.superRefine(checkIdentityClaim);
export type NodeInfo = z.infer<typeof NodeInfo>;

// ---------------------------------------------------------------- GET /node/health (§5.2)

/** Unauthenticated answer. */
export const NodeHealthMinimal = z.object({ status: HealthStatus, time: z.number().int().nonnegative() });
export type NodeHealthMinimal = z.infer<typeof NodeHealthMinimal>;

export const NodeHealthCheck = z.object({ name: z.string().max(64), status: HealthStatus, message: z.string().max(500).optional() });

/** Answer to a signed request from a paired peer. */
export const NodeHealthFull = z.object({
	status: HealthStatus,
	uptimeMs: Count,
	time: z.number().int().nonnegative(),
	activeRuntimes: Count,
	maxConcurrentRuntimes: Count,
	runningTasks: Count,
	queuedTasks: Count,
	checks: z.array(NodeHealthCheck).max(64),
});
export type NodeHealthFull = z.infer<typeof NodeHealthFull>;

/** Either shape; `NodeHealthFull` is tried first. */
export const NodeHealth = z.union([NodeHealthFull, NodeHealthMinimal]);
export type NodeHealth = z.infer<typeof NodeHealth>;

// ---------------------------------------------------------------- POST /node/pair (§5.3, §11)

/** `node` object exchanged during pairing. */
export const PairNode = z
	.object({ nodeId: NodeId, name: Name, publicKey: PublicKey, publicUrl: PeerUrl })
	.superRefine(checkIdentityClaim);
export type PairNode = z.infer<typeof PairNode>;

/** Joiner → inviter. `proof = pairingProof(codeKey, "hello", helloProofParts(…))`. */
export const PairHelloRequest = z.object({
	step: z.literal("hello"),
	invitationId: InvitationId,
	node: PairNode,
	nonce: Nonce,
	proof: Proof,
});
export type PairHelloRequest = z.infer<typeof PairHelloRequest>;

/** Inviter → joiner, answering a hello; the inviter's user has not approved yet. */
export const PairHelloResponse = z.object({
	step: z.literal("hello"),
	node: PairNode,
	nonce: Nonce,
	proof: Proof,
	status: z.literal("pending_user_approval"),
	workspaceId: z.string().min(1).max(128),
	workspaceName: Name,
	expiresAt: IsoDate,
});
export type PairHelloResponse = z.infer<typeof PairHelloResponse>;

/**
 * Inviter → joiner after the inviter's user decided. `capabilities` is what the inviter grants the
 * joiner (bound into the transcript); `signature` is the inviter's {@link signTranscript} over it. A
 * rejection is `status: "rejected"` with `capabilities: []`.
 */
export const PairConfirmRequest = z.object({
	step: z.literal("confirm"),
	invitationId: InvitationId,
	signature: Signature,
	capabilities: z.array(CapabilityName).max(64),
	node: PairNode.optional(),
	status: z.enum(["approved", "rejected"]).default("approved"),
	reason: z.string().max(500).optional(),
});
export type PairConfirmRequest = z.infer<typeof PairConfirmRequest>;

/** Joiner → inviter, as the HTTP response to the confirm: the joiner's transcript signature and what it grants the inviter. */
export const PairConfirmResponse = z.object({
	step: z.literal("confirm"),
	signature: Signature,
	grantedCapabilities: z.array(CapabilityName).max(64),
	status: z.literal("paired"),
});
export type PairConfirmResponse = z.infer<typeof PairConfirmResponse>;

/** Any request body of `POST /node/pair`. */
export const PairRequest = z.discriminatedUnion("step", [PairHelloRequest, PairConfirmRequest]);
export type PairRequest = z.infer<typeof PairRequest>;

// ---------------------------------------------------------------- GET /agents (§5.4)

export const AgentStatus = z.enum(["online", "busy", "offline"]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const AgentEntry = z.object({
	agentId: z.string().min(1).max(128),
	name: z.string().max(128),
	/** Free text; callers must not branch on specific role names. */
	role: z.string().max(256),
	runtime: z.string().max(64),
	capabilities: z.array(z.string().max(64)).max(64),
	status: AgentStatus,
	activeTasks: Count,
	acceptsTasks: z.boolean(),
	/** Additive: runtime sessions currently open for this agent. */
	activeSessions: Count.default(0),
});
export type AgentEntry = z.infer<typeof AgentEntry>;

export const AgentsResponse = z.object({ agents: z.array(AgentEntry).max(1000) });
export type AgentsResponse = z.infer<typeof AgentsResponse>;

// ---------------------------------------------------------------- POST /node/announce, /node/revoke (additive, §13)

/** Signed notice that the sender's reachable URL (and optionally name) changed. */
export const AnnounceBody = z.object({ url: PeerUrl, name: Name.optional() });
export type AnnounceBody = z.infer<typeof AnnounceBody>;

/** Signed best-effort notice that the sender revoked the receiver. */
export const RevokeBody = z.object({ reason: z.string().max(500).optional() });
export type RevokeBody = z.infer<typeof RevokeBody>;

export const OkResponse = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponse>;

// ---------------------------------------------------------------- GET /events (§5.13, §8)

/** `type` values on stream `node` in M3. Receivers must ignore unknown types (§13). */
export const NODE_EVENT_TYPES = ["agents_changed", "health", "peer_revoked", "peer_updated", "task.updated"] as const;
export const NodeEventType = z.enum(NODE_EVENT_TYPES);
export type NodeEventType = z.infer<typeof NodeEventType>;

/** The JSON in the SSE `data:` line of every event. */
export const NodeEvent = z.object({
	stream: z.string().min(1).max(128),
	/** Gap-free per stream. */
	seq: z.number().int().nonnegative(),
	eventId: z.string().min(1).max(128),
	at: IsoDate,
	correlationId: z.string().min(1).max(128),
	epoch: z.number().int().nonnegative().optional(),
	type: z.string().min(1).max(64),
	payload: z.unknown(),
});
export type NodeEvent = z.infer<typeof NodeEvent>;

/** Payload of each {@link NODE_EVENT_TYPES} entry (all fields optional: pure hints, consumers re-fetch). */
export const NodeEventPayloads = {
	agents_changed: z.object({ count: Count.optional() }),
	health: z.object({ status: HealthStatus.optional() }),
	peer_revoked: z.object({ reason: z.string().max(500).optional() }),
	peer_updated: z.object({ url: PeerUrl.optional(), name: Name.optional() }),
	/** M4: a task shared with the addressed peer changed (audience-scoped); the consumer polls `GET /tasks/:id?since=` — a pure hint. */
	"task.updated": z.object({ taskId: z.string().optional(), seq: Count.optional(), status: z.string().optional() }),
} as const;

// ---------------------------------------------------------------- tasks (M4, §5.5–5.8)

const WireId = z.string().regex(FORMAT.id);

/** Message kinds on the wire. Protocol §5.8 listed `instruction | answer | note`; `question` is the additive M4 kind an executing agent uses to ask its delegator. */
export const TASK_MESSAGE_KINDS = ["instruction", "question", "answer", "note"] as const;
export const TaskMessageKind = z.enum(TASK_MESSAGE_KINDS);
export type TaskMessageKind = z.infer<typeof TaskMessageKind>;

/** `POST /tasks` body (sender → executor). `deliverAs` and `sender` are additive to §5.5. */
export const CreateTaskRequest = z.object({
	taskId: WireId,
	workspaceId: z.string().min(1).max(128),
	/**
	 * The task's GitHub repository; the executor maps it to one of its local projects. Absent for a task without a git
	 * repository (`deliverAs` summary/files): the executor then works in a folder of its own. Required for `deliverAs: branch`.
	 */
	projectRef: z
		.object({
			repoUrl: z.string().min(1).max(2048),
			branch: z.string().min(1).max(255).nullish(),
			commit: z.string().min(1).max(64).nullish(),
		})
		.nullish(),
	/** Input files (a folder bundle the sender holds): the executor downloads it with `GET /tasks/:id/inputs/:artifactId` before the agent starts. */
	inputFiles: z.object({ artifactId: WireId, sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().positive(), fileCount: Count }).nullish(),
	title: z.string().min(1).max(200),
	description: z.string().max(50_000),
	targetAgentId: z.string().min(1).max(128).optional(),
	deliverAs: TaskDeliverAs.default("branch"),
	constraints: TaskConstraints.default({}),
	epoch: z.number().int().nonnegative(),
	correlationId: WireId,
	/** The delegating agent (display only); absent when a human created the task. */
	sender: z.object({ agentId: z.string().max(128).nullish(), agentName: z.string().max(128).nullish() }).default({}),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequest>;

/** The executor's view of a task (`TaskRecord`, §5.5): what the sender mirrors. */
export const TaskRecord = z.object({
	taskId: WireId,
	status: TaskStatus,
	epoch: z.number().int().nonnegative(),
	agentId: z.string().max(128).nullish(),
	agentName: z.string().max(128).nullish(),
	reason: z.string().max(5000).nullish(),
	createdAt: IsoDate,
	updatedAt: IsoDate,
	startedAt: IsoDate.nullish(),
	finishedAt: IsoDate.nullish(),
	result: TaskResult.nullish(),
	/** Executor-reported spend (USD). */
	cost: z.number().nullish(),
	lastEventSeq: Count,
});
export type TaskRecord = z.infer<typeof TaskRecord>;

export const TaskEventWire = z.object({
	seq: z.number().int().positive(),
	type: z.string().min(1).max(32),
	at: IsoDate,
	summary: z.string().max(2000),
	payload: z.unknown().optional(),
});
export type TaskEventWire = z.infer<typeof TaskEventWire>;

/** `GET /tasks/:id[?since=<seq>]`: the record plus, with `since`, the events newer than the cursor (oldest first, gap-free). */
export const GetTaskResponse = TaskRecord.extend({ events: z.array(TaskEventWire).max(5000).optional() });
export type GetTaskResponse = z.infer<typeof GetTaskResponse>;

/** `POST /tasks/:id/cancel` body (§5.7). */
export const CancelTaskRequest = z.object({ epoch: z.number().int().nonnegative(), reason: z.string().max(2000).optional() });
export type CancelTaskRequest = z.infer<typeof CancelTaskRequest>;

/** `POST /tasks/:id/messages` body (§5.8), both directions. `author`/`createdAt` are additive. */
export const TaskMessageRequest = z.object({
	messageId: WireId,
	epoch: z.number().int().nonnegative(),
	kind: TaskMessageKind,
	body: z.string().min(1).max(20_000),
	author: z.object({ kind: z.enum(["human", "agent"]), agentId: z.string().max(128).nullish(), agentName: z.string().max(128).nullish() }),
	createdAt: IsoDate,
});
export type TaskMessageRequest = z.infer<typeof TaskMessageRequest>;

/** 202 answer to a message. */
export const TaskMessageAccepted = z.object({ messageId: WireId, accepted: z.literal(true), eventSeq: Count });
export type TaskMessageAccepted = z.infer<typeof TaskMessageAccepted>;

// ---------------------------------------------------------------- shared sessions (M5, docs/agent-network-protocol.md §5.9a)

/**
 * Wire payloads of `/api/v1/shared*`. Every endpoint needs the capability `sessions.share` (granted by the RECEIVING node
 * to the caller). The driver is the node whose local OMP session does the work; `epoch` is the fencing token and rises on
 * every driver change — a driver-only call (mirror, checkpoint, driver notice, transfer) carrying an older epoch is
 * answered `409 stale_epoch`.
 */

/** `POST /shared/invites` (driver → invited node): ask a node to join. Idempotent by `inviteId`. */
export const SharedInviteRequest = z.object({
	inviteId: WireId,
	sharedSessionId: WireId,
	workspaceId: z.string().min(1).max(128),
	title: z.string().min(1).max(200),
	/** What the work is about (shown to the invited user and used to brief the joining agent). */
	goal: z.string().max(50_000).default(""),
	/** How the working files travel: a shared git branch (default) or folder bundles with no repository (`files`). */
	vcs: z.enum(["git", "files"]).default("git"),
	/** git mode (required then): the shared session's repository and branch; absent in files mode. */
	repo: z
		.object({
			/** The shared session's GitHub repository; the invited node maps it to one of its local projects. */
			url: z.string().min(1).max(2048),
			/** The shared branch the driver commits checkpoints to (`clam/shared/…`). */
			branch: z.string().min(1).max(255),
			baseBranch: z.string().min(1).max(255).nullish(),
			baseCommit: z.string().min(1).max(64).nullish(),
		})
		.nullish(),
	epoch: z.number().int().positive(),
	/** The agent on the invited node the driver asked for; absent = the invited node chooses. */
	targetAgentId: z.string().min(1).max(128).optional(),
	/** The driving agent (display) and the base URL of the driver's web UI (links to watch the session there). */
	driver: z.object({ agentId: z.string().max(128).nullish(), agentName: z.string().max(128).nullish(), uiUrl: z.string().max(2048).nullish() }).default({}),
	/** `provider/id` of the driving session; the joining agent starts with it when the invited node has that model (display and cost parity, never required). */
	model: z.string().max(200).nullish(),
});
export type SharedInviteRequest = z.infer<typeof SharedInviteRequest>;

export const SharedInviteAccepted = z.object({ inviteId: WireId, state: z.enum(["pending", "accepted", "declined"]) });
export type SharedInviteAccepted = z.infer<typeof SharedInviteAccepted>;

/** `POST /shared/:id/decision` (invited node → driver): the answer to an invite. */
export const SharedDecisionRequest = z.object({
	inviteId: WireId,
	decision: z.enum(["accept", "decline"]),
	/** The agent that joined (accept). */
	agent: z.object({ agentId: z.string().min(1).max(128), agentName: z.string().max(128) }).nullish(),
	/** That agent's own participant session on the accepting node. */
	agentSessionId: z.string().max(128).nullish(),
	uiUrl: z.string().max(2048).nullish(),
	reason: z.string().max(2000).nullish(),
});
export type SharedDecisionRequest = z.infer<typeof SharedDecisionRequest>;

export const SHARED_MESSAGE_KINDS = ["chat", "reply", "system", "instruction", "question", "answer", "note"] as const;
export const SharedMessageKind = z.enum(SHARED_MESSAGE_KINDS);
export type SharedMessageKind = z.infer<typeof SharedMessageKind>;

/** Addressing of a group message: everybody, the current lead (each receiver resolves it against its own driver), or named agents (one per node). */
export const SharedMessageTo = z.object({
	mode: z.enum(["all", "lead", "agents"]),
	agents: z.array(z.object({ nodeId: NodeId, agentId: z.string().min(1).max(128) })).max(64),
});
export type SharedMessageTo = z.infer<typeof SharedMessageTo>;

/** Metadata of a file posted in the group chat (the bytes travel separately, content-addressed by `sha256`). */
export const SharedAttachmentWire = z.object({
	id: WireId,
	name: z.string().min(1).max(255),
	mimeType: z.string().min(1).max(255),
	size: z.number().int().nonnegative().max(2 * 1024 * 1024 * 1024),
	sha256: Fingerprint,
});
export type SharedAttachmentWire = z.infer<typeof SharedAttachmentWire>;

/**
 * One message of the group chat of a shared session, as sent by its origin (`POST /shared/:id/messages`, any member node →
 * every other) and as served by the catch-up pull (`POST /shared/:id/messages/sync`, which may relay the messages of any
 * member). `origin` is the node that accepted the message: its id, display name and the per-origin sequence number
 * (1, 2, 3 …, the unit of the catch-up cursor); `hlc` is the hybrid logical clock stamp (`<15 digits ms>-<5 digits counter>`).
 * The log order is `(hlc, origin.nodeId, messageId)`.
 */
export const SharedMessageRequest = z
	.object({
		messageId: WireId,
		epoch: z.number().int().positive(),
		kind: SharedMessageKind,
		/** Empty only for a message that carries files. */
		body: z.string().max(20_000),
		author: z.object({ kind: z.enum(["human", "agent", "system"]), agentId: z.string().max(128).nullish(), agentName: z.string().max(128).nullish() }),
		to: SharedMessageTo,
		origin: z.object({ nodeId: NodeId, nodeName: Name, seq: z.number().int().positive() }),
		hlc: z.string().regex(/^\d{15}-\d{5}$/),
		createdAt: IsoDate,
		/** Files posted with the message: metadata only, the bytes are fetched from any member with `GET /shared/:id/attachments/:attachmentId`. Absent = none. */
		attachments: z.array(SharedAttachmentWire).max(20).default([]),
	})
	.refine((m) => m.body.length > 0 || m.attachments.length > 0, { message: "a message needs a body or a file" });
export type SharedMessageRequest = z.infer<typeof SharedMessageRequest>;

/** What a node holds per origin: `{ <origin node id>: highest sequence N such that it has 1..N }`. */
export const SharedMessageCursor = z.record(NodeId, Count).refine((cursor) => Object.keys(cursor).length <= 256, { message: "cursor names too many origins" });
export type SharedMessageCursor = z.infer<typeof SharedMessageCursor>;

/** `POST /shared/:id/messages/sync` (member → member): the messages after `cursor`, oldest first in log order, at most `limit`. */
export const SharedMessagesSyncRequest = z.object({
	cursor: SharedMessageCursor,
	limit: z.number().int().min(1).max(200).default(100),
});
export type SharedMessagesSyncRequest = z.infer<typeof SharedMessagesSyncRequest>;

/** `cursor` = the request's cursor advanced past this page (per origin: the highest sequence served); `hasMore` = ask again with it. */
export const SharedMessagesSyncResponse = z.object({
	messages: z.array(SharedMessageRequest).max(200),
	cursor: SharedMessageCursor,
	hasMore: z.boolean(),
});
export type SharedMessagesSyncResponse = z.infer<typeof SharedMessagesSyncResponse>;

/**
 * Runtime events of the driving session mirrored to participants (the subset of `SessionEvent` a copy needs). The enum is
 * CLOSED on purpose: an old node refuses a batch with an unknown type, so pending questions and approvals do not get an event
 * type of their own — they travel inside the `state` (`SessionLiveState.requests`), whose unknown key an old node strips.
 * Message/state payloads are validated by the receiver against the contracts schemas before they are applied.
 */
export const SharedMirrorEvent = z.object({ type: z.enum(["state", "agent_start", "agent_end", "message_start", "message_delta", "message_end", "message_removed", "tool_start", "tool_update", "tool_end", "prompt_result", "settled", "notice"]) }).passthrough();
export type SharedMirrorEvent = z.infer<typeof SharedMirrorEvent>;

/**
 * `POST /shared/:id/mirror` (driver → participant): the live copy of the driver's conversation. `events` batches are applied
 * once and in order (`seq` must be the stored `lastSeq + 1` of the same `streamId`); anything else answers `409 mirror_resync`
 * and the driver replays its whole transcript with `sync` chunks (`index` 0 resets the mirror, `final` closes the sync and sets `lastSeq = seq`).
 */
export const SharedMirrorRequest = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("events"),
		epoch: z.number().int().positive(),
		streamId: WireId,
		seq: z.number().int().positive(),
		events: z.array(SharedMirrorEvent).min(1).max(2000),
	}),
	z.object({
		type: z.literal("sync"),
		epoch: z.number().int().positive(),
		streamId: WireId,
		seq: z.number().int().nonnegative(),
		index: z.number().int().nonnegative(),
		final: z.boolean(),
		/** `UiMessage[]` of this chunk, oldest first. */
		messages: z.array(z.unknown()).max(2000),
		/** `SessionLiveState`, with the last chunk. */
		state: z.unknown().optional(),
	}),
]);
export type SharedMirrorRequest = z.infer<typeof SharedMirrorRequest>;

export const SharedMirrorAccepted = z.object({ applied: z.boolean(), lastSeq: Count });
export type SharedMirrorAccepted = z.infer<typeof SharedMirrorAccepted>;

/**
 * `POST /shared/:id/answer` (participant → driver): a person on a participant machine answers a question or approval the
 * driver's agent is waiting for. `requestId` is the id carried by the replicated request (`SessionLiveState.requests.pending`);
 * `epoch` is the shared session epoch the participant saw (an older one answers `409 stale_epoch`: the driver changed and
 * the question belongs to a runtime that no longer exists). Exactly one of `value` (confirm → boolean, select/input/editor →
 * string, `null` cancels) and `answers` (`ask`: one entry per question, in order) is set; the driver validates it with the
 * same rules as a local answer. The first answer wins: any later one answers `409 already_answered` with `details.answeredBy`.
 */
export const SharedAnswerRequest = z
	.object({
		epoch: z.number().int().positive(),
		requestId: z.string().min(1).max(200),
		value: z.union([z.boolean(), z.string().max(100_000), z.null()]).optional(),
		answers: z
			.array(z.object({ id: z.string().min(1).max(200), selectedOptions: z.array(z.string().max(4000)).max(200), customInput: z.string().max(100_000).optional() }))
			.max(50)
			.optional(),
	})
	.refine((body) => (body.value === undefined) !== (body.answers === undefined), { message: "send exactly one of value and answers" });
export type SharedAnswerRequest = z.infer<typeof SharedAnswerRequest>;

export const SharedAnswerAccepted = z.object({ ok: z.literal(true), outcome: z.enum(["answered", "cancelled"]) });
export type SharedAnswerAccepted = z.infer<typeof SharedAnswerAccepted>;

/**
 * `POST /shared/:id/checkpoints` (driver → participant): a checkpoint exists; the snapshot is downloaded with
 * `GET /shared/:id/snapshots/:seq` and, in files mode, the folder bundle with `GET /shared/:id/files/:seq`.
 */
export const SharedCheckpointNotice = z.object({
	seq: z.number().int().positive(),
	epoch: z.number().int().positive(),
	/** git mode: the shared branch and commit; absent in files mode. */
	branch: z.string().min(1).max(255).nullish(),
	commit: z.string().min(1).max(64).nullish(),
	pushed: z.boolean(),
	/** files mode: the bundle of the driver's working folder at this checkpoint. */
	files: z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().positive(), fileCount: Count }).nullish(),
	snapshot: z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().positive(), messageCount: Count }).nullish(),
	model: z.string().max(200).nullish(),
	note: z.string().max(500).nullish(),
	at: IsoDate,
});
export type SharedCheckpointNotice = z.infer<typeof SharedCheckpointNotice>;

/**
 * `POST /shared/:id/checkpoints/:seq/ack` (participant → driver): everything the checkpoint announced (the snapshot and, in
 * files mode, the folder bundle) was downloaded, verified and stored. `sha256`/`size` are the snapshot's (absent when the
 * checkpoint has none); `files` is the bundle's (files mode).
 */
export const SharedCheckpointAck = z.object({
	sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
	size: z.number().int().positive().optional(),
	files: z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().positive() }).optional(),
});
export type SharedCheckpointAck = z.infer<typeof SharedCheckpointAck>;

/** `POST /shared/:id/driver` (new driver → every other participant): the driver role moved (takeover or transfer). */
export const SharedDriverNotice = z.object({
	/** The new epoch (always greater than the receiver's). The sender is the new driver. */
	epoch: z.number().int().positive(),
	reason: z.enum(["takeover", "transfer"]),
	/** The checkpoint the new driver continued from. */
	checkpointSeq: z.number().int().nonnegative().nullish(),
	commit: z.string().min(1).max(64).nullish(),
	/** The new driving session on the sender, and the base URL of its web UI (links for the former driver's "moved" banner). */
	sessionId: z.string().max(128).nullish(),
	uiUrl: z.string().max(2048).nullish(),
	agentId: z.string().max(128).nullish(),
	agentName: z.string().max(128).nullish(),
	at: IsoDate,
});
export type SharedDriverNotice = z.infer<typeof SharedDriverNotice>;

/** `POST /shared/:id/membership` (participant leaving → everyone, or driver removing a participant → that participant and everyone). */
export const SharedMembershipRequest = z.object({
	epoch: z.number().int().positive(),
	action: z.enum(["leave", "remove"]),
	/** The node that left / was removed. */
	nodeId: NodeId,
	reason: z.string().max(2000).nullish(),
});
export type SharedMembershipRequest = z.infer<typeof SharedMembershipRequest>;

/** `POST /shared/:id/transfer` (online driver → chosen participant): hand the driver role over; the target takes over from the checkpoint it holds. */
export const SharedTransferRequest = z.object({
	epoch: z.number().int().positive(),
	checkpointSeq: z.number().int().positive(),
	sha256: z.string().regex(/^[0-9a-f]{64}$/),
	/** The driver aborted a running turn for this hand-over: the continued session should check the last steps. */
	interrupted: z.boolean().optional(),
});
export type SharedTransferRequest = z.infer<typeof SharedTransferRequest>;

export const SharedTransferAccepted = z.object({ accepted: z.literal(true), epoch: z.number().int().positive() });
export type SharedTransferAccepted = z.infer<typeof SharedTransferAccepted>;

/** `GET /shared/:id`: what this node holds of the shared session (the authoritative answer to "who drives now?" when a node comes back). */
export const SharedStateResponse = z.object({
	sharedSessionId: WireId,
	title: z.string().max(200),
	workspaceId: z.string().max(128),
	epoch: z.number().int().positive(),
	driverNodeId: NodeId,
	/** git mode; null/absent in files mode. */
	branch: z.string().max(255).nullish(),
	vcs: z.enum(["git", "files"]).default("git"),
	/** The driving session on the driver, when this node is the driver. */
	driverSessionId: z.string().max(128).nullish(),
	driverUiUrl: z.string().max(2048).nullish(),
	participants: z
		.array(
			z.object({
				nodeId: NodeId,
				nodeName: z.string().max(128),
				role: z.enum(["driver", "participant"]),
				state: z.enum(["invited", "active", "declined", "left", "removed"]),
				agentId: z.string().max(128).nullish(),
				agentName: z.string().max(128).nullish(),
				uiUrl: z.string().max(2048).nullish(),
			}),
		)
		.max(256),
	lastCheckpoint: z.object({ seq: z.number().int().positive(), epoch: z.number().int().positive(), commit: z.string().nullish(), pushed: z.boolean(), snapshotSha256: z.string().nullish(), filesSha256: z.string().nullish() }).nullish(),
});
export type SharedStateResponse = z.infer<typeof SharedStateResponse>;

// ---------------------------------------------------------------- handoffs (M7, docs/agent-network-protocol.md §5.10–5.12, docs/handoff-protocol.md)

/**
 * Wire payloads of `/api/v1/handoffs*` (kind `task`; a `session` handoff is only a local record of an M5 hand-over). One capability,
 * `handoff.receive`, checked on the RECEIVING node against what it granted the caller, for every call and in both directions
 * (source → target: offer, artifacts, cancel; target → source: accept, ack, progress/failure). The manifest travels as raw JSON: the
 * target hashes the document AS DELIVERED (`manifestSha256`) and validates it with `@clam/handoff-engine`.
 */
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** `POST /handoffs` (source → target). 201/200 `{handoffId, state: "received"}`; `409 stale_epoch` when `fromEpoch` is not the epoch the target knows. */
export const HandoffOfferRequest = z.object({
	handoffId: WireId,
	taskId: WireId,
	fromEpoch: z.number().int().nonnegative(),
	toEpoch: z.number().int().positive(),
	manifest: z.record(z.string(), z.unknown()),
	manifestSha256: Sha256,
	expiresAt: IsoDate,
});
export type HandoffOfferRequest = z.infer<typeof HandoffOfferRequest>;

export const HandoffOfferAccepted = z.object({ handoffId: WireId, state: z.literal("received") });
export type HandoffOfferAccepted = z.infer<typeof HandoffOfferAccepted>;

/** `POST /handoffs/:id/accept` (target → source). The answer carries the restore deadline the source computed (accept → ack). */
export const HandoffAcceptRequest = z.object({ epoch: z.number().int().positive(), targetAgentId: z.string().max(128).nullish(), targetAgentName: z.string().max(128).nullish(), acceptedAt: IsoDate });
export type HandoffAcceptRequest = z.infer<typeof HandoffAcceptRequest>;

export const HandoffAcceptResponse = z.object({ handoffId: WireId, state: z.enum(["accepted", "rejected"]), reason: z.string().max(2000).optional(), deadlineAt: IsoDate.optional() });
export type HandoffAcceptResponse = z.infer<typeof HandoffAcceptResponse>;

/**
 * `POST /handoffs/:id/ack` (target → source): sent only after steps 1–7 succeeded and the acknowledgement row is durable on the target.
 * `fencingToken` = `<taskId>:<epoch>:<sig>` signed by the target's node key over `taskId|epoch|handoffId|manifestSha256`.
 */
export const HandoffAckRequest = z.object({
	epoch: z.number().int().positive(),
	targetSessionId: z.string().min(1).max(128),
	manifestSha256: Sha256,
	validation: z.object({ gitCommit: z.string().nullish(), workspaceClean: z.boolean(), depsOk: z.boolean() }),
	ackedAt: IsoDate,
	fencingToken: z.string().min(1).max(1024),
});
export type HandoffAckRequest = z.infer<typeof HandoffAckRequest>;

export const HandoffAckResponse = z.object({ handoffId: WireId, state: z.literal("acked"), fencingToken: z.string(), sourceLastEventSeq: z.number().int().nonnegative() });
export type HandoffAckResponse = z.infer<typeof HandoffAckResponse>;

/**
 * `POST /handoffs/:id/state` (both directions). target → source: `rejected`, `failed` (+ `failure`), `cancelled`, progress states
 * (`persisted` … `session_created`), `owner`, `resumed`, `completed`. source → target: `cancelled` (abort), `reclaimed`, `extended`
 * (carries the new `deadlineAt`), `expired`. Idempotent per `(state, epoch)`.
 */
export const HandoffStateRequest = z.object({
	epoch: z.number().int().nonnegative(),
	state: z.string().min(1).max(32),
	summary: z.string().max(2000).optional(),
	failure: z.object({ code: z.string().max(64), detail: z.string().max(2000), step: z.number().int().nullish() }).optional(),
	deadlineAt: IsoDate.optional(),
	targetSessionId: z.string().max(128).nullish(),
	at: IsoDate,
});
export type HandoffStateRequest = z.infer<typeof HandoffStateRequest>;

export const HandoffStateAccepted = z.object({ handoffId: WireId, state: z.string(), accepted: z.literal(true) });
export type HandoffStateAccepted = z.infer<typeof HandoffStateAccepted>;

/** `GET /handoffs/:id`: this node's side of the handoff (the authoritative answer for a restarting/reconciling peer). */
export const HandoffStatusResponse = z.object({
	handoffId: WireId,
	/** The answering node's role. */
	role: z.enum(["source", "target"]),
	state: z.string(),
	taskId: WireId,
	fromEpoch: z.number().int().nonnegative(),
	toEpoch: z.number().int().positive(),
	/** The epoch the answering node holds for the task right now. */
	taskEpoch: z.number().int().nonnegative(),
	manifestSha256: Sha256.nullish(),
	deadlineAt: IsoDate.nullish(),
	ackAt: IsoDate.nullish(),
	targetSessionId: z.string().nullish(),
	fencingToken: z.string().nullish(),
	failure: z.object({ code: z.string(), detail: z.string(), step: z.number().int().nullish() }).nullish(),
	lastEventSeq: z.number().int().nonnegative().nullish(),
});
export type HandoffStatusResponse = z.infer<typeof HandoffStatusResponse>;

/**
 * `POST /tasks/:id/executor` (new executor → the task's SENDER, capability `tasks.receive` granted by the sender): the task continues
 * on the caller at `epoch`. The sender verifies `fencingToken` against the caller's pinned key and follows the new executor.
 */
export const TaskExecutorChange = z.object({
	epoch: z.number().int().positive(),
	handoffId: WireId,
	manifestSha256: Sha256,
	fencingToken: z.string().min(1).max(1024),
	/** The node the caller took the task from. */
	fromNodeId: NodeId,
	agentId: z.string().max(128).nullish(),
	agentName: z.string().max(128).nullish(),
	sessionId: z.string().max(128).nullish(),
	/** The last event seq of the previous executor; the new executor's events continue at `eventSeqBase + 1`. */
	eventSeqBase: z.number().int().nonnegative(),
	at: IsoDate,
});
export type TaskExecutorChange = z.infer<typeof TaskExecutorChange>;
