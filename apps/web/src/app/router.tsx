import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, createRoute, createRouter, lazyRouteComponent, Outlet, redirect } from "@tanstack/react-router";
import { routes } from "@clam/contracts";
import { api } from "@/lib/api";
import { qk } from "@/lib/queries";
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
	validateSearch: (s: Record<string, unknown>): { file?: string; tab?: "git" } => ({
		file: typeof s.file === "string" && s.file ? s.file : undefined,
		tab: s.tab === "git" ? "git" : undefined,
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
	loader: ({ context: { queryClient: qc }, params }) => {
		prefetch(qc, qk.session(params.sessionId), routes.session(params.sessionId));
	},
	component: lazyRouteComponent(() => import("@/features/session/session-page.tsx")),
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
	workspacesRoute.addChildren([workspacesIndexRoute, workspaceRoute, workspaceAgentsRoute, workspaceTasksRoute, workspaceActivityRoute]),
	agentsRoute,
	tasksRoute,
	taskRoute,
	projectRoute,
	sessionRoute,
	nodeRoute.addChildren([nodeIndexRoute, nodeSessionsRoute, nodeProjectsRoute, nodeGitRoute, nodeRuntimeRoute]),
	networkRoute.addChildren([networkIndexRoute, networkNodesRoute, networkPeerRoute, networkAgentsRoute]),
	sharedRoute,
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
