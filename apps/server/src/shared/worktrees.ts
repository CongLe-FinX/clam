import { statSync } from "node:fs";
import path from "node:path";
import { checkoutIdOf, i18nMsg } from "@clam/contracts";
import { projects, sharedSessions } from "@clam/database";
import { eq } from "drizzle-orm";
import type { ServerContext } from "../context.ts";
import { ApiError } from "../http/errors.ts";

type SharedRow = typeof sharedSessions.$inferSelect;
type WorktreeCtx = Pick<ServerContext, "config" | "gitService" | "db" | "log">;

/** Where this node keeps the working tree of a shared session. */
export function worktreeDir(ctx: Pick<ServerContext, "config">, sharedId: string): string {
	return path.join(ctx.config.dataDir, "worktrees", sharedId);
}

/** This node has a worktree for the shared session: the directory exists and holds a linked worktree's `.git` file. */
export function hasWorktree(ctx: Pick<ServerContext, "config">, sharedId: string): boolean {
	try {
		return statSync(path.join(worktreeDir(ctx, sharedId), ".git")).isFile();
	} catch {
		return false;
	}
}

/** A git-mode shared session this node drives: the one whose agent session works in the worktree. */
export function drivesGitShare(shared: Pick<SharedRow, "vcs" | "localRole" | "state" | "branch" | "localProjectId">): boolean {
	return shared.vcs !== "files" && shared.localRole === "driver" && shared.state === "active" && shared.branch !== null && shared.localProjectId !== null;
}

const branchCheckedOut = (branch: string) =>
	new ApiError(
		409,
		"shared_branch_checked_out",
		i18nMsg("The shared branch {branch} is checked out in the project folder. Switch the project folder to another branch, then try again.", { branch }),
		{ branch },
	);

function isBranchInWorktree(error: unknown): boolean {
	const details = error instanceof ApiError ? error.details : undefined;
	return typeof details === "object" && details !== null && "gitCode" in details && details.gitCode === "branch_in_worktree";
}

/**
 * Creates the worktree of a shared session on `shared.branch`: an existing local branch is attached as it is, a branch that only
 * exists on origin is created tracking it, a missing one is created from `startPoint`. The project's own checkout is never touched.
 * A branch the project folder itself has checked out is a 409 `shared_branch_checked_out`.
 */
export async function createWorktree(ctx: WorktreeCtx, shared: { id: string; branch: string; projectId: string }, o: { startPoint?: string } = {}): Promise<string> {
	const { gitService } = ctx;
	const dir = worktreeDir(ctx, shared.id);
	const branches = await gitService.branches(shared.projectId);
	const names = new Set(branches.filter((b) => !b.remote).map((b) => b.name.replace(/^refs\/heads\//, "")));
	const remote = branches.find((b) => b.remote && (b.name === `origin/${shared.branch}` || b.name === `refs/remotes/origin/${shared.branch}`));
	try {
		if (names.has(shared.branch)) await gitService.addWorktree(shared.projectId, { path: dir, branch: shared.branch });
		else if (remote) await gitService.addWorktree(shared.projectId, { path: dir, branch: shared.branch, newBranch: true, startPoint: `origin/${shared.branch}`, track: true });
		else if (o.startPoint) await gitService.addWorktree(shared.projectId, { path: dir, branch: shared.branch, newBranch: true, startPoint: o.startPoint });
		else throw ApiError.notFound(`Branch ${shared.branch}`);
	} catch (error) {
		if (isBranchInWorktree(error)) throw branchCheckedOut(shared.branch);
		throw error;
	}
	return dir;
}

/**
 * Removes the worktree without force: a dirty or locked one stays (and is logged). The branch is never deleted. Returns whether it is
 * gone. `projectId` names the repository when the shared-session row does not exist (yet).
 */
export async function removeWorktree(ctx: WorktreeCtx, sharedId: string, projectId?: string): Promise<boolean> {
	const dir = worktreeDir(ctx, sharedId);
	const owner = projectId ?? ctx.db.select({ projectId: sharedSessions.localProjectId }).from(sharedSessions).where(eq(sharedSessions.id, sharedId)).get()?.projectId;
	if (!hasWorktree(ctx, sharedId)) {
		if (owner) await ctx.gitService.pruneWorktrees(owner).catch(() => undefined);
		return true;
	}
	if (!owner) {
		ctx.log.warn({ sharedId, dir }, "the project of a shared session is gone; its worktree was left in place");
		return false;
	}
	try {
		await ctx.gitService.removeWorktree(owner, dir);
		return true;
	} catch (error) {
		ctx.log.warn({ err: error instanceof Error ? error.message : String(error), sharedId, dir }, "could not remove the worktree of a shared session; it was kept");
		return false;
	}
}

export interface SharedCheckout {
	checkoutId: string;
	dir: string;
	/** False only for a legacy share whose branch the project folder itself still has checked out: it keeps working there. */
	worktree: boolean;
}

const migrations = new Map<string, Promise<SharedCheckout>>();

/**
 * The folder this node works in for a git-mode shared session it drives. A share made before worktrees existed has none yet: it
 * is created here, on demand (existing local branch attached; refused when the project folder holds the branch, in which case
 * that folder is used as it was). Concurrent callers share one creation.
 */
export function ensureSharedCheckout(ctx: WorktreeCtx, shared: SharedRow): Promise<SharedCheckout> {
	const projectId = shared.localProjectId as string;
	if (hasWorktree(ctx, shared.id)) return Promise.resolve({ checkoutId: checkoutIdOf(projectId, shared.id), dir: worktreeDir(ctx, shared.id), worktree: true });
	const running = migrations.get(shared.id);
	if (running) return running;
	const created = createDriverWorktree(ctx, shared).finally(() => migrations.delete(shared.id));
	migrations.set(shared.id, created);
	return created;
}

async function createDriverWorktree(ctx: WorktreeCtx, shared: SharedRow): Promise<SharedCheckout> {
	const projectId = shared.localProjectId as string;
	try {
		const dir = await createWorktree(ctx, { id: shared.id, branch: shared.branch as string, projectId });
		return { checkoutId: checkoutIdOf(projectId, shared.id), dir, worktree: true };
	} catch (error) {
		const project = ctx.db.select().from(projects).where(eq(projects.id, projectId)).get();
		if (project && error instanceof ApiError && error.code === "shared_branch_checked_out") return { checkoutId: projectId, dir: project.path, worktree: false };
		throw error;
	}
}
