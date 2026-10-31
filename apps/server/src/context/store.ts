import type { Context, ContextAuthor } from "@clam/contracts";
import { contextReplicas, contextSnapshots, contexts, type ClamDb } from "@clam/database";
import type { CompetingVersion, ContextState, VersionRecord } from "@clam/context-engine";
import { versionId } from "@clam/context-engine";
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { ApiError } from "../http/errors.ts";
import { newId } from "../services/ids.ts";

export type ContextRow = typeof contexts.$inferSelect;
export type SnapshotRow = typeof contextSnapshots.$inferSelect;
export type ReplicaRow = typeof contextReplicas.$inferSelect;

export interface RowFilter {
	workspaceId?: string;
	/** Contexts bound to this project, plus synced ones whose key matches (workspace-wide ones too with `includeWorkspaceWide`). */
	project?: { id: string; key: string; includeWorkspaceWide?: boolean };
	type?: string;
	shareable?: boolean;
	limit?: number;
}

const nowIso = (): string => new Date().toISOString();

/** Every SQL statement of the context feature. Domain rules live in `@clam/context-engine`; this class persists them. Synchronous (better-sqlite3). */
export class ContextStore {
	constructor(readonly db: ClamDb) {}

	// ------------------------------------------------------------------ contexts

	find(id: string): ContextRow | undefined {
		return this.db.select().from(contexts).where(eq(contexts.id, id)).get();
	}

	get(id: string): ContextRow {
		const row = this.find(id);
		if (!row || row.deletedAt !== null) throw ApiError.notFound("Context");
		return row;
	}

	/** Live contexts (no tombstones), newest edit first. */
	rows(filter: RowFilter = {}): ContextRow[] {
		const conditions = [isNull(contexts.deletedAt)];
		if (filter.workspaceId) conditions.push(eq(contexts.workspaceId, filter.workspaceId));
		if (filter.type) conditions.push(eq(contexts.type, filter.type));
		if (filter.shareable !== undefined) conditions.push(eq(contexts.shareable, filter.shareable));
		if (filter.project) {
			const own = or(eq(contexts.projectId, filter.project.id), and(isNull(contexts.projectId), eq(contexts.projectKey, filter.project.key)));
			conditions.push((filter.project.includeWorkspaceWide ? or(own, and(isNull(contexts.projectId), isNull(contexts.projectKey))) : own) as ReturnType<typeof eq>);
		}
		return this.db
			.select()
			.from(contexts)
			.where(and(...conditions))
			.orderBy(desc(contexts.updatedAt), desc(contexts.seq))
			.limit(filter.limit ?? 1000)
			.all();
	}

	/** Every shareable context of a workspace, tombstones included (what sync reconciles). */
	shareableRows(workspaceId: string): ContextRow[] {
		return this.db
			.select()
			.from(contexts)
			.where(and(eq(contexts.workspaceId, workspaceId), eq(contexts.shareable, true)))
			.orderBy(asc(contexts.seq))
			.all();
	}

	insert(values: typeof contexts.$inferInsert): ContextRow {
		return this.db.insert(contexts).values(values).returning().get();
	}

	update(id: string, patch: Partial<typeof contexts.$inferInsert>): ContextRow {
		const row = this.db.update(contexts).set(patch).where(eq(contexts.id, id)).returning().get();
		if (!row) throw ApiError.notFound("Context");
		return row;
	}

	delete(id: string): void {
		this.db.delete(contexts).where(eq(contexts.id, id)).run();
	}

	countAgentAuthored(workspaceId: string, projectId: string | null): number {
		const rows = this.db
			.select({ author: contexts.author })
			.from(contexts)
			.where(and(eq(contexts.workspaceId, workspaceId), projectId === null ? isNull(contexts.projectId) : eq(contexts.projectId, projectId), isNull(contexts.deletedAt)))
			.all();
		return rows.filter((r) => r.author.kind === "agent").length;
	}

	// ------------------------------------------------------------------ snapshots

	snapshot(contextId: string, version: number, sha256: string): SnapshotRow | undefined {
		return this.db
			.select()
			.from(contextSnapshots)
			.where(and(eq(contextSnapshots.contextId, contextId), eq(contextSnapshots.version, version), eq(contextSnapshots.sha256, sha256)))
			.get();
	}

	hasVersion(contextId: string, id: string): boolean {
		const at = id.indexOf(":");
		return at > 0 && this.snapshot(contextId, Number(id.slice(0, at)), id.slice(at + 1)) !== undefined;
	}

	snapshots(contextId: string): SnapshotRow[] {
		return this.db.select().from(contextSnapshots).where(eq(contextSnapshots.contextId, contextId)).orderBy(desc(contextSnapshots.version), desc(contextSnapshots.createdAt)).all();
	}

	insertSnapshot(contextId: string, v: VersionRecord, gitPath: string | null = null): void {
		this.db
			.insert(contextSnapshots)
			.values({
				id: newId("csn"),
				contextId,
				version: v.version,
				sha256: v.sha256,
				title: v.title,
				body: v.body,
				deleted: v.deleted,
				base: v.base,
				merged: v.merged,
				ancestors: v.ancestors,
				author: v.author,
				originNodeId: v.originNodeId,
				gitPath,
				createdAt: v.createdAt,
			})
			.onConflictDoNothing()
			.run();
	}

	/** A deleted context keeps no text: its live versions are blanked (their hashes stay, so lineage checks still work); the tombstone keeps its title, which its hash covers. */
	purgeBodies(contextId: string): void {
		this.db.update(contextSnapshots).set({ body: "", title: "" }).where(and(eq(contextSnapshots.contextId, contextId), eq(contextSnapshots.deleted, false))).run();
	}

	toRecord(s: SnapshotRow): VersionRecord {
		return {
			version: s.version,
			sha256: s.sha256,
			title: s.title,
			body: s.body,
			deleted: s.deleted,
			base: s.base,
			merged: s.merged,
			ancestors: s.ancestors,
			author: s.author as ContextAuthor,
			originNodeId: s.originNodeId,
			createdAt: s.createdAt,
		};
	}

	/** The version a row's head fields describe. Falls back to the row itself when its snapshot is missing (never expected). */
	head(row: ContextRow): VersionRecord {
		const snapshot = this.snapshot(row.id, row.version, row.sha256);
		if (snapshot) return this.toRecord(snapshot);
		return { version: row.version, sha256: row.sha256, title: row.title, body: row.body, deleted: row.deletedAt !== null, base: null, merged: [], ancestors: [], author: row.author, originNodeId: row.originNodeId, createdAt: row.updatedAt };
	}

	state(row: ContextRow): ContextState {
		return { head: this.head(row), conflict: (row.conflict as CompetingVersion | null) ?? null };
	}

	// ------------------------------------------------------------------ replicas

	replicas(contextId: string): ReplicaRow[] {
		return this.db.select().from(contextReplicas).where(eq(contextReplicas.contextId, contextId)).all();
	}

	replicasOfWorkspace(workspaceId: string): ReplicaRow[] {
		return this.db
			.select({ r: contextReplicas })
			.from(contextReplicas)
			.innerJoin(contexts, eq(contexts.id, contextReplicas.contextId))
			.where(eq(contexts.workspaceId, workspaceId))
			.all()
			.map((x) => x.r);
	}

	replica(contextId: string, peerId: string): ReplicaRow | undefined {
		return this.db.select().from(contextReplicas).where(and(eq(contextReplicas.contextId, contextId), eq(contextReplicas.peerId, peerId))).get();
	}

	setReplica(contextId: string, peerId: string, head: { version: number; sha256: string }, state: "holds" | "behind" | "ahead" | "conflict"): void {
		const values = { contextId, peerId, version: head.version, sha256: head.sha256, state, updatedAt: nowIso() };
		this.db.insert(contextReplicas).values(values).onConflictDoUpdate({ target: [contextReplicas.contextId, contextReplicas.peerId], set: values }).run();
	}

	/**
	 * Record what a peer told us about ITS head when that head is not ours (it pushed an older or a competing version): it
	 * is behind. Never undoes what the peer already acknowledged about our current head ("holds", or "conflict": it knows our
	 * version and reported a conflict) — that would make both sides keep offering each other what they already have.
	 */
	noteTheirHead(contextId: string, peerId: string, theirs: { version: number; sha256: string }, ours: { version: number; sha256: string }): void {
		const known = this.replica(contextId, peerId);
		if (known && known.version === ours.version && known.sha256 === ours.sha256 && (known.state === "holds" || known.state === "conflict")) return;
		this.setReplica(contextId, peerId, theirs, "behind");
	}

	/** After the head moved: every peer whose acknowledged head differs from the new one is behind (or in conflict state no more). */
	invalidateReplicas(contextId: string, head: { version: number; sha256: string }): void {
		this.db
			.update(contextReplicas)
			.set({ state: "behind" })
			.where(and(eq(contextReplicas.contextId, contextId), or(ne(contextReplicas.version, head.version), ne(contextReplicas.sha256, head.sha256))))
			.run();
	}

	deleteReplicas(contextId: string): void {
		this.db.delete(contextReplicas).where(eq(contextReplicas.contextId, contextId)).run();
	}

	// ------------------------------------------------------------------ misc

	countInWorkspace(workspaceId: string): number {
		return this.db.select({ n: sql<number>`count(*)` }).from(contexts).where(and(eq(contexts.workspaceId, workspaceId), isNull(contexts.deletedAt))).get()?.n ?? 0;
	}

	ids(rows: readonly ContextRow[]): string[] {
		return rows.map((r) => r.id);
	}

	byIds(ids: readonly string[]): ContextRow[] {
		return ids.length === 0 ? [] : this.db.select().from(contexts).where(inArray(contexts.id, [...ids])).all();
	}
}

export { versionId };
export type { Context };
