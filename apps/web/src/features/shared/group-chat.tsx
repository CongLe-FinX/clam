import { type MessagesPage, routes, type UiMessage, type Checkpoint, type Participant, type SharedMessage, type SharedSession, type SharedSessionDetail } from "@clam/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowDown, AtSign, Bot, Camera, Check, CornerDownRight, ExternalLink, GitCommitHorizontal, Send, User, Users } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { type KeyboardEvent, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { LazyMarkdown } from "@/components/lazy-markdown";
import { BudgetMeter } from "@/features/tasks/discussion";
import { DeliveryMark } from "@/features/tasks/components";
import { KIND_META } from "@/features/tasks/format";
import { api } from "@/lib/api";
import { useNode } from "@/lib/queries";
import { cn, relativeTime } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { StatusDot } from "@/ui/status-dot";
import { Textarea } from "@/ui/textarea";
import { Tip } from "@/ui/tooltip";
import { commitUrl, driverOf, NODE_STATUS_LABEL, nodeDot, participantLabel, remoteSessionUrl, shortCommit, teamOf } from "./format.ts";
import { textOf } from "@/features/session/stream-store";
import { compareMessages, useCheckpointNow, useMarkSharedRead, useNodeUiUrl, usePostSharedMessage } from "./hooks.ts";

const STICK = 80;
const time = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" });
const dateTime = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const coarsePointer = typeof matchMedia === "function" ? matchMedia("(pointer: coarse)") : null;


interface Earlier {
	items: UiMessage[];
	truncated: boolean;
}

/** The session's own transcript up to the moment the group started (prompts and the agent's final texts only). */
function useEarlierConversation(sessionId: string, cutoff: number): Earlier {
	const q = useQuery({
		queryKey: ["local", "session", sessionId, "earlier"],
		queryFn: ({ signal }) => api.get<MessagesPage>(routes.sessionMessages(sessionId), { limit: 120 }, { signal }),
		staleTime: 60_000,
	});
	return useMemo(() => {
		const items = (q.data?.messages ?? []).filter((m) => (m.role === "user" || m.role === "assistant") && m.timestamp < cutoff && textOf(m).trim() !== "").sort((a, b) => a.timestamp - b.timestamp);
		return { items, truncated: q.data?.nextCursor != null };
	}, [q.data, cutoff]);
}

const EarlierBubble = memo(function EarlierBubble({ message }: { message: UiMessage }) {
	const user = message.role === "user";
	return (
		<div className={cn("flex flex-col gap-1", user ? "items-end" : "items-start")}>
			<span className="text-2xs text-subtle">
				{user ? "Prompt" : "Agent"} · {time.format(message.timestamp)}
			</span>
			<div className={cn("max-w-[92%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed opacity-90 shadow-[inset_0_0_0_1px_var(--border)] sm:max-w-[80%]", user ? "rounded-tr-md bg-surface-3/60" : "rounded-tl-md bg-surface-1")}>
				<LazyMarkdown text={textOf(message)} />
			</div>
		</div>
	);
});
/** Where an agent's own workspace (its session, with the tool calls) can be opened from this node. */
type WorkspaceTarget = { kind: "here" } | { kind: "session"; sessionId: string } | { kind: "external"; nodeId: string; nodeName: string; uiUrl: string | null; sessionId: string | null } | null;

function workspaceOf(shared: SharedSession, nodeId: string, selfNodeId: string | undefined, currentSessionId: string): WorkspaceTarget {
	const p = shared.participants.find((x) => x.nodeId === nodeId);
	if (!p) return null;
	if (nodeId === selfNodeId) {
		const own = p.agentSessionId ?? (shared.localRole === "driver" ? shared.localSessionId : null);
		if (!own) return null;
		return own === currentSessionId ? { kind: "here" } : { kind: "session", sessionId: own };
	}
	if (nodeId === shared.driverNodeId && shared.mirrorSessionId) return shared.mirrorSessionId === currentSessionId ? { kind: "here" } : { kind: "session", sessionId: shared.mirrorSessionId };
	return { kind: "external", nodeId, nodeName: p.nodeName, uiUrl: p.uiUrl, sessionId: p.agentSessionId };
}

function ExternalLive({ target }: { target: Extract<WorkspaceTarget, { kind: "external" }> }) {
	const ui = useNodeUiUrl(target.nodeId, target.uiUrl);
	if (!ui) return null;
	return (
		<a href={remoteSessionUrl(ui, target.sessionId)} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-2xs text-subtle hover:text-foreground">
			<ExternalLink className="size-3" aria-hidden /> Open live view on {target.nodeName}
		</a>
	);
}

function sameDay(a: string, b: string): boolean {
	return new Date(a).toDateString() === new Date(b).toDateString();
}

function recipients(m: SharedMessage, participants: Participant[]): string | null {
	if (m.to.mode === "all") return "everyone";
	if (m.to.mode === "agents" && m.to.agents.length > 0) {
		const names = m.to.agents.map((a) => {
			const p = participants.find((x) => x.agentId === a.agentId && x.nodeId === a.nodeId);
			return p ? participantLabel(p) : "agent";
		});
		return names.join(", ");
	}
	return null;
}

const Bubble = memo(function Bubble({
	message,
	shared,
	selfNodeId,
	sessionId,
	showDate,
	onOpenWorkspace,
}: {
	message: SharedMessage;
	shared: SharedSession;
	selfNodeId: string | undefined;
	sessionId: string;
	showDate: boolean;
	onOpenWorkspace: () => void;
}) {
	const { author } = message;
	const date = showDate ? <div className="py-1 text-center text-2xs font-medium text-subtle">{dateTime.format(Date.parse(message.createdAt))}</div> : null;
	if (message.kind === "system" || author.kind === "system") {
		return (
			<div className="flex flex-col items-center gap-1 py-1">
				{date}
				<p className="max-w-[92%] rounded-full bg-surface-2 px-3 py-1 text-center text-2xs text-muted-foreground">{message.text}</p>
			</div>
		);
	}
	const isAgent = author.kind === "agent";
	const mine = !isAgent && selfNodeId !== undefined && author.nodeId === selfNodeId;
	const lead = isAgent && author.nodeId === shared.driverNodeId;
	const legacy = message.kind !== "chat" && message.kind !== "reply" ? KIND_META[message.kind] : null;
	const to = recipients(message, shared.participants);
	const Icon = isAgent ? Bot : User;
	const label = isAgent ? `${author.agentName ?? "agent"}@${author.nodeName}` : `human@${author.nodeName}`;
	const target = isAgent ? workspaceOf(shared, author.nodeId, selfNodeId, sessionId) : null;
	return (
		<div className="flex flex-col gap-1.5">
			{date}
			<div data-message-id={message.id} data-author-kind={author.kind} className={cn("flex flex-col gap-1", mine ? "items-end" : "items-start")}>
				<div className={cn("flex max-w-full flex-wrap items-center gap-1.5 text-2xs", mine && "flex-row-reverse")}>
					<span className={cn("inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-medium", isAgent ? "bg-accent-soft text-accent" : "bg-surface-3 text-foreground")}>
						<Icon className="size-3 shrink-0" aria-hidden />
						<span className="truncate">{label}</span>
					</span>
					{lead ? <Badge variant="accent">lead</Badge> : null}
					{legacy ? <Badge variant={legacy.variant}>{legacy.label}</Badge> : null}
					{to ? (
						<span className="inline-flex items-center gap-0.5 text-subtle">
							<CornerDownRight className="size-3" aria-hidden /> {to}
						</span>
					) : null}
					<span className="tabular text-subtle" title={new Date(message.createdAt).toLocaleString()}>
						{time.format(Date.parse(message.createdAt))}
					</span>
				</div>
				<div
					className={cn(
						"max-w-[92%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed shadow-[inset_0_0_0_1px_var(--border)] sm:max-w-[80%]",
						mine ? "rounded-tr-md bg-accent-soft" : isAgent ? "rounded-tl-md bg-surface-2" : "rounded-tl-md bg-surface-3/60",
					)}
				>
					<LazyMarkdown text={message.text} />
				</div>
				<div className={cn("flex min-h-5 flex-wrap items-center gap-x-3 gap-y-0.5", mine && "justify-end")}>
					{mine ? <DeliveryMark state={message.delivery} /> : null}
					{target?.kind === "here" ? (
						<button type="button" onClick={onOpenWorkspace} className="inline-flex items-center gap-1 rounded text-2xs text-subtle outline-none hover:text-foreground focus-visible:text-foreground coarse:py-2">
							<ExternalLink className="size-3" aria-hidden /> Open live view
						</button>
					) : null}
					{target?.kind === "session" ? (
						<Link to="/sessions/$sessionId" params={{ sessionId: target.sessionId }} className="inline-flex items-center gap-1 text-2xs text-subtle hover:text-foreground coarse:py-2">
							<ExternalLink className="size-3" aria-hidden /> Open live view
						</Link>
					) : null}
					{target?.kind === "external" ? <ExternalLive target={target} /> : null}
				</div>
			</div>
		</div>
	);
});

// ───────────────────────────── header ─────────────────────────────

function Avatar({ p, lead }: { p: Participant; lead: boolean }) {
	const initials = p.nodeName
		.split(/[\s-]+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((w) => w[0]?.toUpperCase())
		.join("");
	return (
		<Tip label={`${participantLabel(p)}${lead ? " · lead" : ""} · ${NODE_STATUS_LABEL[p.nodeStatus]}`}>
			<span className="relative inline-grid" role="img" aria-label={`${participantLabel(p)}${lead ? ", lead" : ""}, ${NODE_STATUS_LABEL[p.nodeStatus]}`}>
				<span className={cn("grid size-7 place-items-center rounded-full bg-surface-3 text-[11px] font-semibold text-foreground coarse:size-8", lead && "shadow-[0_0_0_2px_var(--accent)]")}>{initials}</span>
				<StatusDot status={nodeDot(p.nodeStatus)} label={NODE_STATUS_LABEL[p.nodeStatus]} className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full shadow-[0_0_0_2px_var(--surface-1)] [&>span]:size-2.5" />
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
				<Button size="sm" variant="ghost" className="shrink-0 text-muted-foreground" aria-label="Checkpoints">
					<Camera /> <span className="tabular max-sm:hidden">{last ? `#${last.seq} · ${relativeTime(last.at)}` : "No checkpoint"}</span>
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-80">
				<div className="flex flex-col gap-2.5">
					<p className="text-xs text-muted-foreground">A checkpoint commits the lead's work to the shared branch and ships a snapshot to every member node.</p>
					{recent.length === 0 ? <p className="text-xs text-subtle">No checkpoints yet.</p> : null}
					<ul className="flex flex-col gap-1.5">
						{recent.map((c) => {
							const url = c.commit ? commitUrl(shared.repo.url, c.commit) : null;
							return (
								<li key={c.seq} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
									<span className="font-medium">#{c.seq}</span>
									<span className="text-subtle">{relativeTime(c.at)}</span>
									{c.commit ? (
										<span className="inline-flex items-center gap-0.5 font-mono text-muted-foreground">
											<GitCommitHorizontal className="size-3" aria-hidden />
											{url ? (
												<a href={url} target="_blank" rel="noreferrer noopener" className="hover:underline">
													{shortCommit(c.commit)}
												</a>
											) : (
												shortCommit(c.commit)
											)}
										</span>
									) : null}
									{c.pushed ? (
										<span className="inline-flex items-center gap-0.5 text-success">
											<Check className="size-3" aria-hidden /> pushed
										</span>
									) : c.commit ? (
										<span className="text-warning">not pushed</span>
									) : null}
								</li>
							);
						})}
					</ul>
					<div className="flex flex-wrap gap-2">
						{shared.localRole === "driver" ? (
							<Button size="sm" variant="outline" loading={now.isPending} onClick={() => now.mutate(undefined)}>
								<Camera /> Checkpoint now
							</Button>
						) : null}
						<Button size="sm" variant="ghost" onClick={onOpenTeam}>
							All checkpoints
						</Button>
					</div>
				</div>
			</PopoverContent>
		</Popover>
	);
}

function ChatHeader({ detail, onOpenTeam }: { detail: SharedSessionDetail; onOpenTeam: () => void }) {
	const { shared } = detail;
	const members = teamOf(shared);
	const lead = driverOf(shared);
	return (
		<div className="flex shrink-0 flex-col gap-2 border-b px-3 py-2">
			<div className="flex items-center gap-2">
				<button type="button" onClick={onOpenTeam} aria-label="Open the team" className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-0.5 text-left outline-none hover:bg-surface-2 focus-visible:bg-surface-2 coarse:py-1.5">
					<span className="flex -space-x-1.5">
						{members.map((p) => (
							<Avatar key={p.nodeId} p={p} lead={p.nodeId === shared.driverNodeId} />
						))}
					</span>
					<span className="min-w-0 truncate text-xs text-muted-foreground">
						<span className="font-medium text-foreground">{members.length} in the group</span>
						{lead ? <> · lead {participantLabel(lead)}</> : null}
					</span>
				</button>
				<CheckpointsPopover shared={shared} checkpoints={detail.checkpoints} onOpenTeam={onOpenTeam} />
			</div>
		</div>
	);
}

// ───────────────────────────── composer ─────────────────────────────

interface MentionOption {
	key: string;
	insert: string;
	label: string;
	hint: string;
	kind: "all" | "agent" | "node";
	nodeId?: string;
	agentId?: string | null;
}

function mentionOptions(shared: SharedSession): MentionOption[] {
	const out: MentionOption[] = [{ key: "all", insert: "@all", label: "@all", hint: "every agent in the group", kind: "all" }];
	const team = teamOf(shared);
	for (const p of team) {
		if (!(p.agentName && p.agentId)) continue;
		// Two agents with the same name (the default "OMP Agent" on every node) are told apart by their node.
		const token = team.filter((x) => x.agentName === p.agentName).length > 1 ? `@${p.agentName}@${p.nodeName}` : `@${p.agentName}`;
		out.push({ key: `a:${p.nodeId}`, insert: token, label: token, hint: `agent on ${p.nodeName}${p.nodeId === shared.driverNodeId ? " · lead" : ""}`, kind: "agent", nodeId: p.nodeId, agentId: p.agentId });
	}
	for (const p of teamOf(shared)) out.push({ key: `n:${p.nodeId}`, insert: `@${p.nodeName}`, label: `@${p.nodeName}`, hint: "the agent on this node", kind: "node", nodeId: p.nodeId, agentId: p.agentId });
	return out;
}

function GroupComposer({ detail, keyboardOpen, className }: { detail: SharedSessionDetail; keyboardOpen?: boolean; className?: string }) {
	const { shared } = detail;
	const post = usePostSharedMessage(shared.id);
	const [text, setText] = useState("");
	const [picked, setPicked] = useState<MentionOption[]>([]);
	const [menu, setMenu] = useState<{ start: number; query: string } | null>(null);
	const [active, setActive] = useState(0);
	const ref = useRef<HTMLTextAreaElement>(null);
	const options = useMemo(() => mentionOptions(shared), [shared]);
	const lead = driverOf(shared);
	const me = shared.participants.find((p) => p.nodeStatus === "self");
	const out = me !== undefined && (me.state === "left" || me.state === "removed" || me.state === "declined");
	const touch = coarsePointer?.matches ?? false;

	const matches = useMemo(() => (menu ? options.filter((o) => o.label.slice(1).toLowerCase().includes(menu.query.toLowerCase())) : []), [menu, options]);
	useEffect(() => setActive(0), [menu?.query]);

	const refreshMenu = (value: string, caret: number) => {
		const m = /(^|\s)@([^\s@]*)$/.exec(value.slice(0, caret));
		setMenu(m ? { start: caret - (m[2]?.length ?? 0) - 1, query: m[2] ?? "" } : null);
	};
	const choose = (o: MentionOption) => {
		if (!menu) return;
		const el = ref.current;
		const caret = el?.selectionStart ?? text.length;
		const next = `${text.slice(0, menu.start)}${o.insert} ${text.slice(caret)}`;
		setText(next);
		setPicked((p) => (p.some((x) => x.key === o.key) ? p : [...p, o]));
		setMenu(null);
		requestAnimationFrame(() => {
			const pos = menu.start + o.insert.length + 1;
			el?.focus();
			el?.setSelectionRange(pos, pos);
		});
	};

	const send = () => {
		const body = text.trim();
		if (!body || post.isPending || out) return;
		const used = picked.filter((o) => body.includes(o.insert));
		let to: { mode: "all" | "lead" | "agents"; agents: Array<{ nodeId: string; agentId: string }> } | undefined;
		if (used.some((o) => o.kind === "all")) to = { mode: "all", agents: [] };
		else {
			const agents = used.flatMap((o) => (o.nodeId && o.agentId ? [{ nodeId: o.nodeId, agentId: o.agentId }] : []));
			if (agents.length > 0) to = { mode: "agents", agents };
		}
		post.mutate(
			{ text: body, kind: "chat", to },
			{
				onSuccess: () => {
					setText("");
					setPicked([]);
					setMenu(null);
				},
			},
		);
	};

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (menu && matches.length > 0) {
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				setActive((i) => (i + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
				return;
			}
			if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				const o = matches[active];
				if (o) choose(o);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				setMenu(null);
				return;
			}
		}
		if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
		if (e.metaKey || e.ctrlKey || (!e.shiftKey && !touch)) {
			e.preventDefault();
			send();
		}
	};

	if (out) return <div className={cn("shrink-0 border-t px-4 py-3 pb-safe text-center text-xs text-subtle", className)}>You are no longer part of this group; the chat is read-only.</div>;
	return (
		<div className={cn("relative shrink-0 bg-surface-1 px-3 pt-2.5", keyboardOpen ? "pb-2" : "pb-[max(0.75rem,env(safe-area-inset-bottom))]", className)}>
			{menu && matches.length > 0 ? (
				<ul role="listbox" aria-label="Mention" className="clam-pop absolute inset-x-3 bottom-full z-10 mb-1 flex max-h-56 flex-col overflow-y-auto rounded-xl bg-overlay p-1 shadow-pop shadow-[inset_0_0_0_1px_var(--border-strong)]">
					{matches.map((o, i) => (
						<li key={o.key} role="option" aria-selected={i === active}>
							<button
								type="button"
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => choose(o)}
								className={cn("flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] outline-none coarse:min-h-11", i === active ? "bg-surface-3" : "hover:bg-surface-2")}
							>
								{o.kind === "all" ? <Users className="size-3.5 shrink-0 text-subtle" aria-hidden /> : o.kind === "agent" ? <Bot className="size-3.5 shrink-0 text-accent" aria-hidden /> : <AtSign className="size-3.5 shrink-0 text-subtle" aria-hidden />}
								<span className="font-medium">{o.label}</span>
								<span className="min-w-0 flex-1 truncate text-2xs text-subtle">{o.hint}</span>
							</button>
						</li>
					))}
				</ul>
			) : null}
			<div className="flex items-end gap-2">
				<Textarea
					ref={ref}
					value={text}
					onChange={(e) => {
						setText(e.target.value);
						refreshMenu(e.target.value, e.target.selectionStart);
					}}
					onKeyDown={onKeyDown}
					onClick={(e) => refreshMenu(e.currentTarget.value, e.currentTarget.selectionStart)}
					rows={2}
					maxLength={20_000}
					aria-label="Message to the group"
					placeholder={lead?.agentName ? `Message the group — goes to ${lead.agentName}@${lead.nodeName} (lead) unless you @mention someone` : "Message the group…"}
					enterKeyHint={touch ? "enter" : "send"}
					className="max-h-40 min-h-[2.75rem] flex-1 resize-none"
				/>
				<Button variant="primary" size="lg" onClick={send} loading={post.isPending} disabled={!text.trim()} aria-label="Send message" className="shrink-0 px-3.5 coarse:min-h-12 coarse:min-w-12">
					<Send />
				</Button>
			</div>
			{touch ? null : <p className="mt-1.5 hidden text-2xs text-subtle fine:block">Type @ to address an agent, a node or everyone · Enter sends · Shift+Enter for a new line</p>}
		</div>
	);
}

// ───────────────────────────── the chat ─────────────────────────────

/**
 * The group chat of a shared session: every person and agent in one timeline, the same on every member node. Each agent keeps its own
 * workspace (its session with the tool calls) behind "Open live view".
 */
export function GroupChat({
	session,
	detail,
	active,
	keyboardOpen,
	onOpenWorkspace,
	onOpenTeam,
	className,
}: {
	session: { id: string };
	detail: SharedSessionDetail;
	/** The chat is on screen: new messages count as read. */
	active: boolean;
	keyboardOpen: boolean;
	onOpenWorkspace: () => void;
	onOpenTeam: () => void;
	className?: string;
}) {
	const { shared } = detail;
	const selfNodeId = useNode().data?.id;
	const markRead = useMarkSharedRead(shared.id);
	const messages = useMemo(() => [...detail.messages].sort(compareMessages), [detail.messages]);
	// The conversation the session had before it became a group is the beginning of the timeline; the group log starts at its first line.
	const cutoff = messages[0] ? Date.parse(messages[0].createdAt) : Number.POSITIVE_INFINITY;
	const earlier = useEarlierConversation(session.id, cutoff);
	const parentRef = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const lastCount = useRef(0);
	const [atBottom, setAtBottom] = useState(true);
	const [unseen, setUnseen] = useState(0);

	const toBottom = useCallback(() => {
		const el = parentRef.current;
		if (!el) return;
		stick.current = true;
		el.scrollTop = el.scrollHeight;
		setAtBottom(true);
		setUnseen(0);
	}, []);
	const onScroll = useCallback(() => {
		const el = parentRef.current;
		if (!el) return;
		const near = el.scrollHeight - el.scrollTop - el.clientHeight < STICK;
		stick.current = near;
		setAtBottom(near);
		if (near) setUnseen(0);
	}, []);
	useLayoutEffect(() => {
		const grew = messages.length - lastCount.current;
		if (grew > 0 && lastCount.current > 0 && !stick.current) setUnseen((n) => n + grew);
		lastCount.current = messages.length;
		if (stick.current) toBottom();
	});
	useEffect(() => {
		if (active) requestAnimationFrame(toBottom);
	}, [active, toBottom]);
	useEffect(() => {
		if (active && shared.unreadMessages > 0 && document.visibilityState === "visible") markRead();
	}, [active, shared.unreadMessages, messages.length, markRead]);

	return (
		<div className={cn("flex min-h-0 flex-1 flex-col bg-background", className)}>
			<ChatHeader detail={detail} onOpenTeam={onOpenTeam} />
			<div className="shrink-0 border-b px-3 py-1.5">
				<BudgetMeter left={shared.agentMessageBudget} noun="group" />
			</div>
			<div className="relative min-h-0 flex-1">
				{messages.length === 0 && earlier.items.length === 0 ? (
					<div className="absolute inset-0 grid place-items-center px-6 text-center text-[13px] text-subtle">
						<p>No messages yet. Everyone in the group — people and agents on every node — talks here. Mention an agent with @ to address it.</p>
					</div>
				) : (
					<div ref={parentRef} onScroll={onScroll} role="log" aria-label="Group chat" aria-relevant="additions" className="scrollbar-thin absolute inset-0 overflow-y-auto overscroll-contain [overflow-anchor:none]">
						<div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-4">
							{earlier.items.length > 0 ? (
								<>
									<p className="self-center rounded-full bg-surface-2 px-3 py-1 text-center text-2xs text-muted-foreground">
										Earlier in this session{earlier.truncated ? " (most recent part)" : ""} — before the group started
									</p>
									{earlier.items.map((m) => (
										<EarlierBubble key={m.id} message={m} />
									))}
								</>
							) : null}
							{messages.map((m, i) => {
								const prev = messages[i - 1];
								return (
									<Bubble
										key={m.id}
										message={m}
										shared={shared}
										selfNodeId={selfNodeId}
										sessionId={session.id}
										showDate={!prev || !sameDay(prev.createdAt, m.createdAt) || Date.parse(m.createdAt) - Date.parse(prev.createdAt) > 30 * 60_000}
										onOpenWorkspace={onOpenWorkspace}
									/>
								);
							})}
						</div>
					</div>
				)}
				{!atBottom && messages.length > 0 ? (
					<div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
						<button
							type="button"
							onClick={toBottom}
							className="animate-pop-in pointer-events-auto flex h-8 items-center gap-1.5 rounded-full bg-overlay pl-2.5 pr-3 text-xs font-medium shadow-pop shadow-[inset_0_0_0_1px_var(--border-strong)] outline-none active:scale-95 coarse:h-11"
						>
							<ArrowDown className="size-3.5" aria-hidden />
							{unseen > 0 ? `${unseen} new` : "Jump to latest"}
						</button>
					</div>
				) : null}
			</div>
			<GroupComposer detail={detail} keyboardOpen={keyboardOpen} />
		</div>
	);
}

/** Replaces the prompt composer under an agent workspace that you cannot prompt (live view, moved copy): the group chat is where you talk. */
export function GroupBar({ detail, onOpenChat, className }: { detail: SharedSessionDetail | undefined; onOpenChat: () => void; className?: string }) {
	const last = detail?.messages.length ? [...detail.messages].sort(compareMessages).at(-1) : undefined;
	const unread = detail?.shared.unreadMessages ?? 0;
	return (
		<div className={cn("shrink-0 border-t bg-surface-1 pb-safe", className)}>
			<button type="button" onClick={onOpenChat} className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-xs text-muted-foreground outline-none transition-colors hover:bg-surface-2 focus-visible:bg-surface-2">
				<Users className="size-4 shrink-0 text-accent" aria-hidden />
				<span className="min-w-0 flex-1 truncate">
					{last ? (
						<>
							<span className="font-medium text-foreground">{last.author.kind === "system" ? "System" : last.author.kind === "agent" ? `${last.author.agentName ?? "agent"}@${last.author.nodeName}` : `human@${last.author.nodeName}`}</span>: {last.text}
						</>
					) : (
						"This is a read-only workspace — talk to the group in the group chat"
					)}
				</span>
				{unread > 0 ? <span className="tabular grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1.5 text-2xs font-semibold text-accent-foreground">{unread}</span> : null}
				<span className="shrink-0 font-medium text-accent">Open group chat</span>
			</button>
		</div>
	);
}
