import {
	type ClmeshInitResult,
	type GitCommit,
	type GitPullResult,
	type GitPushResult,
	type GitStatus,
	routes,
} from "@clam/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { msg, t, tr, type Msg } from "@/i18n";
import { ApiError, api, errorText } from "@/lib/api";
import { applyStatus, gk } from "./hooks.ts";
import { type BusyOp, useGitUi } from "./store.ts";

/**
 * Imperative git operations shared by the Git panel and the command palette. Each one reports through a toast and, when the
 * outcome needs explaining (refusals, remote rejections), a persistent notice in the Git panel. Nothing here forces anything.
 */

const ui = () => useGitUi.getState();

async function run<T>(projectId: string, op: BusyOp, fn: () => Promise<T>): Promise<T | undefined> {
	if (ui().busy[projectId]) {
		toast.info(t("Another git operation is still running for this project"));
		return undefined;
	}
	ui().setBusy(projectId, op);
	try {
		return await fn();
	} finally {
		ui().setBusy(projectId, null);
		ui().setOperation(projectId, null);
	}
}

function fail(projectId: string, title: string, e: unknown, extra?: { body?: string; next?: string }): void {
	const detail = errorText(e);
	toast.error(title, { description: detail.length > 160 ? `${detail.slice(0, 157)}…` : detail });
	ui().setNotice(projectId, { tone: "error", title, body: extra?.body, detail, next: extra?.next });
}

const authNext = () => t("Check the account in Settings → GitHub Accounts (re-verify or reconnect it), then try again.");

function networkHint(e: unknown): { body?: string; next?: string } {
	if (e instanceof ApiError) {
		if (/auth|credential|401|403|denied|SSO/i.test(`${e.code} ${e.message}`)) return { next: authNext() };
		if (e.code === "network" || /network|resolve|connect|timed? ?out/i.test(`${e.code} ${e.message}`)) return { next: t("Check your connection and try again.") };
	}
	return {};
}

// ───────────────────────── fetch / pull / push ─────────────────────────

export async function runFetch(qc: QueryClient, projectId: string): Promise<GitStatus | undefined> {
	return run(projectId, "fetch", async () => {
		try {
			const status = await api.post<GitStatus>(routes.gitFetch(projectId));
			applyStatus(qc, projectId, status);
			ui().setNotice(projectId, null);
			toast.success(t("Fetched from origin"), {
				description: status.behind > 0 ? t("{count, plural, one {# new commit} other {# new commits}} on {upstream}", { count: status.behind, upstream: status.upstream ?? t("upstream") }) : t("No new commits upstream"),
			});
			return status;
		} catch (e) {
			fail(projectId, t("Fetch failed"), e, networkHint(e));
			return undefined;
		}
	});
}

const pullReasons: Record<NonNullable<GitPullResult["reason"]>, { body: Msg; next: Msg }> = {
	"dirty-overlap": {
		body: msg("Pull refused: these files have uncommitted local changes that the incoming commits also modify. Nothing in your working tree was changed."),
		next: msg("Commit your changes, or discard those files, then pull again."),
	},
	diverged: {
		body: msg("Pull refused: your branch and its upstream have both moved on, and a pull here is fast-forward only. Nothing was changed."),
		next: msg("Merge or rebase upstream into your branch yourself, or push this work to a new branch and open a pull request."),
	},
	"no-upstream": {
		body: msg("This branch does not track a remote branch, so there is nothing to pull."),
		next: msg("Push the branch first to publish it and set its upstream."),
	},
	"operation-in-progress": {
		body: msg("A merge, rebase, cherry-pick or revert is in progress in this repository."),
		next: msg("Finish or abort that operation first, then pull."),
	},
	detached: {
		body: msg("HEAD is detached, so there is no branch to update."),
		next: msg("Check out a branch, then pull."),
	},
};

/** The server answers a refused pull / rejected push with an error whose `details` is the full result; unwrap it. */
function resultFromError<T>(e: unknown, code: string): T | null {
	return e instanceof ApiError && e.code === code && e.details && typeof e.details === "object" ? (e.details as T) : null;
}

function reportPull(qc: QueryClient, projectId: string, r: GitPullResult): void {
	applyStatus(qc, projectId, r.status);
	void qc.invalidateQueries({ queryKey: gk.diffRoot(projectId) });
	if (r.result === "refused" && r.reason) {
		const why = pullReasons[r.reason];
		toast.warning(t("Pull refused"), { description: r.paths.length ? t("{count, plural, one {# local file blocks} other {# local files block}} the pull.", { count: r.paths.length }) : tr(why.body) });
		ui().setNotice(projectId, { tone: "warning", title: t("Pull refused"), body: tr(why.body), paths: r.paths, detail: r.message || undefined, next: tr(why.next) });
	} else if (r.result === "up-to-date") {
		ui().setNotice(projectId, null);
		toast.success(t("Already up to date"));
	} else {
		ui().setNotice(projectId, null);
		toast.success(t("Pulled"), { description: r.message || t("Fast-forwarded to {sha}", { sha: r.status.headSha?.slice(0, 7) ?? t("latest") }) });
	}
}

export async function runPull(qc: QueryClient, projectId: string): Promise<GitPullResult | undefined> {
	return run(projectId, "pull", async () => {
		try {
			const r = await api.post<GitPullResult>(routes.gitPull(projectId));
			reportPull(qc, projectId, r);
			return r;
		} catch (e) {
			const refused = resultFromError<GitPullResult>(e, "git_pull_refused");
			if (refused) {
				reportPull(qc, projectId, refused);
				return refused;
			}
			fail(projectId, t("Pull failed"), e, networkHint(e));
			return undefined;
		}
	});
}

const pushReasons: Record<NonNullable<GitPushResult["reason"]>, { body: Msg; next: Msg }> = {
	"non-fast-forward": {
		body: msg("The remote branch has commits you don't have, so the push was rejected. CL Agent Mesh never force-pushes."),
		next: msg("Pull first (fast-forward only), or push this work to a new branch and open a pull request."),
	},
	"protected-branch": {
		body: msg("The remote refused the push because this branch is protected."),
		next: msg("Create a new branch from your commits, push it, and open a pull request instead."),
	},
	permission: {
		body: msg("Your GitHub account does not have permission to push to this repository."),
		next: msg("Ask for write access, push to a fork, or switch the project to an account that has access (Settings → GitHub Accounts)."),
	},
	sso: {
		body: msg("The organization requires SAML SSO authorization for this token."),
		next: msg("Authorize the token for the organization on GitHub (Settings → Developer settings → Tokens → Configure SSO), then retry."),
	},
	auth: {
		body: msg("GitHub rejected the stored credentials."),
		next: msg("Check the account in Settings → GitHub Accounts (re-verify or reconnect it), then try again."),
	},
	other: {
		body: msg("The push was rejected by the remote."),
		next: msg("Read the remote's message below for the exact reason."),
	},
};

function reportPush(qc: QueryClient, projectId: string, r: GitPushResult, quiet?: boolean): void {
	applyStatus(qc, projectId, r.status);
	if (r.result === "rejected" && r.reason) {
		const why = pushReasons[r.reason];
		toast.error(t("Push rejected"), { description: tr(why.body) });
		ui().setNotice(projectId, { tone: "error", title: t("Push rejected"), body: tr(why.body), detail: r.message || undefined, next: tr(why.next) });
		return;
	}
	ui().setNotice(projectId, null);
	if (quiet) return;
	if (r.result === "up-to-date") toast.success(t("Everything is already pushed"));
	else toast.success(t("Pushed {branch}", { branch: r.status.branch ?? t("branch") }), { description: r.status.upstream ? t("Tracking {upstream}", { upstream: r.status.upstream }) : undefined });
}

export async function runPush(qc: QueryClient, projectId: string, opts: { setUpstream?: boolean; quiet?: boolean } = {}): Promise<GitPushResult | undefined> {
	const exec = async (): Promise<GitPushResult | undefined> => {
		try {
			const r = await api.post<GitPushResult>(routes.gitPush(projectId), { setUpstream: opts.setUpstream ?? true });
			reportPush(qc, projectId, r, opts.quiet);
			return r;
		} catch (e) {
			const rejected = resultFromError<GitPushResult>(e, "git_push_rejected");
			if (rejected) {
				reportPush(qc, projectId, rejected, opts.quiet);
				return rejected;
			}
			fail(projectId, t("Push failed"), e, networkHint(e));
			return undefined;
		}
	};
	// Callers that already hold the busy flag (commit & push, push & create PR) pass through.
	if (ui().busy[projectId]) return exec();
	return run(projectId, "push", exec);
}

// ───────────────────────── stage / unstage / discard ─────────────────────────

function optimistic(prev: GitStatus, paths: readonly string[], stage: boolean): GitStatus {
	const set = new Set(paths);
	return {
		...prev,
		files: prev.files.map((f) => {
			if (!set.has(f.path) || f.kind === "conflicted") return f;
			return stage
				? { ...f, staged: true, unstaged: false, kind: f.kind === "untracked" ? "added" : f.kind }
				: { ...f, staged: false, unstaged: true, kind: f.kind === "added" ? "untracked" : f.kind };
		}),
	};
}

/** Optimistic: the list updates immediately; a failed request rolls back to the previous status. */
export async function setStaged(qc: QueryClient, projectId: string, paths: string[], stage: boolean): Promise<void> {
	if (paths.length === 0) return;
	const key = gk.status(projectId);
	await qc.cancelQueries({ queryKey: key });
	const prev = qc.getQueryData<GitStatus>(key);
	if (prev) qc.setQueryData(key, optimistic(prev, paths, stage));
	try {
		const next = await api.post<GitStatus>(stage ? routes.gitStage(projectId) : routes.gitUnstage(projectId), { paths });
		applyStatus(qc, projectId, next);
		// The optimistic status already matched `next`, so applyStatus saw no change: refresh the diffs explicitly.
		void qc.invalidateQueries({ queryKey: gk.diffRoot(projectId) });
	} catch (e) {
		if (prev) qc.setQueryData(key, prev);
		void qc.invalidateQueries({ queryKey: key });
		toast.error(stage ? t("Could not stage") : t("Could not unstage"), { description: errorText(e) });
	}
}

export async function discardPaths(qc: QueryClient, projectId: string, paths: string[]): Promise<boolean> {
	try {
		const next = await api.post<GitStatus>(routes.gitDiscard(projectId), { paths, confirm: true });
		applyStatus(qc, projectId, next);
		toast.success(paths.length === 1 ? t("Changes discarded") : t("Discarded changes in {count} files", { count: paths.length }));
		return true;
	} catch (e) {
		toast.error(t("Could not discard"), { description: errorText(e) });
		void qc.invalidateQueries({ queryKey: gk.status(projectId) });
		return false;
	}
}

// ───────────────────────── commit ─────────────────────────

export async function commitStaged(
	qc: QueryClient,
	projectId: string,
	opts: { message: string; sessionId?: string; push?: boolean },
): Promise<boolean> {
	const ok = await run(projectId, opts.push ? "commit-push" : "commit", async () => {
		let commit: GitCommit;
		try {
			const r = await api.post<{ commit: GitCommit; status: GitStatus }>(routes.gitCommit(projectId), { message: opts.message, sessionId: opts.sessionId });
			commit = r.commit;
			applyStatus(qc, projectId, r.status);
			ui().setDraft(projectId, "");
			ui().setNotice(projectId, null);
		} catch (e) {
			fail(
				projectId,
				t("Commit failed"),
				e,
				e instanceof ApiError && e.code === "no_git_identity" ? { next: t("Set the commit identity with the pencil icon under the commit box, then commit again.") } : undefined,
			);
			return false;
		}
		toast.success(t("Committed {sha}", { sha: commit.shortSha }), { description: commit.subject });
		if (opts.push) {
			const pushed = await runPush(qc, projectId, { setUpstream: true });
			return pushed?.result !== "rejected" && pushed !== undefined;
		}
		return true;
	});
	return ok === true;
}

// ───────────────────────── branches ─────────────────────────

const overwriteRe = /overwritten|would be lost|local changes|dirty|uncommitted|would_overwrite/i;

export async function checkoutBranch(qc: QueryClient, projectId: string, branch: string): Promise<boolean> {
	const ok = await run(projectId, "checkout", async () => {
		try {
			const status = await api.post<GitStatus>(routes.gitCheckout(projectId), { branch });
			applyStatus(qc, projectId, status);
			ui().setNotice(projectId, null);
			toast.success(t("Switched to {branch}", { branch: status.branch ?? branch }));
			return true;
		} catch (e) {
			const detail = errorText(e);
			const refused = overwriteRe.test(`${e instanceof ApiError ? e.code : ""} ${detail}`);
			toast.error(t("Could not switch branch"), { description: refused ? t("Your local changes would be overwritten.") : detail });
			ui().setNotice(projectId, {
				tone: "error",
				title: t("Could not switch to {branch}", { branch }),
				body: refused ? t("Switching was refused because it would overwrite your uncommitted changes. Nothing was changed — CL Agent Mesh never forces a checkout.") : undefined,
				detail,
				next: refused ? t("Commit or discard the conflicting changes, then switch again.") : undefined,
			});
			return false;
		}
	});
	return ok === true;
}

export async function createBranch(qc: QueryClient, projectId: string, name: string, from?: string): Promise<boolean> {
	const ok = await run(projectId, "branch", async () => {
		try {
			const status = await api.post<GitStatus>(routes.gitBranches(projectId), { name, from, checkout: true });
			applyStatus(qc, projectId, status);
			ui().setNotice(projectId, null);
			toast.success(t("Created and switched to {name}", { name }));
			return true;
		} catch (e) {
			fail(projectId, t("Could not create branch “{name}”", { name }), e);
			return false;
		}
	});
	return ok === true;
}

// ───────────────────────── .clmesh ─────────────────────────

export async function initClmesh(qc: QueryClient, projectId: string): Promise<ClmeshInitResult | undefined> {
	return run(projectId, "clmesh", async () => {
		try {
			const r = await api.post<ClmeshInitResult>(routes.clmeshInit(projectId));
			applyStatus(qc, projectId, r.status);
			toast.success(r.written.length ? t("{count, plural, one {Wrote # file} other {Wrote # files}} to .clmesh/", { count: r.written.length }) : t(".clmesh/ already exists"), {
				description: r.written.length ? t("Review them in Changes, then commit.") : t("{count, plural, one {# existing file} other {# existing files}} left untouched.", { count: r.skipped.length }),
			});
			return r;
		} catch (e) {
			fail(projectId, t("Could not initialize .clmesh"), e);
			return undefined;
		}
	});
}
