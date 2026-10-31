import type { Checkpoint, Participant, SharedInvite, SharedMessage, SharedSession, SharedSessionDetail } from "@clam/contracts";
import { projects } from "@clam/database";
import { normalizeRepoUrl } from "@clam/task-engine";
import type { ServerContext } from "../context.ts";
import type { SharedOptions } from "./hub.ts";
import type { CheckpointRow, InviteRow, ParticipantRow, SharedMessageRow, SharedRow, SharedStore } from "./store.ts";

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
			delivery: row.delivery as SharedMessage["delivery"],
			injectedIntoSession: row.injectedSessionId !== null,
		};
	}

	/** Whether this node could take over right now, and if not why (participant and former-driver side). */
	takeover(row: SharedRow): { available: boolean; reason: string | null } {
		if (row.state !== "active") return { available: false, reason: "This node left the shared session" };
		if (row.localRole === "driver") return { available: false, reason: "This node is already the driver" };
		if (!row.localProjectId) return { available: false, reason: "No local clone of the repository is linked to this shared session" };
		const held = this.store.latestHeldCheckpoint(row.id);
		if (!held) return { available: false, reason: "No session snapshot has been received yet" };
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
			repo: { url: row.repoUrl, branch: row.branch },
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
			agentMessageBudget: this.store.budget(row.id, row.agentMessageLimit).remaining,
			unreadMessages: this.store.unread(row.id),
			transfer: row.meta.transfer ?? null,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		};
	}

	detail(row: SharedRow): SharedSessionDetail {
		return {
			shared: this.shared(row),
			checkpoints: this.store.checkpoints(row.id).map((c) => this.checkpoint(c)),
			messages: this.store.messages(row.id).map((m) => this.message(m)),
		};
	}

	invite(row: InviteRow): SharedInvite {
		const key = normalizeRepoUrl(row.repoUrl)?.key;
		return {
			id: row.id,
			sharedSessionId: row.sharedSessionId,
			from: { nodeId: row.fromNodeId, nodeName: row.fromNodeName, agentName: row.fromAgentName },
			title: row.title,
			repo: { url: row.repoUrl, branch: row.repoBranch },
			workspaceId: row.workspaceId,
			agentId: row.agentId,
			candidateProjectIds: key ? candidateProjects(this.ctx, key).map((p) => p.id) : [],
			state: row.state as SharedInvite["state"],
			createdAt: row.createdAt,
		};
	}
}
