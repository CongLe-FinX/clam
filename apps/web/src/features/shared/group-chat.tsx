import type { Checkpoint, Participant, SharedSession, SharedSessionDetail } from "@clam/contracts";
import { BarChart3, Camera, Check, FileText, Film, Search, Users } from "lucide-react";
import { type ComponentType, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useOmpStateOptional, useOptionalOmpStore } from "@/features/session/omp/omp-store.ts";
import { AGENT_MESSAGE_LIMIT } from "@/features/tasks/format";
import { type Msg, msg, renderServerText, t, tr } from "@/i18n";
import { useNode } from "@/lib/queries";
import { DropOverlay } from "@/components/composer/drop-overlay.tsx";
import { useFileDrop } from "@/components/composer/use-file-drop.ts";
import { cn, relativeTime } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { StatusDot } from "@/ui/status-dot";
import { Tip } from "@/ui/tooltip";
import { useWorkingAgents } from "./activity.ts";
import { useAttachmentUploads } from "./attachments.tsx";
import { driverOf, NODE_STATUS_LABEL, nodeDot, participantLabel, teamOf } from "./format.ts";
import { GroupComposer } from "./group-composer.tsx";
import { GroupTimeline, useEarlierConversation } from "./group-timeline.tsx";
import { useCheckpointNow, useMarkSharedRead, useSharedHistory } from "./hooks.ts";
import { AuthorAvatar, hueOf, MachineChip } from "./identity.tsx";
import { CheckpointFacts, ModeLabel } from "./mode.tsx";

// ───────────────────────────── header ─────────────────────────────

function Avatar({ p, lead }: { p: Participant; lead: boolean }) {
	const who = p.agentName ? t("{agent} on {machine}", { agent: p.agentName, machine: p.nodeName }) : p.nodeName;
	const label = t("{who}{lead} · {status}", { who, lead: lead ? ` · ${t("lead")}` : "", status: tr(NODE_STATUS_LABEL[p.nodeStatus]) });
	return (
		<Tip label={label}>
			<span className="relative inline-grid" role="img" aria-label={label}>
				<AuthorAvatar name={p.agentName ?? p.nodeName} hue={hueOf(p.nodeId, p.agentId)} agent={p.agentId !== null} badge={false} className={cn("size-7 coarse:size-8", lead && "shadow-[0_0_0_2px_var(--accent)]")} />
				<StatusDot status={nodeDot(p.nodeStatus)} label={tr(NODE_STATUS_LABEL[p.nodeStatus])} className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full shadow-[0_0_0_2px_var(--surface-1)] [&>span]:size-2.5" />
			</span>
		</Tip>
	);
}

function CheckpointsPopover({ shared, checkpoints, onOpenTeam }: { shared: SharedSession; checkpoints: Checkpoint[]; onOpenTeam: () => void }) {
	const now = useCheckpointNow(shared.id);
	const last = shared.lastCheckpoint;
	const recent = [...checkpoints].sort((a, b) => b.seq - a.seq).slice(0, 4);
	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button size="sm" variant="ghost" className="shrink-0 text-muted-foreground" aria-label={t("Checkpoints")}>
					<Camera /> <span className="tabular max-sm:hidden">{last ? `#${last.seq} · ${relativeTime(last.at)}` : t("No checkpoint")}</span>
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-80">
				<div className="flex flex-col gap-2.5">
					<p className="text-xs text-muted-foreground">
						{shared.vcs === "git" ? t("A checkpoint commits the lead's work to the shared branch and ships a snapshot to every machine in the group.") : t("A checkpoint bundles the working folder (no Git needed) and ships it with a snapshot to every machine in the group.")}
					</p>
					{recent.length === 0 ? <p className="text-xs text-subtle">{t("No checkpoints yet.")}</p> : null}
					<ul className="flex flex-col gap-1.5">
						{recent.map((c) => {
							const git = shared.vcs === "git";
							return (
								<li key={c.seq} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
									<span className="font-medium">#{c.seq}</span>
									<span className="text-subtle">{relativeTime(c.at)}</span>
									{c.commit || c.files ? <CheckpointFacts shared={shared} c={c} className="text-muted-foreground" /> : null}
									{git && c.commit && c.pushed ? (
										<span className="inline-flex items-center gap-0.5 text-success">
											<Check className="size-3" aria-hidden /> {t("pushed")}
										</span>
									) : git && c.commit ? (
										<span className="text-warning">{t("not pushed")}</span>
									) : null}
								</li>
							);
						})}
					</ul>
					<div className="flex flex-wrap gap-2">
						{shared.localRole === "driver" ? (
							<Button size="sm" variant="outline" loading={now.isPending} onClick={() => now.mutate(undefined)}>
								<Camera /> {t("Checkpoint now")}
							</Button>
						) : null}
						<Button size="sm" variant="ghost" onClick={onOpenTeam}>
							{t("All checkpoints")}
						</Button>
					</div>
				</div>
			</PopoverContent>
		</Popover>
	);
}

/** Agent-message budget (loop guard) as a small ring + `12/12`; the explanation opens on hover, focus or tap. */
function BudgetChip({ left: budget }: { left: number }) {
	const left = Math.max(0, budget);
	const frac = Math.min(1, left / AGENT_MESSAGE_LIMIT);
	const low = left <= 3;
	const r = 7;
	const c = 2 * Math.PI * r;
	return (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					aria-label={left === 0 ? t("Agent messages used up on this machine") : t("Agent messages left on this machine: {left} of {limit}", { left, limit: AGENT_MESSAGE_LIMIT })}
					className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-lg px-1.5 py-1 text-2xs outline-none hover:bg-surface-2 focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:min-h-11", low ? "text-warning" : "text-muted-foreground")}
				>
					<svg viewBox="0 0 18 18" className="size-4 -rotate-90" aria-hidden>
						<circle cx="9" cy="9" r={r} fill="none" strokeWidth="2.5" className="stroke-surface-3" />
						<circle cx="9" cy="9" r={r} fill="none" strokeWidth="2.5" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - frac)} className={low ? "stroke-warning" : "stroke-accent"} />
					</svg>
					<span className="tabular font-medium">
						{left}/{AGENT_MESSAGE_LIMIT}
					</span>
				</button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-72">
				<p className="text-xs text-muted-foreground">
					<span className={cn("font-medium", left === 0 ? "text-warning" : "text-foreground")}>{left === 0 ? t("Agent messages used up — a person must continue.") : t("{left} of {limit} agent messages left on this machine.", { left, limit: AGENT_MESSAGE_LIMIT })}</span> {t("Each machine lets its agents post this many messages in a group, so two agents cannot talk forever. A person can always continue the chat, and your message resets the count.")}
				</p>
			</PopoverContent>
		</Popover>
	);
}

function ChatHeader({ detail, onOpenTeam }: { detail: SharedSessionDetail; onOpenTeam: () => void }) {
	const { shared } = detail;
	const members = teamOf(shared);
	const lead = driverOf(shared);
	const leadName = lead ? (lead.agentName ?? lead.nodeName) : null;
	return (
		<div className="flex shrink-0 flex-col gap-2 border-b px-3 py-2">
			<div className="flex items-center gap-1.5">
				<button
					type="button"
					onClick={onOpenTeam}
					aria-label={lead ? t("Open the team. {count} in the group, lead {lead}", { count: members.length, lead: participantLabel(lead) }) : t("Open the team")}
					title={lead ? t("Lead: {name}", { name: participantLabel(lead) }) : undefined}
					className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-0.5 text-left outline-none hover:bg-surface-2 focus-visible:bg-surface-2 coarse:py-1.5"
				>
					<span className="flex shrink-0 -space-x-1.5">
						{members.map((p) => (
							<Avatar key={p.nodeId} p={p} lead={p.nodeId === shared.driverNodeId} />
						))}
					</span>
					<span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
						<span className="shrink-0 font-medium text-foreground">{t("{count} in the group", { count: members.length })}</span>
						{lead && leadName ? (
							<span className="flex min-w-0 items-center gap-1.5 max-sm:hidden">
								<span aria-hidden>·</span>
								<span className="shrink-0">{t("lead")}</span>
								<span className="truncate font-medium text-foreground">{leadName}</span>
								{lead.agentName ? <MachineChip name={lead.nodeName} /> : null}
							</span>
						) : null}
					</span>
				</button>
				<BudgetChip left={shared.agentMessageBudget} />
				<CheckpointsPopover shared={shared} checkpoints={detail.checkpoints} onOpenTeam={onOpenTeam} />
			</div>
			<div className="min-w-0 text-2xs text-muted-foreground [@media(max-height:520px)]:hidden">
				<ModeLabel vcs={shared.vcs} repo={shared.repo} interactive />
			</div>
		</div>
	);
}

// ───────────────────────────── empty state ─────────────────────────────

const EXAMPLES: Array<{ icon: ComponentType<{ className?: string }>; title: Msg; prompt: Msg }> = [
	{ icon: Search, title: msg("Research"), prompt: msg("Research how teams keep long-running AI agents reliable. Compare three approaches, cite your sources and end with a recommendation.") },
	{ icon: FileText, title: msg("Report"), prompt: msg("Write a one-page report on what we have learned so far, as a PDF, and share it here.") },
	{ icon: BarChart3, title: msg("Chart"), prompt: msg("Plot the numbers from the data files in the project as a chart and show it in the chat.") },
	{ icon: Film, title: msg("Media"), prompt: msg("Make a short screen recording or a screenshot of the finished feature and share it here.") },
];

function GroupEmpty({ onPick }: { onPick: (text: string) => void }) {
	return (
		<div className="min-h-0 flex-1 overflow-y-auto">
			<div className="mx-auto flex min-h-full w-full max-w-xl flex-col items-center justify-center gap-5 px-5 py-8 text-center">
				<span className="grid size-11 place-items-center rounded-2xl bg-accent-soft text-accent">
					<Users className="size-5" aria-hidden />
				</span>
				<div className="flex flex-col gap-1.5">
					<h2 className="text-[15px] font-semibold">{t("Nobody has said anything yet")}</h2>
					<p className="text-[13px] text-muted-foreground">
						{t("People and agents on every machine talk here. Messages go to the lead agent unless you @mention someone or write @all. Agents answer with text, files, images, charts and diagrams, and they all show up in this chat.")}
					</p>
				</div>
				<ul className="grid w-full gap-2 sm:grid-cols-2">
					{EXAMPLES.map((x) => (
						<li key={tr(x.title)}>
							<button
								type="button"
								onClick={() => onPick(tr(x.prompt))}
								className="flex min-h-11 w-full flex-col gap-1 rounded-xl bg-surface-1 p-3 text-left shadow-[inset_0_0_0_1px_var(--border)] outline-none transition-colors hover:bg-surface-2 focus-visible:shadow-[inset_0_0_0_2px_var(--accent)]"
							>
								<span className="flex items-center gap-1.5 text-xs font-medium">
									<x.icon className="size-3.5 text-accent" aria-hidden /> {tr(x.title)}
								</span>
								<span className="line-clamp-3 text-xs text-muted-foreground">{tr(x.prompt)}</span>
							</button>
						</li>
					))}
				</ul>
			</div>
		</div>
	);
}

// ───────────────────────────── the chat ─────────────────────────────

/**
 * The group chat of a shared session: every person and agent in one timeline, the same on every member machine. Each agent keeps its own
 * workspace (its session with the tool calls) behind "Open live view". The log is paged: the newest messages come with the detail, older
 * ones load while the user scrolls up (see `useSharedHistory`).
 */
export function GroupChat({
	session,
	detail,
	active,
	keyboardOpen,
	onOpenWorkspace,
	onOpenTeam,
	dock,
	className,
}: {
	session: { id: string };
	detail: SharedSessionDetail;
	/** The chat is on screen: new messages count as read. */
	active: boolean;
	keyboardOpen: boolean;
	onOpenWorkspace: () => void;
	onOpenTeam: () => void;
	/** What the agent is waiting for (its question or approval card): right above the composer, where the eye already is. */
	dock?: ReactNode;
	className?: string;
}) {
	const { shared, messages } = detail;
	const selfNodeId = useNode().data?.id;
	const markRead = useMarkSharedRead(shared.id);
	const history = useSharedHistory(shared.id, detail.messagesCursor);
	// The conversation the session had before it became a group is the beginning of the timeline, shown once the group log is loaded to its first line.
	const earlier = useEarlierConversation(session.id, messages[0] ? Date.parse(messages[0].createdAt) : Number.POSITIVE_INFINITY, !history.hasOlder);
	const working = useWorkingAgents(shared);
	const waiting = useOmpStateOptional(useOptionalOmpStore()).requests.length > 0;
	const uploads = useAttachmentUploads(shared.id);
	const [fill, setFill] = useState<{ text: string; nonce: number } | null>(null);
	const { dragging, handlers: drop } = useFileDrop(uploads.add);
	// Every memoized row receives this: it must not change when the parent re-renders with a fresh inline callback.
	const latestOpen = useRef(onOpenWorkspace);
	latestOpen.current = onOpenWorkspace;
	const openWorkspace = useCallback(() => latestOpen.current(), []);

	useEffect(() => {
		if (active && shared.unreadMessages > 0 && document.visibilityState === "visible") markRead();
	}, [active, shared.unreadMessages, messages.length, markRead]);

	const empty = messages.length === 0 && earlier.items.length === 0 && !history.hasOlder;

	return (
		<div
			className={cn("relative flex min-h-0 flex-1 flex-col bg-background", className)}
			{...drop}
		>
			<ChatHeader detail={detail} onOpenTeam={onOpenTeam} />
			{empty ? (
				<GroupEmpty onPick={(text) => setFill({ text, nonce: Date.now() })} />
			) : (
				<GroupTimeline detail={detail} sessionId={session.id} selfNodeId={selfNodeId} active={active} earlier={earlier} history={history} working={working} waiting={waiting} onOpenWorkspace={openWorkspace} />
			)}
			{dock}
			<GroupComposer detail={detail} uploads={uploads} keyboardOpen={keyboardOpen} fill={fill} />
			{dragging ? <DropOverlay className="inset-2 rounded-2xl">{t("Drop to share with the group")}</DropOverlay> : null}
		</div>
	);
}

/** Replaces the prompt composer under an agent workspace that you cannot prompt (live view, moved copy): the group chat is where you talk. */
export function GroupBar({ detail, onOpenChat, className }: { detail: SharedSessionDetail | undefined; onOpenChat: () => void; className?: string }) {
	const last = detail?.messages.at(-1);
	const unread = detail?.shared.unreadMessages ?? 0;
	return (
		<div className={cn("shrink-0 border-t bg-surface-1 pb-safe", className)}>
			<button type="button" onClick={onOpenChat} className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-xs text-muted-foreground outline-none transition-colors hover:bg-surface-2 focus-visible:bg-surface-2">
				<Users className="size-4 shrink-0 text-accent" aria-hidden />
				<span className="min-w-0 flex-1 truncate">
					{last ? (
						<>
							<span className="font-medium text-foreground">{last.author.kind === "system" ? t("System") : last.author.kind === "agent" ? `${last.author.agentName ?? t("agent")}@${last.author.nodeName}` : `${t("human")}@${last.author.nodeName}`}</span>: {last.text ? (last.kind === "system" || last.author.kind === "system" ? renderServerText(last.text, last.i18n) : last.text) : t("{count, plural, one {shared # file} other {shared # files}}", { count: last.attachments.length })}
						</>
					) : (
						t("This is a read-only workspace — talk to the group in the group chat")
					)}
				</span>
				{unread > 0 ? <span className="tabular grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1.5 text-2xs font-semibold text-accent-foreground">{unread}</span> : null}
				<span className="shrink-0 font-medium text-accent">{t("Open group chat")}</span>
			</button>
		</div>
	);
}
