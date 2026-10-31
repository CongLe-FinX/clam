import type { Checkpoint, Participant, SharedInvite, SharedMessage, SharedMessagesPage, SharedSession, SharedSessionDetail } from "@clam/contracts";
import { projects } from "@clam/database";
import { normalizeRepoUrl } from "@clam/task-engine";
import { eq } from "drizzle-orm";
import type { ServerContext } from "../context.ts";
import { projectVcs } from "../services/project-folders.ts";
import type { SharedOptions } from "./hub.ts";
import { encodeMessageCursor, type CheckpointRow, type InviteRow, type MessagePosition, type ParticipantRow, type SharedMessageRow, type SharedRow, type SharedStore } from "./store.ts";

/** Local projects whose linked GitHub repository is `repoKey` (`owner/name`, lower case). */
export function candidateProjects(ctx: Pick<ServerContext, "db">, repoKey: string): Array<typeof projects.$inferSelect> {
	return ctx.db
		.select()
		.from(projects)
		.all()
		.filter((p) => p.repository && `${p.repository.owner}/${p.repository.name}`.toLowerCase() === repoKey);
}

export interface ViewDeps {
	ctx: ServerContext;
	store: SharedStore;
	options: SharedOptions;
	nodeName(): string;
	uiUrl(): string | null;
}

/** Rows → contract types (`@clam/contracts` shared.ts). Pure reads: no publication, no peer calls. */
export class SharedViews {
	constructor(private readonly deps: ViewDeps) {}

	private get ctx() {
		return this.deps.ctx;
	}

	private get store() {
		return this.deps.store;
	}

	participant(row: ParticipantRow): Participant {
		const self = row.nodeId === this.ctx.identity.nodeId;
		const peer = self ? undefined : this.ctx.network.peers.row(row.nodeId);
		const nodeStatus: Participant["nodeStatus"] = self ? "self" : !peer ? "offline" : (peer.status as Participant["nodeStatus"]);
		return {
			nodeId: row.nodeId,
			nodeName: self ? this.deps.nodeName() : (peer?.name ?? row.nodeName),
			agentId: row.agentId,
			agentName: row.agentName,
			role: row.role as Participant["role"],
			state: row.state as Participant["state"],
			nodeStatus,
			agentSessionId: row.agentSessionId,
			uiUrl: self ? this.deps.uiUrl() : row.uiUrl,
			joinedAt: row.joinedAt,
		};
	}

	checkpoint(row: CheckpointRow): Checkpoint {
		const holds = row.snapshotPath !== null;
		return {
			seq: row.seq,
			epoch: row.epoch,
			nodeId: row.nodeId,
			branch: row.branch,
			commit: row.commit,
			files: row.files ?? null,
			pushed: row.pushed,
			snapshot: row.snapshotSha256 !== null && row.snapshotSize !== null ? { sha256: row.snapshotSha256, size: row.snapshotSize, messageCount: row.snapshotMessages ?? 0 } : null,
			// The driver lists the participants that acknowledged; a participant only knows about itself.
			deliveredTo: row.nodeId === this.ctx.identity.nodeId ? row.deliveredTo : holds ? [this.ctx.identity.nodeId] : [],
			note: row.note,
			at: row.createdAt,
		};
	}

	message(row: SharedMessageRow): SharedMessage {
		return {
			id: row.id,
			sharedSessionId: row.sharedSessionId,
			author: { kind: row.authorKind as SharedMessage["author"]["kind"], nodeId: row.authorNodeId, nodeName: row.authorNodeName, agentId: row.authorAgentId, agentName: row.authorAgentName },
			kind: row.kind as SharedMessage["kind"],
			to: row.to,
			text: row.text,
			originNodeId: row.authorNodeId,
			hlc: row.hlc,
			createdAt: row.createdAt,
			attachments: this.store.attachmentsOfMessage(row.id).map((a) => ({ id: a.id, name: a.name, mimeType: a.mimeType, size: a.size, sha256: a.sha256, originNodeId: a.originNodeId, available: a.stored })),
			delivery: row.delivery as SharedMessage["delivery"],
			injectedIntoSession: row.injectedSessionId !== null,
		};
	}

	/** Whether this node could take over right now, and if not why (participant and former-driver side). */
	takeover(row: SharedRow): { available: boolean; reason: string | null } {
		if (row.state !== "active") return { available: false, reason: "This node left the shared session" };
		if (row.localRole === "driver") return { available: false, reason: "This node is already the driver" };
		if (!row.localProjectId) return { available: false, reason: row.vcs === "files" ? "No local folder is linked to this shared session" : "No local clone of the repository is linked to this shared session" };
		const held = this.store.latestHeldCheckpoint(row.id);
		if (!held) return { available: false, reason: row.vcs === "files" ? "No session snapshot and folder bundle have been received yet" : "No session snapshot has been received yet" };
		if (!held.snapshotSha256) return { available: false, reason: "The last checkpoint has no session snapshot" };
		const driver = this.ctx.network.peers.row(row.driverNodeId);
		const driverOnline = driver !== undefined && (driver.status === "online" || driver.status === "degraded");
		if (driverOnline) return { available: false, reason: `${driver.name} (the driver) is online; ask it to transfer, or continue here anyway` };
		return { available: true, reason: null };
	}

	shared(row: SharedRow): SharedSession {
		const participants = this.store.participants(row.id).map((p) => this.participant(p));
		const last = this.store.latestCheckpoint(row.id);
		const takeover = this.takeover(row);
		return {
			id: row.id,
			workspaceId: row.workspaceId,
			title: row.title,
			vcs: row.vcs === "files" ? "files" : "git",
			repo: row.repoUrl && row.branch ? { url: row.repoUrl, branch: row.branch } : null,
			epoch: row.epoch,
			driverNodeId: row.driverNodeId,
			localRole: row.localRole as SharedSession["localRole"],
			localSessionId: row.localSessionId,
			mirrorSessionId: row.mirrorSessionId,
			localProjectId: row.localProjectId,
			participants,
			lastCheckpoint: last ? this.checkpoint(last) : null,
			takeoverAvailable: takeover.available,
			takeoverBlockedReason: takeover.reason,
			rescueBranch: row.rescueBranch,
			rescueFiles: row.rescueFiles ? { sha256: row.rescueFiles.sha256, size: row.rescueFiles.size, fileCount: row.rescueFiles.fileCount, paths: row.rescueFiles.paths, epoch: row.rescueFiles.epoch, at: row.rescueFiles.at } : null,
			agentMessageBudget: this.store.budget(row.id, row.agentMessageLimit).remaining,
			unreadMessages: this.store.unread(row.id),
			transfer: row.meta.transfer ?? null,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		};
	}

	/** One page of the group log (see `SharedStore.messagesPage`), its messages mapped exactly like the detail's. */
	messagesPage(row: SharedRow, options: { before?: MessagePosition | undefined; limit: number }): SharedMessagesPage {
		const page = this.store.messagesPage(row.id, options);
		return { messages: page.rows.map((m) => this.message(m)), nextCursor: page.older ? encodeMessageCursor(page.older) : null };
	}

	/** With `messageLimit` only the newest N messages, plus the cursor of the older ones; without it the whole log. */
	detail(row: SharedRow, options: { messageLimit?: number | undefined } = {}): SharedSessionDetail {
		const base = { shared: this.shared(row), checkpoints: this.store.checkpoints(row.id).map((c) => this.checkpoint(c)) };
		if (options.messageLimit === undefined) return { ...base, messages: this.store.messages(row.id).map((m) => this.message(m)) };
		const page = this.messagesPage(row, { limit: options.messageLimit });
		return { ...base, messages: page.messages, messagesCursor: page.nextCursor };
	}

	invite(row: InviteRow): SharedInvite {
		const filesMode = row.vcs === "files";
		const key = row.repoUrl ? normalizeRepoUrl(row.repoUrl)?.key : undefined;
		return {
			id: row.id,
			sharedSessionId: row.sharedSessionId,
			from: { nodeId: row.fromNodeId, nodeName: row.fromNodeName, agentName: row.fromAgentName },
			title: row.title,
			vcs: filesMode ? "files" : "git",
			repo: row.repoUrl && row.repoBranch ? { url: row.repoUrl, branch: row.repoBranch } : null,
			workspaceId: row.workspaceId,
			agentId: row.agentId,
			// Files mode: the plain-folder projects of the invitation's workspace (or a new managed folder when none is chosen).
			candidateProjectIds: filesMode ? this.ctx.db.select().from(projects).where(eq(projects.workspaceId, row.workspaceId)).all().filter((p) => projectVcs(p.path) === "none").map((p) => p.id) : key ? candidateProjects(this.ctx, key).map((p) => p.id) : [],
			state: row.state as SharedInvite["state"],
			createdAt: row.createdAt,
		};
	}
}
