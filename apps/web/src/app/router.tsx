import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, createRoute, createRouter, lazyRouteComponent, Outlet, redirect } from "@tanstack/react-router";
import { routes } from "@clam/contracts";
import { api } from "@/lib/api";
import { qk } from "@/lib/queries";
import { hk } from "@/features/handoff/api.ts";
import { RootGate } from "@/features/auth/root-gate.tsx";
import { NotFound, RouteError } from "./route-states.tsx";

export interface RouterContext {
	queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
	component: RootGate,
	notFoundComponent: NotFound,
	errorComponent: RouteError,
});

/** Start data fetching on intent/navigation without blocking the transition. */
function prefetch(qc: QueryClient, key: readonly unknown[], path: string, query?: Record<string, string | undefined>): void {
	void qc.prefetchQuery({ queryKey: key, queryFn: ({ signal }) => api.get(path, query, { signal }) });
}

// Owner sign-in for the public origin. Rendered outside the app shell by RootGate; the page itself is a lazy chunk.
const loginRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/login",
	validateSearch: (s: Record<string, unknown>): { redirect?: string } => ({ redirect: typeof s.redirect === "string" && s.redirect ? s.redirect : undefined }),
	component: lazyRouteComponent(() => import("@/features/auth/login-route.tsx")),
});

const overviewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/",
	loader: ({ context: { queryClient: qc } }) => {
		prefetch(qc, qk.agents, routes.agents);
		prefetch(qc, qk.runtime, routes.runtime);
		prefetch(qc, qk.sessions(), routes.sessions);
	},
	component: lazyRouteComponent(() => import("@/features/overview/overview-page.tsx")),
});

const workspacesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/workspaces", component: Outlet });
const workspacesIndexRoute = createRoute({
	getParentRoute: () => workspacesRoute,
	path: "/",
	component: lazyRouteComponent(() => import("@/features/workspaces/workspaces-page.tsx")),
});
const workspaceRoute = createRoute({
	getParentRoute: () => workspacesRoute,
	path: "$workspaceId",
	loader: ({ context: { queryClient: qc }, params }) => {
		prefetch(qc, qk.workspace(params.workspaceId), routes.workspace(params.workspaceId));
		prefetch(qc, qk.projects(params.workspaceId), routes.projects, { workspaceId: params.workspaceId });
	},
	component: lazyRouteComponent(() => import("@/features/workspaces/workspace-page.tsx")),
});
const workspaceAgentsRoute = createRoute({
	getParentRoute: () => workspacesRoute,
	path: "$workspaceId/agents",
	component: lazyRouteComponent(() => import("@/features/agents/agents-page.tsx")),
});
const workspaceTasksRoute = createRoute({
	getParentRoute: () => workspacesRoute,
	path: "$workspaceId/tasks",
	component: lazyRouteComponent(() => import("@/features/tasks/board-page.tsx")),
});
const workspaceActivityRoute = createRoute({
	getParentRoute: () => workspacesRoute,
	path: "$workspaceId/activity",
	component: lazyRouteComponent(() => import("@/features/tasks/activity-page.tsx")),
});
const CONTEXT_TYPES = ["memory", "plan", "decision", "summary", "note"] as const;
export interface ContextSearch {
	/** Selected context (list → detail on mobile). */
	id?: string;
	type?: (typeof CONTEXT_TYPES)[number];
	q?: string;
	/** Filter: project id, or "workspace" for workspace-wide contexts. */
	project?: string;
	/** Open the editor for a new context. */
	new?: "1";
}
const workspaceContextRoute = createRoute({
	getParentRoute: () => workspacesRoute,
	path: "$workspaceId/context",
	validateSearch: (s: Record<string, unknown>): ContextSearch => ({
		id: typeof s.id === "string" && s.id ? s.id : undefined,
		type: CONTEXT_TYPES.find((t) => t === s.type),
		q: typeof s.q === "string" && s.q ? s.q : undefined,
		project: typeof s.project === "string" && s.project ? s.project : undefined,
		new: s.new === "1" || s.new === 1 ? "1" : undefined,
	}),
	loader: ({ context: { queryClient: qc }, params }) => {
		prefetch(qc, qk.contexts({ workspaceId: params.workspaceId }), routes.contexts, { workspaceId: params.workspaceId });
	},
	component: lazyRouteComponent(() => import("@/features/context/context-page.tsx")),
});
const workspaceMembersRoute = createRoute({
	getParentRoute: () => workspacesRoute,
	path: "$workspaceId/members",
	validateSearch: (s: Record<string, unknown>): { add?: "1" } => ({ add: s.add === "1" || s.add === 1 ? "1" : undefined }),
	loader: ({ context: { queryClient: qc }, params }) => {
		prefetch(qc, qk.members(params.workspaceId), routes.workspaceMembers(params.workspaceId));
	},
	component: lazyRouteComponent(() => import("@/features/workspaces/members-page.tsx")),
});
const tasksRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/tasks",
	loader: ({ context: { queryClient: qc } }) => {
		prefetch(qc, qk.tasks, routes.tasks);
	},
	component: lazyRouteComponent(() => import("@/features/tasks/board-page.tsx")),
});
const taskRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/tasks/$taskId",
	loader: ({ context: { queryClient: qc }, params }) => {
		prefetch(qc, qk.task(params.taskId), routes.task(params.taskId));
	},
	component: lazyRouteComponent(() => import("@/features/tasks/detail-page.tsx")),
});

const agentsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/agents",
	component: lazyRouteComponent(() => import("@/features/agents/agents-page.tsx")),
});

const projectRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/projects/$projectId",
	validateSearch: (s: Record<string, unknown>): { file?: string; tab?: "files" | "git" | "context" } => ({
		file: typeof s.file === "string" && s.file ? s.file : undefined,
		tab: s.tab === "files" ? "files" : s.tab === "git" ? "git" : s.tab === "context" ? "context" : undefined,
	}),
	loader: ({ context: { queryClient: qc }, params }) => {
		prefetch(qc, qk.project(params.projectId), routes.project(params.projectId));
		prefetch(qc, qk.sessions({ projectId: params.projectId }), routes.sessions, { projectId: params.projectId });
		prefetch(qc, qk.projectFiles(params.projectId, ""), routes.projectFiles(params.projectId), { path: "" });
	},
	component: lazyRouteComponent(() => import("@/features/projects/project-page.tsx")),
});

const sessionRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/sessions/$sessionId",
	// `?file=` is the file open in Quick Look.
	validateSearch: (s: Record<string, unknown>): { file?: string } => ({ file: typeof s.file === "string" && s.file ? s.file : undefined }),
	loader: ({ context: { queryClient: qc }, params }) => {
		prefetch(qc, qk.session(params.sessionId), routes.session(params.sessionId));
	},
	component: lazyRouteComponent(() => import("@/features/session/session-page.tsx")),
});

const chatsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/chats",
	component: lazyRouteComponent(() => import("@/features/chats/chats-page.tsx")),
});

const nodeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/node", component: Outlet });
const nodeIndexRoute = createRoute({ getParentRoute: () => nodeRoute, path: "/", beforeLoad: () => redirect({ to: "/node/sessions" }) });
const nodeSessionsRoute = createRoute({
	getParentRoute: () => nodeRoute,
	path: "sessions",
	component: lazyRouteComponent(() => import("@/features/node/sessions-page.tsx")),
});
const nodeProjectsRoute = createRoute({
	getParentRoute: () => nodeRoute,
	path: "projects",
	component: lazyRouteComponent(() => import("@/features/node/projects-page.tsx")),
});
const nodeGitRoute = createRoute({
	getParentRoute: () => nodeRoute,
	path: "git",
	component: lazyRouteComponent(() => import("@/features/git/git-page.tsx")),
});
const nodeRuntimeRoute = createRoute({
	getParentRoute: () => nodeRoute,
	path: "runtime",
	component: lazyRouteComponent(() => import("@/features/node/runtime-page.tsx")),
});
const nodeSystemRoute = createRoute({
	getParentRoute: () => nodeRoute,
	path: "system",
	component: lazyRouteComponent(() => import("@/features/node/system-page.tsx")),
});

// `t`: the selected terminal (survives a reload); `project`: open (or reuse) a terminal in that project's folder on arrival.
const terminalRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/terminal",
	validateSearch: (s: Record<string, unknown>): { t?: string; project?: string } => ({
		t: typeof s.t === "string" && s.t ? s.t : undefined,
		project: typeof s.project === "string" && s.project ? s.project : undefined,
	}),
	component: lazyRouteComponent(() => import("@/features/terminal/terminal-page.tsx")),
});

// `url`: open this URL in a new Browser tab on arrival (then stripped); `tab`: the tab to show.
const browserRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/browser",
	validateSearch: (s: Record<string, unknown>): { url?: string; tab?: string } => ({
		url: typeof s.url === "string" && s.url ? s.url : undefined,
		tab: typeof s.tab === "string" && s.tab ? s.tab : undefined,
	}),
	component: lazyRouteComponent(() => import("@/features/browser/browser-page.tsx")),
});

const networkRoute = createRoute({ getParentRoute: () => rootRoute, path: "/network", component: Outlet });
const networkIndexRoute = createRoute({ getParentRoute: () => networkRoute, path: "/", beforeLoad: () => redirect({ to: "/network/nodes" }) });
const networkNodesRoute = createRoute({
	getParentRoute: () => networkRoute,
	path: "nodes",
	loader: ({ context: { queryClient: qc } }) => {
		prefetch(qc, qk.peers, routes.peers);
		prefetch(qc, qk.invitations, routes.invitations);
	},
	component: lazyRouteComponent(() => import("@/features/network/nodes-page.tsx")),
});
const networkPeerRoute = createRoute({
	getParentRoute: () => networkRoute,
	path: "nodes/$peerId",
	loader: ({ context: { queryClient: qc } }) => {
		prefetch(qc, qk.peers, routes.peers);
		prefetch(qc, qk.directory, routes.directory);
	},
	component: lazyRouteComponent(() => import("@/features/network/peer-page.tsx")),
});
const networkAgentsRoute = createRoute({
	getParentRoute: () => networkRoute,
	path: "agents",
	loader: ({ context: { queryClient: qc } }) => {
		prefetch(qc, qk.directory, routes.directory);
		prefetch(qc, qk.peers, routes.peers);
	},
	component: lazyRouteComponent(() => import("@/features/network/directory-page.tsx")),
});

const sharedRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/shared",
	loader: ({ context: { queryClient: qc } }) => {
		prefetch(qc, qk.shared, routes.sharedSessions);
		prefetch(qc, qk.sharedInvites, routes.sharedInvites);
	},
	component: lazyRouteComponent(() => import("@/features/shared/shared-page.tsx")),
});

const handoffsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/handoffs",
	loader: ({ context: { queryClient: qc } }) => {
		prefetch(qc, hk.all, routes.handoffs);
	},
	component: lazyRouteComponent(() => import("@/features/handoff/center-page.tsx")),
});
const handoffRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/handoffs/$handoffId",
	loader: ({ context: { queryClient: qc }, params }) => {
		prefetch(qc, hk.detail(params.handoffId), routes.handoff(params.handoffId));
	},
	component: lazyRouteComponent(() => import("@/features/handoff/detail-page.tsx")),
});

const settingsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/settings",
	component: lazyRouteComponent(() => import("@/features/settings/routes.tsx"), "SettingsLayout"),
});
// SettingsLayout owns the index: it redirects on ≥768px and renders the section list on mobile.
const settingsIndexRoute = createRoute({ getParentRoute: () => settingsRoute, path: "/", component: () => null });
const settingsPage = <P extends string>(path: P, load: () => Promise<{ default: React.ComponentType }>) =>
	createRoute({ getParentRoute: () => settingsRoute, path, component: lazyRouteComponent(load) });
const settingsChildren = [
	settingsPage("general", () => import("@/features/settings/pages/general.tsx")),
	settingsPage("github", () => import("@/features/settings/pages/github.tsx")),
	settingsPage("omp", () => import("@/features/settings/pages/omp.tsx")),
	settingsPage("usage", () => import("@/features/settings/pages/usage.tsx")),
	settingsPage("runtime", () => import("@/features/settings/pages/runtime.tsx")),
	settingsPage("tunnel", () => import("@/features/settings/pages/tunnel.tsx")),
	settingsPage("security", () => import("@/features/settings/pages/security.tsx")),
	settingsPage("about", () => import("@/features/settings/pages/about.tsx")),
];

const routeTree = rootRoute.addChildren([
	loginRoute,
	overviewRoute,
	workspacesRoute.addChildren([workspacesIndexRoute, workspaceRoute, workspaceAgentsRoute, workspaceTasksRoute, workspaceActivityRoute, workspaceContextRoute, workspaceMembersRoute]),
	agentsRoute,
	tasksRoute,
	taskRoute,
	projectRoute,
	sessionRoute,
	chatsRoute,
	nodeRoute.addChildren([nodeIndexRoute, nodeSessionsRoute, nodeProjectsRoute, nodeGitRoute, nodeRuntimeRoute, nodeSystemRoute]),
	terminalRoute,
	browserRoute,
	networkRoute.addChildren([networkIndexRoute, networkNodesRoute, networkPeerRoute, networkAgentsRoute]),
	sharedRoute,
	handoffsRoute,
	handoffRoute,
	settingsRoute.addChildren([settingsIndexRoute, ...settingsChildren]),
]);

export function createAppRouter(queryClient: QueryClient) {
	return createRouter({
		routeTree,
		context: { queryClient },
		defaultPreload: "intent",
		defaultPreloadStaleTime: 30_000,
		defaultPendingMs: 200,
		scrollRestoration: false,
	});
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof createAppRouter>;
	}
}
