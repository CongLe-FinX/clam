import { z } from "zod";
import { IsoDate } from "./common.ts";
import type { GitStatus } from "./git.ts";

/**
 * M6 — workspace/project context (memory, plans, decisions, summaries).
 *
 * - Every node keeps its own copy (SQLite + FTS5). A context is PRIVATE by default (never leaves the node);
 *   SHAREABLE contexts sync to the workspace's member nodes node-to-node (`POST /api/v1/context/sync`, works for
 *   projects with or without git) and, for git projects, can be exported to / imported from `.clmesh/` in the repo
 *   (written through the secret scanner; never auto-committed).
 * - Versions are immutable; concurrent edits on two nodes are reported as a CONFLICT (never auto-merged) until a
 *   human resolves it.
 * - Agents read context through host tools and get a short project-memory section in their briefs.
 */

export const ContextType = z.enum(["memory", "plan", "decision", "summary", "note"]);
export type ContextType = z.infer<typeof ContextType>;

export const ContextAuthor = z.object({
	kind: z.enum(["human", "agent", "system"]),
	nodeId: z.string(),
	nodeName: z.string(),
	agentName: z.string().nullable(),
});
export type ContextAuthor = z.infer<typeof ContextAuthor>;

export const ContextSync = z.object({
	state: z.enum(["private", "pending", "synced", "conflict"]),
	/** Member nodes that hold the current version. */
	syncedTo: z.array(z.string()),
	/** Set while in conflict: the competing version from another node. */
	conflict: z
		.object({ nodeId: z.string(), nodeName: z.string(), version: z.number().int(), sha256: z.string(), body: z.string(), author: ContextAuthor, at: IsoDate })
		.nullable(),
});

export const Context = z.object({
	id: z.string(),
	workspaceId: z.string(),
	/** null = workspace-wide. */
	projectId: z.string().nullable(),
	type: ContextType,
	title: z.string(),
	/** Markdown. */
	body: z.string(),
	shareable: z.boolean(),
	version: z.number().int(),
	sha256: z.string(),
	author: ContextAuthor,
	sync: ContextSync,
	/** git projects: path under `.clmesh/` this context was last exported to / imported from. */
	gitPath: z.string().nullable(),
	createdAt: IsoDate,
	updatedAt: IsoDate,
});
export type Context = z.infer<typeof Context>;

export const ContextVersion = z.object({
	version: z.number().int(),
	sha256: z.string(),
	title: z.string(),
	body: z.string(),
	author: ContextAuthor,
	createdAt: IsoDate,
});
export type ContextVersion = z.infer<typeof ContextVersion>;

export const ContextListQuery = z.object({
	workspaceId: z.string().optional(),
	projectId: z.string().optional(),
	type: ContextType.optional(),
	shareable: z.enum(["true", "false"]).optional(),
});
export const CreateContextBody = z.object({
	workspaceId: z.string().min(1),
	projectId: z.string().optional(),
	type: ContextType,
	title: z.string().trim().min(1).max(200),
	body: z.string().max(200_000),
	shareable: z.boolean().default(false),
});
export const UpdateContextBody = z.object({
	/** Optimistic concurrency: the version the edit is based on (409 `stale_version` otherwise). */
	baseVersion: z.number().int(),
	title: z.string().trim().min(1).max(200).optional(),
	body: z.string().max(200_000).optional(),
	shareable: z.boolean().optional(),
});
export const ResolveContextConflictBody = z.object({
	keep: z.enum(["local", "remote", "merged"]),
	/** Required for `merged`. */
	body: z.string().max(200_000).optional(),
});

export const ContextSearchQuery = z.object({
	q: z.string().trim().min(1).max(500),
	workspaceId: z.string().optional(),
	projectId: z.string().optional(),
	type: ContextType.optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
});
export const ContextSearchHit = z.object({
	context: Context.omit({ body: true }),
	/** Matched excerpt with `«` `»` around hits. */
	snippet: z.string(),
	rank: z.number(),
});
export type ContextSearchHit = z.infer<typeof ContextSearchHit>;

/** git projects: write shareable contexts to `.clmesh/` (working tree only, never committed by this call). */
export const ContextExportResult = z.object({
	written: z.array(z.string()),
	unchanged: z.array(z.string()),
	/** `.clmesh/` files deleted from the working tree because their context was unshared or deleted. */
	removed: z.array(z.string()).default([]),
	/** Refused by the secret scanner — nothing was written for these. */
	refused: z.array(z.object({ contextId: z.string(), path: z.string(), rule: z.string(), line: z.number().int() })),
});
export type ContextExportResult = z.infer<typeof ContextExportResult> & { status?: GitStatus };
/** git projects: read `.clmesh/` (e.g. after a pull) into contexts. */
export const ContextImportResult = z.object({
	created: z.array(z.string()),
	updated: z.array(z.string()),
	unchanged: z.array(z.string()),
	conflicts: z.array(z.string()),
	/** Files ignored (malformed front matter, secret hit, other workspace, private here). */
	skipped: z.array(z.object({ path: z.string(), reason: z.string() })).default([]),
});
export type ContextImportResult = z.infer<typeof ContextImportResult>;

export const WorkspaceMember = z.object({
	nodeId: z.string(),
	nodeName: z.string(),
	role: z.enum(["owner", "member"]),
	/** "self" for this node. */
	nodeStatus: z.enum(["self", "online", "degraded", "offline", "revoked"]),
	/** What this member may do in the workspace (subset of peer capabilities that apply to it). */
	permissions: z.array(z.string()),
	joinedAt: IsoDate.nullable(),
	revokedAt: IsoDate.nullable(),
});
export type WorkspaceMember = z.infer<typeof WorkspaceMember>;
export const AddWorkspaceMemberBody = z.object({ nodeId: z.string().min(1), permissions: z.array(z.string()).optional() });

/** Events on topic `contexts`. */
export type ContextTopicEvent =
	| { type: "context"; context: Context }
	| { type: "removed"; contextId: string }
	| { type: "members"; workspaceId: string; members: WorkspaceMember[] };
