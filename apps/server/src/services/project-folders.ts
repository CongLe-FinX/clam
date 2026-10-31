import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { projects, workspaces } from "@clam/database";
import { asc, eq } from "drizzle-orm";
import type { ServerContext } from "../context.ts";
import { ApiError } from "../http/errors.ts";
import { newId } from "./ids.ts";

export type ProjectRow = typeof projects.$inferSelect;

/**
 * Whether a project folder is a git working tree, derived live (never stored): a `.git` entry (directory, or file for a
 * worktree) at the folder's own root. A folder merely nested inside someone else's repository is a plain folder here,
 * exactly like the git engine, which only works on a repository root.
 */
export function projectVcs(dir: string): "git" | "none" {
	return existsSync(path.join(dir, ".git")) ? "git" : "none";
}

/** `<dataDir>/projects`: where CL Agent Mesh creates folders for projects the user gave no path (and for executed tasks / joined shared sessions without a repository). */
export function managedRoot(ctx: Pick<ServerContext, "config">): string {
	return path.resolve(ctx.config.dataDir, "projects");
}

/** True when `dir` is strictly inside the managed root (the only place `deleteManagedFolder` will ever delete). */
export function isInsideManagedRoot(ctx: Pick<ServerContext, "config">, dir: string): boolean {
	// The stored path is a realpath, the data dir may be spelled through a symlink (macOS /var → /private/var): accept either spelling of the root.
	let real = managedRoot(ctx);
	try {
		real = realpathSync(real);
	} catch {
		// the root does not exist yet: nothing can be inside it
	}
	return [managedRoot(ctx), real].some((root) => {
		const rel = path.relative(root, dir);
		return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
	});
}

/** Create an empty managed folder and its project row (`managed = true`). `origin` is `chat` for the working folder of a chat that has no project. */
export function createManagedProject(ctx: ServerContext, input: { workspaceId: string; name: string; origin?: "user" | "chat" }): ProjectRow {
	const id = newId("prj");
	const target = path.join(managedRoot(ctx), id);
	mkdirSync(target, { recursive: true });
	const dir = realpathSync(target);
	ctx.db.insert(projects).values({ id, workspaceId: input.workspaceId, name: input.name, path: dir, managed: true, origin: input.origin ?? "user" }).run();
	return ctx.db.select().from(projects).where(eq(projects.id, id)).get() as ProjectRow;
}

const CHAT_NAME_MAX = 80;

/**
 * The working folder of a chat started without a project: a managed folder of origin `chat` in `workspaceId` (default: the
 * node's first workspace; a workspace is created when the node has none yet).
 */
export function createChatProject(ctx: ServerContext, input: { workspaceId?: string | undefined; title?: string | undefined }): ProjectRow {
	const workspaceId = input.workspaceId ?? defaultWorkspaceId(ctx);
	if (!ctx.db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).get()) throw ApiError.notFound("Workspace");
	const stamp = new Date().toISOString().slice(0, 10);
	const name = (input.title?.trim() || `Chat · ${stamp}`).slice(0, CHAT_NAME_MAX);
	return createManagedProject(ctx, { workspaceId, name, origin: "chat" });
}

/** The oldest workspace of the node; creates a default one when there is none (a fresh node that was never given a workspace). */
export function defaultWorkspaceId(ctx: ServerContext): string {
	const first = ctx.db.select({ id: workspaces.id }).from(workspaces).orderBy(asc(workspaces.createdAt), asc(workspaces.id)).get();
	if (first) return first.id;
	const id = newId("ws");
	ctx.db.insert(workspaces).values({ id, name: "Default", ownerNodeId: ctx.identity.nodeId }).run();
	return id;
}

/** Remove the folder of a managed project. Refuses anything outside the managed root and anything not marked managed. */
export async function deleteManagedFolder(ctx: ServerContext, row: Pick<ProjectRow, "path" | "managed">): Promise<boolean> {
	if (!row.managed || !isInsideManagedRoot(ctx, path.resolve(row.path))) return false;
	await rm(row.path, { recursive: true, force: true, maxRetries: 3 });
	return true;
}
