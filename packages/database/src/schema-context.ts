import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { ContextAuthor } from "@clam/contracts";
import { peers, projects, workspaces } from "./schema.ts";

/**
 * M6 — workspace/project context (memory, plans, decisions, summaries, notes). Migration `0007_context`.
 *
 * `contexts` holds the CURRENT head of every context (title/body denormalised so FTS5 can index them);
 * `context_snapshots` holds every immutable version (own versions, versions received from peers, competing versions of a
 * conflict). `context_replicas` remembers, per context and peer node, which head that peer last acknowledged.
 *
 * The full-text index `context_fts` (an FTS5 external-content table over `contexts.title/body`, kept in sync by three
 * triggers) cannot be expressed in drizzle: it is appended as custom SQL to `migrations/0007_context.sql`. Drizzle never
 * sees it, so `db:generate` neither drops nor recreates it. `contexts.seq` is an explicit INTEGER PRIMARY KEY because an
 * external-content FTS5 table addresses rows by rowid, and a rowid that is not an INTEGER PRIMARY KEY may change on VACUUM.
 */

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

/**
 * The competing version of another node, kept on a context while it is in conflict (structurally the context engine's
 * `CompetingVersion`: a full version record plus the node it came from and when this node learned about it).
 */
export interface StoredContextConflict {
	fromNodeId: string;
	fromNodeName: string;
	at: string;
	version: number;
	sha256: string;
	title: string;
	body: string;
	deleted: boolean;
	base: { version: number; sha256: string } | null;
	merged: Array<{ version: number; sha256: string }>;
	/** `<version>:<sha256>` ids the competing version descends from. */
	ancestors: string[];
	author: ContextAuthor;
	originNodeId: string;
	createdAt: string;
}

export const contexts = sqliteTable(
	"contexts",
	{
		/** FTS5 rowid; never reused. */
		seq: integer("seq").primaryKey({ autoIncrement: true }),
		id: text("id").notNull(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		/** Local project this context belongs to; null = workspace-wide, or a synced context whose project does not exist on this node (see `projectKey`). */
		projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
		/** Cross-node project identity (`github:<owner>/<name>` for a linked repository, else `name:<project name>`); null = workspace-wide. */
		projectKey: text("project_key"),
		/** The node that created the context (only it may stop sharing it). */
		originNodeId: text("origin_node_id").notNull(),
		/** memory | plan | decision | summary | note */
		type: text("type").notNull(),
		/** Head title / body (`''` for a tombstone). */
		title: text("title").notNull(),
		body: text("body").notNull(),
		/** Only shareable contexts leave the node (peer sync, `.clmesh/`). */
		shareable: integer("shareable", { mode: "boolean" }).notNull().default(false),
		/** Tombstone of a deleted shareable context: kept so the deletion replicates; hidden from every list. */
		deletedAt: text("deleted_at"),
		version: integer("version").notNull(),
		sha256: text("sha256").notNull(),
		author: text("author", { mode: "json" }).$type<ContextAuthor>().notNull(),
		/** The competing version of another node while this context is in conflict; null otherwise. */
		conflict: text("conflict", { mode: "json" }).$type<StoredContextConflict | null>(),
		/** Path under `.clmesh/` of the last export/import (git projects). */
		gitPath: text("git_path"),
		createdAt: text("created_at").notNull().default(now),
		updatedAt: text("updated_at").notNull().default(now),
	},
	(t) => [
		uniqueIndex("contexts_id_unique").on(t.id),
		index("contexts_scope_idx").on(t.workspaceId, t.projectId, t.type),
		index("contexts_project_key_idx").on(t.workspaceId, t.projectKey),
		index("contexts_shareable_idx").on(t.workspaceId, t.shareable),
	],
);

/**
 * One immutable version of a context. A version is identified by `(version, sha256)`: two nodes that independently write the
 * same text as the same version number have written the same version. `(context_id, version, sha256)` is unique.
 */
export const contextSnapshots = sqliteTable(
	"context_snapshots",
	{
		id: text("id").primaryKey(),
		contextId: text("context_id")
			.notNull()
			.references(() => contexts.id, { onDelete: "cascade" }),
		version: integer("version").notNull(),
		/** sha-256 over the canonical title + body (`@clam/context-engine` `contextSha`). */
		sha256: text("sha256").notNull(),
		title: text("title").notNull(),
		body: text("body").notNull(),
		/** A tombstone: the context was deleted (or stopped being shared) in this version. */
		deleted: integer("deleted", { mode: "boolean" }).notNull().default(false),
		/** The version this one was edited from (null for version 1). */
		base: text("base", { mode: "json" }).$type<{ version: number; sha256: string } | null>(),
		/** Other versions this one resolves (a conflict resolution): `[{ version, sha256 }]`. */
		merged: text("merged", { mode: "json" }).$type<Array<{ version: number; sha256: string }>>().notNull().default(sql`'[]'`),
		/** `<version>:<sha256>` of every version this one descends from (capped): decides fast-forward vs conflict without the history. */
		ancestors: text("ancestors", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
		author: text("author", { mode: "json" }).$type<ContextAuthor>().notNull(),
		/** The node whose user (or agent) wrote this version. */
		originNodeId: text("origin_node_id").notNull(),
		gitPath: text("git_path"),
		createdAt: text("created_at").notNull().default(now),
	},
	(t) => [uniqueIndex("context_snapshots_identity_unique").on(t.contextId, t.version, t.sha256), index("context_snapshots_sha_idx").on(t.contextId, t.sha256)],
);

/** The head a peer node last acknowledged for a context (peer sync). Gone with the context or the peer row. */
export const contextReplicas = sqliteTable(
	"context_replicas",
	{
		contextId: text("context_id")
			.notNull()
			.references(() => contexts.id, { onDelete: "cascade" }),
		peerId: text("peer_id")
			.notNull()
			.references(() => peers.id, { onDelete: "cascade" }),
		version: integer("version").notNull(),
		sha256: text("sha256").notNull(),
		/** holds | behind | ahead | conflict — what the peer's answer said about its head relative to ours. */
		state: text("state").notNull().default("holds"),
		updatedAt: text("updated_at").notNull().default(now),
	},
	(t) => [primaryKey({ columns: [t.contextId, t.peerId] }), index("context_replicas_peer_idx").on(t.peerId)],
);
