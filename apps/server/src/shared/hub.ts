import type { wire } from "@clam/agent-network";
import { ATTACHMENT_EAGER_MAX_BYTES, type I18nMessage, type SaveAttachmentBody, type FileEntry, type SharedAttachment } from "@clam/contracts";
import type { Checkpoint, DecideSharedInviteBody, FilesApplyResult, FilesPreview, SessionLiveState, SharedInvite, SharedMessage, SharedSession, SharedSessionDetail, SharedTopicEvent, TransferBody, UiResponseBody } from "@clam/contracts";
import type { GroupMessageKind, MessageTo } from "@clam/task-engine";
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { ServerContext } from "../context.ts";
import type { NewOutboxItem } from "../tasks/store.ts";
import type { SharedRescueFiles } from "@clam/database";
import type { AttachmentRow, CheckpointRow, InviteRow, ParticipantRow, SharedMessageRow, SharedRow, SharedStore } from "./store.ts";

/**
 * The seams between the units of the shared-session feature (docs/shared-sessions.md, "Code map"). `SharedService`
 * owns the store and the behaviour all units need (publication, outbox helper, views) and wires the units; every unit
 * receives the hub in its constructor and talks to the others only through these interfaces (no unit calls another
 * from its constructor).
 */

/** Timers and limits; tests shorten the timers (`SharedServiceOptions`). */
export interface SharedOptions {
	/** Mirror batches go out at most this often (default 500 ms). */
	mirrorFlushMs: number;
	/** Minimum time between automatic checkpoints (default 30 s); a checkpoint requested earlier is taken when it elapsed. */
	checkpointDebounceMs: number;
	/** Largest session snapshot this node serves or accepts (default 100 MiB). */
	maxSnapshotBytes: number;
	/** How long a checkpoint waits for the driving session to settle before it gives up (default 120 s). */
	idleTimeoutMs: number;
	/** Loop guard of the shared thread (default 12 agent messages per node without a human message in between). */
	agentMessageLimit: number;
	/** Retry cadence of snapshot downloads and mirror re-syncs towards peers that are unreachable or failed (default 5 s). */
	retryMs: number;
	/** How long a transfer waits for the target to hold the snapshot / take over (default 120 s). */
	transferTimeoutMs: number;
	/** How long a hand-over waits for the invited node to accept before it gives up (default 15 min; the invitation stays open). */
	transferAcceptTimeoutMs: number;
	/** How long a hand-over waits for the aborted or running turn of the driving session to settle (default 30 s). */
	transferStopTimeoutMs: number;
	/** Polling cadence of the hand-over while it waits for acceptance or a settled turn (default 250 ms). */
	transferPollMs: number;
	/** Per-request timeout of a snapshot download (default 60 s of silence). */
	downloadIdleMs: number;
	/** Files up to this size are copied to every member node as soon as they are posted; larger ones are fetched when somebody opens them (default 100 MiB). */
	attachmentEagerMaxBytes: number;
	/** How often every reachable peer is asked who drives the shared sessions we have in common (default 30 s; also on every `online` transition and at boot). */
	reconcileMs: number;
}

export const DEFAULT_SHARED_OPTIONS: SharedOptions = {
	mirrorFlushMs: 500,
	checkpointDebounceMs: 30_000,
	maxSnapshotBytes: 100 * 1024 * 1024,
	idleTimeoutMs: 120_000,
	agentMessageLimit: 12,
	retryMs: 5_000,
	transferTimeoutMs: 120_000,
	transferAcceptTimeoutMs: 15 * 60_000,
	transferStopTimeoutMs: 30_000,
	transferPollMs: 250,
	downloadIdleMs: 60_000,
	reconcileMs: 30_000,
	attachmentEagerMaxBytes: ATTACHMENT_EAGER_MAX_BYTES,
};

export interface ChangedInfo {
	checkpoints?: readonly CheckpointRow[];
	messages?: readonly SharedMessageRow[];
	invites?: readonly InviteRow[];
}

export interface PostInput {
	text: string;
	kind: GroupMessageKind;
	author: { kind: "human" | "agent"; agentId: string | null; agentName: string | null };
	/** Explicit addressing (humans only); without it the @mentions in `text` decide. */
	to?: MessageTo | undefined;
	/** Ids of files uploaded to this shared session by this node (`AttachmentApi.upload`), posted with the message. */
	attachmentIds?: readonly string[] | undefined;
}

export interface ShareInput {
	nodeId: string;
	agentId?: string;
}

export type DecideInput = z.infer<typeof DecideSharedInviteBody>;

/** Sharing a session, inviting, accepting and leaving (`sharing.ts`). */
export interface SharingApi {
	/** `POST /sessions/:id/participants`: shares the session on first use (shared branch, SharedSession) and queues the invite. */
	addParticipant(sessionId: string, input: ShareInput): Promise<SharedSession>;
	/** `POST /shared/:id/participants/:nodeId` DELETE: the driver removes a participant. */
	removeParticipant(sharedId: string, nodeId: string): Promise<SharedSession>;
	/** `POST /shared/:id/leave`: this node (a participant) leaves; mirror and participant session are torn down. */
	leave(sharedId: string): Promise<SharedSession>;
	/** `POST /shared/invites/:id/decide` on the invited node. */
	decide(inviteId: string, input: DecideInput): Promise<SharedInvite>;
	/** Wire: `POST /shared/invites`. Idempotent by invite id. */
	receiveInvite(peerId: string, request: wire.SharedInviteRequest): Promise<wire.SharedInviteAccepted & { created: boolean }>;
	/** Wire: `POST /shared/:id/decision` (driver side). */
	receiveDecision(peerId: string, sharedId: string, request: wire.SharedDecisionRequest): Promise<void>;
	/** Wire: `POST /shared/:id/membership` (leave / remove notices). */
	receiveMembership(peerId: string, sharedId: string, request: wire.SharedMembershipRequest): Promise<void>;
	/** Create (or re-create after a driver change) the mirror session of this node for the current driver. Returns its id. */
	ensureMirror(shared: SharedRow): string;
	/** The local participant agent session got no briefing yet (boot recovery, session creation): brief it. Never throws. */
	briefPending(): Promise<void>;
	/** The participant agent session of this node for `sharedId` (created when the node has an agent and none is usable). Null when it has no agent. */
	ensureParticipantAgent(sharedId: string): string | null;
	/** Refuses deleting a session that is still part of an active shared session. */
	removeGuard(row: { id: string; kind: string; sharedSessionId: string | null }): void;
}

/** The group chat of a shared session: a log replicated on every member node (`discussion.ts`). */
export interface DiscussionApi {
	/** A human (any member node's UI) or an agent (`mesh_say`) says something. Accepted on THIS node, whether or not the driver is online. */
	post(sharedId: string, input: PostInput): Promise<SharedMessage>;
	/** Wire: `POST /shared/:id/messages`. Idempotent by message id. */
	receive(peerId: string, sharedId: string, request: wire.SharedMessageRequest): Promise<{ messageId: string; accepted: true }>;
	/** Wire: `POST /shared/:id/messages/sync`: the catch-up page for a member that was away. */
	serveSync(peerId: string, sharedId: string, request: wire.SharedMessagesSyncRequest): wire.SharedMessagesSyncResponse;
	/** Pull what `peerId` holds and this node lacks, for every shared session they have in common (boot, peer online, timer). Never throws. */
	syncPeer(peerId: string): Promise<void>;
	/** Hand the pending wake-ups and buffers to the local agent sessions (boot, a session became available). Never throws. */
	retryPending(): Promise<void>;
	markRead(sharedId: string): void;
	/** A `system` message: replicated to every member node, or (`local`) a note about something every node observes itself, kept in this node's copy only. */
	note(sharedId: string, say: I18nMessage, options?: { local?: boolean }): void;
	/** Queue an existing message for one node (the history a participant gets when it joins). */
	enqueue(message: SharedMessageRow, peerId: string): void;
	start(): void;
	stop(): void;
}

/** Files posted in the group chat: stored once per digest, replicated to every member node, handed to the local agent (`attachments.ts`). */
export interface AttachmentApi {
	/** `POST /shared/:id/attachments`: store the raw request body (streamed, hashed) as an unattached file of this shared session. */
	upload(sharedId: string, input: { name: string; mimeType: string | undefined; body: unknown; contentLength: string | undefined }): Promise<SharedAttachment>;
	/** Check that `ids` are unattached uploads of this node in `sharedId` (throws 400 otherwise) and return them. */
	claim(sharedId: string, ids: readonly string[]): AttachmentRow[];
	/** A message that carries files arrived from `originNodeId`: remember their metadata and start fetching the bytes (eagerly up to the size limit). */
	received(sharedId: string, messageId: string, originNodeId: string, files: readonly wire.SharedAttachmentWire[]): void;
	/** `GET /shared/:id/attachments/:attId`: stream the file (range supported); fetched from a member first when this node lacks it. */
	serve(request: FastifyRequest, reply: FastifyReply, sharedId: string, attachmentId: string, download: boolean): Promise<FastifyReply>;
	/** Wire: the file as stored here for a member that asks. 404 when this node does not hold the bytes. */
	wireFile(sharedId: string, attachmentId: string): { path: string; size: number; sha256: string; name: string };
	/** `POST …/save`: copy into a local project folder. */
	save(sharedId: string, attachmentId: string, body: z.infer<typeof SaveAttachmentBody>): Promise<FileEntry>;
	/** Copy the files into the project folder of the local agent session (`attachments/<name>`); `null` for a file that could not be fetched. */
	placeInFolder(sessionId: string, files: readonly AttachmentRow[]): Promise<Array<{ file: AttachmentRow; relativePath: string | null }>>;
	/** Store a file of the agent's working folder as an unattached group chat file (`maxBytes` caps it; `skipIfPosted` makes a file already in the chat from that path with the same digest yield null). The agent's own path rules apply: inside the folder, a regular file, no `.git`. */
	registerFromFolder(sharedId: string, sessionId: string, path: string, options?: { maxBytes?: number; skipIfPosted?: boolean }): Promise<AttachmentRow | null>;
	/** An agent shares a file of its working folder (`mesh_share_file`): stored, then posted to the group as a message of that agent. */
	shareFile(sharedId: string, sessionId: string, input: { path: string; caption: string | undefined; agent: { id: string | null; name: string | null } }): Promise<{ attachment: SharedAttachment; messageId: string }>;
	/** Fetch every missing file up to the eager limit now (boot, a peer came online, a message arrived). Never throws. */
	kick(): void;
	start(): void;
	stop(): void;
}

/** Live copy of the driving session on participant nodes (`mirror.ts`). */
export interface MirrorApi {
	/** Driver: start publishing the driving session of `sharedId` (idempotent) and sync the participants that are reachable. */
	publish(sharedId: string): void;
	/** Driver: a participant may be behind (accepted, came online, took part in a driver change): replay the whole transcript to it. */
	syncPeer(sharedId: string, peerId: string): void;
	/** Driver: stop publishing (role lost, session left or removed). */
	unpublish(sharedId: string): void;
	/** Participant: apply a batch or sync chunk from the driver. Throws `409 mirror_resync` when the driver must replay. */
	receive(peerId: string, sharedId: string, request: wire.SharedMirrorRequest): wire.SharedMirrorAccepted;
	/** Freeze the transcript of a session's runtime into `sessionId`'s stored transcript (moved copies are read from it). */
	freeze(sessionId: string): Promise<void>;
	/** Driver: the pending questions/approvals (or how one ended) of the driving session changed: publish the new state to the participants now. */
	requestsChanged(sessionId: string): void;
	/** Participant: the driver of the mirror's session changed; its questions are not answerable any more. Closes them (`abandoned`) on the mirror and its viewers. */
	withdrawRequests(mirrorSessionId: string): void;
	start(): void;
	stop(): Promise<void>;
}

/** Questions and approvals answered from any member machine (`requests.ts`). */
export interface RequestApi {
	/** Driver: what the driving session waits for and how its latest requests ended (the part of the mirrored state that carries them). */
	snapshot(sessionId: string): NonNullable<SessionLiveState["requests"]>;
	/** Participant: forward a person's answer of the mirror session to the driver. Rejects `409 already_answered` (with `details.answeredBy`) when somebody was first. */
	answer(mirrorSessionId: string, input: z.infer<typeof UiResponseBody>): Promise<void>;
	/** Wire: `POST /shared/:id/answer` (driver side). */
	receiveAnswer(peerId: string, sharedId: string, request: wire.SharedAnswerRequest): Promise<wire.SharedAnswerAccepted>;
	start(): void;
	stop(): void;
}

/** Checkpoints and snapshots (`checkpoints.ts`). */
export interface CheckpointApi {
	/** Driver: commit + push the working tree, snapshot the session, record and announce. Serialized per shared session. */
	checkpoint(sharedId: string, options: { note?: string; manual: boolean }): Promise<Checkpoint>;
	/** Driver: make sure `peerId` is told about (and can download) the latest checkpoint; takes the first one when there is none. */
	shipLatest(sharedId: string, peerId: string): void;
	/** Wire: `POST /shared/:id/checkpoints` (participant side): record it and download the snapshot in the background. */
	receiveNotice(peerId: string, sharedId: string, notice: wire.SharedCheckpointNotice): void;
	/** Wire: `POST /shared/:id/checkpoints/:seq/ack` (driver side). */
	receiveAck(peerId: string, sharedId: string, seq: number, ack: wire.SharedCheckpointAck): void;
	/** Wire: `GET /shared/:id/snapshots/:seq`: absolute path, size and digest of a snapshot this node holds. 404 when it does not. */
	snapshotFile(sharedId: string, seq: number): { path: string; size: number; sha256: string };
	/** Download snapshots announced but not held yet (restart, peer came online). Never throws. */
	downloadPending(peerId?: string): Promise<void>;
	/** Resolves once `peerId` acknowledged the snapshot of `seq` (or rejects after `timeoutMs`). */
	waitDelivered(sharedId: string, seq: number, peerId: string, timeoutMs: number): Promise<void>;
	/** Driver: a settled turn happened in the driving session (automatic checkpoint trigger). */
	turnSettled(sharedId: string): void;
	start(): void;
	stop(): Promise<void>;
}

/** Driver changes: takeover and the target side of a transfer, learning about a new driver, return of a former driver (`epochs.ts`). */
export interface EpochApi {
	/** `POST /shared/:id/takeover` on a participant. */
	takeover(sharedId: string, options: { force: boolean }): Promise<SharedSession>;
	/** Wire: `POST /shared/:id/transfer` (target side): start the takeover from the checkpoint the driver announced. */
	receiveTransfer(peerId: string, sharedId: string, request: wire.SharedTransferRequest): Promise<wire.SharedTransferAccepted>;
	/** Wire: `POST /shared/:id/driver`. */
	receiveDriver(peerId: string, sharedId: string, notice: wire.SharedDriverNotice): Promise<void>;
	/** Wire: `GET /shared/:id`. */
	stateFor(peerId: string, sharedId: string): wire.SharedStateResponse;
	/** A peer is reachable again: ask it (and apply) who drives each shared session we have in common. Never throws. */
	reconcilePeer(peerId: string): Promise<void>;
	/** Boot: finish half-done former-driver handling and reconcile with every reachable peer. Never throws. */
	recover(): Promise<void>;
	start(): void;
	stop(): Promise<void>;
}

/** Handing the driver role to another node as one action (`transfers.ts`). */
export interface TransferApi {
	/** `POST /shared/:id/transfer` on the driver: invites the node when needed, then runs the hand-over in the background. Resolves once it started. */
	begin(sharedId: string, body: TransferBody): Promise<SharedSession>;
	/** `POST /sessions/:id/handover`: like `begin`, sharing the session first when it is not shared yet. */
	handover(sessionId: string, body: TransferBody): Promise<SharedSession>;
	/** `DELETE /shared/:id/transfer`: cancel a pending hand-over, or dismiss a finished record. */
	cancel(sharedId: string): Promise<SharedSession>;
	/** The driver of `sharedId` changed (called by the epoch service): completes or fails the hand-over this node started. */
	driverChanged(sharedId: string, change: { driverNodeId: string; sessionId: string | null; uiUrl: string | null }): void;
	/** Refuses a prompt to the driving session while its hand-over checkpoint is taken. */
	guardPrompt(row: { id: string; kind: string; sharedSessionId: string | null }): void;
	/** Boot: a hand-over that was running when the node stopped cannot continue; mark it failed. */
	recover(): void;
	stop(): Promise<void>;
}

/** Files mode (no git repository): the working folder travels as bundles (`files.ts`). */
export interface FilesModeApi {
	/** Driver: bundle the driving project's folder as the files of checkpoint `seq` (stored 0600). `meta` is null with a problem note when it could not be made. */
	bundle(shared: SharedRow, seq: number): Promise<{ relative: string | null; meta: { sha256: string; size: number; fileCount: number } | null; problems: string[] }>;
	/** Wire: absolute path, size and digest of a folder bundle this node holds. 404 when it does not. */
	bundleFile(sharedId: string, seq: number): { path: string; size: number; sha256: string };
	/** Participant: the first bundle arrived: place its files in the local folder (existing different files are kept). */
	applyInitial(sharedId: string, seq: number): Promise<void>;
	/** Takeover/transfer: restore the folder from the held checkpoint. Throws `409 files_conflict` for local edits unless `force` (transfers always continue, saving the local versions as a rescue bundle first). */
	restore(shared: SharedRow, held: CheckpointRow, options: { force: boolean; reason: "takeover" | "transfer" }): Promise<{ fileCount: number; applied: string[]; kept: string[]; rescued: number }>;
	/** Former driver: save everything new or changed since the last synced checkpoint as a rescue bundle; null when there was none. */
	rescueSinceSync(shared: SharedRow): Promise<SharedRescueFiles | null>;
	rescuePreview(sharedId: string, projectId: string): Promise<FilesPreview>;
	rescueApply(sharedId: string, body: { projectId: string; paths?: string[] | undefined; overwrite: string[] }): Promise<FilesApplyResult>;
}

export interface SharedHub {
	readonly ctx: ServerContext;
	readonly store: SharedStore;
	readonly log: FastifyBaseLogger;
	readonly options: SharedOptions;
	readonly sharing: SharingApi;
	readonly discussion: DiscussionApi;
	readonly attachments: AttachmentApi;
	readonly mirror: MirrorApi;
	readonly requests: RequestApi;
	readonly checkpoints: CheckpointApi;
	readonly epochs: EpochApi;
	readonly transfers: TransferApi;
	readonly files: FilesModeApi;
	nodeName(): string;
	/** Public base URL of this node's web UI (its domain), or null when it has none. */
	uiUrl(): string | null;
	/** Queue a signed peer call through the shared outbox (`taskId` = the shared session id keeps the items of one session in order). */
	enqueue(item: Omit<NewOutboxItem, "taskId"> & { sharedSessionId: string }): void;
	/** Publish what changed: `shared` and `shared:<id>` bus events plus an agent-directory refresh. */
	changed(sharedId: string, info?: ChangedInfo): void;
	/** `shared` topic: an incoming invitation appeared or changed. */
	invitePublished(invite: InviteRow): void;
	views: {
		shared(row: SharedRow): SharedSession;
		detail(row: SharedRow): SharedSessionDetail;
		invite(row: InviteRow): SharedInvite;
		message(row: SharedMessageRow): SharedMessage;
		checkpoint(row: CheckpointRow): Checkpoint;
		participant(row: ParticipantRow): SharedSession["participants"][number];
	};
	/** Peers granted/received capability check with the clear errors the API owes the user. */
	assertShareable(peerId: string): void;
}

export type SharedTopicPublisher = (topic: string, event: SharedTopicEvent) => void;
