import type { AgentSession, Project, SharedSession, Workspace } from "@clam/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, ArrowRightLeft, ChevronRight, FolderTree, MessagesSquare, PanelBottom, PanelLeft, PanelRight, Square, Terminal, UserPlus, WifiOff } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { toast } from "sonner";
import { RUNTIME_STATE_LABEL, runtimeDot, SessionKindBadge } from "@/components/session-status";
import { ChatHeaderMenu } from "@/features/chats/chat-menus";
import { driverOf, NODE_STATUS_LABEL, nodeDot } from "@/features/shared/format";
import { t, tr } from "@/i18n";
import { errorText } from "@/lib/api";
import { useWsStatus } from "@/lib/ws";
import { useUi } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { StatusDot } from "@/ui/status-dot";
import { Tip } from "@/ui/tooltip";
import { ModelPicker } from "./model-pickers.tsx";
import { useUpdateSession } from "./session-actions.ts";
import { isBusy, type SessionStream, useStreamMeta } from "./stream-store.ts";
import { SessionMenu } from "./session-menu.tsx";
import { QuotaMeter } from "@/features/usage/quota-meter.tsx";

const iconBtn =
	"grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:bg-surface-2 aria-pressed:bg-surface-3 aria-pressed:text-foreground coarse:size-11 [&_svg]:size-4";

export function PanelToggle({ label, shortcut, pressed, onClick, children, className }: { label: string; shortcut?: string; pressed: boolean; onClick: () => void; children: ReactNode; className?: string }) {
	return (
		<Tip label={label} shortcut={shortcut}>
			<button type="button" aria-label={label} aria-pressed={pressed} onClick={onClick} className={cn(iconBtn, className)}>
				{children}
			</button>
		</Tip>
	);
}

function InlineTitle({ session, className }: { session: AgentSession; className?: string }) {
	const update = useUpdateSession();
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(session.title);
	const cancelled = useRef(false);
	const commit = () => {
		setEditing(false);
		const title = draft.trim();
		if (cancelled.current || !title || title === session.title) return;
		update.mutate({ id: session.id, patch: { title } });
	};
	if (editing) {
		return (
			<input
				autoFocus
				value={draft}
				maxLength={120}
				aria-label={t("Session title")}
				onFocus={(e) => e.currentTarget.select()}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={commit}
				onKeyDown={(e) => {
					if (e.key === "Enter") e.currentTarget.blur();
					else if (e.key === "Escape") {
						cancelled.current = true;
						e.currentTarget.blur();
					}
				}}
				className={cn("h-7 min-w-0 rounded-md bg-surface-1 px-2 text-[13px] font-medium shadow-[inset_0_0_0_1px_var(--accent)] outline-none coarse:h-10", className)}
			/>
		);
	}
	return (
		<Tip label={t("Rename thread")}>
			<button
				type="button"
				onClick={() => {
					cancelled.current = false;
					setDraft(session.title);
					setEditing(true);
				}}
				className={cn("min-w-0 truncate rounded-md px-1.5 py-0.5 text-left text-[13px] font-medium outline-none transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 coarse:py-2", className)}
			>
				{session.title || t("Untitled session")}
			</button>
		</Tip>
	);
}

export interface HeaderPanels {
	showLeft: boolean;
	showRight: boolean;
	showLog: boolean;
	/** The right panel shows its Files tab. */
	showFiles: boolean;
	onToggleLeft: () => void;
	onToggleRight: () => void;
	onToggleLog: () => void;
	onToggleFiles: () => void;
}

export function SessionHeader({
	session,
	project,
	workspace,
	stream,
	panels,
	compact,
	shared,
	readOnly,
	onAddAgent,
	onHandover,
	onOpenTeam,
}: {
	session: AgentSession;
	project: Project | undefined;
	workspace: Workspace | undefined;
	stream: SessionStream;
	panels: HeaderPanels;
	/** Mobile layout. */
	compact: boolean;
	shared: SharedSession | null;
	/** Mirror sessions and moved copies: no prompting, no model, no stop. */
	readOnly: boolean;
	onAddAgent: () => void;
	onHandover: () => void;
	onOpenTeam: () => void;
}) {
	const wsStatus = useWsStatus();
	const runtime = useStreamMeta(stream, (m) => m.live?.runtime ?? null);
	const liveStatus = useStreamMeta(stream, (m) => m.liveStatus);
	const busy = useStreamMeta(stream, isBusy);
	const aborting = useStreamMeta(stream, (m) => m.aborting);
	const approvals = useStreamMeta(stream, (m) => m.uiRequests.length);

	const stateLabel = runtime ? tr(RUNTIME_STATE_LABEL[runtime.state]) : liveStatus === "error" ? t("Unavailable") : t("Connecting");
	const dot = runtime ? runtimeDot(runtime.state) : liveStatus === "error" ? "crashed" : "starting";
	const driver = shared ? driverOf(shared) : undefined;
	const teamUnread = shared?.unreadMessages ?? 0;
	const openDialog = useUi((s) => s.openDialog);
	/** Only the driving session (or one not shared yet) can bring more agents in. */
	const isChat = project?.origin === "chat";
	const canAdd = !readOnly && session.kind === "local" && (!shared || shared.localRole === "driver");

	const filesToggle = (
		<PanelToggle label={t("Files")} shortcut="F" pressed={panels.showFiles} onClick={panels.onToggleFiles}>
			<FolderTree />
		</PanelToggle>
	);

	return (
		<header className="flex h-[calc(3rem+env(safe-area-inset-top))] shrink-0 items-center gap-1.5 border-b bg-surface-1/80 px-2 pt-safe backdrop-blur coarse:h-[calc(3.5rem+env(safe-area-inset-top))] sm:px-3">
			<Tip label={isChat ? t("Back to chats") : t("Back to project")}>
				<Button asChild variant="ghost" size="icon" aria-label={isChat ? t("Back to chats") : t("Back to project")}>
					{isChat ? (
						<Link to="/chats">
							<ArrowLeft />
						</Link>
					) : (
						<Link to="/projects/$projectId" params={{ projectId: session.projectId }}>
							<ArrowLeft />
						</Link>
					)}
				</Button>
			</Tip>
			{!compact ? (
				<PanelToggle label={t("Threads")} shortcut="[" pressed={panels.showLeft} onClick={panels.onToggleLeft}>
					<PanelLeft />
				</PanelToggle>
			) : null}

			{compact ? (
				<div className="flex min-w-0 flex-1 flex-col justify-center">
					<InlineTitle session={session} className="-ml-1.5" />
					<span className="flex items-center gap-1.5 truncate px-1.5 text-2xs text-subtle -mt-0.5">
						{readOnly ? (
							<>
								{driver && session.kind === "mirror" ? <StatusDot status={nodeDot(driver.nodeStatus)} label={tr(NODE_STATUS_LABEL[driver.nodeStatus])} className="size-1.5 [&>span]:size-1.5" /> : null}
								<span>{session.movedTo ? t("Moved to {name}", { name: session.movedTo.nodeName }) : driver ? t("Live view · {name}", { name: driver.nodeName }) : t("Live view")}</span>
							</>
						) : (
							<>
								<StatusDot status={dot} label={stateLabel} className="size-1.5 [&>span]:size-1.5" />
								{/* With the quota meter beside it the state is the dot alone (its word stays for screen readers), so both fit on a phone. */}
								<span className="shrink-0 first-letter:uppercase [&:has(+[data-quota])]:sr-only">{stateLabel}</span>
								<QuotaMeter compact />
								{project && !isChat ? <span className="truncate">· {project.name}</span> : null}
							</>
						)}
					</span>
				</div>
			) : (
				<nav aria-label={t("Breadcrumb")} className="flex min-w-0 flex-1 items-center gap-0.5 text-[13px] text-muted-foreground">
					{workspace && !isChat ? (
						<>
							<Link to="/workspaces/$workspaceId" params={{ workspaceId: workspace.id }} className="hidden max-w-[10rem] truncate rounded-md px-1.5 py-0.5 outline-none transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:bg-surface-2 lg:block">
								{workspace.name}
							</Link>
							<ChevronRight className="hidden size-3.5 shrink-0 text-subtle lg:block" aria-hidden />
						</>
					) : null}
					{project && !isChat ? (
						<>
							<Link to="/projects/$projectId" params={{ projectId: project.id }} className="hidden max-w-[10rem] truncate rounded-md px-1.5 py-0.5 outline-none transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:bg-surface-2 sm:block">
								{project.name}
							</Link>
							<ChevronRight className="hidden size-3.5 shrink-0 text-subtle sm:block" aria-hidden />
						</>
					) : null}
					<InlineTitle session={session} className="text-foreground" />
				</nav>
			)}

			{wsStatus !== "open" ? (
				<Tip label={wsStatus === "connecting" ? t("Connecting to the live event stream…") : t("Live updates are disconnected. Reconnecting…")}>
					<span role="status" className="flex h-6 shrink-0 items-center gap-1 rounded-md bg-warning/14 px-1.5 text-2xs font-medium text-warning">
						<WifiOff className="size-3" aria-hidden />
						<span className="hidden sm:inline">{wsStatus === "connecting" ? t("Connecting") : t("Offline")}</span>
					</span>
				</Tip>
			) : null}

			{!compact ? (
				readOnly ? (
					<span className="hidden shrink-0 items-center gap-1.5 px-1 text-xs text-muted-foreground md:flex" role="status" aria-label={driver ? t("Driver {status}", { status: tr(NODE_STATUS_LABEL[driver.nodeStatus]) }) : t("Read-only")}>
						{driver && session.kind === "mirror" ? <StatusDot status={nodeDot(driver.nodeStatus)} label={tr(NODE_STATUS_LABEL[driver.nodeStatus])} /> : null}
						<SessionKindBadge session={session} />
					</span>
				) : (
					<span className="hidden shrink-0 items-center gap-1.5 px-1 text-xs text-muted-foreground md:flex" role="status" aria-label={t("Runtime {state}", { state: stateLabel })}>
						<StatusDot status={dot} label={stateLabel} />
						<span className="hidden first-letter:uppercase lg:inline">{stateLabel}</span>
					</span>
				)
			) : null}
			{!compact && !readOnly ? <ModelPicker stream={stream} className="hidden lg:inline-flex lg:max-w-[14rem]" /> : null}
			{!compact && canAdd ? (
				<Button size="sm" variant="outline" onClick={onAddAgent} className="hidden shrink-0 md:inline-flex" aria-label={t("Add agent")} title={t("Add agent")}>
					<UserPlus /> <span className="hidden xl:inline">{t("Add agent")}</span>
				</Button>
			) : null}
			{!compact && canAdd ? (
				<Button size="sm" variant="ghost" onClick={onHandover} className="hidden shrink-0 md:inline-flex" aria-label={t("Hand over")} title={t("Hand over…")}>
					<ArrowRightLeft /> <span className="hidden xl:inline">{t("Hand over…")}</span>
				</Button>
			) : null}

			{!compact && !readOnly ? (
				<Tip label={t("Open terminal here")}>
					<Button asChild variant="ghost" size="icon" aria-label={t("Open terminal here")} className="hidden shrink-0 md:inline-flex">
						<Link to="/terminal" search={{ project: session.checkoutId }}>
							<Terminal />
						</Link>
					</Button>
				</Tip>
			) : null}

			{approvals > 0 && !compact ? <span className="tabular grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-warning px-1 text-2xs font-semibold text-background" title={t("Approvals waiting")}>{approvals}</span> : null}

			{busy && !readOnly && !compact ? (
				<Tip label={aborting ? t("Stopping…") : t("Stop the agent")} shortcut="Esc">
					<Button
						variant="outline"
						size="icon"
						aria-label={t("Stop the agent")}
						disabled={aborting}
						className="text-danger"
						onClick={() => stream.abort().catch((e) => toast.error(t("Could not stop the agent: {error}", { error: errorText(e) })))}
					>
						<Square className="fill-current" />
					</Button>
				</Tip>
			) : null}

			{compact ? (
				<PanelToggle label={t("Threads")} pressed={panels.showLeft} onClick={panels.onToggleLeft}>
					<MessagesSquare />
				</PanelToggle>
			) : null}
			{compact ? filesToggle : null}
			{compact ? (
				<SessionMenu
					checkoutId={session.checkoutId}
					canAdd={canAdd}
					readOnly={readOnly}
					teamUnread={teamUnread}
					approvals={approvals}
					onAddAgent={onAddAgent}
					onHandover={onHandover}
					onOpenTeam={onOpenTeam}
					onToggleLog={panels.onToggleLog}
					onToggleRight={panels.onToggleRight}
					onDelete={isChat ? () => openDialog({ kind: "delete-chat", sessionId: session.id }) : undefined}
				/>
			) : null}
			{compact ? null : (
				<>
					{filesToggle}
					<PanelToggle label={t("Runtime log")} shortcut="\\" pressed={panels.showLog} onClick={panels.onToggleLog}>
						<PanelBottom />
					</PanelToggle>
					<PanelToggle label={t("Context")} shortcut="]" pressed={panels.showRight} onClick={panels.onToggleRight}>
						<PanelRight />
					</PanelToggle>
					{isChat ? <ChatHeaderMenu sessionId={session.id} /> : null}
				</>
			)}
		</header>
	);
}
