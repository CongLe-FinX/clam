import { type AgentSession, routes } from "@clam/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Command } from "cmdk";
import {
	Bot,
	CloudDownload,
	Cpu,
	DownloadCloud,
	GitBranch,
	GitCommitHorizontal,
	GitPullRequest,
	UploadCloud,
	FolderGit2,
	FolderPlus,
	KeyRound,
	LayoutDashboard,
	Layers,
	LayersIcon,
	MessageSquarePlus,
	Moon,
	Settings,
	Sun,
	TerminalSquare,
	Info,
	Gauge,
	GitFork,
	Server,
	Globe,
	ShieldCheck,
	Search,
	Inbox,
	LogIn,
	Network,
	Play,
	Square as StopIcon,
	UserPlus,
	Users,
	ArrowRightLeft,
	ListChecks,
	Send,
	type LucideIcon,
} from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { runFetch, runPull, runPush } from "@/features/git/ops";
import { useGitUi } from "@/features/git/store";
import { api } from "@/lib/api";
import { tunnelBusy, useTunnelActions } from "@/features/network/hooks";
import { isAwaitingApproval, isPendingInvite, qk, usePairingRequests, useProjects, useSessions, useSharedInvites, useSharedSessions, useTasks, useTunnel, useWorkspaces } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { toggleTheme, useResolvedTheme } from "@/lib/theme";
import { relativeTime } from "@/lib/utils";
import { StatusDot } from "@/ui/status-dot";
import { Kbd } from "@/ui/kbd";

type To = Parameters<ReturnType<typeof useNavigate>>[0]["to"];

function Item({ icon: Icon, children, hint, onSelect, value, keywords }: { icon: LucideIcon; children: ReactNode; hint?: ReactNode; onSelect: () => void; value: string; keywords?: string[] }) {
	return (
		<Command.Item
			value={value}
			keywords={keywords}
			onSelect={onSelect}
			className="flex h-9 cursor-default select-none items-center gap-2.5 rounded-lg px-2.5 text-[13px] text-muted-foreground outline-none data-[selected=true]:bg-surface-3 data-[selected=true]:text-foreground coarse:h-12 [&_svg]:size-4 [&_svg]:shrink-0"
		>
			<Icon />
			<span className="min-w-0 flex-1 truncate">{children}</span>
			{hint ? <span className="shrink-0 text-2xs text-subtle">{hint}</span> : null}
		</Command.Item>
	);
}

const Group = ({ heading, children }: { heading: string; children: ReactNode }) => (
	<Command.Group heading={heading} className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-subtle">
		{children}
	</Command.Group>
);

export default function CommandPalette() {
	const open = useUi((s) => s.paletteOpen);
	const setOpen = useUi((s) => s.setPaletteOpen);
	const openDialog = useUi((s) => s.openDialog);
	const navigate = useNavigate();
	const theme = useResolvedTheme();
	const sessions = useSessions();
	const workspaces = useWorkspaces();
	const projects = useProjects();
	const qc = useQueryClient();
	const tunnel = useTunnel();
	const tunnelActions = useTunnelActions();
	const tc = tunnel.data?.config;
	const tunnelReady = Boolean(tunnel.data?.cloudflared.installed && tc && (tc.mode === "quick" || (tc.mode === "named" && tc.hasToken && tc.hostname)));
	const waiting = (usePairingRequests().data ?? []).filter(isAwaitingApproval).length;
	const pendingInvites = (useSharedInvites().data ?? []).filter(isPendingInvite).length;
	const shared = useSharedSessions();
	const recentShared = useMemo(() => [...(shared.data ?? [])].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 10), [shared.data]);
	const params = useParams({ strict: false }) as { projectId?: string; sessionId?: string };
	const sessionForGit = useQuery({
		queryKey: qk.session(params.sessionId ?? ""),
		queryFn: ({ signal }) => api.get<AgentSession>(routes.session(params.sessionId ?? ""), undefined, { signal }),
		enabled: Boolean(params.sessionId) && !params.projectId,
	});
	const gitProjectId = params.projectId ?? sessionForGit.data?.projectId;
	const canHandover = sessionForGit.data?.kind === "local" && !sessionForGit.data.movedTo;
	const requestIntent = useGitUi((s) => s.requestIntent);
	const projectName = useMemo(() => new Map((projects.data ?? []).map((p) => [p.id, p.name])), [projects.data]);
	const tasks = useTasks();
	const recentTasks = useMemo(() => [...(tasks.data ?? [])].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 15), [tasks.data]);

	const run = (fn: () => void) => () => {
		setOpen(false);
		fn();
	};
	const go = (to: To, params?: Record<string, string>) => run(() => void navigate({ to, params } as never));
	const gitIntent = (action: "commit" | "create-pr" | "switch-branch") =>
		run(() => {
			if (!gitProjectId) return;
			void navigate({ to: "/projects/$projectId", params: { projectId: gitProjectId }, search: { tab: "git" } });
			requestIntent(gitProjectId, action);
		});

	return (
		<Command.Dialog
			open={open}
			onOpenChange={setOpen}
			label="Command palette"
			loop
			overlayClassName="clam-overlay fixed inset-0 z-[60] bg-[var(--scrim)] backdrop-blur-[2px]"
			contentClassName="clam-dialog fixed left-1/2 top-[max(1rem,12vh)] z-[61] flex max-h-[min(560px,calc(100dvh-2rem))] w-[calc(100vw-1.5rem)] max-w-xl -translate-x-1/2 flex-col overflow-hidden rounded-2xl bg-overlay shadow-pop shadow-[inset_0_0_0_1px_var(--border-strong)] outline-none"
		>
			<div className="flex items-center gap-2.5 border-b px-4">
				<Search className="size-4 shrink-0 text-subtle" />
				<Command.Input
					autoFocus
					placeholder="Search sessions, projects, commands…"
					className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-subtle coarse:h-14"
				/>
				<Kbd>esc</Kbd>
			</div>
			<Command.List className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-contain p-2 pb-3">
				<Command.Empty className="px-4 py-10 text-center text-[13px] text-subtle">No results.</Command.Empty>

				<Group heading="Create">
					<Item icon={LayersIcon} value="create new workspace" onSelect={run(() => openDialog({ kind: "create-workspace" }))}>
						New workspace
					</Item>
					<Item icon={FolderPlus} value="create add project" onSelect={run(() => openDialog({ kind: "create-project" }))}>
						Add project
					</Item>
					<Item icon={MessageSquarePlus} value="create new agent session" onSelect={run(() => openDialog({ kind: "create-session" }))}>
						New agent session
					</Item>
				</Group>

				{gitProjectId ? (
					<Group heading={`Git · ${projectName.get(gitProjectId) ?? "this project"}`}>
						<Item icon={CloudDownload} value="git fetch" keywords={["remote", "origin"]} onSelect={run(() => void runFetch(qc, gitProjectId))}>
							Fetch
						</Item>
						<Item icon={DownloadCloud} value="git pull fast-forward" onSelect={run(() => void runPull(qc, gitProjectId))}>
							Pull
						</Item>
						<Item icon={UploadCloud} value="git push publish" onSelect={run(() => void runPush(qc, gitProjectId, { setUpstream: true }))}>
							Push
						</Item>
						<Item icon={GitCommitHorizontal} value="git commit staged changes" onSelect={gitIntent("commit")}>
							Commit…
						</Item>
						<Item icon={GitPullRequest} value="git create pull request pr" onSelect={gitIntent("create-pr")}>
							Create pull request…
						</Item>
						<Item icon={GitBranch} value="git switch checkout branch" keywords={["branch"]} onSelect={gitIntent("switch-branch")}>
							Switch branch…
						</Item>
					</Group>
				) : null}

				{sessions.data && sessions.data.length > 0 ? (
					<Group heading="Sessions">
						{sessions.data.slice(0, 40).map((s) => (
							<Item
								key={s.id}
								icon={TerminalSquare}
								value={`session ${s.title} ${s.id} ${projectName.get(s.projectId) ?? ""}`}
								hint={
									<span className="flex items-center gap-1.5">
										{s.status === "running" ? <StatusDot status="busy" /> : null}
										{projectName.get(s.projectId)} · {relativeTime(s.updatedAt)}
									</span>
								}
								onSelect={go("/sessions/$sessionId", { sessionId: s.id })}
							>
								{s.title}
							</Item>
						))}
					</Group>
				) : null}

				{workspaces.data && workspaces.data.length > 0 ? (
					<Group heading="Workspaces">
						{workspaces.data.map((w) => (
							<Item key={w.id} icon={Layers} value={`workspace ${w.name}`} onSelect={go("/workspaces/$workspaceId", { workspaceId: w.id })}>
								{w.name}
							</Item>
						))}
					</Group>
				) : null}

				{projects.data && projects.data.length > 0 ? (
					<Group heading="Projects">
						{projects.data.map((p) => (
							<Item key={p.id} icon={FolderGit2} value={`project ${p.name} ${p.path}`} hint={p.path} onSelect={go("/projects/$projectId", { projectId: p.id })}>
								{p.name}
							</Item>
						))}
					</Group>
				) : null}

				<Group heading="Tasks">
					<Item icon={Send} value="delegate a task to an agent on another node" keywords={["send", "assign"]} onSelect={run(() => openDialog({ kind: "delegate-task" }))}>
						Delegate a task…
					</Item>
					<Item icon={ListChecks} value="open task board tasks" onSelect={go("/tasks")}>
						Task board
					</Item>
					{recentTasks.map((t) => (
						<Item
							key={t.id}
							icon={ListChecks}
							value={`task ${t.title} ${t.id} ${t.sender.nodeName} ${t.executor.nodeName}`}
							hint={t.direction === "incoming" && t.status === "offered" ? "waiting for you" : t.status}
							onSelect={go("/tasks/$taskId", { taskId: t.id })}
						>
							{t.title}
						</Item>
					))}
				</Group>

				<Group heading="Shared sessions">
					{canHandover && params.sessionId ? (
						<Item icon={ArrowRightLeft} value="hand over this session to another node agent continue transfer driver" keywords={["handoff", "stop", "continue", "transfer"]} onSelect={run(() => openDialog({ kind: "handover", sessionId: params.sessionId ?? "" }))}>
							Hand over this session…
						</Item>
					) : null}
					<Item icon={Users} value="shared sessions team participants mirror takeover" onSelect={go("/shared")}>
						Shared sessions
					</Item>
					{pendingInvites > 0 ? (
						<Item icon={Inbox} value="review shared session invitations invites accept" hint={`${pendingInvites} waiting`} onSelect={go("/shared")}>
							Review shared-session invitations
						</Item>
					) : null}
					{recentShared.map((s) => (
						<Item
							key={s.id}
							icon={Users}
							value={`shared session ${s.title} ${s.id} ${s.localRole}`}
							hint={s.takeoverAvailable ? "driver offline" : s.localRole === "participant" ? "live view" : s.localRole === "former_driver" ? "moved" : "driver"}
							onSelect={s.localSessionId ? go("/sessions/$sessionId", { sessionId: s.localSessionId }) : go("/shared")}
						>
							{s.title}
						</Item>
					))}
				</Group>

				<Group heading="Agent Network">
					<Item icon={UserPlus} value="invite a node pair create invitation code" onSelect={run(() => openDialog({ kind: "invite-node" }))}>
						Invite a node
					</Item>
					<Item icon={LogIn} value="join a node pair enter invitation code" onSelect={run(() => openDialog({ kind: "join-node" }))}>
						Join a node
					</Item>
					{waiting > 0 ? (
						<Item icon={Inbox} value="review pairing requests approve" hint={`${waiting} waiting`} onSelect={run(() => openDialog({ kind: "pairing-requests" }))}>
							Review pairing requests
						</Item>
					) : null}
					<Item icon={Bot} value="open agent directory network agents" onSelect={go("/network/agents")}>
						Open Agent Directory
					</Item>
					<Item icon={Network} value="connected nodes peers network" onSelect={go("/network/nodes")}>
						Connected Nodes
					</Item>
					{tunnel.data ? (
						tunnelBusy(tunnel.data.state) ? (
							<Item icon={StopIcon} value="stop cloudflare tunnel" onSelect={run(() => tunnelActions.stop.mutate())}>
								Stop tunnel
							</Item>
						) : (
							<Item
								icon={Play}
								value="start cloudflare tunnel"
								hint={tunnelReady ? undefined : "needs setup"}
								onSelect={tunnelReady ? run(() => tunnelActions.start.mutate()) : go("/settings/tunnel")}
							>
								Start tunnel
							</Item>
						)
					) : null}
				</Group>

				<Group heading="Go to">
					<Item icon={LayoutDashboard} value="go overview home" onSelect={go("/")}>Overview</Item>
					<Item icon={Layers} value="go workspaces" onSelect={go("/workspaces")}>Workspaces</Item>
					<Item icon={TerminalSquare} value="go agent sessions" onSelect={go("/node/sessions")}>Agent Sessions</Item>
					<Item icon={FolderGit2} value="go projects" onSelect={go("/node/projects")}>Projects</Item>
					<Item icon={GitBranch} value="go git status branches" onSelect={go("/node/git")}>Git</Item>
					<Item icon={Cpu} value="go runtime processes" onSelect={go("/node/runtime")}>Runtime</Item>
					<Item icon={Bot} value="go agents" onSelect={go("/agents")} keywords={["agent"]}>Agents</Item>
				</Group>

				<Group heading="Settings">
					<Item icon={Settings} value="settings general" onSelect={go("/settings/general")}>General</Item>
					<Item icon={GitFork} value="settings github accounts" onSelect={go("/settings/github")}>GitHub Accounts</Item>
					<Item icon={KeyRound} value="settings omp providers login models" onSelect={go("/settings/omp")}>OMP Providers & Login</Item>
					<Item icon={Gauge} value="settings llm usage cost tokens quota" onSelect={go("/settings/usage")}>LLM Usage</Item>
					<Item icon={Server} value="settings agent runtime" onSelect={go("/settings/runtime")}>Agent Runtime</Item>
					<Item icon={Globe} value="settings cloudflare tunnel" onSelect={go("/settings/tunnel")}>Cloudflare Tunnel</Item>
					<Item icon={ShieldCheck} value="settings security" onSelect={go("/settings/security")}>Security</Item>
					<Item icon={Info} value="settings about" onSelect={go("/settings/about")}>About</Item>
				</Group>

				<Group heading="Appearance">
					<Item icon={theme === "dark" ? Sun : Moon} value="toggle theme dark light" onSelect={run(toggleTheme)}>
						Switch to {theme === "dark" ? "light" : "dark"} theme
					</Item>
				</Group>
			</Command.List>
		</Command.Dialog>
	);
}
