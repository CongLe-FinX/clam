import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	routes,
	type DeviceFlowStart,
	type GithubAccount,
	type GithubConfig,
	type GithubRepo,
	type LoginFlow,
	type ModelInfo,
	type ModelRoles,
	type ModelTestResult,
	type NodeInfo,
	type NodeSettings,
	type NodeSettingsPatch,
	type Project,
	type ProviderAccount,
	type ProvidersOverview,
	type RepoPermissionCheck,
	type RepositoryRef,
	type RuntimeStatus,
	type SecurityInfo,
} from "@clam/contracts";
import { api } from "@/lib/api";
import { qk } from "@/lib/queries";

const get = <T>(path: string) => ({ signal }: { signal?: AbortSignal }) => api.get<T>(path, undefined, { signal });

// ── node ────────────────────────────────────────────────────────────────────────────────────────

export const useNodeInfo = () => useQuery({ queryKey: qk.node, queryFn: get<NodeInfo>(routes.node), staleTime: 60_000 });
export const useSecurityInfo = () => useQuery({ queryKey: qk.security, queryFn: get<SecurityInfo>(routes.security), staleTime: 60_000 });
export const useSettings = () => useQuery({ queryKey: qk.settings, queryFn: get<NodeSettings>(routes.settings) });

/** Optimistic PATCH: UI reflects the change immediately, rolls back on error. */
export function usePatchSettings() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (patch: NodeSettingsPatch) => api.patch<NodeSettings>(routes.settings, patch),
		onMutate: async (patch) => {
			await qc.cancelQueries({ queryKey: qk.settings });
			const prev = qc.getQueryData<NodeSettings>(qk.settings);
			if (prev) qc.setQueryData<NodeSettings>(qk.settings, { ...prev, ...patch });
			return { prev };
		},
		onError: (_e, _p, ctx) => {
			if (ctx?.prev) qc.setQueryData(qk.settings, ctx.prev);
		},
		onSuccess: (next) => {
			qc.setQueryData(qk.settings, next);
			qc.invalidateQueries({ queryKey: qk.node });
		},
	});
}

export function useRuntimeActions() {
	const qc = useQueryClient();
	const done = () => qc.invalidateQueries({ queryKey: qk.runtime });
	return {
		stop: useMutation({ mutationFn: (id: string) => api.post<void>(routes.runtimeStop(id)), onSuccess: done }),
		restart: useMutation({ mutationFn: (id: string) => api.post<RuntimeStatus>(routes.runtimeRestart(id)), onSuccess: done }),
	};
}

export function useProjects() {
	return useQuery({ queryKey: qk.projects(), queryFn: get<Project[]>(routes.projects) });
}

export function useLinkRepository() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ projectId, repository }: { projectId: string; repository: RepositoryRef | null }) =>
			api.patch<Project>(routes.project(projectId), { repository }),
		onMutate: async ({ projectId, repository }) => {
			const key = qk.projects();
			await qc.cancelQueries({ queryKey: key });
			const prev = qc.getQueryData<Project[]>(key);
			if (prev) qc.setQueryData<Project[]>(key, prev.map((p) => (p.id === projectId ? { ...p, repository } : p)));
			return { prev };
		},
		onError: (_e, _v, ctx) => {
			if (ctx?.prev) qc.setQueryData(qk.projects(), ctx.prev);
		},
		onSettled: () => qc.invalidateQueries({ queryKey: ["local", "projects"] }),
	});
}

// ── GitHub ──────────────────────────────────────────────────────────────────────────────────────

export const useGithubConfig = () => useQuery({ queryKey: qk.githubConfig, queryFn: get<GithubConfig>(routes.githubConfig) });
export const useGithubAccounts = () => useQuery({ queryKey: qk.githubAccounts, queryFn: get<GithubAccount[]>(routes.githubAccounts) });

export function useUpdateGithubConfig() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (clientId: string | null) => api.put<GithubConfig>(routes.githubConfig, { clientId }),
		onSuccess: (cfg) => qc.setQueryData(qk.githubConfig, cfg),
	});
}

export function useStartDeviceFlow() {
	return useMutation({ mutationFn: () => api.post<DeviceFlowStart>(routes.githubDeviceStart) });
}

export function useImportGh() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: () => api.post<GithubAccount>(routes.githubImportGh),
		onSuccess: () => qc.invalidateQueries({ queryKey: qk.githubAccounts }),
	});
}

export function useSetDefaultAccount() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.post<GithubAccount[]>(routes.githubAccountDefault(id)),
		onMutate: async (id) => {
			await qc.cancelQueries({ queryKey: qk.githubAccounts });
			const prev = qc.getQueryData<GithubAccount[]>(qk.githubAccounts);
			if (prev) qc.setQueryData<GithubAccount[]>(qk.githubAccounts, prev.map((a) => ({ ...a, isDefault: a.id === id })));
			return { prev };
		},
		onError: (_e, _id, ctx) => {
			if (ctx?.prev) qc.setQueryData(qk.githubAccounts, ctx.prev);
		},
		onSuccess: (list) => qc.setQueryData(qk.githubAccounts, list),
	});
}

export function useVerifyAccount() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.post<GithubAccount>(routes.githubAccountVerify(id)),
		onSuccess: (acc) =>
			qc.setQueryData<GithubAccount[]>(qk.githubAccounts, (list) => list?.map((a) => (a.id === acc.id ? acc : a))),
	});
}

export function useDisconnectAccount() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.delete<void>(routes.githubAccount(id)),
		onMutate: async (id) => {
			await qc.cancelQueries({ queryKey: qk.githubAccounts });
			const prev = qc.getQueryData<GithubAccount[]>(qk.githubAccounts);
			if (prev) qc.setQueryData<GithubAccount[]>(qk.githubAccounts, prev.filter((a) => a.id !== id));
			return { prev };
		},
		onError: (_e, _id, ctx) => {
			if (ctx?.prev) qc.setQueryData(qk.githubAccounts, ctx.prev);
		},
		onSettled: () => qc.invalidateQueries({ queryKey: qk.githubAccounts }),
	});
}

interface RepoPage {
	items: GithubRepo[];
	nextPage: number | null;
}

export function useGithubRepos(accountId: string, q: string, enabled = true) {
	return useInfiniteQuery({
		enabled: enabled && accountId !== "",
		queryKey: qk.githubRepos(accountId, q),
		initialPageParam: 1,
		queryFn: ({ pageParam, signal }) =>
			api.get<RepoPage>(routes.githubRepos(accountId), { q: q || undefined, page: pageParam }, { signal }),
		getNextPageParam: (last) => last.nextPage ?? undefined,
		staleTime: 60_000,
	});
}

export function useRepoCheck() {
	return useMutation({
		mutationFn: ({ accountId, owner, repo }: { accountId: string; owner: string; repo: string }) =>
			api.get<RepoPermissionCheck>(routes.githubRepoCheck(accountId, owner, repo)),
	});
}

// ── OMP ─────────────────────────────────────────────────────────────────────────────────────────

export const useOmpOverview = () =>
	useQuery({ queryKey: qk.ompProviders, queryFn: get<ProvidersOverview>(routes.ompProviders), staleTime: 30_000 });
export const useOmpModels = () => useQuery({ queryKey: qk.ompModels, queryFn: get<ModelInfo[]>(routes.ompModels), staleTime: 120_000 });
export const useModelRoles = () => useQuery({ queryKey: qk.ompModelRoles, queryFn: get<ModelRoles>(routes.ompModelRoles) });

export function useProviderAccounts(providerId: string, enabled: boolean) {
	return useQuery({
		queryKey: qk.ompAccounts(providerId),
		queryFn: get<ProviderAccount[]>(routes.ompProviderAccounts(providerId)),
		enabled,
	});
}

export function useStartLogin() {
	return useMutation({ mutationFn: (providerId: string) => api.post<LoginFlow>(routes.ompLogin, { providerId }) });
}

export function useLoginInput(flowId: string) {
	return useMutation({
		mutationFn: (v: { requestId: string; value: string }) => api.post<LoginFlow>(routes.ompLoginInput(flowId), v),
	});
}

export function useCancelLogin() {
	return useMutation({ mutationFn: (flowId: string) => api.post<LoginFlow>(routes.ompLoginCancel(flowId)) });
}

export function useLogout() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (v: { providerId: string; credentialId: number }) =>
			api.post<{ remainingSource: string | null }>(routes.ompLogout, v),
		onSettled: (_d, _e, v) => {
			qc.invalidateQueries({ queryKey: qk.ompAccounts(v.providerId) });
			qc.invalidateQueries({ queryKey: qk.ompProviders });
			qc.invalidateQueries({ queryKey: qk.usageQuota });
		},
	});
}

export function useSetModelRole() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (v: { role: string; selector: string | null }) => api.put<ModelRoles>(routes.ompModelRoles, v),
		onMutate: async ({ role, selector }) => {
			await qc.cancelQueries({ queryKey: qk.ompModelRoles });
			const prev = qc.getQueryData<ModelRoles>(qk.ompModelRoles);
			if (prev) {
				const next = { ...prev };
				if (selector) next[role] = selector;
				else delete next[role];
				qc.setQueryData<ModelRoles>(qk.ompModelRoles, next);
			}
			return { prev };
		},
		onError: (_e, _v, ctx) => {
			if (ctx?.prev) qc.setQueryData(qk.ompModelRoles, ctx.prev);
		},
		onSuccess: (roles) => {
			qc.setQueryData(qk.ompModelRoles, roles);
			qc.invalidateQueries({ queryKey: qk.ompProviders });
		},
	});
}

export function useTestModel() {
	return useMutation({ mutationFn: (selector: string) => api.post<ModelTestResult>(routes.ompModelTest, { selector }) });
}
