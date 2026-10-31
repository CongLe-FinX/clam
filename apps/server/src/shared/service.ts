import type { SharedInvite, SharedMessagesPage, SharedSession, SharedSessionDetail, SharedTopicEvent } from "@clam/contracts";
import type { FastifyBaseLogger } from "fastify";
import { ApiError } from "../http/errors.ts";
import type { ServerContext } from "../context.ts";
import { readNodeSettings } from "../services/settings.ts";
import type { NewOutboxItem } from "../tasks/store.ts";
import { AttachmentService } from "./attachments.ts";
import { CheckpointService } from "./checkpoints.ts";
import { DiscussionService } from "./discussion.ts";
import { EpochService } from "./epochs.ts";
import { SharedFilesService } from "./files.ts";
import { SharedHostTools } from "./host-tools.ts";
import { DEFAULT_SHARED_OPTIONS, type ChangedInfo, type SharedHub, type SharedOptions } from "./hub.ts";
import { MirrorService } from "./mirror.ts";
import { SHARED_OUTBOX_KINDS, sharedOutboxHandlers } from "./outbox.ts";
import { RequestService } from "./requests.ts";
import { SharingService } from "./sharing.ts";
import { decodeMessageCursor, MESSAGES_PAGE_DEFAULT, SharedStore, type InviteRow } from "./store.ts";
import { SharedViews } from "./views.ts";
import { TransferService } from "./transfers.ts";

export interface SharedServiceOptions {
	timings?: Partial<SharedOptions>;
}

/**
 * Composition root of shared sessions (docs/shared-sessions.md): owns the store, the publication of changes and the
 * outbox helper every unit needs, and wires the units (`sharing`, `discussion`, `mirror`, `checkpoints`, `epochs`, the host
 * tools). Peer calls ride the task engine's outbox; the service starts and stops with the task engine (`TaskService`).
 */
export class SharedService implements SharedHub {
	readonly store: SharedStore;
	readonly log: FastifyBaseLogger;
	readonly options: SharedOptions;
	readonly views: SharedViews;
	readonly sharing: SharingService;
	readonly discussion: DiscussionService;
	readonly attachments: AttachmentService;
	readonly mirror: MirrorService;
	readonly requests: RequestService;
	readonly checkpoints: CheckpointService;
	readonly epochs: EpochService;
	readonly transfers: TransferService;
	readonly files: SharedFilesService;
	readonly hostTools: SharedHostTools;
	private hostToolsRegistered = false;

	constructor(
		readonly ctx: ServerContext,
		options: SharedServiceOptions = {},
	) {
		this.log = ctx.log;
		this.options = { ...DEFAULT_SHARED_OPTIONS, ...options.timings };
		this.store = new SharedStore(ctx.db, { nodeId: ctx.identity.nodeId });
		this.views = new SharedViews({ ctx, store: this.store, options: this.options, nodeName: () => this.nodeName(), uiUrl: () => this.uiUrl() });
		// Units only keep the hub; none may call another unit from its constructor.
		this.sharing = new SharingService(this);
		this.discussion = new DiscussionService(this);
		this.attachments = new AttachmentService(this);
		this.mirror = new MirrorService(this);
		this.requests = new RequestService(this);
		this.checkpoints = new CheckpointService(this);
		this.epochs = new EpochService(this);
		this.transfers = new TransferService(this);
		this.files = new SharedFilesService(this);
		this.hostTools = new SharedHostTools(this);
	}

	nodeName(): string {
		return readNodeSettings(this.ctx.db).nodeName;
	}

	/** Base URL of this node's web UI on its domain: only when the owner enabled remote access (it is the tunnel / public URL). */
	uiUrl(): string | null {
		return this.ctx.access.config().remoteUiEnabled ? this.ctx.network.selfUrl() : null;
	}

	// ------------------------------------------------------------------ lifecycle

	/** Register `mesh_team` / `mesh_say`; before the first runtime of the node is opened (the task engine calls this next to its own tools). */
	registerHostTools(): void {
		if (this.hostToolsRegistered) return;
		this.hostToolsRegistered = true;
		this.ctx.hostTools.register(this.hostTools);
	}

	start(): void {
		this.registerHostTools();
		for (const [kind, handler] of Object.entries(sharedOutboxHandlers(this))) this.ctx.tasks.outbox.register(kind, handler);
		this.ctx.sessions.setViews(this.mirror);
		this.ctx.sessions.setRemoveGuard((row) => this.sharing.removeGuard(row));
		this.ctx.sessions.setPromptGuard((row) => this.transfers.guardPrompt(row));
		this.discussion.start();
		this.attachments.start();
		this.mirror.start();
		this.requests.start();
		this.checkpoints.start();
		this.epochs.start();
		this.transfers.recover();
		void this.sharing.briefPending();
	}

	async stop(): Promise<void> {
		await this.transfers.stop();
		await this.epochs.stop();
		await this.checkpoints.stop();
		this.requests.stop();
		await this.mirror.stop();
		this.discussion.stop();
		this.attachments.stop();
	}

	// ------------------------------------------------------------------ the hub

	enqueue(item: Omit<NewOutboxItem, "taskId"> & { sharedSessionId: string }): void {
		const { sharedSessionId, ...rest } = item;
		// Items of one (shared session, peer) pair go out in order, and one unreachable peer never holds up another.
		this.ctx.tasks.store.enqueue({ ...rest, taskId: `${sharedSessionId}:${item.peerId}` });
		this.ctx.tasks.outbox.kick(item.peerId);
	}

	changed(sharedId: string, info: ChangedInfo = {}): void {
		const row = this.store.find(sharedId);
		if (!row) return;
		const shared = this.views.shared(row);
		const event: SharedTopicEvent = { type: "shared", shared };
		this.ctx.bus.publish("shared", event);
		this.ctx.bus.publish(`shared:${sharedId}`, event);
		for (const checkpoint of info.checkpoints ?? []) this.ctx.bus.publish(`shared:${sharedId}`, { type: "checkpoint", sharedSessionId: sharedId, checkpoint: this.views.checkpoint(checkpoint) } satisfies SharedTopicEvent);
		for (const message of info.messages ?? []) this.ctx.bus.publish(`shared:${sharedId}`, { type: "message", sharedSessionId: sharedId, message: this.views.message(message) } satisfies SharedTopicEvent);
		this.ctx.network.localAgentsChanged();
	}

	invitePublished(invite: InviteRow): void {
		this.ctx.bus.publish("shared", { type: "invite", invite: this.views.invite(invite) } satisfies SharedTopicEvent);
	}

	assertShareable(peerId: string): void {
		const peer = this.ctx.network.peers.row(peerId);
		if (!peer || peer.status === "revoked") throw ApiError.notFound("Peer");
		if (!(peer.receivedCapabilities as string[]).includes("sessions.share")) {
			throw new ApiError(409, "capability_missing", `${peer.name} has not granted this node the capability sessions.share. Ask its user to enable shared sessions for this node (Network → peers).`, { missing: ["sessions.share"], grantedBy: peer.id });
		}
		if (!(peer.grantedCapabilities as string[]).includes("sessions.share")) {
			throw new ApiError(409, "capability_missing", `This node has not granted ${peer.name} the capability sessions.share, which it needs to reach shared sessions on this node (mirror, snapshots, messages). Grant it in Network → ${peer.name}.`, { missing: ["sessions.share"], grantedBy: this.ctx.identity.nodeId });
		}
	}

	// ------------------------------------------------------------------ local API reads

	list(): SharedSession[] {
		return this.store.active().map((row) => this.views.shared(row));
	}

	detail(id: string, options: { messageLimit?: number | undefined } = {}): SharedSessionDetail {
		return this.views.detail(this.store.get(id), options);
	}

	/** One page of the group log, newest first by page and ascending inside it; `before` is a cursor an earlier page returned (400 when it is not one). */
	messages(id: string, query: { before?: string | undefined; limit?: number | undefined }): SharedMessagesPage {
		const row = this.store.get(id);
		return this.views.messagesPage(row, { before: query.before === undefined ? undefined : decodeMessageCursor(query.before), limit: query.limit ?? MESSAGES_PAGE_DEFAULT });
	}

	invites(): SharedInvite[] {
		return this.store.invites().map((row) => this.views.invite(row));
	}
}
