import { realpath, stat } from "node:fs/promises";
import { checkoutIdOf, i18nMsg, parseCheckoutId } from "@clam/contracts";
import { projects, sharedSessions } from "@clam/database";
import { eq } from "drizzle-orm";
import type { ServerContext } from "../context.ts";
import { ApiError } from "../http/errors.ts";
import { hasWorktree, worktreeDir } from "../shared/worktrees.ts";

export type ProjectRow = typeof projects.$inferSelect;

export interface Checkout {
	/** The project the folder belongs to: authentication, identity, repository link. */
	row: ProjectRow;
	/** Canonical working directory: the project's folder, or the shared session's worktree. */
	dir: string;
	/** The shared session whose worktree this is; null for the project's own folder. */
	sharedId: string | null;
	/** `<projectId>` or `<projectId>~<sharedId>`. */
	id: string;
}

/** Row lookup and the (not yet verified) directory of a checkout id; `null` when the project does not exist. Used by watchers that cannot await. */
export function locateCheckout(ctx: Pick<ServerContext, "db" | "config">, id: string): { row: ProjectRow; dir: string; sharedId: string | null } | null {
	const { projectId, sharedSessionId: sharedId } = parseCheckoutId(id);
	const row = ctx.db.select().from(projects).where(eq(projects.id, projectId)).get();
	if (!row) return null;
	if (!sharedId) return { row, dir: row.path, sharedId: null };
	return hasWorktree(ctx, sharedId) ? { row, dir: worktreeDir(ctx, sharedId), sharedId } : null;
}

/**
 * The ONE place a checkout id becomes a directory. A bare project id is the project's folder; `<projectId>~<sharedId>` is the
 * worktree of a git-mode shared session of that project that exists on this node. Client paths are never accepted.
 * 404 `Project` / `Shared session`, 409 `checkout_not_available` (not a git share of this project, or no worktree on this node),
 * 409 `project_dir_missing` / `project_dir_moved` for the project folder.
 */
export async function resolveCheckout(ctx: Pick<ServerContext, "db" | "config">, id: string): Promise<Checkout> {
	const { projectId, sharedSessionId: sharedId } = parseCheckoutId(id);
	const row = ctx.db.select().from(projects).where(eq(projects.id, projectId)).get();
	if (!row) throw ApiError.notFound("Project");
	if (sharedId === null) {
		let real: string;
		try {
			real = await realpath(row.path);
			if (!(await stat(real)).isDirectory()) throw new Error("not a directory");
		} catch {
			throw new ApiError(409, "project_dir_missing", i18nMsg("The project directory no longer exists: {path}", { path: row.path }));
		}
		if (real !== row.path) {
			throw new ApiError(409, "project_dir_moved", i18nMsg("The project directory resolves elsewhere now ({path}); re-add the project at its new location.", { path: real }));
		}
		return { row, dir: row.path, sharedId: null, id: projectId };
	}
	const shared = ctx.db.select().from(sharedSessions).where(eq(sharedSessions.id, sharedId)).get();
	if (!shared) throw ApiError.notFound("Shared session");
	if (shared.localProjectId !== projectId || shared.vcs === "files") {
		throw new ApiError(409, "checkout_not_available", i18nMsg("That shared session does not work in this project's repository."), { sharedSessionId: sharedId });
	}
	if (!hasWorktree(ctx, sharedId)) {
		throw new ApiError(409, "checkout_not_available", i18nMsg("This node has no working tree for that shared session."), { sharedSessionId: sharedId });
	}
	const dir = await realpath(worktreeDir(ctx, sharedId)).catch(() => {
		throw new ApiError(409, "checkout_not_available", i18nMsg("This node has no working tree for that shared session."), { sharedSessionId: sharedId });
	});
	return { row, dir, sharedId, id: checkoutIdOf(projectId, sharedId) };
}

/**
 * The folder behind a checkout id for the file routes. The project's own folder is returned as stored (the file helpers report a missing
 * folder themselves); a shared session's worktree must exist (see `resolveCheckout`).
 */
export async function checkoutFolder(ctx: Pick<ServerContext, "db" | "config">, id: string): Promise<string> {
	const { projectId, sharedSessionId: sharedId } = parseCheckoutId(id);
	if (sharedId === null) {
		const row = ctx.db.select({ path: projects.path }).from(projects).where(eq(projects.id, projectId)).get();
		if (!row) throw ApiError.notFound("Project");
		return row.path;
	}
	return (await resolveCheckout(ctx, id)).dir;
}
