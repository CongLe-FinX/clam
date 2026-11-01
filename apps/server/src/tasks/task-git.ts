import { type I18nMessage, i18nMsg } from "@clam/contracts";
import type { GitPushResult, GitStatus, RepositoryRef, TaskResult } from "@clam/contracts";
import type { GitEngine } from "@clam/git-engine";
import { compareUrl, normalizeRepoUrl, slugify, taskBranchName } from "@clam/task-engine";
import { errorText } from "../network/util.ts";
import type { GitService } from "../services/git-service.ts";
import type { ArtifactStore } from "./artifacts.ts";
import type { TaskRow } from "./store.ts";

/** The human can fix it and re-accept: tracked uncommitted changes, a merge/rebase in progress, not a git repository. */
export class TaskBlockedError extends Error {}
/** The task cannot proceed: base branch missing, checkout/commit/identity failure. */
export class TaskFailedError extends Error {}

export interface PreparedBranch {
	workBranch: string;
	baseBranch: string;
	/** `origin/<base>` */
	baseRef: string;
	originalBranch: string | null;
	originalSha: string | null;
}

export interface DeliveryResult {
	branch: string | null;
	commit: string | null;
	pushed: boolean;
	compareUrl: string | null;
	artifacts: TaskResult["artifacts"];
	changed: boolean;
	note: I18nMessage;
}

/** What restoring the human's own branch after delivery left to say (appended to the delivery note). */
type RestoreTail = { kind: "none" } | { kind: "dirty"; original: string } | { kind: "failed"; original: string; error: string };

function noChangesNote(tail: RestoreTail): I18nMessage {
	switch (tail.kind) {
		case "none":
			return i18nMsg("The agent made no changes.");
		case "dirty":
			return i18nMsg("The agent made no changes. The working tree still has uncommitted changes, so {original} was not checked out again.", { original: tail.original });
		case "failed":
			return i18nMsg("The agent made no changes. Could not check {original} out again: {error}", { original: tail.original, error: tail.error });
	}
}

function pushedNote(branch: string, tail: RestoreTail): I18nMessage {
	switch (tail.kind) {
		case "none":
			return i18nMsg("Pushed {branch}.", { branch });
		case "dirty":
			return i18nMsg("Pushed {branch}. The working tree still has uncommitted changes, so {original} was not checked out again.", { branch, original: tail.original });
		case "failed":
			return i18nMsg("Pushed {branch}. Could not check {original} out again: {error}", { branch, original: tail.original, error: tail.error });
	}
}

/** `patchError` is null when a patch of the commits was attached. */
function pushFailedNote(branch: string, pushError: string, patchError: string | null, tail: RestoreTail): I18nMessage {
	if (patchError === null) {
		switch (tail.kind) {
			case "none":
				return i18nMsg("Could not push {branch}: {error} The commits are on the local branch {branch}. A patch of the commits is attached.", { branch, error: pushError });
			case "dirty":
				return i18nMsg("Could not push {branch}: {error} The commits are on the local branch {branch}. A patch of the commits is attached. The working tree still has uncommitted changes, so {original} was not checked out again.", { branch, error: pushError, original: tail.original });
			case "failed":
				return i18nMsg("Could not push {branch}: {error} The commits are on the local branch {branch}. A patch of the commits is attached. Could not check {original} out again: {restoreError}", { branch, error: pushError, original: tail.original, restoreError: tail.error });
		}
	}
	switch (tail.kind) {
		case "none":
			return i18nMsg("Could not push {branch}: {error} The commits are on the local branch {branch}. No patch could be attached ({patchError}).", { branch, error: pushError, patchError });
		case "dirty":
			return i18nMsg("Could not push {branch}: {error} The commits are on the local branch {branch}. No patch could be attached ({patchError}). The working tree still has uncommitted changes, so {original} was not checked out again.", { branch, error: pushError, patchError, original: tail.original });
		case "failed":
			return i18nMsg("Could not push {branch}: {error} The commits are on the local branch {branch}. No patch could be attached ({patchError}). Could not check {original} out again: {restoreError}", { branch, error: pushError, patchError, original: tail.original, restoreError: tail.error });
	}
}

export type ProjectRef = { id: string; path: string; repository: RepositoryRef | null };

/** What the git steps need of the node: nothing task- or hub-specific, so other features (shared sessions) build their own. */
export interface TaskGitDeps {
	gitService: GitService;
	/** Engine access for `formatPatch`. */
	git: GitEngine;
	/** Where a patch of a refused push is stored. */
	artifacts: Pick<ArtifactStore, "add">;
	nodeName(): string;
	log: { warn(o: object, m?: string): void };
	/** Local fence (`FenceApi.assertOwner`): throws when this node no longer owns the task. Called right before the commit and before the push. */
	assertOwner?(taskId: string): void;
}

/** The fields of a task the git steps read; any work item with these (and its own `execState.prepared`) can use them. */
export type GitSubject = Pick<TaskRow, "id" | "title" | "repoBranch" | "executorAgentName" | "execState"> & { repoUrl: string | null };

const MAX_LISTED_PATHS = 5;

const stripRef = (name: string, prefix: string): string => (name.startsWith(prefix) ? name.slice(prefix.length) : name);

function storedPrepared(task: GitSubject): Partial<PreparedBranch> {
	const value = task.execState.prepared;
	if (typeof value !== "object" || value === null) return {};
	const v = value as Record<string, unknown>;
	const str = (key: string): string | undefined => (typeof v[key] === "string" ? (v[key] as string) : undefined);
	return {
		...(str("workBranch") && { workBranch: str("workBranch") }),
		...(str("baseBranch") && { baseBranch: str("baseBranch") }),
		...(str("baseRef") && { baseRef: str("baseRef") }),
		originalBranch: str("originalBranch") ?? null,
		originalSha: str("originalSha") ?? null,
	};
}

/**
 * The git side of executing a delegated task (`deliverAs = branch`): a dedicated task branch before the agent
 * starts, one commit + push (or a patch artifact when the push fails) afterwards. Everything goes through
 * `GitService`, which serializes per project and authenticates with the project's GitHub account; nothing here
 * ever forces a ref or touches a path that did not come from the arguments. `TaskExecutor` owns the lifecycle.
 */
export class TaskGit {
	constructor(private readonly deps: TaskGitDeps) {}

	private get gitService() {
		return this.deps.gitService;
	}

	/** Idempotent: when the tree already sits on the task branch (restart, re-run) nothing is changed. */
	async prepare(task: GitSubject, project: ProjectRef): Promise<PreparedBranch> {
		const status = await this.gitService.status(project.id);
		if (!status.isRepo) throw new TaskBlockedError("The project directory is not a git repository.");
		if (status.operation) {
			throw new TaskBlockedError(`A ${status.operation} is in progress in the project; finish or abort it, then accept the task again.`);
		}
		const workBranch = taskBranchName({ nodeName: this.deps.nodeName(), title: task.title, taskId: task.id });
		const stored = storedPrepared(task);

		if (status.branch === workBranch) {
			const baseBranch = stored.baseBranch ?? (await this.resolveBase(task, project)).baseBranch;
			return {
				workBranch,
				baseBranch,
				baseRef: stored.baseRef ?? `origin/${baseBranch}`,
				originalBranch: stored.originalBranch ?? null,
				originalSha: stored.originalSha ?? null,
			};
		}

		const tracked = status.files.filter((f) => f.kind !== "untracked");
		if (tracked.length > 0) {
			const listed = tracked.slice(0, MAX_LISTED_PATHS).map((f) => f.path);
			const more = tracked.length > listed.length ? ` and ${tracked.length - listed.length} more` : "";
			throw new TaskBlockedError(`The project has uncommitted changes to tracked files (${listed.join(", ")}${more}). Commit, stash or discard them, then accept the task again.`);
		}

		try {
			await this.gitService.fetch(project.id);
		} catch (err) {
			throw new TaskFailedError(`could not fetch origin: ${errorText(err)}`);
		}

		const { baseBranch, remoteShas, localNames } = await this.resolveBase(task, project);
		const baseRef = `origin/${baseBranch}`;
		const baseSha = remoteShas.get(baseRef);
		if (!baseSha) throw new TaskFailedError(`base branch ${baseBranch} not found on origin`);

		try {
			if (localNames.has(workBranch)) await this.gitService.checkout(project.id, workBranch);
			// From the commit, not from `origin/<base>`: a branch started from a remote-tracking ref tracks it, and the
			// engine's push would then publish the task commit onto the base branch itself.
			else await this.gitService.createBranch(project.id, { name: workBranch, from: baseSha, checkout: true });
		} catch (err) {
			throw new TaskFailedError(`could not check out ${workBranch}: ${errorText(err)}`);
		}
		return { workBranch, baseBranch, baseRef, originalBranch: status.branch, originalSha: status.headSha };
	}

	async deliver(task: GitSubject, project: ProjectRef, prepared: PreparedBranch, o: { sessionId: string | null }): Promise<DeliveryResult> {
		const { workBranch, baseRef } = prepared;
		this.deps.assertOwner?.(task.id);
		let status = await this.gitService.status(project.id);
		if (status.branch !== workBranch) {
			try {
				status = await this.gitService.checkout(project.id, workBranch);
			} catch (err) {
				throw new TaskFailedError(`could not return to the task branch ${workBranch} (${errorText(err)}); the work stays where it is (currently ${status.branch ?? "a detached HEAD"}).`);
			}
		}
		if (status.upstream !== null && status.upstream !== `origin/${workBranch}`) {
			throw new TaskFailedError(`refusing to push: ${workBranch} tracks ${status.upstream}, so a push would update that branch instead of ${workBranch}. The work stays on ${workBranch}.`);
		}

		// A staged rename carries its old path, which `git add` cannot address any more; as delete + add both paths can be committed.
		const renamed = status.files.flatMap((f) => (f.origPath ? [f.path, f.origPath] : []));
		if (renamed.length > 0) status = await this.gitService.unstage(project.id, renamed);
		const changed = status.files.length > 0;
		if (changed) {
			this.deps.assertOwner?.(task.id);
			const paths = status.files.map((f) => f.path);
			const agent = `${task.executorAgentName ?? "agent"}@${this.deps.nodeName()}`;
			try {
				const committed = await this.gitService.commit(
					project.id,
					{ message: task.title, paths, ...(o.sessionId && { sessionId: o.sessionId }) },
					{ Task: task.id, ...(!o.sessionId && { Agent: agent }) },
				);
				status = committed.status;
			} catch (err) {
				throw new TaskFailedError(`cannot commit the agent's changes: ${errorText(err)} The changes are still in the working tree on ${workBranch}.`);
			}
		}

		const { dir } = await this.gitService.resolve(project.id);
		// A failure to count (patch over the size cap) must not hide commits the agent made itself, so assume there are some.
		const commits = await this.deps.git.formatPatch(dir, { base: baseRef }).then(
			(r) => r.commits,
			() => (changed ? 1 : null),
		);
		if (commits === 0 && !changed) {
			const restored = await this.restore(project, prepared, status);
			return { branch: null, commit: null, pushed: false, compareUrl: null, artifacts: [], changed: false, note: noChangesNote(restored) };
		}

		let pushed: GitPushResult | null = null;
		this.deps.assertOwner?.(task.id);
		let pushError = "";
		try {
			pushed = await this.gitService.push(project.id, { setUpstream: true });
			status = pushed.status;
		} catch (err) {
			pushError = errorText(err, 500);
			this.deps.log.warn({ taskId: task.id, projectId: project.id }, "task branch push failed; attaching a patch");
		}

		let result: Omit<DeliveryResult, "note">;
		let patchError: string | null = null;
		if (pushed) {
			const repo = task.repoUrl === null ? null : normalizeRepoUrl(task.repoUrl);
			result = {
				branch: workBranch,
				commit: status.headSha,
				pushed: true,
				compareUrl: repo ? compareUrl(repo, prepared.baseBranch, workBranch) : null,
				artifacts: [],
				changed,
			};
		} else {
			const attached = await this.attachPatch(task, dir, baseRef);
			patchError = attached.error;
			result = {
				branch: workBranch,
				commit: status.headSha,
				pushed: false,
				compareUrl: null,
				artifacts: attached.artifacts,
				changed,
			};
		}
		const tail = await this.restore(project, prepared, status);
		return { ...result, note: pushed ? pushedNote(workBranch, tail) : pushFailedNote(workBranch, pushError, patchError, tail) };
	}

	/** Never modifies anything. */
	async describeLeftovers(_task: GitSubject, project: ProjectRef, prepared: PreparedBranch | null): Promise<{ branch: string | null; dirty: boolean; note: string }> {
		let status: GitStatus;
		try {
			status = await this.gitService.status(project.id);
		} catch (err) {
			return { branch: prepared?.workBranch ?? null, dirty: false, note: `Could not inspect the project: ${errorText(err)}` };
		}
		const dirty = status.files.length > 0;
		const where = status.branch ?? "a detached HEAD";
		if (!prepared) {
			return { branch: status.branch, dirty, note: dirty ? `The project has ${status.files.length} uncommitted file(s) on ${where}; nothing was committed or pushed.` : `The project is clean on ${where}.` };
		}
		if (dirty) {
			return { branch: status.branch, dirty, note: `Work left on branch ${where} with ${status.files.length} uncommitted file(s); nothing was committed or pushed.` };
		}
		return { branch: status.branch, dirty, note: `No uncommitted changes; the project is on ${where} (task branch ${prepared.workBranch}).` };
	}

	/** The base is the task's branch, else the repository default, else main/master; `remoteShas` maps `origin/<x>` to its commit. */
	private async resolveBase(task: GitSubject, project: ProjectRef): Promise<{ baseBranch: string; remoteShas: Map<string, string>; localNames: Set<string> }> {
		const branches = await this.gitService.branches(project.id);
		const remoteShas = new Map(branches.filter((b) => b.remote).map((b) => [stripRef(b.name, "refs/remotes/"), b.headSha] as const));
		const localNames = new Set(branches.filter((b) => !b.remote).map((b) => stripRef(b.name, "refs/heads/")));
		const baseBranch = task.repoBranch ?? project.repository?.defaultBranch ?? (remoteShas.has("origin/main") ? "main" : "master");
		return { baseBranch, remoteShas, localNames };
	}

	private async attachPatch(task: GitSubject, dir: string, baseRef: string): Promise<{ artifacts: TaskResult["artifacts"]; error: string | null }> {
		try {
			const { patch } = await this.deps.git.formatPatch(dir, { base: baseRef });
			const row = await this.deps.artifacts.add(task.id, { name: `${slugify(task.title)}.patch`, mediaType: "text/x-patch", bytes: patch });
			return { artifacts: [{ artifactId: row.id, name: row.name, sha256: row.sha256, size: row.size }], error: null };
		} catch (err) {
			return { artifacts: [], error: errorText(err) };
		}
	}

	/** Back to the branch the human was on, but only on a clean tree. What is left to say about it. */
	private async restore(project: ProjectRef, prepared: PreparedBranch, status: GitStatus): Promise<RestoreTail> {
		const original = prepared.originalBranch;
		if (!original || status.branch === original) return { kind: "none" };
		if (status.files.length > 0) return { kind: "dirty", original };
		try {
			await this.gitService.checkout(project.id, original);
			return { kind: "none" };
		} catch (err) {
			return { kind: "failed", original, error: errorText(err) };
		}
	}
}
