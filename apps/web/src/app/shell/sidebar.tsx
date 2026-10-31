import type { Workspace } from "@clam/contracts";
import { Link, useParams } from "@tanstack/react-router";
import {
	Activity,
	Bot,
	BookMarked,
	ChevronRight,
	Command,
	FolderGit2,
	GitBranch,
	LayoutDashboard,
	ListChecks,
	Moon,
	Network,
	PanelLeftClose,
	PanelLeftOpen,
	Plus,
	Settings,
	Sun,
	TerminalSquare,
	Waypoints,
	Layers,
	Cpu,
	Users,
	type LucideIcon,
} from "lucide-react";
import { useEffect } from "react";
import { MILESTONES } from "@/lib/milestones";
import { isAwaitingApproval, isPendingInvite, taskNeedsAttention, usePairingRequests, useProjects, useSharedInvites, useSharedSessions, useTasks, useWorkspaces } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { toggleTheme, useResolvedTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Kbd } from "@/ui/kbd";
import { Skeleton } from "@/ui/skeleton";
import { Tip } from "@/ui/tooltip";
import { SignOutItem } from "@/features/auth/sign-out-item";
import { NodeStatusCard, NodeStatusDot } from "./node-status.tsx";

export const rowClass =
	"group/row relative flex h-8 min-w-0 items-center gap-2 rounded-lg px-2 text-[13px] text-muted-foreground outline-none transition-colors duration-150 hover:bg-surface-2 hover:text-foreground data-[status=active]:bg-surface-3 data-[status=active]:text-foreground coarse:h-11 [&_svg]:size-4 [&_svg]:shrink-0";

type StaticTo = "/" | "/workspaces" | "/node/sessions" | "/node/projects" | "/node/runtime" | "/node/git" | "/network/nodes" | "/network/agents" | "/tasks" | "/shared" | "/settings";

function NavLink({ to, icon: Icon, label, rail, exact, badge, badgeNoun = "pairing request" }: { to: StaticTo; icon: LucideIcon; label: string; rail: boolean; exact?: boolean; badge?: number; badgeNoun?: string }) {
	const link = (
		<Link
			to={to}
			activeOptions={{ exact }}
			preload="intent"
			className={cn(rowClass, rail && "justify-center px-0")}
			aria-label={rail ? (badge ? `${label} (${badge} waiting)` : label) : undefined}
		>
			<Icon />
			{rail ? null : <span className="flex-1 truncate">{label}</span>}
			{badge ? (
				rail ? (
					<span aria-hidden className="absolute right-1.5 top-1.5 size-2 rounded-full bg-accent" />
				) : (
					<span className="grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 font-mono text-2xs font-semibold text-accent-foreground" aria-label={`${badge} ${badgeNoun}${badge === 1 ? "" : "s"} waiting`}>
						{badge}
					</span>
				)
			) : null}
		</Link>
	);
	return rail ? (
		<Tip label={label} side="right">
			{link}
		</Tip>
	) : (
		link
	);
}

export function DisabledNav({ icon: Icon, label, milestone, rail }: { icon: LucideIcon; label: string; milestone: string; rail?: boolean }) {
	if (rail) return null;
	return (
		<div aria-disabled className={cn(rowClass, "cursor-not-allowed opacity-55 hover:bg-transparent hover:text-muted-foreground")} title={`${label} ships in ${milestone}`}>
			<Icon />
			<span className="flex-1 truncate">{label}</span>
			<Badge variant="outline">{milestone}</Badge>
		</div>
	);
}

function SectionLabel({ children, action }: { children: string; action?: React.ReactNode }) {
	return (
		<div className="mb-1 mt-4 flex items-center justify-between px-2 text-2xs font-semibold uppercase tracking-wider text-subtle">
			<span>{children}</span>
			{action}
		</div>
	);
}

function WsLink({ ws, to, icon: Icon, label }: { ws: Workspace; to: "agents" | "tasks" | "activity"; icon: LucideIcon; label: string }) {
	return (
		<Link to={`/workspaces/$workspaceId/${to}`} params={{ workspaceId: ws.id }} preload="intent" className={cn(rowClass, "h-7 coarse:h-10")}>
			<Icon />
			<span className="truncate">{label}</span>
		</Link>
	);
}

function WorkspaceNode({ ws }: { ws: Workspace }) {
	const expanded = useUi((s) => s.expandedWorkspaces.includes(ws.id));
	const toggle = useUi((s) => s.toggleWorkspaceExpanded);
	const params = useParams({ strict: false }) as { workspaceId?: string };
	const projects = useProjects(expanded ? ws.id : undefined);
	const active = params.workspaceId === ws.id;
	useEffect(() => {
		if (active) toggle(ws.id, true);
	}, [active, toggle, ws.id]);

	return (
		<div>
			<div className="flex items-center">
				<button
					type="button"
					aria-label={expanded ? "Collapse workspace" : "Expand workspace"}
					aria-expanded={expanded}
					onClick={() => toggle(ws.id)}
					className="grid size-6 shrink-0 place-items-center rounded-md text-subtle outline-none hover:text-foreground coarse:size-9"
				>
					<ChevronRight className={cn("size-3.5 transition-transform duration-200", expanded && "rotate-90")} />
				</button>
				<Link to="/workspaces/$workspaceId" params={{ workspaceId: ws.id }} preload="intent" className={cn(rowClass, "flex-1 gap-1.5 px-1.5")}>
					<Layers />
					<span className="truncate">{ws.name}</span>
					<span className="ml-auto font-mono text-2xs text-subtle">{ws.projectCount}</span>
				</Link>
			</div>
			{expanded ? (
				<div className="ml-3 mt-0.5 flex flex-col gap-px border-l pl-2">
					{projects.isLoading ? <Skeleton className="m-1 h-5 w-28" /> : null}
					{projects.data?.map((p) => (
						<Link key={p.id} to="/projects/$projectId" params={{ projectId: p.id }} preload="intent" className={cn(rowClass, "h-7 coarse:h-10")}>
							<FolderGit2 />
							<span className="truncate">{p.name}</span>
						</Link>
					))}
					{projects.data?.length === 0 ? <span className="px-2 py-1 text-2xs text-subtle">No projects yet</span> : null}
					<WsLink ws={ws} to="agents" icon={Bot} label="Agents" />
					<WsLink ws={ws} to="tasks" icon={ListChecks} label="Tasks" />
					<DisabledNav icon={BookMarked} label="Shared Context" milestone={MILESTONES.sharedContext} />
					<WsLink ws={ws} to="activity" icon={Activity} label="Activity" />
				</div>
			) : null}
		</div>
	);
}

/** Navigation tree shared by the desktop sidebar and the mobile drawer. */
export function NavTree({ rail = false, onNavigate }: { rail?: boolean; onNavigate?: () => void }) {
	const workspaces = useWorkspaces();
	const waiting = (usePairingRequests().data ?? []).filter(isAwaitingApproval).length;
	const attention = (useTasks().data ?? []).filter(taskNeedsAttention).length;
	// Invitations to answer plus shared discussions with unread messages.
	const sharedAttention = (useSharedInvites().data ?? []).filter(isPendingInvite).length + (useSharedSessions().data ?? []).filter((s) => s.unreadMessages > 0).length;
	const openDialog = useUi((s) => s.openDialog);
	return (
		<nav aria-label="Primary" className="flex flex-col px-2 pb-3" onClick={(e) => (e.target as HTMLElement).closest("a") && onNavigate?.()}>
			<NavLink to="/" icon={LayoutDashboard} label="Overview" rail={rail} exact />

			{rail ? (
				<>
					<div className="my-2 h-px bg-border" />
					<NavLink to="/workspaces" icon={Layers} label="Workspaces" rail />
					<NavLink to="/node/sessions" icon={TerminalSquare} label="Agent Sessions" rail />
					<NavLink to="/node/projects" icon={FolderGit2} label="Projects" rail />
					<NavLink to="/node/git" icon={GitBranch} label="Git" rail />
					<NavLink to="/node/runtime" icon={Cpu} label="Runtime" rail />
					<div className="my-2 h-px bg-border" />
					<NavLink to="/network/nodes" icon={Network} label="Connected Nodes" rail badge={waiting} />
					<NavLink to="/network/agents" icon={Bot} label="Agent Directory" rail />
					<NavLink to="/tasks" icon={ListChecks} label="Tasks" rail badge={attention} badgeNoun="task" />
					<NavLink to="/shared" icon={Users} label="Shared Sessions" rail badge={sharedAttention} badgeNoun="shared-session update" />
				</>
			) : (
				<>
					<SectionLabel
						action={
							<Tip label="New workspace" side="right">
								<button
									type="button"
									aria-label="New workspace"
									onClick={() => openDialog({ kind: "create-workspace" })}
									className="grid size-5 place-items-center rounded-md text-subtle outline-none hover:bg-surface-2 hover:text-foreground coarse:size-8"
								>
									<Plus className="size-3.5" />
								</button>
							</Tip>
						}
					>
						Workspaces
					</SectionLabel>
					<div className="flex flex-col gap-px">
						{workspaces.isLoading ? (
							<>
								<Skeleton className="mx-1 my-1 h-6" />
								<Skeleton className="mx-1 my-1 h-6 w-3/4" />
							</>
						) : null}
						{workspaces.data?.map((ws) => (
							<WorkspaceNode key={ws.id} ws={ws} />
						))}
						{workspaces.data?.length === 0 ? (
							<button type="button" onClick={() => openDialog({ kind: "create-workspace" })} className={cn(rowClass, "text-accent hover:text-accent")}>
								<Plus />
								<span>Create your first workspace</span>
							</button>
						) : null}
					</div>

					<SectionLabel>My Node</SectionLabel>
					<div className="flex flex-col gap-px">
						<NavLink to="/node/sessions" icon={TerminalSquare} label="Agent Sessions" rail={false} />
						<NavLink to="/node/projects" icon={FolderGit2} label="Projects" rail={false} />
						<NavLink to="/node/runtime" icon={Cpu} label="Runtime" rail={false} />
						<NavLink to="/node/git" icon={GitBranch} label="Git" rail={false} />
					</div>

					<SectionLabel>Agent Network</SectionLabel>
					<NavLink to="/network/nodes" icon={Network} label="Connected Nodes" rail={false} badge={waiting} />
					<NavLink to="/network/agents" icon={Bot} label="Agent Directory" rail={false} />
					<NavLink to="/tasks" icon={ListChecks} label="Tasks" rail={false} badge={attention} badgeNoun="task" />
					<NavLink to="/shared" icon={Users} label="Shared Sessions" rail={false} badge={sharedAttention} badgeNoun="shared-session update" />
					<DisabledNav icon={Waypoints} label="Handoffs" milestone={MILESTONES.handoffs} />
				</>
			)}
		</nav>
	);
}

export function Logo({ className }: { className?: string }) {
	return (
		<div className={cn("grid size-7 shrink-0 place-items-center rounded-lg bg-accent text-accent-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.25)]", className)}>
			<Network className="size-4" strokeWidth={2.4} />
		</div>
	);
}

export function ThemeToggle({ className }: { className?: string }) {
	const theme = useResolvedTheme();
	return (
		<Tip label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}>
			<Button variant="ghost" size="icon" className={className} onClick={toggleTheme} aria-label="Toggle theme">
				{theme === "dark" ? <Sun /> : <Moon />}
			</Button>
		</Tip>
	);
}

export function PaletteButton({ rail }: { rail?: boolean }) {
	const setPaletteOpen = useUi((s) => s.setPaletteOpen);
	if (rail)
		return (
			<Tip label="Command palette" shortcut="⌘K" side="right">
				<Button variant="ghost" size="icon" onClick={() => setPaletteOpen(true)} aria-label="Open command palette">
					<Command />
				</Button>
			</Tip>
		);
	return (
		<button
			type="button"
			onClick={() => setPaletteOpen(true)}
			className="flex h-8 flex-1 items-center gap-2 rounded-lg bg-surface-2 px-2.5 text-xs text-subtle shadow-[inset_0_0_0_1px_var(--border)] outline-none transition-colors hover:bg-surface-3 hover:text-muted-foreground"
		>
			<Command className="size-3.5" />
			<span className="flex-1 text-left">Search or jump to…</span>
			<Kbd>⌘K</Kbd>
		</button>
	);
}

export function Sidebar({ mode }: { mode: "full" | "rail" }) {
	const collapsedPref = useUi((s) => s.sidebarCollapsed);
	const setCollapsed = useUi((s) => s.setSidebarCollapsed);
	const rail = mode === "rail" || collapsedPref;
	return (
		<aside
			className={cn("flex h-full shrink-0 flex-col border-r bg-surface-1 pt-safe", rail ? "w-14" : "w-[17rem]")}
			aria-label="Sidebar"
		>
			<div className={cn("flex items-center gap-2 px-3 pb-2 pt-3", rail && "flex-col px-2")}>
				<Logo />
				{rail ? null : (
					<div className="flex min-w-0 flex-1 flex-col leading-tight">
						<span className="truncate text-[13px] font-semibold tracking-tight">CL Agent Mesh</span>
						<span className="truncate text-2xs text-subtle">Local node</span>
					</div>
				)}
				{rail ? <NodeStatusDot /> : null}
			</div>
			<div className={cn("flex items-center gap-1.5 px-3 pb-2", rail && "flex-col px-2")}>
				<PaletteButton rail={rail} />
			</div>
			{rail ? null : (
				<div className="px-3 pb-1">
					<NodeStatusCard />
				</div>
			)}
			<div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-contain pt-1">
				<NavTree rail={rail} />
			</div>
			<div className={cn("flex items-center gap-1 border-t p-2", rail && "flex-col")}>
				<NavLinkSettings rail={rail} />
				<ThemeToggle />
				{rail ? <SignOutItem compact /> : null}
				{mode === "full" ? (
					<Tip label={rail ? "Expand sidebar" : "Collapse sidebar"}>
						<Button variant="ghost" size="icon" onClick={() => setCollapsed(!collapsedPref)} aria-label={rail ? "Expand sidebar" : "Collapse sidebar"}>
							{rail ? <PanelLeftOpen /> : <PanelLeftClose />}
						</Button>
					</Tip>
				) : null}
			</div>
		</aside>
	);
}

function NavLinkSettings({ rail }: { rail: boolean }) {
	return (
		<Tip label="Settings" side="right">
			<Link
				to="/settings"
				preload="intent"
				aria-label="Settings"
				className={cn(rowClass, "flex-1", rail && "flex-none justify-center px-0 size-8")}
			>
				<Settings />
				{rail ? null : <span>Settings</span>}
			</Link>
		</Tip>
	);
}
