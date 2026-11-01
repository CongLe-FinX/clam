import { CAPABILITIES, type AddWorkspaceMemberBody, type WorkspaceMember, i18nMsg } from "@clam/contracts";
import type { ContextMembershipRequest } from "@clam/context-engine";
import { peers, workspaceMembers, workspaces } from "@clam/database";
import { and, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import { ApiError } from "../http/errors.ts";
import { newId } from "../services/ids.ts";
import type { OutboxHandler } from "../tasks/outbox.ts";
import type { ContextService } from "./service.ts";

type MemberRow = typeof workspaceMembers.$inferSelect;
type PeerRow = typeof peers.$inferSelect;

export const MEMBERSHIP_PATH = "/context/membership";
const nowIso = (): string => new Date().toISOString();
const CAPABILITY_SET: ReadonlySet<string> = new Set(CAPABILITIES);

/**
 * Workspace membership across nodes. A workspace is local to each node (same id, own copy); a member is a paired peer
 * whose row in `workspace_members` is not revoked. Pairing creates the first membership; adding a paired peer to another
 * workspace creates the row here and tells the peer (signed `POST /context/membership`) so it creates the workspace
 * locally if it has none. Removing revokes the row for that workspace only (the peer stays paired) and tells it.
 */
export class WorkspaceMembers {
	private unsubscribe: (() => void) | null = null;

	constructor(private readonly hub: ContextService) {}

	start(): void {
		this.unsubscribe?.();
		// A revoked peer drops out of every workspace in `workspace_members` itself; members listings must follow.
		this.unsubscribe = this.hub.ctx.network.peers.onChange((change) => {
			if (change.type !== "revoked") return;
			for (const workspaceId of this.workspacesOf(change.peerId)) this.publish(workspaceId);
		});
	}

	stop(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	private db() {
		return this.hub.ctx.db;
	}

	private rows(workspaceId: string): MemberRow[] {
		return this.db().select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId)).orderBy(workspaceMembers.createdAt, workspaceMembers.memberId).all();
	}

	private workspacesOf(nodeId: string): string[] {
		return this.db().select({ id: workspaceMembers.workspaceId }).from(workspaceMembers).where(eq(workspaceMembers.memberId, nodeId)).all().map((r) => r.id);
	}

	/** Paired peers that currently share the workspace with this node (member row not revoked, peer not revoked). */
	activePeerIds(workspaceId: string): string[] {
		const self = this.hub.nodeId;
		return this.rows(workspaceId)
			.filter((r) => r.revokedAt === null && r.memberId !== self)
			.filter((r) => {
				const peer = this.hub.ctx.network.peers.row(r.memberId);
				return peer !== undefined && peer.status !== "revoked";
			})
			.map((r) => r.memberId);
	}

	isActiveMember(workspaceId: string, nodeId: string): boolean {
		return this.hub.workspaceMemberRow(workspaceId, nodeId) !== undefined && this.hub.ctx.network.peers.row(nodeId)?.status !== "revoked";
	}

	// ------------------------------------------------------------------ local API

	list(workspaceId: string): WorkspaceMember[] {
		this.hub.requireWorkspace(workspaceId);
		const self = this.hub.nodeId;
		const rows = this.rows(workspaceId);
		const members: WorkspaceMember[] = rows.map((r) => {
			const peer = r.memberId === self ? undefined : this.hub.ctx.network.peers.row(r.memberId);
			return {
				nodeId: r.memberId,
				nodeName: r.memberId === self ? this.hub.nodeName() : (peer?.name ?? r.memberId),
				role: r.role === "owner" ? "owner" : "member",
				nodeStatus: r.memberId === self ? "self" : peer ? (r.revokedAt !== null || peer.status === "revoked" ? "revoked" : (peer.status as "online" | "degraded" | "offline")) : "revoked",
				permissions: (r.permissions as string[]) ?? [],
				joinedAt: r.createdAt,
				revokedAt: r.revokedAt,
			};
		});
		// This node is always a member of its own workspaces, even if the row was never written.
		if (!members.some((m) => m.nodeId === self)) {
			const ws = this.hub.requireWorkspace(workspaceId);
			members.unshift({ nodeId: self, nodeName: this.hub.nodeName(), role: ws.ownerNodeId === self ? "owner" : "member", nodeStatus: "self", permissions: [], joinedAt: ws.createdAt, revokedAt: null });
		}
		return members;
	}

	private publish(workspaceId: string): void {
		if (!this.hub.workspace(workspaceId)) return;
		this.hub.ctx.bus.publish("contexts", { type: "members", workspaceId, members: this.list(workspaceId) });
	}

	private requirePeer(nodeId: string): PeerRow {
		const peer = this.hub.ctx.network.peers.row(nodeId);
		if (!peer) throw ApiError.notFound("Node (pair with it first)");
		if (peer.status === "revoked") throw new ApiError(409, "peer_revoked", i18nMsg("{name} has been revoked; pair again to restore access", { name: peer.name }));
		return peer;
	}

	/** Cancel what has not been delivered to `peerId` for kind `kind` (and, when given, only for that workspace). */
	private cancelPending(peerId: string, kind: string, workspaceId?: string): void {
		const { store } = this.hub.ctx.tasks;
		for (const item of store.pendingOutbox(peerId)) {
			if (item.kind !== kind) continue;
			const body = item.body as { workspaceId?: string } | null;
			if (workspaceId === undefined || body?.workspaceId === workspaceId) store.updateOutbox(item.id, { state: "cancelled" });
		}
	}

	private notify(peer: PeerRow, request: ContextMembershipRequest): void {
		const { tasks } = this.hub.ctx;
		this.cancelPending(peer.id, "context.member", request.workspaceId);
		tasks.store.enqueue({
			peerId: peer.id,
			taskId: null,
			kind: "context.member",
			refId: request.workspaceId,
			path: MEMBERSHIP_PATH,
			body: request,
			idempotencyKey: `context.member:${peer.id}:${request.workspaceId}:${request.action}:${newId("m")}`,
			correlationId: `ws:${request.workspaceId}`,
		});
		tasks.outbox.kick(peer.id);
	}

	/**
	 * Add a paired peer to a workspace: the row here, then a signed notice so the peer creates the workspace if it has
	 * none. The workspace's shareable contexts follow once the peer has acknowledged the notice.
	 */
	add(workspaceId: string, body: z.infer<typeof AddWorkspaceMemberBody>): WorkspaceMember[] {
		const workspace = this.hub.requireWorkspace(workspaceId);
		const peer = this.requirePeer(body.nodeId);
		if (!(peer.receivedCapabilities as string[]).includes("context.sync")) {
			throw new ApiError(409, "capability_missing", i18nMsg("{name} has not granted this node context.sync, so the workspace cannot be shared with it. Ask them to enable it for this node.", { name: peer.name }), { missing: ["context.sync"] });
		}
		const unknown = (body.permissions ?? []).filter((p) => !CAPABILITY_SET.has(p));
		if (unknown.length > 0) throw ApiError.badRequest(i18nMsg("Unknown permission(s): {permissions}", { permissions: unknown.join(", ") }));
		const permissions = body.permissions ? [...new Set(body.permissions)] : [...(peer.grantedCapabilities as string[])];
		const existing = this.rows(workspaceId).find((r) => r.memberId === peer.id);
		const now = nowIso();
		this.db()
			.insert(workspaceMembers)
			.values({ workspaceId, memberId: peer.id, role: existing?.role ?? "member", permissions, grantedBy: this.hub.nodeId, createdAt: existing?.createdAt ?? now })
			.onConflictDoUpdate({ target: [workspaceMembers.workspaceId, workspaceMembers.memberId], set: { permissions, grantedBy: this.hub.nodeId, revokedAt: null } })
			.run();
		this.notify(peer, { workspaceId, workspaceName: workspace.name, action: "add", ownerNodeId: workspace.ownerNodeId, permissions });
		this.publish(workspaceId);
		return this.list(workspaceId);
	}

	/** Revoke a member for this workspace only (the peer stays paired for everything else) and tell it. */
	remove(workspaceId: string, nodeId: string): WorkspaceMember[] {
		const workspace = this.hub.requireWorkspace(workspaceId);
		if (nodeId === this.hub.nodeId) throw new ApiError(409, "cannot_remove_self", i18nMsg("This node cannot remove itself from its own workspace"));
		const row = this.rows(workspaceId).find((r) => r.memberId === nodeId);
		if (!row) throw ApiError.notFound("Member");
		this.db()
			.update(workspaceMembers)
			.set({ revokedAt: row.revokedAt ?? nowIso(), permissions: [] })
			.where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.memberId, nodeId)))
			.run();
		// Nothing about this workspace is delivered to the removed node any more.
		this.cancelPending(nodeId, "context.sync", workspaceId);
		const peer = this.hub.ctx.network.peers.row(nodeId);
		if (peer && peer.status !== "revoked" && (peer.receivedCapabilities as string[]).includes("context.sync")) {
			this.notify(peer, { workspaceId, workspaceName: workspace.name, action: "remove", ownerNodeId: workspace.ownerNodeId, permissions: [] });
		}
		this.publish(workspaceId);
		return this.list(workspaceId);
	}

	// ------------------------------------------------------------------ wire

	/** `POST /context/membership` from a paired peer that holds our `context.sync` grant. */
	receive(peerId: string, request: ContextMembershipRequest): { ok: true } {
		const peer = this.hub.ctx.network.peers.row(peerId);
		if (!peer || peer.status === "revoked") throw new ApiError(403, "peer_revoked", i18nMsg("peer has been revoked"));
		const { workspaceId } = request;
		const now = nowIso();
		if (request.action === "remove") {
			const row = this.rows(workspaceId).find((r) => r.memberId === peerId);
			if (row && row.revokedAt === null) {
				this.db()
					.update(workspaceMembers)
					.set({ revokedAt: now, permissions: [] })
					.where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.memberId, peerId)))
					.run();
				this.cancelPending(peerId, "context.sync", workspaceId);
				this.publish(workspaceId);
			}
			return { ok: true };
		}
		const self = this.hub.nodeId;
		this.db().transaction((tx) => {
			if (!this.hub.workspace(workspaceId)) {
				const taken = (name: string) => tx.select({ id: workspaces.id }).from(workspaces).where(sql`lower(${workspaces.name}) = lower(${name})`).get() !== undefined;
				let name = request.workspaceName;
				if (taken(name)) name = `${request.workspaceName} (${peer.name})`;
				for (let n = 2; taken(name); n++) name = `${request.workspaceName} (${peer.name} ${n})`;
				tx.insert(workspaces).values({ id: workspaceId, name, ownerNodeId: self, createdAt: now, updatedAt: now }).run();
			}
			tx.insert(workspaceMembers).values({ workspaceId, memberId: self, role: "member", grantedBy: self, createdAt: now }).onConflictDoNothing().run();
			const values = { role: request.ownerNodeId === peerId ? "owner" : "member", permissions: peer.grantedCapabilities as string[], grantedBy: peerId };
			tx.insert(workspaceMembers).values({ workspaceId, memberId: peerId, createdAt: now, ...values }).onConflictDoUpdate({ target: [workspaceMembers.workspaceId, workspaceMembers.memberId], set: { ...values, revokedAt: null } }).run();
		});
		this.publish(workspaceId);
		// We may hold contexts for this workspace the peer lacks.
		this.hub.sync.reconcile(peerId);
		return { ok: true };
	}

	/** After a membership notice is delivered, the workspace's contexts follow (the peer now knows the workspace). */
	outboxHandler(): OutboxHandler {
		return {
			sent: (item) => {
				const body = item.body as { action?: string } | null;
				if (body?.action === "add") this.hub.sync.reconcile(item.peerId);
			},
			dead: (item, reason) => this.hub.log.warn({ outboxId: item.id, peerId: item.peerId, err: reason }, "a workspace membership notice could not be delivered"),
		};
	}
}

