import {
	type Agent,
	type AgentSession,
	type DirectoryAgent,
	type Invitation,
	type NodeHealth,
	type NodeInfo,
	type OutgoingPairing,
	type PairingRequest,
	type Peer,
	type Project,
	type ProvidersOverview,
	type QuotaReport,
	type RecordedUsage,
	type RuntimeStatus,
	type SharedInvite,
	type SharedSession,
	type Task,
	type TunnelState,
	type Workspace,
	routes,
} from "@clam/contracts";
import { QueryClient, type QueryKey, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";
import { api, ApiError } from "./api.ts";
import { useUi } from "./store.ts";
import { useTopic } from "./ws.ts";

export interface SessionFilter {
	projectId?: string;
	archived?: boolean;
}

/** Every key starts with "local" (the local UI API). Prefix keys are exported for invalidation. */
export const qk = {
	all: ["local"] as const,
	node: ["local", "node"] as const,
	health: ["local", "health"] as const,
	settings: ["local", "settings"] as const,
	security: ["local", "security"] as const,
	tunnel: ["local", "tunnel"] as const,
	networkAll: ["local", "network"] as const,
	peers: ["local", "network", "peers"] as const,
	invitations: ["local", "network", "invitations"] as const,
	pairingRequests: ["local", "network", "pairing-requests"] as const,
	outgoingPairings: ["local", "network", "join"] as const,
	directory: ["local", "network", "agents"] as const,
	workspaces: ["local", "workspaces"] as const,
	workspace: (id: string) => ["local", "workspace", id] as const,
	projectsAll: ["local", "projects"] as const,
	projects: (workspaceId?: string) => ["local", "projects", { workspaceId: workspaceId ?? null }] as const,
	project: (id: string) => ["local", "project", id] as const,
	projectFiles: (id: string, path: string) => ["local", "project", id, "files", path] as const,
	projectFile: (id: string, path: string) => ["local", "project", id, "file", path] as const,
	agents: ["local", "agents"] as const,
	sessionsAll: ["local", "sessions"] as const,
	sessions: (filter: SessionFilter = {}) => ["local", "sessions", { projectId: filter.projectId ?? null, archived: filter.archived ?? false }] as const,
	session: (id: string) => ["local", "session", id] as const,
	sessionState: (id: string) => ["local", "session", id, "state"] as const,
	sessionMessages: (id: string) => ["local", "session", id, "messages"] as const,
	runtime: ["local", "runtime"] as const,
	tasks: ["local", "tasks"] as const,
	task: (id: string) => ["local", "task", id] as const,
	shared: ["local", "shared"] as const,
	sharedDetail: (id: string) => ["local", "shared", id] as const,
	sharedInvites: ["local", "shared-invites"] as const,
	activityAll: ["local", "activity"] as const,
	activity: (workspaceId?: string) => ["local", "activity", { workspaceId: workspaceId ?? null }] as const,
	ompProviders: ["local", "omp", "providers"] as const,
	ompAccounts: (providerId: string) => ["local", "omp", "accounts", providerId] as const,
	ompModels: ["local", "omp", "models"] as const,
	ompModelRoles: ["local", "omp", "model-roles"] as const,
	usageRecorded: ["local", "usage", "recorded"] as const,
	usageQuota: ["local", "usage", "quota"] as const,
	usageMesh: ["local", "usage", "mesh"] as const,
	githubConfig: ["local", "github", "config"] as const,
	githubAccounts: ["local", "github", "accounts"] as const,
	githubRepos: (accountId: string, q?: string) => ["local", "github", "repos", accountId, q ?? ""] as const,
} satisfies Record<string, QueryKey | ((...args: never[]) => QueryKey)>;

export function createQueryClient(): QueryClient {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 15_000,
				gcTime: 10 * 60_000,
				refetchOnWindowFocus: false,
				retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 1,
			},
		},
	});
}

// ───────────────────────── shared typed query hooks ─────────────────────────

export const useNode = () => useQuery({ queryKey: qk.node, queryFn: ({ signal }) => api.get<NodeInfo>(routes.node, undefined, { signal }), staleTime: 5 * 60_000 });
export const useHealth = () => useQuery({ queryKey: qk.health, queryFn: ({ signal }) => api.get<NodeHealth>(routes.health, undefined, { signal }), refetchInterval: 30_000 });
export const useWorkspaces = () => useQuery({ queryKey: qk.workspaces, queryFn: ({ signal }) => api.get<Workspace[]>(routes.workspaces, undefined, { signal }) });
export const useWorkspace = (id: string) => useQuery({ queryKey: qk.workspace(id), queryFn: ({ signal }) => api.get<Workspace>(routes.workspace(id), undefined, { signal }) });
export const useProjects = (workspaceId?: string) =>
	useQuery({ queryKey: qk.projects(workspaceId), queryFn: ({ signal }) => api.get<Project[]>(routes.projects, { workspaceId }, { signal }) });
export const useProject = (id: string) => useQuery({ queryKey: qk.project(id), queryFn: ({ signal }) => api.get<Project>(routes.project(id), undefined, { signal }) });
export const useAgents = () => useQuery({ queryKey: qk.agents, queryFn: ({ signal }) => api.get<Agent[]>(routes.agents, undefined, { signal }) });
export const useSessions = (filter: SessionFilter = {}) =>
	useQuery({
		queryKey: qk.sessions(filter),
		queryFn: ({ signal }) => api.get<AgentSession[]>(routes.sessions, { projectId: filter.projectId, archived: filter.archived ? "true" : undefined }, { signal }),
	});
export const useSession = (id: string) => useQuery({ queryKey: qk.session(id), queryFn: ({ signal }) => api.get<AgentSession>(routes.session(id), undefined, { signal }) });
export const useRuntime = () => useQuery({ queryKey: qk.runtime, queryFn: ({ signal }) => api.get<RuntimeStatus[]>(routes.runtime, undefined, { signal }) });
export const useOmpProviders = () => useQuery({ queryKey: qk.ompProviders, queryFn: ({ signal }) => api.get<ProvidersOverview>(routes.ompProviders, undefined, { signal }) });
export const useUsageRecorded = () => useQuery({ queryKey: qk.usageRecorded, queryFn: ({ signal }) => api.get<RecordedUsage>(routes.usageRecorded, undefined, { signal }), staleTime: 60_000 });
export const useUsageQuota = () => useQuery({ queryKey: qk.usageQuota, queryFn: ({ signal }) => api.get<QuotaReport>(routes.usageQuota, undefined, { signal }), staleTime: 60_000 });

export const useTunnel = () => useQuery({ queryKey: qk.tunnel, queryFn: ({ signal }) => api.get<TunnelState>(routes.tunnel, undefined, { signal }), staleTime: 60_000 });
export const usePeers = () => useQuery({ queryKey: qk.peers, queryFn: ({ signal }) => api.get<Peer[]>(routes.peers, undefined, { signal }) });
export const useInvitations = () => useQuery({ queryKey: qk.invitations, queryFn: ({ signal }) => api.get<Invitation[]>(routes.invitations, undefined, { signal }) });
export const usePairingRequests = () => useQuery({ queryKey: qk.pairingRequests, queryFn: ({ signal }) => api.get<PairingRequest[]>(routes.pairingRequests, undefined, { signal }) });
export const useOutgoingPairings = () => useQuery({ queryKey: qk.outgoingPairings, queryFn: ({ signal }) => api.get<OutgoingPairing[]>(routes.join, undefined, { signal }) });
export const useDirectory = () => useQuery({ queryKey: qk.directory, queryFn: ({ signal }) => api.get<DirectoryAgent[]>(routes.directory, undefined, { signal }), staleTime: 30_000 });
export const useTasks = () => useQuery({ queryKey: qk.tasks, queryFn: ({ signal }) => api.get<Task[]>(routes.tasks, undefined, { signal }), staleTime: 30_000 });
export const useSharedSessions = () => useQuery({ queryKey: qk.shared, queryFn: ({ signal }) => api.get<SharedSession[]>(routes.sharedSessions, undefined, { signal }), staleTime: 30_000 });
export const useSharedInvites = () => useQuery({ queryKey: qk.sharedInvites, queryFn: ({ signal }) => api.get<SharedInvite[]>(routes.sharedInvites, undefined, { signal }), staleTime: 30_000 });
/** Invites that wait for this node's user. */
export const isPendingInvite = (i: SharedInvite): boolean => i.state === "pending";

const FINISHED: Record<string, true> = { rejected: true, succeeded: true, failed: true, cancelled: true, handed_off: true };
export const isActiveTask = (t: Task): boolean => !FINISHED[t.status];
/** Tasks that wait for this node's user: an offer to decide on, or unread discussion messages. */
export const taskNeedsAttention = (t: Task): boolean => (t.direction === "incoming" && t.status === "offered") || t.unreadMessages > 0;

/** Requests that wait for this node's user (drives the sidebar badge and the inbox). */
export const isAwaitingApproval = (r: PairingRequest): boolean => r.state === "awaiting_approval";

function upsertBy<T>(list: T[] | undefined, item: T, id: (t: T) => string): T[] | undefined {
	if (!list) return list;
	const i = list.findIndex((x) => id(x) === id(item));
	return i < 0 ? [item, ...list] : list.map((x, j) => (j === i ? item : x));
}

// ───────────────────────── realtime → cache bridge ─────────────────────────

function matchesSessionFilter(key: QueryKey, s: AgentSession): boolean {
	const f = key[2] as { projectId: string | null; archived: boolean } | undefined;
	if (!f) return false;
	if (f.projectId && f.projectId !== s.projectId) return false;
	return f.archived === s.archived;
}

/** Mounted once in the app shell: keeps list caches current from `sessions`, `runtime`, `node` topics. */
export function useRealtimeBridge(): void {
	const qc = useQueryClient();
	const resync = useCallback(() => {
		void qc.invalidateQueries({ queryKey: qk.sessionsAll });
		void qc.invalidateQueries({ queryKey: qk.runtime });
		void qc.invalidateQueries({ queryKey: qk.health });
		void qc.invalidateQueries({ queryKey: qk.agents });
	}, [qc]);

	useTopic(
		"sessions",
		(e) => {
			if (e.type === "upsert") {
				const s = e.session;
				qc.setQueryData(qk.session(s.id), s);
				for (const [key, data] of qc.getQueriesData<AgentSession[]>({ queryKey: qk.sessionsAll })) {
					if (!Array.isArray(data) || key.length !== 3) continue;
					const idx = data.findIndex((x) => x.id === s.id);
					const matches = matchesSessionFilter(key, s);
					if (idx >= 0) {
						const next = matches ? data.map((x, i) => (i === idx ? s : x)) : data.filter((x) => x.id !== s.id);
						qc.setQueryData(key, next);
					} else if (matches) {
						qc.setQueryData(key, [s, ...data]);
					}
				}
				void qc.invalidateQueries({ queryKey: qk.projectsAll });
				void qc.invalidateQueries({ queryKey: qk.agents });
			} else if (e.type === "remove") {
				qc.removeQueries({ queryKey: qk.session(e.sessionId) });
				qc.setQueriesData<AgentSession[]>({ queryKey: qk.sessionsAll }, (data) => (Array.isArray(data) ? data.filter((x) => x.id !== e.sessionId) : data));
				void qc.invalidateQueries({ queryKey: qk.projectsAll });
			}
		},
		{ onResync: resync },
	);

	useTopic(
		"runtime",
		(e) => {
			if (e.type !== "status") return;
			qc.setQueryData<RuntimeStatus[]>(qk.runtime, (data) => {
				if (!data) return data;
				const idx = data.findIndex((r) => r.sessionId === e.status.sessionId);
				if (idx < 0) return [...data, e.status];
				return data.map((r, i) => (i === idx ? e.status : r));
			});
			void qc.invalidateQueries({ queryKey: qk.agents });
		},
		{ onResync: resync },
	);

	useTopic("node", (e) => {
		if (e.type === "health") qc.setQueryData(qk.health, e.health);
	});

	useTopic(
		"network",
		(e) => {
			switch (e.type) {
				case "peer":
					qc.setQueryData<Peer[]>(qk.peers, (d) => upsertBy(d, e.peer, (p) => p.id));
					if (e.peer.status === "revoked") void qc.invalidateQueries({ queryKey: qk.directory });
					break;
				case "invitation":
					qc.setQueryData<Invitation[]>(qk.invitations, (d) => upsertBy(d, e.invitation, (i) => i.id));
					break;
				case "pairing_request": {
					const r = e.request;
					qc.setQueryData<PairingRequest[]>(qk.pairingRequests, (d) => upsertBy(d, r, (x) => x.id));
					if (r.state === "awaiting_approval") {
						toast(`Pairing request from ${r.remote.name}`, {
							id: `pairing-${r.id}`,
							description: "A node entered your invitation code. Compare its fingerprint, then approve or reject.",
							duration: 20_000,
							action: { label: "Review", onClick: () => useUi.getState().openDialog({ kind: "pairing-requests" }) },
						});
					} else {
						toast.dismiss(`pairing-${r.id}`);
					}
					break;
				}
				case "join":
					qc.setQueryData<OutgoingPairing[]>(qk.outgoingPairings, (d) => upsertBy(d, e.pairing, (x) => x.id));
					break;
				case "directory_changed":
					void qc.invalidateQueries({ queryKey: qk.directory });
					break;
			}
		},
		{ onResync: () => void qc.invalidateQueries({ queryKey: qk.networkAll }) },
	);

	useTopic(
		"tunnel",
		(e) => {
			if (e.type === "state") qc.setQueryData(qk.tunnel, e.state);
		},
		{ onResync: () => void qc.invalidateQueries({ queryKey: qk.tunnel }) },
	);

}
