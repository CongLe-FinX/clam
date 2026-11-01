import { z } from "zod";
import { I18nText, IsoDate } from "./common.ts";

/**
 * Shared sessions: one piece of work driven by an agent session on one node, with agents on other nodes joined as
 * participants. Design: docs/shared-sessions.md.
 *
 * - Exactly one DRIVER at a time (the node whose local OMP session does the work). `epoch` is the fencing token:
 *   it increases on every driver change, and any driver action carrying an older epoch is refused.
 * - Every participant node keeps a MIRROR session (read-only live copy of the driver's conversation, `AgentSession.kind
 *   = "mirror"`) and, when its agent participates, its own local OMP "participant session" in its own clone.
 * - The driver CHECKPOINTS after settled turns with changes: commit + push to the shared branch (never force) and an
 *   OMP session snapshot (`omp session pack`) shipped to participants. Snapshots never enter Git.
 * - TAKEOVER (manual, on a participant node — normally because the driver node is offline): check out the shared
 *   branch at the last checkpoint, `omp session unpack` the last snapshot into a NEW local session, become driver with
 *   epoch + 1. TRANSFER: the same, initiated by an online driver, which first takes a fresh checkpoint.
 */

export const SharedRole = z.enum(["driver", "participant"]);
export type SharedRole = z.infer<typeof SharedRole>;

export const Participant = z.object({
	nodeId: z.string(),
	nodeName: z.string(),
	agentId: z.string().nullable(),
	agentName: z.string().nullable(),
	role: SharedRole,
	state: z.enum(["invited", "active", "declined", "left", "removed"]),
	/** Node reachability as seen from this node ("self" for this node). */
	nodeStatus: z.enum(["self", "online", "degraded", "offline", "revoked"]),
	/** The participant's OWN local OMP session on its node (its agent's session), when known. */
	agentSessionId: z.string().nullable(),
	/** Base URL of that node's web UI (its public URL), when known. */
	uiUrl: z.string().nullable(),
	joinedAt: IsoDate.nullable(),
});
export type Participant = z.infer<typeof Participant>;

export const Checkpoint = z.object({
	seq: z.number().int(),
	epoch: z.number().int(),
	nodeId: z.string(),
	/** git mode: shared branch + commit; null in files mode. */
	branch: z.string().nullable(),
	commit: z.string().nullable(),
	/** files mode: bundle of the working folder (no git), delivered with the session snapshot. */
	files: z.object({ sha256: z.string(), size: z.number().int(), fileCount: z.number().int() }).nullable(),
	pushed: z.boolean(),
	/** OMP session snapshot (archive v1) metadata; null when the snapshot could not be taken. */
	snapshot: z.object({ sha256: z.string(), size: z.number().int(), messageCount: z.number().int() }).nullable(),
	/** Which participants hold this snapshot locally. */
	deliveredTo: z.array(z.string()),
	note: z.string().nullable(),
	at: IsoDate,
});
export type Checkpoint = z.infer<typeof Checkpoint>;

/**
 * Progress of a hand-over of the driver role, kept on the node that started it. Terminal phases (`continuing`, `failed`,
 * `cancelled`) stay visible until `DELETE /shared/:id/transfer` dismisses them or a new transfer starts.
 *   inviting → waiting_accept → stopping (only with `stopRunning` while a turn runs) → checkpointing (commit + push +
 *   snapshot of everything) → delivering (target downloads the snapshot) → handing_over (target takes over) → continuing.
 */
export const TransferPhase = z.enum(["inviting", "waiting_accept", "stopping", "checkpointing", "delivering", "handing_over", "continuing", "failed", "cancelled"]);
export type TransferPhase = z.infer<typeof TransferPhase>;

export const SharedTransfer = z.object({
	id: z.string(),
	toNodeId: z.string(),
	toNodeName: z.string(),
	phase: TransferPhase,
	/** One line describing the current phase, ready to show ("Waiting for node-b to accept the invitation…"). */
	message: z.string(),
	/** Structured twin of `message` for localisation; absent on records from older nodes. */
	i18n: I18nText.optional(),
	stopRunning: z.boolean(),
	/** Set with `failed`. */
	error: z.object({ code: z.string(), message: z.string(), i18n: I18nText.optional() }).nullable(),
	/** Set with `continuing`: the new driver's session on the target node, and its page (target UI URL + `/sessions/<id>`) when that node's UI URL is known. */
	newSessionId: z.string().nullable(),
	newSessionUrl: z.string().nullable(),
	startedAt: IsoDate,
	updatedAt: IsoDate,
});
export type SharedTransfer = z.infer<typeof SharedTransfer>;

export const SharedSession = z.object({
	id: z.string(),
	workspaceId: z.string(),
	title: z.string(),
	/** How the working files travel between nodes: a shared git branch, or folder bundles shipped node to node (no repository). */
	vcs: z.enum(["git", "files"]),
	/** git mode only. */
	repo: z.object({ url: z.string(), branch: z.string() }).nullable(),
	epoch: z.number().int(),
	driverNodeId: z.string(),
	/** This node's relation to it. */
	localRole: z.enum(["driver", "participant", "former_driver"]),
	/** The local session on THIS node that shows it: the driving session (driver), the mirror (participant), or the moved copy (former driver). */
	localSessionId: z.string().nullable(),
	/** The live mirror of the current driver's conversation on THIS node (null on the driver itself, or before the first sync). For a former driver `localSessionId` is the moved copy and this is the mirror of the new driver. */
	mirrorSessionId: z.string().nullable(),
	/** Local project (clone) on this node, when one is linked. */
	localProjectId: z.string().nullable(),
	participants: z.array(Participant),
	lastCheckpoint: Checkpoint.nullable(),
	/** Participant side: whether the driver looks offline and a takeover is possible right now. */
	takeoverAvailable: z.boolean(),
	/** Why takeover is not available (e.g. "no snapshot received yet", "no local clone"). */
	takeoverBlockedReason: z.string().nullable(),
	/** Structured twin of `takeoverBlockedReason` for localisation. */
	takeoverBlockedI18n: I18nText.optional(),
	/** Rescue branch where this node's unpushed changes were saved after losing the driver role. */
	rescueBranch: z.string().nullable(),
	/** Files mode: this node's work after the last checkpoint, saved as a bundle when it lost the driver role (apply it to a project with `sharedRescueApply`). */
	rescueFiles: z.object({ sha256: z.string(), size: z.number().int(), fileCount: z.number().int(), paths: z.array(z.string()), epoch: z.number().int(), at: IsoDate }).nullable(),
	agentMessageBudget: z.number().int(),
	unreadMessages: z.number().int(),
	/** The hand-over this node started (null when none). */
	transfer: SharedTransfer.nullable(),
	createdAt: IsoDate,
	updatedAt: IsoDate,
});
export type SharedSession = z.infer<typeof SharedSession>;

/**
 * A file posted into the group chat (by a human upload or by an agent via `mesh_share_file`). Metadata replicates with
 * the message; bytes replicate to every member node (eagerly up to `ATTACHMENT_EAGER_MAX_BYTES`, on demand above),
 * verified by sha-256, so any one online member can serve them.
 */
export const SharedAttachment = z.object({
	id: z.string(),
	name: z.string(),
	mimeType: z.string(),
	size: z.number().int(),
	sha256: z.string(),
	/** Node that first stored the bytes. */
	originNodeId: z.string(),
	/** Whether the bytes are present on THIS node (false = fetched from a member when opened). */
	available: z.boolean(),
});
export type SharedAttachment = z.infer<typeof SharedAttachment>;
export const ATTACHMENT_EAGER_MAX_BYTES = 100 * 1024 * 1024;
export const ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024 * 1024;

export const SharedMessage = z.object({
	id: z.string(),
	sharedSessionId: z.string(),
	author: z.object({
		kind: z.enum(["human", "agent", "system"]),
		nodeId: z.string(),
		nodeName: z.string(),
		agentId: z.string().nullable(),
		agentName: z.string().nullable(),
	}),
	/** `chat` = a human talking to the group; `reply` = an agent's end-of-turn answer posted automatically; `system` = joins, hand-overs, checkpoints. */
	kind: z.enum(["chat", "reply", "system", "instruction", "question", "answer", "note"]),
	/** Who should act on it: `all`, the current `lead` (default without mentions), or explicit agents (from @mentions). */
	to: z.object({ mode: z.enum(["all", "lead", "agents"]), agents: z.array(z.object({ nodeId: z.string(), agentId: z.string() })) }),
	text: z.string(),
	/** Structured twin of `text` for localisation (generated system lines); `text` stays the English rendering. Absent on human/agent messages and on messages from older nodes. */
	i18n: I18nText.optional(),
	/** Node that accepted the message first (group log is replicated; any online member node can accept). */
	originNodeId: z.string(),
	/** Hybrid logical clock used for ordering: sort by (hlc, originNodeId). */
	hlc: z.string(),
	createdAt: IsoDate,
	attachments: z.array(SharedAttachment).default([]),
	delivery: z.enum(["local", "pending", "delivered", "failed"]),
	injectedIntoSession: z.boolean(),
});
export type SharedMessage = z.infer<typeof SharedMessage>;

export const SharedSessionDetail = z.object({
	shared: SharedSession,
	checkpoints: z.array(Checkpoint),
	messages: z.array(SharedMessage),
	/** Set when `GET /shared/:id?messageLimit=N` returned only the newest N messages: pass it as `before` to `GET /shared/:id/messages` for older ones. Absent/null = `messages` is the whole log. */
	messagesCursor: z.string().nullable().optional(),
});
export type SharedSessionDetail = z.infer<typeof SharedSessionDetail>;

/** `GET /shared/:id/messages?before=<cursor>&limit=`: one page of the group log in display order (oldest → newest); `nextCursor` (opaque) pages further back, null at the start of the log. Without `before` it is the newest page. */
export const SharedMessagesPage = z.object({ messages: z.array(SharedMessage), nextCursor: z.string().nullable() });
export type SharedMessagesPage = z.infer<typeof SharedMessagesPage>;

/** Incoming invitation on a participant node. */
export const SharedInvite = z.object({
	id: z.string(),
	sharedSessionId: z.string(),
	from: z.object({ nodeId: z.string(), nodeName: z.string(), agentName: z.string().nullable() }),
	title: z.string(),
	vcs: z.enum(["git", "files"]),
	repo: z.object({ url: z.string(), branch: z.string() }).nullable(),
	workspaceId: z.string(),
	/** Requested local agent (null = this node picks). */
	agentId: z.string().nullable(),
	/** Local projects whose linked repo matches; empty = the user must clone first. */
	candidateProjectIds: z.array(z.string()),
	state: z.enum(["pending", "accepted", "declined", "expired"]),
	createdAt: IsoDate,
});
export type SharedInvite = z.infer<typeof SharedInvite>;

// ---------------------------------------------------------------- requests

/** Turn a local session into a shared one (driver = this node) and invite a participant in one go. */
export const AddParticipantBody = z.object({
	nodeId: z.string().min(1),
	/** Omit to let the participant node choose its agent. */
	agentId: z.string().optional(),
});
export const DecideSharedInviteBody = z.discriminatedUnion("decision", [
	z.object({ decision: z.literal("accept"), projectId: z.string().optional(), agentId: z.string().optional() }),
	z.object({ decision: z.literal("decline"), reason: z.string().max(2000).optional() }),
]);
/** Humans post `chat` (default); @mentions in `text` are resolved server-side unless `to` is given explicitly. */
export const PostSharedMessageBody = z.object({
	/** May be empty when attachments are posted. */
	text: z.string().trim().max(20_000).default(""),
	kind: z.enum(["chat", "instruction", "answer", "note"]).default("chat"),
	to: z.object({ mode: z.enum(["all", "lead", "agents"]), agents: z.array(z.object({ nodeId: z.string(), agentId: z.string() })).default([]) }).optional(),
	/** Ids returned by `sharedAttachmentUpload` (uploaded first, then referenced here). */
	attachmentIds: z.array(z.string()).max(20).default([]),
}).refine((b) => b.text.length > 0 || b.attachmentIds.length > 0, { message: "Write a message or attach a file" });
export const SaveAttachmentBody = z.object({
	projectId: z.string().min(1),
	/** Relative destination path; defaults to `attachments/<name>`. Never overwrites an existing file (a suffix is added). */
	path: z.string().min(1).optional(),
});
export const CheckpointBody = z.object({ note: z.string().max(500).optional() });
/** Participant side: continue the work here. */
export const TakeoverBody = z.object({
	/** Required when the driver is still reachable (prevents an accidental split brain). */
	force: z.boolean().default(false),
});
/**
 * Driver side: hand the driver role to another node. The target need not be a participant yet: it is invited first
 * (like `AddParticipantBody`) and the transfer waits until it accepted. A running turn makes the request fail with
 * `409 session_busy` unless `stopRunning` is true (the turn is then aborted before the final checkpoint).
 */
export const TransferBody = z.object({
	toNodeId: z.string().min(1),
	/** Agent on the target node; omit to let it choose (only used when the node still has to be invited). */
	agentId: z.string().optional(),
	stopRunning: z.boolean().optional(),
});
export type TransferBody = z.infer<typeof TransferBody>;

/** Events on topic `shared` (list) and `shared:<id>` (detail). */
export type SharedTopicEvent =
	| { type: "shared"; shared: SharedSession }
	| { type: "checkpoint"; sharedSessionId: string; checkpoint: Checkpoint }
	| { type: "message"; sharedSessionId: string; message: SharedMessage }
	| { type: "invite"; invite: SharedInvite };
