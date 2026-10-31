import {
	type Context,
	type ContextAuthor,
	type ContextListQuery,
	type ContextSearchHit,
	type ContextVersion,
	type CreateContextBody,
	type ResolveContextConflictBody,
	type UpdateContextBody,
} from "@clam/contracts";
import { applyIncoming, buildPreface, canonicalBody, canonicalTitle, createVersion, resolveConflict, searchContexts, versionId, withPreface, type Applied, type PrefaceItem, type VersionRecord } from "@clam/context-engine";
import { workspaceMembers, workspaces, type contexts } from "@clam/database";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { z } from "zod";
import type { ServerContext } from "../context.ts";
import { ApiError } from "../http/errors.ts";
import { newId } from "../services/ids.ts";
import { readNodeSettings } from "../services/settings.ts";
import { ClmeshService } from "./clmesh.ts";
import { ContextHostTools } from "./host-tools.ts";
import { WorkspaceMembers } from "./members.ts";
import { findProjectByKey, projectKeyOf, projectRow } from "./project-keys.ts";
import { ContextStore, type ContextRow } from "./store.ts";
import { ContextSync } from "./sync.ts";

export interface ContextTimings {
	/** How often every peer is reconciled with the shareable contexts it does not hold (ms). */
	reconcileMs: number;
}
export const DEFAULT_CONTEXT_TIMINGS: ContextTimings = { reconcileMs: 30_000 };

export interface ContextServiceOptions {
	timings?: Partial<ContextTimings>;
}

type WorkspaceRow = typeof workspaces.$inferSelect;

const nowIso = (): string => new Date().toISOString();

/**
 * Composition root of the context feature (docs/roadmap.md M6): the store, the local API (CRUD with optimistic
 * concurrency, versions, conflict resolution, search), the peer sync, workspace membership, `.clmesh/` export/import, the
 * agents' host tools and the project-memory preface. Units only keep this hub.
 */
export class ContextService {
	readonly store: ContextStore;
	readonly log: FastifyBaseLogger;
	readonly timings: ContextTimings;
	readonly sync: ContextSync;
	readonly members: WorkspaceMembers;
	readonly clmesh: ClmeshService;
	readonly tools: ContextHostTools;
	/** Sessions whose first prompt has been looked at (preface added or not needed). */
	private readonly prefaced = new Set<string>();

	constructor(
		readonly ctx: ServerContext,
		options: ContextServiceOptions = {},
	) {
		this.log = ctx.log;
		this.timings = { ...DEFAULT_CONTEXT_TIMINGS, ...options.timings };
		this.store = new ContextStore(ctx.db);
		// Units only keep the hub; none may call another unit from its constructor.
		this.sync = new ContextSync(this);
		this.members = new WorkspaceMembers(this);
		this.clmesh = new ClmeshService(this);
		this.tools = new ContextHostTools(this);
		// Registered here (not at start) so every runtime the node opens has the tools, including recovery sessions.
		ctx.hostTools.register(this.tools);
	}

	// ------------------------------------------------------------------ lifecycle

	start(): void {
		this.sync.start();
		this.members.start();
	}

	async stop(): Promise<void> {
		this.sync.stop();
		this.members.stop();
	}

	// ------------------------------------------------------------------ identity

	get nodeId(): string {
		return this.ctx.identity.nodeId;
	}

	nodeName(): string {
		return readNodeSettings(this.ctx.db).nodeName;
	}

	humanAuthor(): ContextAuthor {
		return { kind: "human", nodeId: this.nodeId, nodeName: this.nodeName(), agentName: null };
	}

	agentAuthor(agentName: string | null): ContextAuthor {
		return { kind: "agent", nodeId: this.nodeId, nodeName: this.nodeName(), agentName };
	}

	systemAuthor(): ContextAuthor {
		return { kind: "system", nodeId: this.nodeId, nodeName: this.nodeName(), agentName: null };
	}

	// ------------------------------------------------------------------ lookups

	workspace(id: string): WorkspaceRow | undefined {
		return this.ctx.db.select().from(workspaces).where(eq(workspaces.id, id)).get();
	}

	requireWorkspace(id: string): WorkspaceRow {
		const row = this.workspace(id);
		if (!row) throw ApiError.notFound("Workspace");
		return row;
	}

	/** The project's key as other nodes know it (live: a renamed or newly linked project changes it). */
	liveProjectKey(row: Pick<ContextRow, "projectId" | "projectKey">): string | null {
		if (row.projectId) {
			const project = projectRow(this.ctx.db, row.projectId);
			if (project) return projectKeyOf(project);
		}
		return row.projectKey;
	}

	/** The local project a context belongs to: its binding, or the local project matching its key. */
	resolveProjectId(row: Pick<ContextRow, "workspaceId" | "projectId" | "projectKey">, memo?: Map<string, string | null>): string | null {
		if (row.projectId) return row.projectId;
		if (!row.projectKey) return null;
		const cacheKey = `${row.workspaceId}\n${row.projectKey}`;
		if (memo?.has(cacheKey)) return memo.get(cacheKey) ?? null;
		const found = findProjectByKey(this.ctx.db, row.workspaceId, row.projectKey)?.id ?? null;
		memo?.set(cacheKey, found);
		return found;
	}

	// ------------------------------------------------------------------ mapping

	/** `toContext` for many rows (members and project keys are resolved once per workspace/key). */
	toContexts(rows: readonly ContextRow[]): Context[] {
		const memo = { projects: new Map<string, string | null>(), peers: new Map<string, string[]>() };
		return rows.map((row) => this.toContext(row, memo));
	}

	toContext(row: ContextRow, memo?: { projects: Map<string, string | null>; peers: Map<string, string[]> }): Context {
		return {
			id: row.id,
			workspaceId: row.workspaceId,
			projectId: this.resolveProjectId(row, memo?.projects),
			type: row.type as Context["type"],
			title: row.title,
			body: row.body,
			shareable: row.shareable,
			version: row.version,
			sha256: row.sha256,
			author: row.author,
			sync: this.syncInfo(row, memo?.peers),
			gitPath: row.gitPath,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		};
	}

	private syncInfo(row: ContextRow, memo?: Map<string, string[]>): Context["sync"] {
		if (!row.shareable) return { state: "private", syncedTo: [], conflict: null };
		const competing = row.conflict;
		const conflict = competing
			? { nodeId: competing.fromNodeId, nodeName: competing.fromNodeName, version: competing.version, sha256: competing.sha256, body: competing.body, author: competing.author, at: competing.at }
			: null;
		let members = memo?.get(row.workspaceId);
		if (!members) {
			members = this.members.activePeerIds(row.workspaceId);
			memo?.set(row.workspaceId, members);
		}
		// A peer that reported a conflict about this version knows it but does not hold it as its own.
		const holding = new Set(this.store.replicas(row.id).filter((r) => r.version === row.version && r.sha256 === row.sha256 && r.state !== "conflict").map((r) => r.peerId));
		const syncedTo = members.filter((id) => holding.has(id));
		const state: Context["sync"]["state"] = conflict ? "conflict" : members.every((id) => holding.has(id)) ? "synced" : "pending";
		return { state, syncedTo, conflict };
	}

	/** Publish a changed context on the `contexts` topic. */
	publish(row: ContextRow): void {
		if (row.deletedAt !== null) {
			this.ctx.bus.publish("contexts", { type: "removed", contextId: row.id });
			return;
		}
		this.ctx.bus.publish("contexts", { type: "context", context: this.toContext(row) });
	}

	publishRemoved(contextId: string): void {
		this.ctx.bus.publish("contexts", { type: "removed", contextId });
	}

	/** Head columns of a version. */
	headPatch(v: VersionRecord): Partial<typeof contexts.$inferInsert> {
		const at = nowIso();
		return { version: v.version, sha256: v.sha256, title: v.title, body: v.body, author: v.author, updatedAt: at, deletedAt: v.deleted ? at : null };
	}

	// ------------------------------------------------------------------ local API

	list(query: z.infer<typeof ContextListQuery>): Context[] {
		const project = query.projectId ? this.scopeOfProject(query.projectId, query.workspaceId) : undefined;
		const rows = this.store.rows({
			...((query.workspaceId ?? project?.workspaceId) !== undefined && { workspaceId: (query.workspaceId ?? project?.workspaceId) as string }),
			...(project && { project: { id: project.id, key: project.key } }),
			...(query.type && { type: query.type }),
			...(query.shareable !== undefined && { shareable: query.shareable === "true" }),
		});
		return this.toContexts(rows);
	}

	private scopeOfProject(projectId: string, workspaceId?: string): { id: string; key: string; workspaceId: string } {
		const project = projectRow(this.ctx.db, projectId);
		if (!project || (workspaceId !== undefined && project.workspaceId !== workspaceId)) throw ApiError.notFound("Project");
		return { id: project.id, key: projectKeyOf(project), workspaceId: project.workspaceId };
	}

	get(id: string): Context {
		return this.toContext(this.store.get(id));
	}

	create(input: z.infer<typeof CreateContextBody>, author: ContextAuthor): Context {
		this.requireWorkspace(input.workspaceId);
		const project = input.projectId ? this.scopeOfProject(input.projectId, input.workspaceId) : null;
		const title = canonicalTitle(input.title);
		if (title === "") throw ApiError.badRequest("A context needs a title");
		const at = nowIso();
		const version = createVersion(null, { title, body: input.body, author, originNodeId: this.nodeId, at });
		const id = newId("ctx");
		const row = this.store.db.$client.transaction(() => {
			const inserted = this.store.insert({
				id,
				workspaceId: input.workspaceId,
				projectId: project?.id ?? null,
				projectKey: project?.key ?? null,
				originNodeId: this.nodeId,
				type: input.type,
				title: version.title,
				body: version.body,
				shareable: input.shareable,
				version: version.version,
				sha256: version.sha256,
				author,
				createdAt: at,
				updatedAt: at,
			});
			this.store.insertSnapshot(id, version);
			return inserted;
		})();
		this.publish(row);
		if (row.shareable) this.sync.changed(row);
		return this.toContext(row);
	}

	update(id: string, input: z.infer<typeof UpdateContextBody>, author: ContextAuthor): Context {
		const row = this.store.get(id);
		if (input.baseVersion !== row.version) {
			throw new ApiError(409, "stale_version", `The context is at version ${row.version}; the edit is based on version ${input.baseVersion}. Reload it and apply the change again.`, { currentVersion: row.version });
		}
		if (row.conflict) throw new ApiError(409, "context_conflict", "This context is in conflict with a version from another node; resolve the conflict first.", { contextId: row.id });
		const head = this.store.head(row);
		const title = input.title === undefined ? head.title : canonicalTitle(input.title);
		const body = input.body === undefined ? head.body : canonicalBody(input.body);
		if (title === "") throw ApiError.badRequest("A context needs a title");
		const shareable = input.shareable ?? row.shareable;
		const textChanged = title !== head.title || body !== head.body;

		if (row.shareable && !shareable) return this.retract(row, head, { title, body, textChanged }, author);

		let updated = row;
		if (textChanged) {
			const next = createVersion(head, { title, body, author, originNodeId: this.nodeId, at: nowIso() });
			updated = this.store.db.$client.transaction(() => {
				this.store.insertSnapshot(row.id, next);
				const saved = this.store.update(row.id, { ...this.headPatch(next), shareable });
				this.store.invalidateReplicas(row.id, next);
				return saved;
			})();
		} else if (shareable !== row.shareable) {
			updated = this.store.update(row.id, { shareable });
		}
		if (updated === row && !textChanged && shareable === row.shareable) return this.toContext(row);
		this.publish(updated);
		if (updated.shareable) this.sync.changed(updated);
		return this.toContext(updated);
	}

	/**
	 * Stop sharing a context this node created: peers receive a tombstone (their copy goes away) and the local copy
	 * continues as a private context — a new version that descends from the tombstone, so sharing it again later brings it
	 * back everywhere. Only the creating node may do this (everyone else would delete the others' copies).
	 */
	private retract(row: ContextRow, head: VersionRecord, edit: { title: string; body: string; textChanged: boolean }, author: ContextAuthor): Context {
		if (row.originNodeId !== this.nodeId) {
			throw new ApiError(409, "not_origin", "Only the node that created this context can stop sharing it; delete your copy instead.");
		}
		const at = nowIso();
		const tombstone = createVersion(head, { title: head.title, body: "", deleted: true, author, originNodeId: this.nodeId, at });
		const keep = createVersion(tombstone, { title: edit.title, body: edit.body, author, originNodeId: this.nodeId, at });
		const retracted = { ...tombstone };
		const saved = this.store.db.$client.transaction(() => {
			this.store.insertSnapshot(row.id, tombstone);
			this.store.insertSnapshot(row.id, keep);
			// The tombstone goes out first (the outbox items are built from it), then the row becomes private.
			this.sync.retracted(row, retracted);
			this.store.deleteReplicas(row.id);
			return this.store.update(row.id, { ...this.headPatch(keep), shareable: false });
		})();
		this.publish(saved);
		return this.toContext(saved);
	}

	remove(id: string, author: ContextAuthor): void {
		const row = this.store.get(id);
		if (!row.shareable) {
			this.store.delete(row.id);
			this.publishRemoved(row.id);
			return;
		}
		const head = this.store.head(row);
		const tombstone = createVersion(head, { title: head.title, body: "", deleted: true, author, originNodeId: this.nodeId, at: nowIso() });
		const saved = this.store.db.$client.transaction(() => {
			this.store.insertSnapshot(row.id, tombstone);
			const updated = this.store.update(row.id, { ...this.headPatch(tombstone), conflict: null });
			this.store.purgeBodies(row.id);
			this.store.invalidateReplicas(row.id, tombstone);
			return updated;
		})();
		this.publishRemoved(row.id);
		this.sync.changed(saved);
	}

	versions(id: string): ContextVersion[] {
		const row = this.store.get(id);
		const head = this.store.head(row);
		const lineage = new Set([versionId(head), ...head.ancestors]);
		if (row.conflict) lineage.add(versionId(row.conflict));
		return this.store
			.snapshots(row.id)
			.filter((s) => !s.deleted && lineage.has(`${s.version}:${s.sha256}`))
			.map((s) => ({ version: s.version, sha256: s.sha256, title: s.title, body: s.body, author: s.author, createdAt: s.createdAt }));
	}

	resolve(id: string, input: z.infer<typeof ResolveContextConflictBody>, author: ContextAuthor): Context {
		const row = this.store.get(id);
		if (!row.conflict) throw new ApiError(409, "no_conflict", "This context has no open conflict.");
		if (input.keep === "merged" && (input.body === undefined || canonicalBody(input.body) === "")) throw ApiError.badRequest("A merged resolution needs the merged text in `body`");
		const state = this.store.state(row);
		if (!state.head || !state.conflict) throw new ApiError(409, "no_conflict", "This context has no open conflict.");
		const resolved = resolveConflict({ head: state.head, conflict: state.conflict }, { keep: input.keep, ...(input.body !== undefined && { body: input.body }), author, originNodeId: this.nodeId, at: nowIso() });
		const saved = this.store.db.$client.transaction(() => {
			this.store.insertSnapshot(row.id, resolved);
			const updated = this.store.update(row.id, { ...this.headPatch(resolved), conflict: null });
			this.store.invalidateReplicas(row.id, resolved);
			return updated;
		})();
		this.publish(saved);
		if (saved.deletedAt === null && saved.shareable) this.sync.changed(saved);
		return this.toContext(saved);
	}

	search(query: { q: string; workspaceId?: string; projectId?: string; type?: string; limit: number }): ContextSearchHit[] {
		const project = query.projectId ? this.scopeOfProject(query.projectId, query.workspaceId) : undefined;
		const workspaceId = query.workspaceId ?? project?.workspaceId;
		const hits = searchContexts(this.ctx.db.$client, query.q, {
			...(workspaceId !== undefined && { workspaceId }),
			...(project && { project: { id: project.id, key: project.key } }),
			...(query.type && { type: query.type }),
			limit: query.limit,
		});
		return this.hitsToResult(hits);
	}

	hitsToResult(hits: ReadonlyArray<{ id: string; snippet: string; rank: number }>): ContextSearchHit[] {
		const rows = new Map(this.store.byIds(hits.map((h) => h.id)).map((r) => [r.id, r]));
		const memo = { projects: new Map<string, string | null>(), peers: new Map<string, string[]>() };
		return hits.flatMap((h) => {
			const row = rows.get(h.id);
			if (!row) return [];
			const { body: _body, ...context } = this.toContext(row, memo);
			return [{ context, snippet: h.snippet, rank: h.rank }];
		});
	}

	/**
	 * Bring one version that came from outside this node's own editing (a peer's push, a `.clmesh/` file) into the store:
	 * the engine decides (fast-forward, stale, conflict, ...) and the result is saved in one transaction. The caller
	 * records replicas, publishes and relays. `project` only matters for a context this node does not hold yet.
	 */
	applyVersion(input: {
		existing: ContextRow | undefined;
		workspaceId: string;
		contextId: string;
		type: string;
		originNodeId: string;
		contextCreatedAt: string;
		project: { id: string | null; key: string | null };
		incoming: VersionRecord;
		from: { nodeId: string; nodeName: string };
	}): { row: ContextRow; applied: Applied; headMoved: boolean; conflictChanged: boolean } {
		const { store } = this;
		const { existing, incoming } = input;
		const state = existing ? store.state(existing) : { head: null, conflict: null };
		const at = nowIso();
		const applied = applyIncoming(state, incoming, input.from, at);
		const headMoved = applied.state.head !== state.head;
		const conflictChanged = applied.state.conflict !== state.conflict;
		const row = store.db.$client.transaction((): ContextRow => {
			if (!existing) {
				const inserted = store.insert({
					id: input.contextId,
					workspaceId: input.workspaceId,
					projectId: input.project.id,
					projectKey: input.project.key,
					originNodeId: input.originNodeId,
					type: input.type,
					title: incoming.title,
					body: incoming.body,
					shareable: true,
					deletedAt: incoming.deleted ? at : null,
					version: incoming.version,
					sha256: incoming.sha256,
					author: incoming.author,
					createdAt: input.contextCreatedAt,
					updatedAt: at,
				});
				store.insertSnapshot(input.contextId, incoming);
				return inserted;
			}
			if (applied.keep) store.insertSnapshot(existing.id, incoming);
			const patch: Parameters<typeof store.update>[1] = {};
			if (headMoved && applied.state.head) Object.assign(patch, this.headPatch(applied.state.head));
			if (conflictChanged) patch.conflict = applied.state.conflict;
			if (existing.projectId === null && input.project.id !== null) patch.projectId = input.project.id;
			const saved = Object.keys(patch).length > 0 ? store.update(existing.id, patch) : existing;
			if (headMoved && applied.state.head?.deleted) store.purgeBodies(existing.id);
			if (headMoved && applied.state.head) store.invalidateReplicas(existing.id, applied.state.head);
			return saved;
		})();
		return { row, applied, headMoved, conflictChanged };
	}

	// ------------------------------------------------------------------ project memory

	/** Contexts a session of `projectId` is told about: the project's own and the workspace-wide ones, tombstones excluded. */
	memoryOf(projectId: string): { projectName: string; workspaceId: string; items: ContextRow[] } | null {
		const project = projectRow(this.ctx.db, projectId);
		if (!project) return null;
		const items = this.store.rows({ workspaceId: project.workspaceId, project: { id: project.id, key: projectKeyOf(project), includeWorkspaceWide: true }, limit: 200 });
		return { projectName: project.name, workspaceId: project.workspaceId, items };
	}

	/**
	 * The text a session's FIRST prompt is sent as: a compact "Project memory" section in front of it when the project has
	 * contexts and the conversation is brand new (the runtime has no messages yet — a resumed or taken-over session already
	 * had its briefing). Never throws and never blocks the prompt: on any problem the prompt goes out unchanged.
	 */
	async promptWithMemory(session: { id: string; projectId: string }, runtime: { messages(query: { limit: number }): Promise<{ total: number }> }, message: string): Promise<string> {
		if (this.prefaced.has(session.id)) return message;
		try {
			const memory = this.memoryOf(session.projectId);
			if (!memory || memory.items.length === 0) return message;
			const page = await runtime.messages({ limit: 1 });
			this.prefaced.add(session.id);
			if (page.total > 0) return message;
			const items: PrefaceItem[] = memory.items.map((r) => ({ type: r.type as PrefaceItem["type"], title: r.title, body: r.body, updatedAt: r.updatedAt }));
			const preface = buildPreface(memory.projectName, items);
			return preface === null ? message : withPreface(preface, message);
		} catch (error) {
			this.log.warn({ err: error instanceof Error ? error.message : String(error), sessionId: session.id }, "could not add the project memory to the first prompt");
			return message;
		}
	}

	/** Workspace members' rows are read by `WorkspaceMembers`; exposed for the routes that need an "is this workspace known" check. */
	workspaceMemberRow(workspaceId: string, nodeId: string) {
		return this.ctx.db.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.memberId, nodeId), isNull(workspaceMembers.revokedAt))).get();
	}
}
