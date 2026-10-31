import type { Context, ContextExportResult, ContextImportResult, ContextSearchHit, ContextType, ContextVersion, WorkspaceMember } from "@clam/contracts";
import { routes } from "@clam/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { ApiError, api } from "@/lib/api";
import { qk, usePeers } from "@/lib/queries";

export interface CreateContextInput {
	workspaceId: string;
	projectId?: string;
	type: ContextType;
	title: string;
	body: string;
	shareable: boolean;
}
export interface UpdateContextInput {
	/** The version the edit is based on; the server answers 409 `stale_version` otherwise. */
	baseVersion: number;
	title?: string;
	body?: string;
	shareable?: boolean;
}
export interface ResolveContextInput {
	keep: "local" | "remote" | "merged";
	/** Required for `merged`. */
	body?: string;
}
export type ContextFilter = { workspaceId?: string; projectId?: string; type?: string };

export const useContexts = (filter: ContextFilter) =>
	useQuery({
		queryKey: qk.contexts(filter),
		queryFn: ({ signal }) => api.get<Context[]>(routes.contexts, filter, { signal }),
		staleTime: 10_000,
		enabled: Boolean(filter.workspaceId || filter.projectId),
	});
export const useContext = (id: string | undefined) =>
	useQuery({ queryKey: qk.context(id ?? ""), queryFn: ({ signal }) => api.get<Context>(routes.context(id ?? ""), undefined, { signal }), enabled: Boolean(id), staleTime: 10_000 });
export const useContextVersions = (id: string | undefined, enabled = true) =>
	useQuery({ queryKey: qk.contextVersions(id ?? ""), queryFn: ({ signal }) => api.get<ContextVersion[]>(routes.contextVersions(id ?? ""), undefined, { signal }), enabled: Boolean(id) && enabled });
export const useContextSearch = (q: string, scope: { workspaceId?: string; projectId?: string }) =>
	useQuery({
		queryKey: qk.contextSearch(q, scope.workspaceId, scope.projectId),
		queryFn: ({ signal }) => api.get<ContextSearchHit[]>(routes.contextSearch, { q, ...scope, limit: 30 }, { signal }),
		enabled: q.trim().length > 0,
		staleTime: 5_000,
	});
export const useMembers = (workspaceId: string) =>
	useQuery({ queryKey: qk.members(workspaceId), queryFn: ({ signal }) => api.get<WorkspaceMember[]>(routes.workspaceMembers(workspaceId), undefined, { signal }) });

/** nodeId → display name, from the member list plus paired peers (peer ids are node ids). */
export function useNodeNames(workspaceId?: string): Map<string, string> {
	const members = useMembers(workspaceId ?? "");
	const peers = usePeers().data;
	return useMemo(() => {
		const m = new Map<string, string>();
		for (const p of peers ?? []) m.set(p.id, p.name);
		for (const w of workspaceId ? (members.data ?? []) : []) m.set(w.nodeId, w.nodeName);
		return m;
	}, [members.data, peers, workspaceId]);
}

export const isStaleVersion = (e: unknown): boolean => e instanceof ApiError && e.status === 409 && e.code === "stale_version";

export function useContextMutations() {
	const qc = useQueryClient();
	const put = (c: Context) => {
		qc.setQueryData(qk.context(c.id), c);
		void qc.invalidateQueries({ queryKey: [...qk.contextsAll, "list"] });
		void qc.invalidateQueries({ queryKey: [...qk.contextsAll, "search"] });
		void qc.invalidateQueries({ queryKey: qk.contextVersions(c.id) });
	};
	return {
		create: useMutation({ mutationFn: (body: CreateContextInput) => api.post<Context>(routes.contexts, body), onSuccess: put }),
		update: useMutation({ mutationFn: ({ id, body }: { id: string; body: UpdateContextInput }) => api.patch<Context>(routes.context(id), body), onSuccess: put }),
		resolve: useMutation({ mutationFn: ({ id, body }: { id: string; body: ResolveContextInput }) => api.post<Context>(routes.contextResolve(id), body), onSuccess: put }),
		remove: useMutation({
			mutationFn: (id: string) => api.delete(routes.context(id)),
			onSuccess: (_v, id) => {
				qc.removeQueries({ queryKey: qk.context(id) });
				void qc.invalidateQueries({ queryKey: [...qk.contextsAll, "list"] });
				void qc.invalidateQueries({ queryKey: [...qk.contextsAll, "search"] });
			},
		}),
		exportClmesh: useMutation({
			mutationFn: (projectId: string) => api.post<ContextExportResult>(routes.contextExport(projectId)),
			onSuccess: () => void qc.invalidateQueries({ queryKey: [...qk.contextsAll, "list"] }),
		}),
		importClmesh: useMutation({
			mutationFn: (projectId: string) => api.post<ContextImportResult>(routes.contextImport(projectId)),
			onSuccess: () => {
				void qc.invalidateQueries({ queryKey: [...qk.contextsAll, "list"] });
				void qc.invalidateQueries({ queryKey: [...qk.contextsAll, "search"] });
			},
		}),
	};
}

export function useMemberMutations(workspaceId: string) {
	const qc = useQueryClient();
	const set = (m: WorkspaceMember[]) => qc.setQueryData(qk.members(workspaceId), m);
	return {
		add: useMutation({ mutationFn: (body: { nodeId: string; permissions?: string[] }) => api.post<WorkspaceMember[]>(routes.workspaceMembers(workspaceId), body), onSuccess: set }),
		remove: useMutation({ mutationFn: (nodeId: string) => api.delete<WorkspaceMember[]>(routes.workspaceMember(workspaceId, nodeId)), onSuccess: set }),
	};
}
