import type { Task, TaskMessage } from "@clam/contracts";
import { Link } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, Bot, CornerDownRight, MessagesSquare, Send, User } from "lucide-react";
import { type KeyboardEvent, memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { LazyMarkdown } from "@/components/lazy-markdown";
import { useNode } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Progress } from "@/ui/progress";
import { Textarea } from "@/ui/textarea";
import { Kbd } from "@/ui/kbd";
import { DeliveryMark } from "./components.tsx";
import { AGENT_MESSAGE_LIMIT, KIND_META, authorLabel, isTerminal, ownParty } from "./format.ts";
import { useMarkTaskRead, usePostTaskMessage } from "./hooks.ts";

const time = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" });
const dateTime = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const STICK = 80;

type PostKind = "instruction" | "answer" | "note";
const POST_KINDS: Array<{ id: PostKind; label: string; hint: string }> = [
	{ id: "instruction", label: "Instruction", hint: "Steers the agent right now, even mid-turn." },
	{ id: "answer", label: "Answer", hint: "Replies to the agent's question and wakes it." },
	{ id: "note", label: "Note", hint: "Extra context; the agent reads it after its current step." },
];

function sameDay(a: string, b: string): boolean {
	return new Date(a).toDateString() === new Date(b).toDateString();
}

/** What the discussion pane renders: task messages and shared-session messages have this shape. */
export interface DiscussionMessage {
	id: string;
	author: { kind: "human" | "agent" | "system"; nodeId: string; nodeName: string; agentId: string | null; agentName: string | null };
	kind: "instruction" | "question" | "answer" | "note";
	text: string;
	createdAt: string;
	delivery: "local" | "pending" | "delivered" | "failed";
	injectedIntoSession: boolean;
}

const MessageBubble = memo(function MessageBubble({ message, mine, sessionId, showDate }: { message: DiscussionMessage; mine: boolean; sessionId: string | null; showDate: boolean }) {
	const { author } = message;
	const kind = KIND_META[message.kind];
	if (author.kind === "system") {
		return (
			<div className="flex flex-col items-center gap-1 py-1">
				{showDate ? <DateRule at={message.createdAt} /> : null}
				<p className="max-w-[90%] rounded-full bg-surface-2 px-3 py-1 text-center text-2xs text-muted-foreground">{message.text}</p>
			</div>
		);
	}
	const Icon = author.kind === "agent" ? Bot : User;
	return (
		<div className="flex flex-col gap-1.5">
			{showDate ? <DateRule at={message.createdAt} /> : null}
			<div data-message-id={message.id} data-author-kind={author.kind} className={cn("flex flex-col gap-1", mine ? "items-end" : "items-start")}>
				<div className={cn("flex max-w-full items-center gap-1.5 text-2xs", mine && "flex-row-reverse")}>
					<span
						className={cn(
							"inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-medium",
							author.kind === "agent" ? "bg-accent-soft text-accent" : "bg-surface-3 text-foreground",
						)}
					>
						<Icon className="size-3 shrink-0" aria-hidden />
						<span className="truncate">{authorLabel(message)}</span>
					</span>
					<Badge variant={kind.variant}>{kind.label}</Badge>
					<span className="tabular text-subtle" title={new Date(message.createdAt).toLocaleString()}>
						{time.format(Date.parse(message.createdAt))}
					</span>
				</div>
				<div
					className={cn(
						"max-w-[92%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed shadow-[inset_0_0_0_1px_var(--border)]",
						mine ? "rounded-tr-md bg-accent-soft" : "rounded-tl-md bg-surface-2",
						message.kind === "question" && !mine && "shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--warning)_45%,transparent)]",
					)}
				>
					<LazyMarkdown text={message.text} />
				</div>
				<div className={cn("flex min-h-5 flex-wrap items-center gap-x-3 gap-y-0.5", mine && "justify-end")}>
					{mine ? <DeliveryMark state={message.delivery} /> : null}
					{message.injectedIntoSession ? (
						sessionId ? (
							<Link to="/sessions/$sessionId" params={{ sessionId }} className="inline-flex items-center gap-1 text-2xs text-subtle hover:text-foreground">
								<CornerDownRight className="size-3" aria-hidden /> Injected into the agent's session
							</Link>
						) : (
							<span className="inline-flex items-center gap-1 text-2xs text-subtle">
								<CornerDownRight className="size-3" aria-hidden /> Injected into the agent's session
							</span>
						)
					) : null}
				</div>
			</div>
		</div>
	);
});

function DateRule({ at }: { at: string }) {
	return <div className="py-1 text-center text-2xs font-medium text-subtle">{dateTime.format(Date.parse(at))}</div>;
}

/** Agent-message budget (loop guard) as the machine enforces it. */
export function BudgetMeter({ left: budget, noun = "task" }: { left: number; noun?: string }) {
	const left = Math.max(0, budget);
	const used = Math.max(0, AGENT_MESSAGE_LIMIT - left);
	return (
		<div className="flex flex-col gap-1" title={`Each machine lets its agents post this many messages per ${noun}, so two agents cannot talk forever. A human can always continue the discussion.`}>
			<div className="flex items-center justify-between gap-2 text-2xs">
				<span className={cn(left === 0 ? "font-medium text-warning" : "text-subtle")}>{left === 0 ? "Agent messages used up — a human must continue" : `Agent messages left on this machine: ${left} of ${AGENT_MESSAGE_LIMIT}`}</span>
			</div>
			<Progress value={(used / AGENT_MESSAGE_LIMIT) * 100} tone={left === 0 ? "warning" : left <= 3 ? "warning" : "accent"} className="h-1" />
		</div>
	);
}

/** The discussion of one task. */
export function Discussion({ task, messages, visible, hideTitle, className }: { task: Task; messages: TaskMessage[]; visible: boolean; /** The caller already labels the pane (mobile tab). */ hideTitle?: boolean; className?: string }) {
	const post = usePostTaskMessage(task.id);
	const markRead = useMarkTaskRead(task.id);
	const closed = isTerminal(task.status);
	return (
		<DiscussionPane
			messages={messages}
			budgetLeft={task.agentMessageBudget}
			budgetNoun="task"
			unread={task.unreadMessages}
			onMarkRead={markRead}
			onPost={(body, done) => post.mutate(body, { onSuccess: done })}
			posting={post.isPending}
			closedNote={closed ? `This task is ${task.status === "succeeded" ? "finished" : task.status.replace("_", " ")}; the discussion is read-only.` : null}
			ownSessionId={ownParty(task).sessionId}
			visible={visible}
			hideTitle={hideTitle}
			className={className}
			logLabel="Task discussion"
			emptyText="No messages yet. Agents on both machines can ask questions and answer here; you can step in at any time."
			inputLabel="Message to the other machine"
		/>
	);
}

export interface DiscussionPaneProps {
	messages: DiscussionMessage[];
	budgetLeft: number;
	budgetNoun: string;
	unread: number;
	onMarkRead: () => void;
	onPost: (body: { text: string; kind: PostKind }, done: () => void) => void;
	posting: boolean;
	/** Set when the thread is read-only: shown instead of the composer. */
	closedNote: string | null;
	/** This machine's agent session the messages are injected into (for the "injected" link). */
	ownSessionId: string | null;
	visible: boolean;
	/** The caller already labels the pane (mobile tab). */
	hideTitle?: boolean;
	className?: string;
	logLabel: string;
	emptyText: string;
	inputLabel: string;
}

/** Message thread + budget meter + composer, shared by task and shared-session discussions. */
export function DiscussionPane({ messages, budgetLeft, budgetNoun, unread, onMarkRead, onPost, posting, closedNote, ownSessionId, visible, hideTitle, className, logLabel, emptyText, inputLabel }: DiscussionPaneProps) {
	const selfId = useNode().data?.id;
	const markRead = onMarkRead;
	const parentRef = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const [atBottom, setAtBottom] = useState(true);
	const [unseen, setUnseen] = useState(0);
	const lastCount = useRef(0);

	const v = useVirtualizer({
		count: messages.length,
		getScrollElement: () => parentRef.current,
		estimateSize: () => 110,
		overscan: 8,
		paddingStart: 12,
		paddingEnd: 12,
		getItemKey: (i) => messages[i]?.id ?? i,
	});

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

	// Follow the tail; when the user scrolled away, count what arrived instead.
	useLayoutEffect(() => {
		const grew = messages.length - lastCount.current;
		if (grew > 0 && lastCount.current > 0 && !stick.current) setUnseen((n) => n + grew);
		lastCount.current = messages.length;
		if (stick.current) toBottom();
	});
	// The tab / pane just became visible: jump to the latest.
	useEffect(() => {
		if (visible) requestAnimationFrame(toBottom);
	}, [visible, toBottom]);

	// Reading = the pane is on screen and the document is focused-ish.
	useEffect(() => {
		if (visible && unread > 0 && document.visibilityState === "visible") markRead();
	}, [visible, unread, messages.length, markRead]);

	return (
		<div className={cn("flex min-h-0 flex-col", className)}>
			<div className="flex shrink-0 flex-col gap-2 border-b px-4 py-2.5">
				{hideTitle ? null : (
					<div className="flex items-center gap-2">
						<MessagesSquare className="size-4 text-muted-foreground" aria-hidden />
						<h2 className="text-[13px] font-semibold">Discussion</h2>
						<span className="tabular font-mono text-2xs text-subtle">{messages.length}</span>
					</div>
				)}
				<BudgetMeter left={budgetLeft} noun={budgetNoun} />
			</div>
			<div className="relative min-h-0 flex-1">
				{messages.length === 0 ? (
					<div className="absolute inset-0 grid place-items-center px-6 text-center text-[13px] text-subtle">
						<p>{emptyText}</p>
					</div>
				) : (
					<div ref={parentRef} onScroll={onScroll} role="log" aria-label={logLabel} aria-relevant="additions" className="scrollbar-thin absolute inset-0 overflow-y-auto overscroll-contain [overflow-anchor:none]">
						<div className="relative w-full" style={{ height: v.getTotalSize() }}>
							{v.getVirtualItems().map((item) => {
								const m = messages[item.index];
								if (!m) return null;
								const prev = messages[item.index - 1];
								const mine = selfId !== undefined && m.author.nodeId === selfId;
								return (
									<div key={item.key} data-index={item.index} ref={v.measureElement} className="absolute left-0 top-0 w-full px-4 pb-3" style={{ transform: `translateY(${item.start}px)` }}>
										<MessageBubble message={m} mine={mine} sessionId={ownSessionId} showDate={!prev || !sameDay(prev.createdAt, m.createdAt) || Date.parse(m.createdAt) - Date.parse(prev.createdAt) > 30 * 60_000} />
									</div>
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
			<DiscussionComposer messages={messages} onPost={onPost} posting={posting} closedNote={closedNote} inputLabel={inputLabel} />
		</div>
	);
}

/** Kind chips + textarea + send. Also used on its own where the thread is shown elsewhere (mirror sessions). */
export function DiscussionComposer({
	messages,
	onPost,
	posting,
	closedNote,
	inputLabel,
	compact,
	className,
}: {
	messages: DiscussionMessage[];
	onPost: (body: { text: string; kind: PostKind }, done: () => void) => void;
	posting: boolean;
	closedNote: string | null;
	inputLabel: string;
	/** Single-line start, no kind hint line (mirror view). */
	compact?: boolean;
	className?: string;
}) {
	const selfId = useNode().data?.id;
	const [text, setText] = useState("");
	const [kind, setKind] = useState<PostKind | null>(null);
	const closed = closedNote !== null;
	const last = messages[messages.length - 1];
	const suggested: PostKind = last && last.kind === "question" && last.author.nodeId !== selfId ? "answer" : "note";
	const active = kind ?? suggested;
	const ready = text.trim().length > 0 && !closed;

	const send = () => {
		if (!ready || posting) return;
		onPost({ text: text.trim(), kind: active }, () => setText(""));
	};
	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			send();
		}
	};

	if (closedNote !== null) {
		return <div className={cn("shrink-0 border-t px-4 py-3 pb-safe text-center text-xs text-subtle", className)}>{closedNote}</div>;
	}
	return (
		<div className={cn("shrink-0 border-t bg-surface-1 px-3 pt-2.5", compact ? "pb-2" : "pb-[max(0.75rem,env(safe-area-inset-bottom))]", className)}>
			<div role="radiogroup" aria-label="Message kind" className="mb-2 flex gap-1">
				{POST_KINDS.map((k) => (
					<button
						key={k.id}
						type="button"
						role="radio"
						aria-checked={active === k.id}
						title={k.hint}
						onClick={() => setKind(k.id)}
						className={cn(
							"inline-flex h-7 items-center rounded-md px-2.5 text-xs font-medium outline-none transition-colors focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:h-11",
							active === k.id ? "bg-accent-soft text-accent" : "text-muted-foreground hover:bg-surface-2 hover:text-foreground",
						)}
					>
						{k.label}
					</button>
				))}
			</div>
			<div className="flex items-end gap-2">
				<Textarea
					value={text}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={onKeyDown}
					rows={compact ? 1 : 2}
					maxLength={20_000}
					aria-label={inputLabel}
					placeholder={active === "answer" ? "Answer the agent's question…" : active === "instruction" ? "Tell the agent what to do…" : "Add a note for the discussion…"}
					className="max-h-40 min-h-[2.75rem] flex-1 resize-none"
				/>
				<Button variant="primary" size="lg" onClick={send} loading={posting} disabled={!ready} aria-label="Send message" className="shrink-0 px-3.5 coarse:min-h-12 coarse:min-w-12">
					<Send />
				</Button>
			</div>
			{compact ? null : (
				<p className="mt-1.5 hidden items-center gap-1 text-2xs text-subtle fine:flex">
					<Kbd>⌘</Kbd>
					<Kbd>Enter</Kbd> to send · {POST_KINDS.find((k) => k.id === active)?.hint}
				</p>
			)}
		</div>
	);
}
