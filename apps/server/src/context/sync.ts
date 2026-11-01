import { i18nMsg } from "@clam/contracts";
import {
	ContextSyncResponse,
	MAX_HAVE,
	canonicalBody,
	canonicalTitle,
	hasValidSha,
	versionId,
	type ContextSyncRequest,
	type VersionRecord,
	type WireHave,
	type WireVersion,
} from "@clam/context-engine";
import { workspaceMembers } from "@clam/database";
import { and, eq, isNull } from "drizzle-orm";
import { ApiError } from "../http/errors.ts";
import { errorText } from "../network/util.ts";
import type { OutboxHandler } from "../tasks/outbox.ts";
import type { OutboxRow } from "../tasks/store.ts";
import { newId } from "../services/ids.ts";
import type { ContextService } from "./service.ts";
import { findProjectByKey } from "./project-keys.ts";
import type { ContextRow } from "./store.ts";

/** Outbox kinds of the context feature (delivered by the task engine's `OutboxService`). */
export const CONTEXT_OUTBOX_KINDS = ["context.sync", "context.member"] as const;
export const SYNC_PATH = "/context/sync";
/** A request bigger than this is not sent (the listener's body limit is 1 MiB): the context stays `pending` and is logged. */
const MAX_REQUEST_BYTES = 900 * 1024;

type PeerRow = NonNullable<ReturnType<ContextService["ctx"]["network"]["peers"]["row"]>>;

const nowIso = (): string => new Date().toISOString();
const holdsHead = (r: { version: number; sha256: string } | undefined, head: { version: number; sha256: string }): boolean => r !== undefined && r.version === head.version && r.sha256 === head.sha256;

/**
 * Replication of shareable contexts between the nodes of a workspace (docs/agent-network-protocol.md §5.9). Every node
 * keeps its own copy; a change is pushed to each member peer through the durable outbox (`context.sync`), a peer that
 * comes online is reconciled with a have-index (it answers what it lacks and we push that), and an incoming version is
 * applied by the engine: fast-forward, or reported as a conflict, never merged. Private contexts are never read here.
 */
export class ContextSync {
	private stopped = true;
	private timer: NodeJS.Timeout | null = null;
	private unsubscribe: (() => void) | null = null;

	constructor(private readonly hub: ContextService) {}

	private get store() {
		return this.hub.store;
	}

	// ------------------------------------------------------------------ lifecycle

	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		const { ctx } = this.hub;
		for (const [kind, handler] of Object.entries(this.handlers())) ctx.tasks.outbox.register(kind, handler);
		this.unsubscribe = ctx.network.peers.onChange((change) => {
			if (change.type === "online" || change.type === "url_changed" || change.type === "added") this.reconcile(change.peerId);
		});
		this.timer = setInterval(() => this.reconcile(), this.hub.timings.reconcileMs);
		this.timer.unref();
		// What changed while this node was down is pushed as soon as the peers are reachable.
		queueMicrotask(() => this.reconcile());
	}

	stop(): void {
		this.stopped = true;
		this.unsubscribe?.();
		this.unsubscribe = null;
		clearInterval(this.timer ?? undefined);
		this.timer = null;
	}

	// ------------------------------------------------------------------ who

	/** Member peers of a workspace that may be sent its contexts: not revoked and they granted this node `context.sync`. */
	eligiblePeers(workspaceId: string): PeerRow[] {
		const { peers } = this.hub.ctx.network;
		return this.hub.members
			.activePeerIds(workspaceId)
			.map((id) => peers.row(id))
			.filter((p): p is PeerRow => p !== undefined && p.status !== "revoked" && (p.receivedCapabilities as string[]).includes("context.sync"));
	}

	private workspacesWith(peerId: string): string[] {
		return this.hub.ctx.db
			.select({ id: workspaceMembers.workspaceId })
			.from(workspaceMembers)
			.where(and(eq(workspaceMembers.memberId, peerId), isNull(workspaceMembers.revokedAt)))
			.all()
			.map((r) => r.id);
	}

	// ------------------------------------------------------------------ outbound

	/** A shareable context changed on this node (or arrived from `except`): bring every other member peer up to date. */
	changed(row: ContextRow, o: { except?: string } = {}): void {
		if (!row.shareable) return;
		for (const peer of this.eligiblePeers(row.workspaceId)) {
			if (peer.id !== o.except) this.enqueuePush(peer.id, row);
		}
	}

	/** The tombstone of a context this node stopped sharing goes to every member peer, whatever we believe they hold. */
	retracted(row: ContextRow, tombstone: VersionRecord): void {
		for (const peer of this.eligiblePeers(row.workspaceId)) this.enqueuePush(peer.id, row, { version: tombstone, force: true });
	}

	toWire(row: ContextRow, v: VersionRecord): WireVersion {
		return {
			contextId: row.id,
			type: row.type as WireVersion["type"],
			projectKey: this.hub.liveProjectKey(row),
			originNodeId: row.originNodeId,
			contextCreatedAt: row.createdAt,
			version: v.version,
			sha256: v.sha256,
			title: v.title,
			body: v.body,
			deleted: v.deleted,
			base: v.base,
			merged: v.merged,
			ancestors: v.ancestors,
			author: v.author,
			versionOriginNodeId: v.originNodeId,
			createdAt: v.createdAt,
		};
	}

	private hasPending(peerId: string, match: (item: OutboxRow) => boolean): boolean {
		return this.hub.ctx.tasks.store.pendingOutbox(peerId).some((i) => i.kind === "context.sync" && match(i));
	}

	private cancelPending(peerId: string, match: (item: OutboxRow) => boolean): void {
		const { store } = this.hub.ctx.tasks;
		for (const item of store.pendingOutbox(peerId)) if (item.kind === "context.sync" && match(item)) store.updateOutbox(item.id, { state: "cancelled" });
	}

	/**
	 * Queue the push of one version (default: the head) to one peer, replacing a push of an older version that has not
	 * gone out yet. Does nothing when the peer is known to hold that version already.
	 */
	enqueuePush(peerId: string, row: ContextRow, o: { version?: VersionRecord; force?: boolean; unique?: boolean } = {}): void {
		const v = o.version ?? this.store.head(row);
		if (!o.force && holdsHead(this.store.replica(row.id, peerId), v)) return;
		const wire = this.toWire(row, v);
		const body = { workspaceId: row.workspaceId, have: [{ contextId: row.id, version: v.version, sha256: v.sha256, deleted: v.deleted }], push: [wire] };
		if (JSON.stringify(body).length > MAX_REQUEST_BYTES) {
			this.hub.log.warn({ contextId: row.id, version: v.version }, "context is too large to sync (limit about 900 KiB serialized); it stays pending");
			return;
		}
		this.cancelPending(peerId, (i) => i.refId === row.id);
		const { tasks } = this.hub.ctx;
		tasks.store.enqueue({
			peerId,
			taskId: null,
			kind: "context.sync",
			refId: row.id,
			path: SYNC_PATH,
			body,
			idempotencyKey: `context.sync:${peerId}:${row.id}:${v.version}:${v.sha256.slice(0, 16)}${o.unique ? `:${newId("w")}` : ""}`,
			correlationId: `ctx:${row.id}`,
		});
		tasks.outbox.kick(peerId);
	}

	/**
	 * Compare what this node holds with what `peerId` holds: for every shareable context of the workspaces they share
	 * whose acknowledged state is unknown or behind, send the have-index; the peer answers what it lacks and `handleResponse` pushes it.
	 */
	reconcile(peerId?: string): void {
		if (this.stopped) return;
		const { network } = this.hub.ctx;
		const peers = peerId ? [network.peers.row(peerId)] : network.peers.activeRows();
		for (const peer of peers) {
			if (!peer || peer.status === "revoked" || (peer.status !== "online" && peer.status !== "degraded")) continue;
			if (!(peer.receivedCapabilities as string[]).includes("context.sync")) continue;
			for (const workspaceId of this.workspacesWith(peer.id)) {
				try {
					this.reconcileWorkspace(peer, workspaceId);
				} catch (error) {
					this.hub.log.warn({ peerId: peer.id, workspaceId, err: errorText(error) }, "context reconcile failed");
				}
			}
		}
	}

	private reconcileWorkspace(peer: PeerRow, workspaceId: string): void {
		if (!this.hub.workspace(workspaceId)) return;
		const round = `round:${workspaceId}`;
		if (this.hasPending(peer.id, (i) => i.refId === round)) return;
		const replicas = new Map(this.store.replicasOfWorkspace(workspaceId).filter((r) => r.peerId === peer.id).map((r) => [r.contextId, r]));
		const pending = new Set(this.hub.ctx.tasks.store.pendingOutbox(peer.id).filter((i) => i.kind === "context.sync" && i.refId !== null).map((i) => i.refId));
		const entries: WireHave[] = [];
		for (const row of this.store.shareableRows(workspaceId)) {
			if (pending.has(row.id)) continue;
			const head = this.store.head(row);
			const replica = replicas.get(row.id);
			const unknownOrBehind = replica === undefined || (!holdsHead(replica, head) && replica.state !== "ahead" && replica.state !== "conflict");
			if (unknownOrBehind) entries.push({ contextId: row.id, version: head.version, sha256: head.sha256, deleted: head.deleted });
		}
		const { tasks } = this.hub.ctx;
		for (let at = 0; at < entries.length; at += MAX_HAVE) {
			tasks.store.enqueue({
				peerId: peer.id,
				taskId: null,
				kind: "context.sync",
				refId: round,
				path: SYNC_PATH,
				body: { workspaceId, have: entries.slice(at, at + MAX_HAVE), push: [] },
				idempotencyKey: `context.sync:${peer.id}:${round}:${newId("r")}`,
				correlationId: `ctx:${workspaceId}`,
			});
		}
		if (entries.length > 0) tasks.outbox.kick(peer.id);
	}

	// ------------------------------------------------------------------ answers to our requests

	handlers(): Record<"context.sync" | "context.member", OutboxHandler> {
		return {
			"context.sync": {
				sent: (item, _status, body) => this.handleResponse(item, body),
				dead: (item, reason) => this.hub.log.warn({ outboxId: item.id, peerId: item.peerId, err: reason }, "a context sync request could not be delivered"),
			},
			"context.member": this.hub.members.outboxHandler(),
		};
	}

	/** Record what the peer said about its copies and push what it asked for. */
	private handleResponse(item: OutboxRow, raw: unknown): void {
		const parsed = ContextSyncResponse.safeParse(raw);
		if (!parsed.success) {
			this.hub.log.warn({ outboxId: item.id, peerId: item.peerId }, "unreadable answer to a context sync request");
			return;
		}
		const response = parsed.data;
		const touched = new Set<string>();
		const note = (contextId: string, theirs: { version: number; sha256: string }, state: "holds" | "behind" | "ahead" | "conflict"): void => {
			const row = this.store.find(contextId);
			if (!row) return;
			const mine = this.store.head(row);
			// "accepted" for a head that is not ours any more only says they are behind.
			this.store.setReplica(contextId, item.peerId, theirs, state === "holds" && !holdsHead(theirs, mine) ? "behind" : state);
			touched.add(contextId);
		};
		for (const a of response.accepted) note(a.contextId, a, "holds");
		for (const a of response.ahead) note(a.contextId, a, "ahead");
		for (const c of response.conflicts) {
			// The peer reported a conflict about the version we offered (it knows it now, and holds its own).
			const offered = this.offered(item, c.contextId);
			if (offered) note(c.contextId, offered, "conflict");
		}
		for (const r of response.rejected) this.hub.log.info({ peerId: item.peerId, contextId: r.contextId, reason: r.reason }, "a peer refused a context");
		for (const w of response.want) {
			const row = this.store.find(w.contextId);
			if (!row || !row.shareable) continue;
			// A fresh key: the same version may have been pushed (and lost) before; one push in flight at a time.
			if (!this.hasPending(item.peerId, (i) => i.refId === row.id)) this.enqueuePush(item.peerId, row, { force: true, unique: true });
		}
		for (const id of touched) {
			const row = this.store.find(id);
			if (row) this.hub.publish(row);
		}
	}

	/** The version of a context that `item` offered the peer (its push, else its have entry). */
	private offered(item: OutboxRow, contextId: string): { version: number; sha256: string } | null {
		const body = item.body as { push?: Array<{ contextId: string; version: number; sha256: string }>; have?: Array<{ contextId: string; version: number; sha256: string }> } | null;
		const entry = body?.push?.find((p) => p.contextId === contextId) ?? body?.have?.find((h) => h.contextId === contextId);
		return entry ? { version: entry.version, sha256: entry.sha256 } : null;
	}

	// ------------------------------------------------------------------ inbound

	/**
	 * `POST /context/sync` (the caller is authenticated and holds `context.sync`). Applies every pushed version through
	 * the engine and answers what this node holds, lacks and could not merge.
	 */
	receive(peerId: string, request: ContextSyncRequest): ContextSyncResponse {
		const { workspaceId } = request;
		if (!this.hub.workspace(workspaceId) || !this.hub.members.isActiveMember(workspaceId, peerId)) {
			throw new ApiError(403, "forbidden", i18nMsg("This node does not share that workspace with you"));
		}
		const peer = this.hub.ctx.network.peers.row(peerId);
		const from = { nodeId: peerId, nodeName: peer?.name ?? peerId };
		const response: ContextSyncResponse = { want: [], accepted: [], conflicts: [], ahead: [], rejected: [] };
		const pushed = new Set<string>();

		for (const wire of request.push) {
			pushed.add(wire.contextId);
			const reason = this.validate(workspaceId, wire);
			if (reason) {
				response.rejected.push({ contextId: wire.contextId, reason });
				continue;
			}
			try {
				this.applyPush(peerId, from, workspaceId, wire, response);
			} catch (error) {
				this.hub.log.warn({ contextId: wire.contextId, peerId, err: errorText(error) }, "applying a pushed context failed");
				response.rejected.push({ contextId: wire.contextId, reason: "could not be applied" });
			}
		}

		for (const have of request.have) {
			if (pushed.has(have.contextId)) continue;
			this.answerHave(peerId, workspaceId, have, response);
		}
		return response;
	}

	private validate(workspaceId: string, wire: WireVersion): string | null {
		const existing = this.store.find(wire.contextId);
		if (existing && existing.workspaceId !== workspaceId) return "belongs to another workspace";
		if (existing && !existing.shareable) return "private on this node";
		if (canonicalTitle(wire.title) !== wire.title) return "title is not canonical";
		if (!wire.deleted && wire.title === "") return "a context needs a title";
		if (wire.deleted && wire.body !== "") return "a tombstone has no text";
		if (canonicalBody(wire.body) !== wire.body) return "body is not canonical";
		if (!hasValidSha({ title: wire.title, body: wire.body, deleted: wire.deleted, sha256: wire.sha256 })) return "sha256 does not match the text";
		return null;
	}

	private applyPush(peerId: string, from: { nodeId: string; nodeName: string }, workspaceId: string, wire: WireVersion, response: ContextSyncResponse): void {
		const { store } = this;
		const existing = store.find(wire.contextId);
		const incoming: VersionRecord = {
			version: wire.version,
			sha256: wire.sha256,
			title: wire.title,
			body: wire.body,
			deleted: wire.deleted,
			base: wire.base,
			merged: wire.merged,
			ancestors: wire.ancestors,
			author: wire.author,
			originNodeId: wire.versionOriginNodeId,
			createdAt: wire.createdAt,
		};
		const project = wire.projectKey ? findProjectByKey(this.hub.ctx.db, workspaceId, wire.projectKey) : undefined;
		const { row, applied, headMoved, conflictChanged } = this.hub.applyVersion({
			existing,
			workspaceId,
			contextId: wire.contextId,
			type: wire.type,
			originNodeId: wire.originNodeId,
			contextCreatedAt: wire.contextCreatedAt,
			project: { id: project?.id ?? null, key: wire.projectKey },
			incoming,
			from,
		});
		const theirs = { version: incoming.version, sha256: incoming.sha256 };
		const head = applied.state.head as VersionRecord;
		const mine = { contextId: row.id, version: head.version, sha256: head.sha256 };
		// Seen again: their version is the competing one we already hold, so they still do not know ours.
		const knownCompeting = applied.outcome === "duplicate" && applied.state.conflict !== null && versionId(applied.state.conflict) === versionId(incoming);
		const conflicted = knownCompeting || applied.outcome === "conflict" || applied.outcome === "conflict_updated" || applied.outcome === "conflict_extra";
		const behind = applied.outcome === "stale" || applied.outcome === "ignore_deletion";
		if (conflicted) {
			// They do not hold our head yet: send it, so the conflict is reported on both sides.
			store.noteTheirHead(row.id, peerId, theirs, head);
			response.conflicts.push({ contextId: row.id, localVersion: head.version, remoteVersion: incoming.version });
		} else if (behind) {
			store.noteTheirHead(row.id, peerId, theirs, head);
			response.ahead.push(mine);
		} else {
			store.setReplica(row.id, peerId, theirs, "holds");
			response.accepted.push(mine);
		}

		const changed = headMoved || conflictChanged || behind;
		if (changed || !existing) this.hub.publish(row);
		if (headMoved) this.changed(row, { except: peerId });
		// The peer is behind what we hold: bring it up to date now instead of waiting for its next reconcile.
		if (behind || conflicted) this.enqueuePush(peerId, row);
	}

	/** The receiver's half of the have-index: what do we hold, what are we missing? */
	private answerHave(peerId: string, workspaceId: string, have: WireHave, response: ContextSyncResponse): void {
		const row = this.store.find(have.contextId);
		if (!row) {
			// A deletion of something we never saw needs no answer; anything else we want.
			if (!have.deleted) response.want.push({ contextId: have.contextId, sinceVersion: 0 });
			return;
		}
		if (row.workspaceId !== workspaceId) {
			response.rejected.push({ contextId: have.contextId, reason: "belongs to another workspace" });
			return;
		}
		if (!row.shareable) {
			response.rejected.push({ contextId: have.contextId, reason: "private on this node" });
			return;
		}
		const head = this.store.head(row);
		const mine = { contextId: row.id, version: head.version, sha256: head.sha256 };
		const id = versionId(have);
		const sameText = have.sha256 === head.sha256 && have.deleted === head.deleted;
		if (id === versionId(head)) {
			this.store.setReplica(row.id, peerId, have, "holds");
			response.accepted.push(mine);
		} else if (head.ancestors.includes(id) || (sameText && have.version < head.version)) {
			// Their copy is older than ours (or the same text with a shorter history): they are behind.
			this.store.noteTheirHead(row.id, peerId, have, head);
			response.ahead.push(mine);
			this.enqueuePush(peerId, row);
		} else if (sameText) {
			// The same text with a longer history: take their version so both sides end on one.
			response.want.push({ contextId: row.id, sinceVersion: head.version });
		} else if (row.conflict && versionId(row.conflict) === id) {
			// We hold their version as the competing one; they do not know ours yet.
			this.store.noteTheirHead(row.id, peerId, have, head);
			response.conflicts.push({ contextId: row.id, localVersion: head.version, remoteVersion: have.version });
			this.enqueuePush(peerId, row);
		} else if (this.store.hasVersion(row.id, id)) {
			response.accepted.push(mine);
		} else {
			response.want.push({ contextId: row.id, sinceVersion: head.version });
		}
	}
}
