import type { AgentSession } from "@clam/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { Bot, ChevronDown, FileText, GitBranch, MessagesSquare, RotateCw, ScrollText, SearchX, TriangleAlert, Users, X } from "lucide-react";
import { lazy, type ReactNode, type RefObject, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ImperativePanelHandle, Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { toast } from "sonner";
import { useGitStatus } from "@/features/git/hooks";
import { useSharedDetail, useSharedLive } from "@/features/shared/hooks";
import { GroupBar, GroupChat } from "@/features/shared/group-chat";
import { SharedBanner } from "@/features/shared/shared-banner";
import { TaskBanner } from "@/features/tasks/task-banner";
import { useBreakpoint } from "@/hooks/use-breakpoint";
import { ApiError, errorMessage } from "@/lib/api";
import { useProject, useSession, useWorkspaces } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { basename, cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty-state";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/ui/sheet";
import { Skeleton } from "@/ui/skeleton";
import { ApprovalDock } from "./approval-dialog.tsx";
import { Composer } from "./composer.tsx";
import { ContextPanel } from "./context-panel.tsx";
import { Conversation } from "./conversation.tsx";
import { RuntimeLog } from "./runtime-log.tsx";
import { SessionHeader } from "./session-header.tsx";
import { SessionStream, StreamContext, useStreamMeta } from "./stream-store.ts";
import { ThreadsPanel } from "./threads-panel.tsx";
import { useKeyboardInset } from "./use-keyboard-inset.ts";

const GitWorkbench = lazy(() => import("@/features/git/git-panel.tsx"));
const FileViewer = lazy(() => import("@/features/projects/file-viewer.tsx").then((m) => ({ default: m.FileViewer })));
const TeamPanel = lazy(() => import("@/features/shared/team-panel.tsx").then((m) => ({ default: m.TeamPanel })));
const AddAgentDialog = lazy(() => import("@/features/shared/add-agent-dialog.tsx"));

// ───────────────────────────── page gate ─────────────────────────────

export default function SessionPage() {
	const { sessionId } = useParams({ strict: false }) as { sessionId?: string };
	if (!sessionId) return null;
	return <SessionGate key={sessionId} sessionId={sessionId} />;
}

function PageSkeleton() {
	return (
		<div className="flex h-full flex-col" aria-busy="true" aria-label="Loading session">
			<div className="flex h-12 shrink-0 items-center gap-3 border-b px-3">
				<Skeleton className="size-8" />
				<Skeleton className="h-4 w-48" />
			</div>
			<div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-6">
				<div className="flex justify-end">
					<Skeleton className="h-9 w-2/5 rounded-2xl" />
				</div>
				<div className="flex flex-col gap-2">
					<Skeleton className="h-4 w-11/12" />
					<Skeleton className="h-4 w-4/5" />
					<Skeleton className="h-4 w-3/5" />
				</div>
			</div>
			<div className="mx-auto w-full max-w-3xl px-4 pb-4">
				<Skeleton className="h-[88px] rounded-2xl" />
			</div>
		</div>
	);
}

function SessionGate({ sessionId }: { sessionId: string }) {
	const q = useSession(sessionId);
	if (q.data) return <Workspace session={q.data} />;
	if (q.isPending) return <PageSkeleton />;
	if (q.error instanceof ApiError && q.error.status === 404) {
		return (
			<EmptyState
				className="h-full"
				icon={SearchX}
				title="Session not found"
				description="It may have been deleted, or the link is wrong."
				action={
					<Button asChild variant="outline">
						<Link to="/node/sessions">View all sessions</Link>
					</Button>
				}
			/>
		);
	}
	return (
		<EmptyState
			className="h-full"
			icon={TriangleAlert}
			title="Could not load this session"
			description={errorMessage(q.error)}
			action={
				<Button variant="outline" onClick={() => void q.refetch()}>
					<RotateCw /> Retry
				</Button>
			}
		/>
	);
}

// ───────────────────────────── panel helpers ─────────────────────────────

interface PanelToggleState {
	ref: RefObject<ImperativePanelHandle | null>;
	collapsed: boolean;
	toggle: () => void;
	open: () => void;
	onCollapse: () => void;
	onExpand: () => void;
}

/** Imperative collapse/expand with React state mirrored from the (persisted) panel layout. */
function usePanelToggle(openSize: number): PanelToggleState {
	const ref = useRef<ImperativePanelHandle>(null);
	const [collapsed, setCollapsed] = useState(false);
	useEffect(() => {
		const p = ref.current;
		if (p) setCollapsed(p.isCollapsed());
	}, []);
	const open = useCallback(() => {
		const p = ref.current;
		if (!p || !p.isCollapsed()) return;
		p.expand();
		requestAnimationFrame(() => {
			if (p.getSize() < 4) p.resize(openSize);
		});
	}, [openSize]);
	const toggle = useCallback(() => {
		const p = ref.current;
		if (!p) return;
		if (p.isCollapsed()) open();
		else p.collapse();
	}, [open]);
	const onCollapse = useCallback(() => setCollapsed(true), []);
	const onExpand = useCallback(() => setCollapsed(false), []);
	return { ref, collapsed, toggle, open, onCollapse, onExpand };
}

function isTyping(t: EventTarget | null): boolean {
	return t instanceof HTMLElement && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
}

function StateBanner({ stream }: { stream: SessionStream }) {
	const live = useStreamMeta(stream, (m) => m.live);
	const liveStatus = useStreamMeta(stream, (m) => m.liveStatus);
	const liveError = useStreamMeta(stream, (m) => m.liveError);
	const [restarting, setRestarting] = useState(false);
	let body: ReactNode = null;
	let action: ReactNode = null;
	if (!live && liveStatus === "error") {
		body = (
			<>
				<span className="font-medium">Could not reach the runtime.</span> {errorMessage(liveError)}
			</>
		);
		action = (
			<Button size="sm" variant="outline" onClick={() => void stream.retry()}>
				<RotateCw /> Retry
			</Button>
		);
	} else if (live?.runtime.state === "crashed") {
		body = (
			<>
				<span className="font-medium">The runtime crashed.</span> {live.runtime.lastError ?? "No error details were reported."}
			</>
		);
		action = (
			<Button
				size="sm"
				variant="outline"
				loading={restarting}
				onClick={() => {
					setRestarting(true);
					stream
						.restartRuntime()
						.catch((e) => toast.error(`Could not restart the runtime: ${errorMessage(e)}`))
						.finally(() => setRestarting(false));
				}}
			>
				<RotateCw /> Restart
			</Button>
		);
	}
	if (!body) return null;
	return (
		<div role="alert" className="animate-fade-in flex shrink-0 items-center gap-3 border-b bg-danger/8 px-3 py-2 text-[13px] text-danger">
			<TriangleAlert className="size-4 shrink-0" aria-hidden />
			<p className="line-clamp-2 min-w-0 flex-1 break-words">{body}</p>
			{action}
		</div>
	);
}

// ───────────────────────────── workspace ─────────────────────────────

function Workspace({ session }: { session: AgentSession }) {
	const qc = useQueryClient();
	const stream = useMemo(() => new SessionStream(session.id, qc), [session.id, qc]);
	useEffect(() => stream.attach(), [stream]);

	const bp = useBreakpoint();
	const desktop = bp === "desktop";
	const mobile = bp === "mobile";
	const project = useProject(session.projectId).data;
	const workspaces = useWorkspaces().data;
	const workspace = useMemo(() => workspaces?.find((w) => w.id === project?.workspaceId), [workspaces, project?.workspaceId]);
	const kbInset = useKeyboardInset(!desktop);
	const detail = useSharedDetail(session.sharedSessionId).data;
	useSharedLive(session.sharedSessionId);
	/** Mirrors show another node's conversation; moved copies belong to the node that took over. Neither accepts prompts. */
	const readOnly = session.kind === "mirror" || session.movedTo !== null;
	// A shared session is a group chat: its timeline is the main view, the agent's own session is its workspace.
	const sharedMode = session.sharedSessionId !== null;
	const [view, setView] = useState<"group" | "workspace">("group");
	const showChat = sharedMode && view === "group";

	useEffect(() => {
		const prev = document.title;
		document.title = `${session.title || "Session"} · CL Agent Mesh`;
		return () => {
			document.title = prev;
		};
	}, [session.title]);

	// files opened from the explorer become extra center tabs
	const [openFiles, setOpenFiles] = useState<string[]>([]);
	const [tab, setTab] = useState<"chat" | string>("chat");
	const [sheets, setSheets] = useState({ left: false, right: false, log: false });
	const [fill, setFill] = useState<{ text: string; nonce: number } | null>(null);
	const [rightTab, setRightTab] = useState<"context" | "changes" | "team">("context");
	const [addAgent, setAddAgent] = useState(false);
	const [bottomTab, setBottomTab] = useState<"log" | "git">("log");

	const left = usePanelToggle(18);
	const right = usePanelToggle(24);
	const log = usePanelToggle(26);

	const setSheet = (k: "left" | "right" | "log", v: boolean) => setSheets((s) => ({ ...s, [k]: v }));
	const openDialog = useUi((s) => s.openDialog);
	const handover = useCallback(() => openDialog({ kind: "handover", sessionId: session.id }), [openDialog, session.id]);
	const rightOpen = right.open;
	const rightRef = right.ref;
	/** Reveal the Team tab of the right panel (desktop panel or mobile bottom sheet). The team thread needs more room than the context stats. */
	const openTeam = useCallback(() => {
		setRightTab("team");
		if (desktop) {
			rightOpen();
			requestAnimationFrame(() => {
				const p = rightRef.current;
				if (p && p.getSize() < 30) p.resize(32);
			});
		} else setSheets((s) => (s.right ? s : { ...s, right: true }));
	}, [desktop, rightOpen, rightRef]);

	const openFile = useCallback((path: string) => {
		setOpenFiles((f) => (f.includes(path) ? f : [...f, path]));
		setTab(path);
		setView("workspace");
		setSheets((s) => (s.left ? { ...s, left: false } : s));
	}, []);
	const closeFile = useCallback(
		(path: string) => {
			setOpenFiles((f) => f.filter((p) => p !== path));
			setTab((t) => (t === path ? "chat" : t));
		},
		[],
	);

	// "Inspect" on a tool card reveals the context panel.
	const selectedTool = useStreamMeta(stream, (m) => m.selectedToolId);
	useEffect(() => {
		if (!selectedTool) return;
		setRightTab("context");
		if (desktop) rightOpen();
		else setSheets((s) => (s.right ? s : { ...s, right: true }));
	}, [selectedTool, desktop, rightOpen]);

	// `[` threads · `]` context · `\` runtime log
	const toggles = useRef({ left: () => {}, right: () => {}, log: () => {} });
	toggles.current = {
		left: desktop ? left.toggle : () => setSheets((s) => ({ ...s, left: !s.left })),
		right: desktop ? right.toggle : () => setSheets((s) => ({ ...s, right: !s.right })),
		log: desktop ? log.toggle : () => setSheets((s) => ({ ...s, log: !s.log })),
	};
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
			if (e.key === "[") toggles.current.left();
			else if (e.key === "]") toggles.current.right();
			else if (e.key === "\\") toggles.current.log();
			else return;
			e.preventDefault();
		};
		addEventListener("keydown", onKey);
		return () => removeEventListener("keydown", onKey);
	}, []);

	const threadsEl = (onNavigate?: () => void) => <ThreadsPanel session={session} selectedFile={tab === "chat" ? null : tab} onOpenFile={openFile} onNavigate={onNavigate} />;
	const contextEl = (
		<RightPanel
			session={session}
			tab={rightTab}
			onTab={(t) => (t === "team" ? openTeam() : setRightTab(t))}
			context={<ContextPanel stream={stream} session={session} project={project} />}
			team={<TeamPanel session={session} onAddAgent={() => setAddAgent(true)} />}
			teamUnread={detail?.shared.unreadMessages ?? 0}
		/>
	);
	// The Git panel needs far more room than the log: grow the bottom panel when it is selected.
	const selectBottomTab = (t: "log" | "git") => {
		setBottomTab(t);
		const panel = log.ref.current;
		if (t === "git" && desktop && panel && panel.getSize() < 45) panel.resize(55);
	};
	const bottomEl = (onCollapse: () => void) => <BottomPanel stream={stream} session={session} tab={bottomTab} onTab={selectBottomTab} onCollapse={onCollapse} />;

	const center = (
		<div className="flex h-full min-h-0 min-w-0 flex-col bg-background">
			{openFiles.length > 0 ? (
				<div role="tablist" aria-label="Open views" className="scrollbar-none flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto border-b bg-surface-1 px-1.5 coarse:h-11">
					<TabButton active={tab === "chat"} onClick={() => setTab("chat")}>
						<MessagesSquare className="size-3.5" /> Chat
					</TabButton>
					{openFiles.map((p) => (
						<TabButton key={p} active={tab === p} onClick={() => setTab(p)} onClose={() => closeFile(p)} title={p}>
							<FileText className="size-3.5" /> <span className="max-w-[10rem] truncate font-mono">{basename(p)}</span>
						</TabButton>
					))}
				</div>
			) : null}
			{sharedMode ? <ViewSwitch view={view} onView={setView} unread={detail?.shared.unreadMessages ?? 0} workspaceLabel={session.kind === "mirror" ? "Live view" : session.movedTo ? "Moved copy" : "Workspace"} /> : null}
			<TaskBanner sessionId={session.id} />
			<SharedBanner session={session} detail={detail} onOpenTeam={openTeam} onOpenHandover={handover} />
			{readOnly || showChat ? null : <StateBanner stream={stream} />}
			{showChat ? (
				detail ? (
					<GroupChat session={session} detail={detail} active={view === "group"} keyboardOpen={kbInset > 0} onOpenWorkspace={() => setView("workspace")} onOpenTeam={openTeam} />
				) : (
					<div className="flex flex-col gap-3 p-4" aria-busy="true" aria-label="Loading the group chat">
						<Skeleton className="h-9 w-2/5 self-end rounded-2xl" />
						<Skeleton className="h-16 w-3/5 rounded-2xl" />
						<Skeleton className="h-9 w-1/3 rounded-2xl" />
					</div>
				)
			) : null}
			<div className={cn("flex min-h-0 flex-1 flex-col", showChat && "hidden")}>
				<div className="relative flex min-h-0 flex-1 flex-col">
					<div className={cn("flex min-h-0 flex-1 flex-col", tab !== "chat" && "hidden")}>
						<Conversation stream={stream} readOnly={readOnly} onPickPrompt={(text) => setFill({ text, nonce: Date.now() })} />
					</div>
					{tab !== "chat" ? (
						<Suspense
							fallback={
								<div className="flex flex-col gap-2 p-4" aria-busy="true">
									<Skeleton className="h-5 w-1/3" />
									<Skeleton className="h-4 w-full" />
									<Skeleton className="h-4 w-5/6" />
								</div>
							}
						>
							<FileViewer key={tab} projectId={session.projectId} path={tab} className="min-h-0 flex-1" onClose={() => closeFile(tab)} />
						</Suspense>
					) : null}
				</div>
				<ApprovalDock stream={stream} />
				{session.kind === "mirror" || session.movedTo ? <GroupBar detail={detail} onOpenChat={() => setView("group")} /> : <Composer stream={stream} fill={fill} keyboardOpen={kbInset > 0} />}
			</div>
		</div>
	);

	const header = (
		<SessionHeader
			session={session}
			project={project}
			workspace={workspace}
			stream={stream}
			compact={mobile}
			shared={detail?.shared ?? null}
			readOnly={readOnly}
			onAddAgent={() => setAddAgent(true)}
			onHandover={handover}
			onOpenTeam={openTeam}
			panels={{
				showLeft: desktop ? !left.collapsed : sheets.left,
				showRight: desktop ? !right.collapsed : sheets.right,
				showLog: desktop ? !log.collapsed : sheets.log,
				onToggleLeft: () => toggles.current.left(),
				onToggleRight: () => toggles.current.right(),
				onToggleLog: () => toggles.current.log(),
			}}
		/>
	);

	return (
		<StreamContext.Provider value={stream}>
			<div className="flex h-full min-h-0 flex-col bg-background" style={kbInset > 0 ? { paddingBottom: kbInset } : undefined}>
				{header}
				{desktop ? (
					<PanelGroup direction="horizontal" autoSaveId="clam.session.h" className="min-h-0 flex-1">
						<Panel id="left" order={1} defaultSize={18} minSize={14} maxSize={32} collapsible collapsedSize={0} ref={left.ref} onCollapse={left.onCollapse} onExpand={left.onExpand}>
							{threadsEl()}
						</Panel>
						<PanelResizeHandle />
						<Panel id="center" order={2} minSize={30}>
							<PanelGroup direction="vertical" autoSaveId="clam.session.v">
								<Panel id="chat" order={1} minSize={30}>
									{center}
								</Panel>
								<PanelResizeHandle />
								<Panel id="log" order={2} defaultSize={0} minSize={12} maxSize={60} collapsible collapsedSize={0} ref={log.ref} onCollapse={log.onCollapse} onExpand={log.onExpand}>
									{bottomEl(log.toggle)}
								</Panel>
							</PanelGroup>
						</Panel>
						<PanelResizeHandle />
						<Panel id="right" order={3} defaultSize={24} minSize={18} maxSize={40} collapsible collapsedSize={0} ref={right.ref} onCollapse={right.onCollapse} onExpand={right.onExpand}>
							{contextEl}
						</Panel>
					</PanelGroup>
				) : (
					<>
						<div className="min-h-0 flex-1">{center}</div>
						{!mobile && sheets.log ? (
							<div className={cn("animate-slide-up shrink-0 border-t", bottomTab === "git" ? "h-[60dvh]" : "h-60")}>
								{bottomEl(() => setSheet("log", false))}
							</div>
						) : null}
						<Sheet open={sheets.left} onOpenChange={(v) => setSheet("left", v)}>
							<SheetContent side="left" className="p-0" aria-describedby={undefined}>
								<SheetTitle className="sr-only">Threads and files</SheetTitle>
								<SheetDescription className="sr-only">Switch threads or browse project files.</SheetDescription>
								{sheets.left ? threadsEl(() => setSheet("left", false)) : null}
							</SheetContent>
						</Sheet>
						<Sheet open={sheets.right} onOpenChange={(v) => setSheet("right", v)}>
							<SheetContent
								side={mobile ? "bottom" : "right"}
								className={cn("p-0", mobile && "h-[82dvh]")}
								style={mobile && kbInset > 0 ? { bottom: kbInset, height: `min(82dvh, calc(100dvh - ${kbInset}px - 1rem))` } : undefined}
								aria-describedby={undefined}
							>
								<SheetTitle className="sr-only">{rightTab === "team" ? "Team" : "Context"}</SheetTitle>
								<SheetDescription className="sr-only">{rightTab === "team" ? "Participants, discussion and checkpoints of the shared session." : "Context usage, plan, stats and session info."}</SheetDescription>
								{sheets.right ? <div className="min-h-0 flex-1 overflow-hidden">{contextEl}</div> : null}
							</SheetContent>
						</Sheet>
						{mobile ? (
							<Sheet open={sheets.log} onOpenChange={(v) => setSheet("log", v)}>
								<SheetContent side="bottom" className="h-[70dvh] p-0" aria-describedby={undefined}>
									<SheetTitle className="sr-only">Runtime log</SheetTitle>
									<SheetDescription className="sr-only">Tool executions and runtime events.</SheetDescription>
									{sheets.log ? bottomEl(() => setSheet("log", false)) : null}
								</SheetContent>
							</Sheet>
						) : null}
					</>
				)}
				{addAgent ? (
					<Suspense fallback={null}>
						<AddAgentDialog
							sessionId={session.id}
							projectId={session.projectId}
							shared={detail?.shared ?? null}
							onClose={() => setAddAgent(false)}
							onAdded={() => setView("group")}
						/>
					</Suspense>
				) : null}
			</div>
		</StreamContext.Provider>
	);
}

function PanelTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
	return (
		<button
			type="button"
			role="tab"
			aria-selected={active}
			onClick={onClick}
			className={cn(
				"inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium outline-none transition-colors focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:h-9 [&_svg]:size-3.5",
				active ? "bg-surface-3 text-foreground" : "text-muted-foreground hover:bg-surface-2 hover:text-foreground",
			)}
		>
			{children}
		</button>
	);
}

type RightTabId = "context" | "changes" | "team";

/** Right panel: the session context, the project's Git changes, and (shared sessions) the team. */
function RightPanel({
	session,
	tab,
	onTab,
	context,
	team,
	teamUnread,
}: {
	session: AgentSession;
	tab: RightTabId;
	onTab: (t: RightTabId) => void;
	context: ReactNode;
	/** Rendered under the Team tab; null hides the tab (moved copies of unshared sessions have nothing to show). */
	team: ReactNode | null;
	teamUnread: number;
}) {
	const status = useGitStatus(session.projectId).data;
	const dirty = status?.isRepo ? status.files.length : 0;
	return (
		<div className="flex h-full min-h-0 flex-col bg-surface-1">
			<div role="tablist" aria-label="Side panel" className="flex h-10 shrink-0 items-center gap-0.5 border-b px-1.5 coarse:h-12">
				<PanelTab active={tab === "context"} onClick={() => onTab("context")}>
					Context
				</PanelTab>
				<PanelTab active={tab === "changes"} onClick={() => onTab("changes")}>
					Changes
					{dirty > 0 ? <span className="tabular rounded bg-accent-soft px-1 font-mono text-2xs text-accent">{dirty}</span> : null}
				</PanelTab>
				{team ? (
					<PanelTab active={tab === "team"} onClick={() => onTab("team")}>
						<Users /> Team
						{teamUnread > 0 ? <span className="tabular rounded bg-accent px-1 font-mono text-2xs text-accent-foreground">{teamUnread}</span> : null}
					</PanelTab>
				) : null}
			</div>
			<div className="min-h-0 flex-1">
				{tab === "context" ? (
					context
				) : tab === "team" && team ? (
					<Suspense fallback={<Skeleton className="m-3 h-24" />}>{team}</Suspense>
				) : (
					<Suspense fallback={<Skeleton className="m-3 h-24" />}>
						<GitWorkbench projectId={session.projectId} sessionId={session.id} />
					</Suspense>
				)}
			</div>
		</div>
	);
}

/** Bottom panel: runtime log, plus the project's Git panel (branches, changes, history, pull requests). */
function BottomPanel({ stream, session, tab, onTab, onCollapse }: { stream: SessionStream; session: AgentSession; tab: "log" | "git"; onTab: (t: "log" | "git") => void; onCollapse: () => void }) {
	const tabs = (
		<div role="tablist" aria-label="Bottom panel" className="flex items-center gap-0.5">
			<PanelTab active={tab === "log"} onClick={() => onTab("log")}>
				<ScrollText /> Runtime log
			</PanelTab>
			<PanelTab active={tab === "git"} onClick={() => onTab("git")}>
				<GitBranch /> Git
			</PanelTab>
		</div>
	);
	if (tab === "log") return <RuntimeLog stream={stream} onCollapse={onCollapse} headerLead={tabs} />;
	return (
		<div className="flex h-full min-h-0 flex-col bg-surface-1">
			<div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 coarse:h-11">
				{tabs}
				<button type="button" aria-label="Collapse panel" onClick={onCollapse} className="ml-auto grid size-6 place-items-center rounded-md text-subtle outline-none transition-colors hover:bg-surface-3 hover:text-foreground coarse:size-9">
					<ChevronDown className="size-3.5" />
				</button>
			</div>
			<div className="min-h-0 flex-1">
				<Suspense fallback={<Skeleton className="m-3 h-24" />}>
					<GitWorkbench projectId={session.projectId} sessionId={session.id} />
				</Suspense>
			</div>
		</div>
	);
}

function TabButton({ active, onClick, onClose, children, title }: { active: boolean; onClick: () => void; onClose?: () => void; children: ReactNode; title?: string }) {
	return (
		<div className={cn("flex h-7 shrink-0 items-center rounded-md text-xs transition-colors coarse:h-9", active ? "bg-surface-3 text-foreground" : "text-muted-foreground hover:bg-surface-2 hover:text-foreground")}>
			<button type="button" role="tab" aria-selected={active} title={title} onClick={onClick} className="flex h-full items-center gap-1.5 rounded-md px-2.5 outline-none">
				{children}
			</button>
			{onClose ? (
				<button type="button" aria-label={`Close ${title ?? "tab"}`} onClick={onClose} className="mr-1 grid size-5 place-items-center rounded text-subtle outline-none hover:bg-surface-3 hover:text-foreground coarse:size-8">
					<X className="size-3" />
				</button>
			) : null}
		</div>
	);
}

/** Shared sessions: the group chat is the main view, the agent's own session (tool calls, files) its workspace. */
function ViewSwitch({ view, onView, unread, workspaceLabel }: { view: "group" | "workspace"; onView: (v: "group" | "workspace") => void; unread: number; workspaceLabel: string }) {
	return (
		<div role="tablist" aria-label="Session view" className="flex h-10 shrink-0 items-center gap-0.5 border-b bg-surface-1 px-1.5 coarse:h-12">
			<PanelTab active={view === "group"} onClick={() => onView("group")}>
				<Users /> Group chat
				{unread > 0 ? <span className="tabular rounded bg-accent px-1 font-mono text-2xs text-accent-foreground">{unread}</span> : null}
			</PanelTab>
			<PanelTab active={view === "workspace"} onClick={() => onView("workspace")}>
				<Bot /> {workspaceLabel}
			</PanelTab>
		</div>
	);
}
