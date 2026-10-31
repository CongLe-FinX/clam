import {
	type GitBranch,
	type GitConflictReport,
	type GitDiff,
	type GitIdentity,
	type GitLogPage,
	type GitStatus,
	type Project,
	type PullRequest,
	routes,
} from "@clam/contracts";
import { type QueryClient, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api } from "@/lib/api";
import { useTopic } from "@/lib/ws";
import { useGitUi } from "./store.ts";

/** Every git query of one project lives under `["local","git",projectId]` so a single prefix refreshes or drops all of it. */
export const gk = {
	root: (id: string) => ["local", "git", id] as const,
	status: (id: string) => ["local", "git", id, "status"] as const,
	branches: (id: string) => ["local", "git", id, "branches"] as const,
	identity: (id: string) => ["local", "git", id, "identity"] as const,
	logRoot: (id: string) => ["local", "git", id, "log"] as const,
	log: (id: string, ref: string) => ["local", "git", id, "log", ref] as const,
	diffRoot: (id: string) => ["local", "git", id, "diff"] as const,
	diff: (id: string, req: DiffRequest) => ["local", "git", id, "diff", req.scope, req.commit ?? "", req.path ?? ""] as const,
	pullsRoot: (id: string) => ["local", "git", id, "pulls"] as const,
	pulls: (id: string, state: PullState) => ["local", "git", id, "pulls", state] as const,
	overview: ["local", "git", "overview"] as const,
};

export type PullState = "open" | "closed" | "all";
export interface DiffRequest {
	scope: "unstaged" | "staged" | "head" | "commit";
	commit?: string;
	path?: string;
}

export interface GitOverviewEntry {
	project: Project;
	status: GitStatus | null;
	error: string | null;
}

/** A compact signature of everything the UI renders from a status; identical signatures never re-trigger diff refetches. */
export function statusSig(s: GitStatus): string {
	return [
		s.branch ?? "",
		s.headSha ?? "",
		s.upstream ?? "",
		s.ahead,
		s.behind,
		s.operation ?? "",
		s.files.map((f) => `${f.path}:${f.kind}:${+f.staged}${+f.unstaged}`).join("|"),
	].join("\u0001");
}

/** Writes a fresh status into the cache and refreshes whatever depends on it (diffs, and refs when HEAD/branch moved). */
export function applyStatus(qc: QueryClient, projectId: string, next: GitStatus): void {
	const prev = qc.getQueryData<GitStatus>(gk.status(projectId));
	qc.setQueryData(gk.status(projectId), next);
	if (prev && statusSig(prev) === statusSig(next)) return;
	void qc.invalidateQueries({ queryKey: gk.diffRoot(projectId) });
	if (!prev || prev.headSha !== next.headSha || prev.branch !== next.branch || prev.upstream !== next.upstream || prev.ahead !== next.ahead || prev.behind !== next.behind) {
		void qc.invalidateQueries({ queryKey: gk.branches(projectId) });
		void qc.invalidateQueries({ queryKey: gk.logRoot(projectId) });
	}
	void qc.invalidateQueries({ queryKey: gk.overview });
}

function subscribeVisibility(cb: () => void): () => void {
	document.addEventListener("visibilitychange", cb);
	return () => document.removeEventListener("visibilitychange", cb);
}
export function usePageVisible(): boolean {
	return useSyncExternalStore(
		subscribeVisibility,
		() => document.visibilityState === "visible",
		() => true,
	);
}

/**
 * Cached status of one project. With `live`, subscribes to `git:<projectId>` while the page is visible and bridges events
 * into the cache; a missed event (gap/reconnect) or returning to the tab refetches.
 */
export function useGitStatus(projectId: string, opts: { live?: boolean; enabled?: boolean } = {}) {
	const qc = useQueryClient();
	const visible = usePageVisible();
	const setOp = useGitUi((s) => s.setOperation);
	const q = useQuery({
		queryKey: gk.status(projectId),
		queryFn: ({ signal }) => api.get<GitStatus>(routes.gitStatus(projectId), undefined, { signal }),
		staleTime: 4_000,
		enabled: opts.enabled ?? true,
	});
	const live = Boolean(opts.live) && visible;
	useTopic(
		live ? `git:${projectId}` : null,
		(e) => {
			if (e.type === "status") applyStatus(qc, projectId, e.status);
			else setOp(projectId, e.operation);
		},
		{ onResync: () => void qc.invalidateQueries({ queryKey: gk.root(projectId) }) },
	);
	const refetch = q.refetch;
	useEffect(() => {
		if (live && q.isStale) void refetch();
		// refetch once when the tab becomes visible again
		// biome-ignore lint/correctness/useExhaustiveDependencies: only react to visibility flips
	}, [live]);
	return q;
}

export function useBranches(projectId: string, enabled = true) {
	return useQuery({
		queryKey: gk.branches(projectId),
		queryFn: ({ signal }) => api.get<GitBranch[]>(routes.gitBranches(projectId), undefined, { signal }),
		enabled,
		staleTime: 8_000,
	});
}

export function useIdentity(projectId: string) {
	return useQuery({
		queryKey: gk.identity(projectId),
		queryFn: ({ signal }) => api.get<GitIdentity>(routes.gitIdentity(projectId), undefined, { signal }),
		staleTime: 60_000,
		retry: false,
	});
}

export function useSetIdentity(projectId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: { name: string; email: string } | null) => api.put<GitIdentity>(routes.gitIdentity(projectId), body),
		onSuccess: (identity) => qc.setQueryData(gk.identity(projectId), identity),
	});
}

export function useDiff(projectId: string, req: DiffRequest, enabled = true) {
	return useQuery({
		queryKey: gk.diff(projectId, req),
		queryFn: ({ signal }) => api.get<GitDiff>(routes.gitDiff(projectId), { scope: req.scope, commit: req.commit, path: req.path }, { signal }),
		enabled,
		staleTime: req.scope === "commit" ? Number.POSITIVE_INFINITY : 2_000,
		placeholderData: (prev) => prev,
	});
}

export function useGitLog(projectId: string, ref = "HEAD") {
	return useInfiniteQuery({
		queryKey: gk.log(projectId, ref),
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam, signal }) => api.get<GitLogPage>(routes.gitLog(projectId), { ref, limit: 40, cursor: pageParam }, { signal }),
		getNextPageParam: (last) => last.nextCursor ?? undefined,
		staleTime: 10_000,
	});
}

export function usePullRequests(projectId: string, state: PullState, enabled = true) {
	return useQuery({
		queryKey: gk.pulls(projectId, state),
		queryFn: ({ signal }) => api.get<PullRequest[]>(routes.gitPullRequests(projectId), { state }, { signal }),
		enabled,
		staleTime: 20_000,
		retry: false,
	});
}

export function useConflictCheck(projectId: string) {
	return useMutation({
		mutationFn: () => api.get<GitConflictReport>(routes.gitConflicts(projectId)),
	});
}

export function useOverview() {
	const visible = usePageVisible();
	return useQuery({
		queryKey: gk.overview,
		queryFn: ({ signal }) => api.get<GitOverviewEntry[]>(routes.gitOverview, undefined, { signal }),
		staleTime: 5_000,
		refetchInterval: visible ? 15_000 : false,
	});
}

/** Stable callback that refreshes every git query of a project. */
export function useRefreshGit(projectId: string): () => void {
	const qc = useQueryClient();
	return useCallback(() => void qc.invalidateQueries({ queryKey: gk.root(projectId) }), [qc, projectId]);
}
