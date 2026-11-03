import type { AgentSession, Workspace } from "@clam/contracts";
import { Link, useParams } from "@tanstack/react-router";
import {
	Activity,
	Bot,
	BookMarked,
	ChevronRight,
	Command,
	Folder,
	FolderGit2,
	GitBranch,
	Globe,
	LayoutDashboard,
	ListChecks,
	MessageSquarePlus,
	MessagesSquare,
	Monitor,
	Moon,
	Network,
	PanelLeftClose,
	PanelLeftOpen,
	Plus,
	Settings,
	Sun,
	Terminal,
	TerminalSquare,
	Waypoints,
	Layers,
	Cpu,
	Users,
	type LucideIcon,
} from "lucide-react";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ChatContextMenu, ChatRowMenu } from "@/features/chats/chat-actions";
import { useChats } from "@/features/chats/hooks";
import { useActiveHandoffCount } from "@/features/handoff/api";
import { warmHandlers } from "@/features/session/preload";
import { hueOf, hueStyle } from "@/features/shared/identity";
import { t, tr } from "@/i18n";
import { isAwaitingApproval, isPendingInvite, taskNeedsAttention, usePairingRequests, useProjects, useRuntime, useSessions, useSharedInvites, useSharedSessions, useTasks, useWorkspaces } from "@/lib/queries";
import { RUNTIME_STATE_LABEL, runtimeDot } from "@/components/session-status";
import { StatusDot } from "@/ui/status-dot";
import { useUi } from "@/lib/store";
import { cycleTheme, THEME_LABEL, type ThemePref, useThemePref } from "@/lib/theme";
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

type StaticTo = "/" | "/chats" | "/workspaces" | "/node/sessions" | "/node/projects" | "/node/runtime" | "/node/git" | "/terminal" | "/browser" | "/network/nodes" | "/network/agents" | "/tasks" | "/shared" | "/handoffs" | "/settings";

type BadgeKind = "pairing" | "task" | "shared" | "handoff";

function badgeLabel(kind: BadgeKind, count: number): string {
	switch (kind) {
		case "pairing":
			return t("{count, plural, one {# pairing request waiting} other {# pairing requests waiting}}", { count });
		case "task":
			return t("{count, plural, one {# task waiting} other {# tasks waiting}}", { count });
		case "shared":
			return t("{count, plural, one {# shared-session update waiting} other {# shared-session updates waiting}}", { count });
		case "handoff":
			return t("{count, plural, one {# active handoff waiting} other {# active handoffs waiting}}", { count });
	}
}

function NavLink({ to, icon: Icon, label, rail, exact, badge, badgeKind = "pairing" }: { to: StaticTo; icon: LucideIcon; label: string; rail: boolean; exact?: boolean; badge?: number; badgeKind?: BadgeKind }) {
	const link = (
		<Link
			to={to}
			activeOptions={{ exact }}
			preload="intent"
			className={cn(rowClass, rail && "justify-center px-0")}
			aria-label={rail ? (badge ? t("{label} ({count} waiting)", { label, count: badge }) : label) : undefined}
		>
			<Icon />
			{rail ? null : <span className="flex-1 truncate">{label}</span>}
			{badge ? (
				rail ? (
					<span aria-hidden className="absolute right-1.5 top-1.5 size-2 rounded-full bg-accent" />
				) : (
					<span className="grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 font-mono text-2xs font-semibold text-accent-foreground" aria-label={badgeLabel(badgeKind, badge)}>
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
		<div aria-disabled className={cn(rowClass, "cursor-not-allowed opacity-55 hover:bg-transparent hover:text-muted-foreground")} title={t("{label} ships in {milestone}", { label, milestone })}>
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

function WsLink({ ws, to, icon: Icon, label }: { ws: Workspace; to: "agents" | "tasks" | "activity" | "context" | "members"; icon: LucideIcon; label: string }) {
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
					aria-label={expanded ? t("Collapse workspace") : t("Expand workspace")}
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
					{projects.data?.filter((p) => p.origin !== "chat").map((p) => (
						<Link key={p.id} to="/projects/$projectId" params={{ projectId: p.id }} preload="intent" className={cn(rowClass, "h-7 coarse:h-10")}>
							{p.vcs === "none" ? <Folder /> : <FolderGit2 />}
							<span className="truncate">{p.name}</span>
						</Link>
					))}
					{projects.data?.filter((p) => p.origin !== "chat").length === 0 ? <span className="px-2 py-1 text-2xs text-subtle">{t("No projects yet")}</span> : null}
					<WsLink ws={ws} to="agents" icon={Bot} label={t("Agents")} />
					<WsLink ws={ws} to="tasks" icon={ListChecks} label={t("Tasks")} />
					<WsLink ws={ws} to="context" icon={BookMarked} label={t("Shared Context")} />
					<WsLink ws={ws} to="members" icon={Users} label={t("Members")} />
					<WsLink ws={ws} to="activity" icon={Activity} label={t("Activity")} />
				</div>
			) : null}
		</div>
	);
}

function NewChatButton({ rail }: { rail: boolean }) {
	const openDialog = useUi((s) => s.openDialog);
	const setDrawerOpen = useUi((st) => st.setDrawerOpen);
	const open = () => {
		setDrawerOpen(false);
		openDialog({ kind: "new-chat" });
	};
	if (rail)
		return (
			<Tip label={t("New chat")} side="right">
				<Button variant="soft" size="icon" aria-label={t("New chat")} onClick={open} className="mx-auto mb-1">
					<MessageSquarePlus />
				</Button>
			</Tip>
		);
	return (
		<Button variant="soft" size="lg" onClick={open} className="mb-1 w-full justify-start gap-2 px-3 text-[13px] coarse:min-h-12">
			<MessageSquarePlus /> {t("New chat")}
		</Button>
	);
}

/** One chat of the sidebar: link, a "⋯" menu on hover/focus (always on touch) and a right-click menu, both with Delete. */
function ChatNavItem({ session: s, current, qc }: { session: AgentSession; current: boolean; qc: QueryClient }) {
	const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
	return (
		<div className="group/row relative" onContextMenu={(e) => {
			e.preventDefault();
			setMenuAt({ x: e.clientX, y: e.clientY });
		}}>
			<Link
				to="/sessions/$sessionId"
				params={{ sessionId: s.id }}
				{...warmHandlers(qc, s.id, s.status)}
				preload="intent"
				aria-current={current ? "page" : undefined}
				className={cn(rowClass, "group-hover/row:pr-8 group-focus-within/row:pr-8 coarse:pr-10", current && "bg-surface-3 text-foreground")}
			>
				<MessagesSquare />
				<span className="min-w-0 flex-1 truncate">{s.title || t("Untitled chat")}</span>
				{s.pendingRequests > 0 ? (
					<span role="img" aria-label={t("Waiting for your answer")} title={t("Waiting for your answer")} className="relative grid size-2 shrink-0 place-items-center">
						<span aria-hidden className="absolute inline-flex size-full animate-[clam-pulse-ring_1.6s_ease-out_infinite] rounded-full bg-warning" />
						<span aria-hidden className="relative size-2 rounded-full bg-warning" />
					</span>
				) : null}
			</Link>
			<ChatRowMenu session={s} className="absolute right-0.5 top-1/2 -translate-y-1/2" />
			{menuAt ? <ChatContextMenu session={s} point={menuAt} onClose={() => setMenuAt(null)} /> : null}
		</div>
	);
}

const CHATS_SHOWN = 6;

/** Recent chats (sessions without a repository) under their own heading, not mixed into the project tree. */
function ChatsSection() {
	const { chats, isPending } = useChats();
	const params = useParams({ strict: false }) as { sessionId?: string };
	const qc = useQueryClient();
	const shown = chats.slice(0, CHATS_SHOWN);
	return (
		<>
			<SectionLabel
				action={
					<Link to="/chats" preload="intent" className="rounded-md px-1 text-2xs font-medium normal-case tracking-normal text-subtle outline-none hover:text-foreground">
						{chats.length > CHATS_SHOWN ? t("All {count}", { count: chats.length }) : t("All")}
					</Link>
				}
			>
				{t("Chats")}
			</SectionLabel>
			<div className="flex flex-col gap-px">
				{isPending ? <Skeleton className="mx-1 my-1 h-6" /> : null}
				{shown.map((s) => (
					<ChatNavItem key={s.id} session={s} current={params.sessionId === s.id} qc={qc} />
				))}
				{!isPending && chats.length === 0 ? <span className="px-2 py-1 text-2xs text-subtle">{t("No chats yet — start one above")}</span> : null}
			</div>
		</>
	);
}

/** Busy first, then a crashed one (it needs a look), then the rest. */
const RUNNING_ORDER: Partial<Record<string, number>> = { busy: 0, crashed: 1 };

/**
 * Sessions whose agent process is up right now (busy first, then most recently active): one click to switch between the work in flight.
 * Hidden when nothing runs; the Runtime page keeps the full table with stop/restart.
 */
function RunningSection() {
	const runtime = useRuntime().data;
	const sessions = useSessions().data;
	// Every project of the node (no workspace filter): the badge names the project a runtime works in, or says "Chat" for a chat's own folder.
	const projects = useProjects().data;
	const params = useParams({ strict: false }) as { sessionId?: string };
	const qc = useQueryClient();
	const live = (runtime ?? []).filter((r) => r.state !== "stopped");
	if (live.length === 0) return null;
	const byId = new Map((sessions ?? []).map((s) => [s.id, s] as const));
	const projectOf = new Map((projects ?? []).map((p) => [p.id, p] as const));
	const rows = [...live].sort((a, b) => (RUNNING_ORDER[a.state] ?? 2) - (RUNNING_ORDER[b.state] ?? 2) || (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""));
	return (
		<>
			<SectionLabel
				action={
					<Link to="/node/runtime" preload="intent" className="rounded-md px-1 text-2xs font-medium normal-case tracking-normal text-subtle outline-none hover:text-foreground">
						{t("Manage")}
					</Link>
				}
			>
				{t("Running")}
			</SectionLabel>
			<div className="flex flex-col gap-px">
				{rows.map((r) => {
					const s = byId.get(r.sessionId);
					const project = s ? projectOf.get(s.projectId) : undefined;
					const current = params.sessionId === r.sessionId;
					return (
						<Link
							key={r.sessionId}
							to="/sessions/$sessionId"
							params={{ sessionId: r.sessionId }}
							{...warmHandlers(qc, r.sessionId, s?.status ?? "ready")}
							preload="intent"
							aria-current={current ? "page" : undefined}
							className={cn(rowClass, current && "bg-surface-3 text-foreground")}
						>
							<span className="grid size-4 shrink-0 place-items-center">
								<StatusDot status={runtimeDot(r.state)} label={tr(RUNTIME_STATE_LABEL[r.state])} />
							</span>
							<span className="min-w-0 flex-1 truncate">{s?.title || t("Untitled session")}</span>
							{project?.origin === "chat" ? (
								<span title={t("Chat")} className="inline-flex shrink-0 items-center gap-1 rounded-md bg-accent-soft px-1.5 py-px text-[10px] font-medium leading-4 text-accent">
									<MessagesSquare className="size-2.5" aria-hidden />
									{t("Chat")}
								</span>
							) : project ? (
								// One colour per project (stable: derived from its id), so the same project reads the same at a glance.
								<span
									title={t("Project: {name}", { name: project.name })}
									style={hueStyle(hueOf(project.id, null))}
									className="inline-flex min-w-0 max-w-[45%] shrink-0 items-center gap-1 rounded-md bg-[oklch(0.95_0.035_var(--hue))] px-1.5 py-px text-[10px] font-medium leading-4 text-[oklch(0.45_0.13_var(--hue))] shadow-[inset_0_0_0_1px_oklch(0.88_0.06_var(--hue))] dark:bg-[oklch(0.3_0.05_var(--hue))] dark:text-[oklch(0.85_0.09_var(--hue))] dark:shadow-[inset_0_0_0_1px_oklch(0.4_0.07_var(--hue))]"
								>
									<FolderGit2 className="size-2.5 shrink-0" aria-hidden />
									<span className="truncate">{project.name}</span>
								</span>
							) : null}
							{s && s.pendingRequests > 0 ? <span role="img" aria-label={t("Waiting for your answer")} title={t("Waiting for your answer")} className="size-2 shrink-0 rounded-full bg-warning" /> : null}
						</Link>
					);
				})}
			</div>
		</>
	);
}

/** Navigation tree shared by the desktop sidebar and the mobile drawer. */
export function NavTree({ rail = false, onNavigate }: { rail?: boolean; onNavigate?: () => void }) {
	const workspaces = useWorkspaces();
	const waiting = (usePairingRequests().data ?? []).filter(isAwaitingApproval).length;
	const attention = (useTasks().data ?? []).filter(taskNeedsAttention).length;
	// Invitations to answer plus shared discussions with unread messages.
	const sharedAttention = (useSharedInvites().data ?? []).filter(isPendingInvite).length + (useSharedSessions().data ?? []).filter((s) => s.unreadMessages > 0).length;
	const handoffs = useActiveHandoffCount();
	const openDialog = useUi((s) => s.openDialog);
	return (
		<nav aria-label={t("Primary")} className="flex flex-col px-2 pb-3" onClick={(e) => (e.target as HTMLElement).closest("a") && onNavigate?.()}>
			<NewChatButton rail={rail} />
			<NavLink to="/" icon={LayoutDashboard} label={t("Overview")} rail={rail} exact />

			{rail ? (
				<>
					<div className="my-2 h-px bg-border" />
					<NavLink to="/chats" icon={MessagesSquare} label={t("Chats")} rail />
					<NavLink to="/workspaces" icon={Layers} label={t("Workspaces")} rail />
					<NavLink to="/node/sessions" icon={TerminalSquare} label={t("Agent Sessions")} rail />
					<NavLink to="/node/projects" icon={FolderGit2} label={t("Projects")} rail />
					<NavLink to="/node/git" icon={GitBranch} label={t("Git")} rail />
					<NavLink to="/node/runtime" icon={Cpu} label={t("Runtime")} rail />
					<NavLink to="/terminal" icon={Terminal} label={t("Terminal")} rail />
					<NavLink to="/browser" icon={Globe} label={t("Browser")} rail />
					<div className="my-2 h-px bg-border" />
					<NavLink to="/network/nodes" icon={Network} label={t("Machines")} rail badge={waiting} />
					<NavLink to="/network/agents" icon={Bot} label={t("Agent Directory")} rail />
					<NavLink to="/tasks" icon={ListChecks} label={t("Tasks")} rail badge={attention} badgeKind="task" />
					<NavLink to="/shared" icon={Users} label={t("Shared Sessions")} rail badge={sharedAttention} badgeKind="shared" />
					<NavLink to="/handoffs" icon={Waypoints} label={t("Handoffs")} rail badge={handoffs} badgeKind="handoff" />
				</>
			) : (
				<>
					<RunningSection />
					<ChatsSection />
					<SectionLabel
						action={
							<Tip label={t("New workspace")} side="right">
								<button
									type="button"
									aria-label={t("New workspace")}
									onClick={() => openDialog({ kind: "create-workspace" })}
									className="grid size-5 place-items-center rounded-md text-subtle outline-none hover:bg-surface-2 hover:text-foreground coarse:size-8"
								>
									<Plus className="size-3.5" />
								</button>
							</Tip>
						}
					>
						{t("Workspaces")}
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
								<span>{t("Create your first workspace")}</span>
							</button>
						) : null}
					</div>

					<SectionLabel>{t("This Machine")}</SectionLabel>
					<div className="flex flex-col gap-px">
						<NavLink to="/node/sessions" icon={TerminalSquare} label={t("Agent Sessions")} rail={false} />
						<NavLink to="/node/projects" icon={FolderGit2} label={t("Projects")} rail={false} />
						<NavLink to="/node/runtime" icon={Cpu} label={t("Runtime")} rail={false} />
						<NavLink to="/node/git" icon={GitBranch} label={t("Git")} rail={false} />
						<NavLink to="/terminal" icon={Terminal} label={t("Terminal")} rail={false} />
						<NavLink to="/browser" icon={Globe} label={t("Browser")} rail={false} />
					</div>

					<SectionLabel>{t("Agent Network")}</SectionLabel>
					<NavLink to="/network/nodes" icon={Network} label={t("Machines")} rail={false} badge={waiting} />
					<NavLink to="/network/agents" icon={Bot} label={t("Agent Directory")} rail={false} />
					<NavLink to="/tasks" icon={ListChecks} label={t("Tasks")} rail={false} badge={attention} badgeKind="task" />
					<NavLink to="/shared" icon={Users} label={t("Shared Sessions")} rail={false} badge={sharedAttention} badgeKind="shared" />
					<NavLink to="/handoffs" icon={Waypoints} label={t("Handoffs")} rail={false} badge={handoffs} badgeKind="handoff" />
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

const THEME_ICON: Record<ThemePref, LucideIcon> = { system: Monitor, light: Sun, dark: Moon };
const NEXT_THEME: Record<ThemePref, ThemePref> = { system: "light", light: "dark", dark: "system" };

/** Cycles System → Light → Dark; the icon shows the current preference. Settings → General has the full picker. */
export function ThemeToggle({ className }: { className?: string }) {
	const pref = useThemePref();
	const Icon = THEME_ICON[pref];
	return (
		<Tip label={t("Theme: {theme} · switch to {next}", { theme: tr(THEME_LABEL[pref]), next: tr(THEME_LABEL[NEXT_THEME[pref]]) })}>
			<Button variant="ghost" size="icon" className={className} onClick={cycleTheme} aria-label={t("Theme: {theme}. Switch to {next}", { theme: tr(THEME_LABEL[pref]), next: tr(THEME_LABEL[NEXT_THEME[pref]]) })}>
				<Icon />
			</Button>
		</Tip>
	);
}

export function PaletteButton({ rail }: { rail?: boolean }) {
	const setPaletteOpen = useUi((s) => s.setPaletteOpen);
	if (rail)
		return (
			<Tip label={t("Command palette")} shortcut="⌘K" side="right">
				<Button variant="ghost" size="icon" onClick={() => setPaletteOpen(true)} aria-label={t("Open command palette")}>
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
			<span className="flex-1 text-left">{t("Search or jump to…")}</span>
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
			className={cn("flex h-full shrink-0 flex-col border-r bg-surface-1 pb-safe pl-[env(safe-area-inset-left)] pt-safe", rail ? "w-14" : "w-[17rem]")}
			aria-label={t("Sidebar")}
		>
			<div className={cn("flex items-center gap-2 px-3 pb-2 pt-3", rail && "flex-col px-2")}>
				<Logo />
				{rail ? null : (
					<div className="flex min-w-0 flex-1 flex-col leading-tight">
						<span className="truncate text-[13px] font-semibold tracking-tight">CL Agent Mesh</span>
						<span className="truncate text-2xs text-subtle">{t("This machine")}</span>
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
					<Tip label={rail ? t("Expand sidebar") : t("Collapse sidebar")}>
						<Button variant="ghost" size="icon" onClick={() => setCollapsed(!collapsedPref)} aria-label={rail ? t("Expand sidebar") : t("Collapse sidebar")}>
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
		<Tip label={t("Settings")} side="right">
			<Link
				to="/settings"
				preload="intent"
				aria-label={t("Settings")}
				className={cn(rowClass, "flex-1", rail && "flex-none justify-center px-0 size-8")}
			>
				<Settings />
				{rail ? null : <span>{t("Settings")}</span>}
			</Link>
		</Tip>
	);
}
