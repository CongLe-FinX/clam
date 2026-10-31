import type { Capability, Peer, PeerStatus } from "@clam/contracts";
import { peerAgents, peers, workspaceMembers } from "@clam/database";
import type { ClamDb } from "@clam/database";
import type { PeerKey } from "@clam/agent-network";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { EventBus } from "../context.ts";
import { ApiError } from "../http/errors.ts";
import type { NetworkEventLog } from "./events.ts";
import { NODE_STREAM } from "./events.ts";

type PeerRow = typeof peers.$inferSelect;

export type PeerChange =
	| { type: "revoked"; peerId: string; by: "local" | "remote" }
	| { type: "added"; peerId: string }
	| { type: "url_changed"; peerId: string }
	/** The peer is reachable again (offline → online/degraded): queued work for it can drain. */
	| { type: "online"; peerId: string };

export interface NewPeer {
	id: string;
	name: string;
	fingerprint: string;
	publicKey: string;
	keyId: string;
	url: string;
	/** What WE grant the peer. */
	grantedCapabilities: Capability[];
	/** What the peer grants us. */
	receivedCapabilities: Capability[];
	/** Workspace the pairing shared. */
	workspaceId: string;
	/** Role the peer has in that workspace (the inviter is the workspace `owner` on the joiner's node). */
	role: "owner" | "member";
}

export interface PeerServiceDeps {
	db: ClamDb;
	bus: EventBus;
	events: NetworkEventLog;
	nodeId: string;
}

/** Pinned peers: identity, capabilities in both directions, liveness and revocation. */
export class PeerService {
	private readonly listeners = new Set<(change: PeerChange) => void>();

	constructor(private readonly deps: PeerServiceDeps) {}

	onChange(listener: (change: PeerChange) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(change: PeerChange): void {
		for (const listener of [...this.listeners]) {
			try {
				listener(change);
			} catch {
				// Observers must never break the state change that triggered them.
			}
		}
	}

	row(id: string): PeerRow | undefined {
		return this.deps.db.select().from(peers).where(eq(peers.id, id)).get();
	}

	rows(): PeerRow[] {
		return this.deps.db.select().from(peers).orderBy(peers.pairedAt, peers.id).all();
	}

	/** Peers that may still be contacted (not revoked). */
	activeRows(): PeerRow[] {
		return this.deps.db.select().from(peers).where(ne(peers.status, "revoked")).orderBy(peers.pairedAt, peers.id).all();
	}

	toPeer(row: PeerRow): Peer {
		const agentCount = this.deps.db.select({ n: sql<number>`count(*)` }).from(peerAgents).where(eq(peerAgents.peerId, row.id)).get()?.n ?? 0;
		const workspaceIds = this.deps.db
			.select({ id: workspaceMembers.workspaceId })
			.from(workspaceMembers)
			.where(and(eq(workspaceMembers.memberId, row.id), isNull(workspaceMembers.revokedAt)))
			.all()
			.map((r) => r.id);
		return {
			id: row.id,
			name: row.name,
			fingerprint: row.fingerprint,
			url: row.url,
			status: row.status as PeerStatus,
			grantedCapabilities: row.grantedCapabilities as Capability[],
			receivedCapabilities: row.receivedCapabilities as Capability[],
			workspaceIds,
			protocolVersion: row.protocolVersion,
			agentCount: row.status === "revoked" ? 0 : agentCount,
			latencyMs: row.latencyMs,
			lastSeenAt: row.lastSeenAt,
			lastError: row.lastError,
			pairedAt: row.pairedAt,
			revokedAt: row.revokedAt,
			revokedBy: row.revokedBy === "local" || row.revokedBy === "remote" ? row.revokedBy : null,
			autoAcceptTasks: row.autoAcceptTasks,
		};
	}

	list(): Peer[] {
		return this.rows().map((row) => this.toPeer(row));
	}

	get(id: string): Peer | null {
		const row = this.row(id);
		return row ? this.toPeer(row) : null;
	}

	require(id: string): Peer {
		const peer = this.get(id);
		if (!peer) throw ApiError.notFound("Peer");
		return peer;
	}

	/** The pinned key `verifyRequest` checks signatures against; revoked peers are flagged so they are refused first. */
	lookupKey(nodeId: string): PeerKey | null {
		const row = this.row(nodeId);
		return row ? { nodeId: row.id, keyId: row.keyId, publicKey: row.publicKey, revoked: row.status === "revoked" } : null;
	}

	publish(id: string): void {
		const peer = this.get(id);
		if (peer) this.deps.bus.publish("network", { type: "peer", peer });
	}

	/**
	 * Pin a freshly paired peer and record it as a member of the shared workspace (one transaction). Re-pairing a
	 * previously revoked peer replaces its row; an active peer is never silently overwritten.
	 */
	addPaired(input: NewPeer, executor: Pick<ClamDb, "transaction"> = this.deps.db): Peer {
		const now = new Date().toISOString();
		const existing = this.row(input.id);
		if (existing && existing.status !== "revoked") throw ApiError.conflict("This node is already paired", { code: "already_paired" });
		executor.transaction((tx) => {
			const values = {
				name: input.name,
				fingerprint: input.fingerprint,
				publicKey: input.publicKey,
				keyId: input.keyId,
				url: input.url,
				status: "offline",
				grantedCapabilities: input.grantedCapabilities,
				receivedCapabilities: input.receivedCapabilities,
				protocolVersion: 1,
				latencyMs: null,
				lastSeenAt: null,
				lastError: null,
				lastEventCursor: null,
				pairedAt: now,
				revokedAt: null,
				revokedBy: null,
				updatedAt: now,
			};
			tx.insert(peers).values({ id: input.id, ...values }).onConflictDoUpdate({ target: peers.id, set: values }).run();
			tx.delete(peerAgents).where(eq(peerAgents.peerId, input.id)).run();
			tx.insert(workspaceMembers)
				.values({ workspaceId: input.workspaceId, memberId: input.id, role: input.role, permissions: input.grantedCapabilities, grantedBy: this.deps.nodeId, createdAt: now })
				.onConflictDoUpdate({ target: [workspaceMembers.workspaceId, workspaceMembers.memberId], set: { role: input.role, permissions: input.grantedCapabilities, grantedBy: this.deps.nodeId, revokedAt: null } })
				.run();
		});
		this.publish(input.id);
		this.emit({ type: "added", peerId: input.id });
		return this.require(input.id);
	}

	/**
	 * Drop the record of a revoked peer so it can be paired again. Called when its user approves a new pairing: until
	 * the new pin is written, the peer may already be calling us, and a stale `revoked` row would answer it
	 * `peer_revoked` (which the peer treats as a fresh revocation) instead of the benign `unknown_peer`.
	 */
	forgetRevoked(id: string): void {
		const row = this.row(id);
		if (row?.status === "revoked") this.deps.db.delete(peers).where(eq(peers.id, id)).run();
	}

	/** Local rename and/or capability change. A capability change is pushed to the peer as a `peer_updated` event. */
	update(id: string, patch: { name?: string; grantedCapabilities?: Capability[]; autoAcceptTasks?: boolean }): Peer {
		const row = this.row(id);
		if (!row) throw ApiError.notFound("Peer");
		if (row.status === "revoked") throw ApiError.conflict("This peer is revoked; pair again to restore access");
		const now = new Date().toISOString();
		const capabilities = patch.grantedCapabilities ? [...new Set(patch.grantedCapabilities)] : undefined;
		const changedCapabilities = capabilities !== undefined && JSON.stringify([...capabilities].sort()) !== JSON.stringify([...(row.grantedCapabilities as string[])].sort());
		this.deps.db.transaction((tx) => {
			tx.update(peers)
				.set({
					...(patch.name !== undefined && { name: patch.name }),
					...(capabilities !== undefined && { grantedCapabilities: capabilities }),
					...(patch.autoAcceptTasks !== undefined && { autoAcceptTasks: patch.autoAcceptTasks }),
					updatedAt: now,
				})
				.where(eq(peers.id, id))
				.run();
			if (capabilities !== undefined) {
				tx.update(workspaceMembers).set({ permissions: capabilities }).where(and(eq(workspaceMembers.memberId, id), isNull(workspaceMembers.revokedAt))).run();
			}
		});
		if (changedCapabilities) this.deps.events.append(NODE_STREAM, "peer_updated", { peerId: id, capabilities }, id);
		this.publish(id);
		return this.require(id);
	}

	/** Record a liveness observation. Publishes the peer to the UI when anything the UI shows changed. */
	setLiveness(id: string, patch: { status: PeerStatus; latencyMs?: number | null; seen?: boolean; error?: string | null; protocolVersion?: number }): void {
		const row = this.row(id);
		if (!row || row.status === "revoked") return;
		const now = new Date().toISOString();
		const changed =
			row.status !== patch.status ||
			(patch.error !== undefined && row.lastError !== patch.error) ||
			(patch.latencyMs !== undefined && row.latencyMs !== patch.latencyMs) ||
			patch.seen === true;
		if (!changed) return;
		this.deps.db
			.update(peers)
			.set({
				status: patch.status,
				...(patch.latencyMs !== undefined && { latencyMs: patch.latencyMs }),
				...(patch.seen === true && { lastSeenAt: now }),
				...(patch.error !== undefined && { lastError: patch.error }),
				...(patch.protocolVersion !== undefined && { protocolVersion: patch.protocolVersion }),
				updatedAt: now,
			})
			.where(eq(peers.id, id))
			.run();
		this.publish(id);
		const wasUp = row.status === "online" || row.status === "degraded";
		const isUp = patch.status === "online" || patch.status === "degraded";
		if (!wasUp && isUp) this.emit({ type: "online", peerId: id });
	}

	setCursor(id: string, cursor: string): void {
		this.deps.db.update(peers).set({ lastEventCursor: cursor }).where(eq(peers.id, id)).run();
	}

	setReceivedCapabilities(id: string, capabilities: Capability[]): void {
		const row = this.row(id);
		if (!row || row.status === "revoked") return;
		this.deps.db.update(peers).set({ receivedCapabilities: capabilities, updatedAt: new Date().toISOString() }).where(eq(peers.id, id)).run();
		this.publish(id);
	}

	/** The peer announced a new address (quick tunnels get a new one on every start) and/or name. */
	applyAnnounce(id: string, patch: { url: string; name?: string }): void {
		const row = this.row(id);
		if (!row || row.status === "revoked") return;
		const urlChanged = row.url !== patch.url;
		this.deps.db
			.update(peers)
			.set({ url: patch.url, ...(patch.name !== undefined && { name: patch.name }), updatedAt: new Date().toISOString() })
			.where(eq(peers.id, id))
			.run();
		this.publish(id);
		if (urlChanged) this.emit({ type: "url_changed", peerId: id });
	}

	/**
	 * Revoke a peer: from this instant `verifyRequest` refuses it (`peer_revoked`), its capabilities and workspace
	 * memberships are removed, and live connections are closed. `by: "remote"` records that the peer revoked US.
	 */
	revoke(id: string, by: "local" | "remote"): Peer {
		const row = this.row(id);
		if (!row) throw ApiError.notFound("Peer");
		if (row.status === "revoked") return this.require(id);
		const now = new Date().toISOString();
		this.deps.db.transaction((tx) => {
			tx.update(peers)
				.set({ status: "revoked", revokedAt: now, revokedBy: by, grantedCapabilities: [], lastError: by === "remote" ? "This peer revoked access to its node" : null, latencyMs: null, updatedAt: now })
				.where(eq(peers.id, id))
				.run();
			tx.update(workspaceMembers).set({ revokedAt: now, permissions: [] }).where(and(eq(workspaceMembers.memberId, id), isNull(workspaceMembers.revokedAt))).run();
		});
		// Appended before connections close so the revoked peer's own open stream can still deliver it (audience-scoped).
		this.deps.events.append(NODE_STREAM, "peer_revoked", { peerId: id }, id);
		this.emit({ type: "revoked", peerId: id, by });
		this.publish(id);
		this.deps.bus.publish("network", { type: "directory_changed" });
		return this.require(id);
	}
}
