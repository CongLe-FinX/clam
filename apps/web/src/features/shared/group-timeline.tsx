import { type MessagesPage, routes, type SharedMessage, type SharedSessionDetail, type UiMessage } from "@clam/contracts";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, Loader2, MessageCircleQuestion, RefreshCw } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { RELEASE_TAIL } from "@/components/collapsible-text";
import { LazyMarkdown } from "@/components/lazy-markdown";
import { textOf } from "@/features/session/stream-store";
import { useKeyboardInset } from "@/features/session/use-keyboard-inset";
import { t } from "@/i18n";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { type WorkingAgent } from "./activity.ts";
import { clockTime, dayKey, dayLabel } from "./format.ts";
import { GroupMessage, recipients, type WorkspaceTarget, workspaceOf } from "./group-message.tsx";
import type { SharedHistory } from "./hooks.ts";
import { AuthorAvatar, authorKey, hueOf, hueStyle } from "./identity.tsx";

const STICK_THRESHOLD = 72;
const LOAD_OLDER_THRESHOLD = 280;
/** Consecutive messages of one author closer than this share a header. */
const GROUP_MS = 5 * 60_000;
const FRESH_MS = 600;
const coarse = typeof matchMedia === "function" ? matchMedia("(pointer: coarse)") : null;

// ───────────────────────────── the session before the group ─────────────────────────────

export interface Earlier {
	items: UiMessage[];
	truncated: boolean;
}

/** The session's own transcript up to the moment the group started (prompts and the agent's final texts only). Only fetched once the group log is loaded back to its start. */
export function useEarlierConversation(sessionId: string, cutoff: number, enabled: boolean): Earlier {
	const q = useQuery({
		queryKey: ["local", "session", sessionId, "earlier"],
		queryFn: ({ signal }) => api.get<MessagesPage>(routes.sessionMessages(sessionId), { limit: 120 }, { signal }),
		staleTime: 60_000,
		enabled,
	});
	return useMemo(() => {
		if (!enabled) return { items: [], truncated: false };
		const items = (q.data?.messages ?? []).filter((m) => (m.role === "user" || m.role === "assistant") && m.timestamp < cutoff && textOf(m).trim() !== "").sort((a, b) => a.timestamp - b.timestamp);
		return { items, truncated: q.data?.nextCursor != null };
	}, [q.data, cutoff, enabled]);
}

const EarlierBubble = memo(function EarlierBubble({ message }: { message: UiMessage }) {
	const user = message.role === "user";
	return (
		<div className="flex flex-col gap-1 pt-3">
			<div className={cn("flex flex-col gap-1", user ? "items-end" : "items-start")}>
				<span className="text-2xs text-subtle">
					{user ? t("Prompt · {time}", { time: clockTime(message.timestamp) }) : t("Agent · {time}", { time: clockTime(message.timestamp) })}
				</span>
				<div className={cn("min-w-0 max-w-[min(100%,72ch)] rounded-2xl px-3.5 py-2 text-sm leading-relaxed opacity-90 shadow-[inset_0_0_0_1px_var(--border)]", user ? "rounded-tr-md bg-surface-3/60" : "rounded-tl-md bg-surface-1")}>
					<LazyMarkdown text={textOf(message)} breaks={user} />
				</div>
			</div>
		</div>
	);
});

// ───────────────────────────── row model ─────────────────────────────

type Row =
	| { type: "earlier-head"; key: string; truncated: boolean }
	| { type: "earlier"; key: string; message: UiMessage }
	| { type: "msg"; key: string; message: SharedMessage; grouped: boolean; day: string | null };

const isSystem = (m: SharedMessage): boolean => m.kind === "system" || m.author.kind === "system";

/** Flat list the virtualizer walks: pre-group transcript (once the log's start is loaded), then every message with its day divider and grouping. */
function buildRows(messages: readonly SharedMessage[], earlier: Earlier): Row[] {
	const rows: Row[] = [];
	if (earlier.items.length > 0) {
		rows.push({ type: "earlier-head", key: "earlier-head", truncated: earlier.truncated });
		for (const m of earlier.items) rows.push({ type: "earlier", key: `earlier:${m.id}`, message: m });
	}
	const now = Date.now();
	let prev: SharedMessage | undefined;
	let prevMs = 0;
	let prevDay = "";
	for (const m of messages) {
		const ms = Date.parse(m.createdAt);
		const day = dayKey(ms);
		const newDay = !prev || day !== prevDay;
		const grouped = !newDay && prev !== undefined && !isSystem(m) && !isSystem(prev) && authorKey(prev.author) === authorKey(m.author) && Math.abs(ms - prevMs) < GROUP_MS;
		rows.push({ type: "msg", key: m.id, message: m, grouped, day: newDay ? dayLabel(ms, now) : null });
		prev = m;
		prevMs = ms;
		prevDay = day;
	}
	return rows;
}

/**
 * Keys of messages that arrived while the chat was open (appended after the last one it had), for their entrance animation. A virtualized
 * row remounts whenever it scrolls back into view, so the key expires: the animation plays once, never on a remount.
 */
function useFreshKeys(rows: readonly Row[]): ReadonlySet<string> {
	const state = useRef({ seen: new Set<string>(), last: undefined as string | undefined, fresh: new Set<string>() });
	// Mutated from a memo on purpose: re-running it for the same rows (StrictMode) must not forget what was fresh.
	useMemo(() => {
		const s = state.current;
		let lastAt = -1;
		if (s.last !== undefined) {
			for (let i = rows.length - 1; i >= 0; i--) {
				if (rows[i]?.key === s.last) {
					lastAt = i;
					break;
				}
			}
		}
		rows.forEach((r, i) => {
			if (r.type !== "msg" || s.seen.has(r.key)) return;
			s.seen.add(r.key);
			// Only rows after the previous newest one are live; history paged in above, or a cache reset, is not.
			if (lastAt >= 0 && i > lastAt) {
				s.fresh.add(r.key);
				setTimeout(() => s.fresh.delete(r.key), FRESH_MS);
			}
		});
		for (let i = rows.length - 1; i >= 0; i--) {
			const r = rows[i];
			if (r?.type === "msg") {
				s.last = r.key;
				break;
			}
		}
	}, [rows]);
	return state.current.fresh;
}

// ───────────────────────────── working indicator ─────────────────────────────

const WorkingRow = memo(function WorkingRow({ agents, waiting }: { agents: WorkingAgent[]; waiting: boolean }) {
	if (agents.length === 0 && !waiting) return null;
	const first = agents[0] as WorkingAgent | undefined;
	// A question or approval that waits for a person: the agents are blocked on the group, not working.
	const text = waiting
		? t("Waiting for an answer")
		: !first
			? ""
			: agents.length === 1
				? t("{name} is working", { name: first.label })
				: agents.length === 2
					? t("{first} and {second} are working", { first: first.label, second: (agents[1] as WorkingAgent).label })
					: t("{first} and {count, plural, one {# more} other {# more}} are working", { first: first.label, count: agents.length - 1 });
	return (
		<div role="status" className="flex items-center gap-2.5 pt-3 text-xs text-muted-foreground motion-safe:animate-[clam-slide-up_160ms_var(--ease-out-quint)_both]">
			{agents.length === 0 ? (
				<span aria-hidden className="grid size-6 place-items-center rounded-full bg-warning/14 text-warning">
					<MessageCircleQuestion className="size-3.5" />
				</span>
			) : (
				<span className="flex -space-x-2">
					{agents.slice(0, 3).map((a) => (
						<AuthorAvatar key={a.key} name={a.label} hue={a.hue} agent badge={false} className="size-6 text-[9px] shadow-[0_0_0_2px_var(--background)]" />
					))}
				</span>
			)}
			<span className="min-w-0 truncate">{text}</span>
			{waiting ? null : (
				<span aria-hidden className="flex items-center gap-1">
					{[0, 1, 2].map((i) => (
						<span key={i} className="size-1.5 animate-pulse rounded-full bg-current" style={{ animationDelay: `${i * 160}ms` }} />
					))}
				</span>
			)}
		</div>
	);
});

// ───────────────────────────── timeline ─────────────────────────────

export function GroupTimeline({
	detail,
	sessionId,
	selfNodeId,
	active,
	earlier,
	history,
	working,
	waiting,
	onOpenWorkspace,
	className,
}: {
	detail: SharedSessionDetail;
	sessionId: string;
	selfNodeId: string | undefined;
	/** The chat is on screen: jump to the latest message. */
	active: boolean;
	earlier: Earlier;
	history: SharedHistory;
	working: WorkingAgent[];
	/** A question or approval of the agent is waiting for somebody in the group. */
	waiting: boolean;
	/** Must be stable: it is a prop of every memoized row. */
	onOpenWorkspace: () => void;
	className?: string;
}) {
	const { shared, messages } = detail;
	const rows = useMemo(() => buildRows(messages, earlier), [messages, earlier]);
	const fresh = useFreshKeys(rows);
	const kbInset = useKeyboardInset(coarse?.matches ?? false);

	const parentRef = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const [atBottom, setAtBottom] = useState(true);
	const [unseen, setUnseen] = useState(0);
	/** First row at least partly visible, as (key, distance from the viewport top): where to put the viewport back when rows appear above. */
	const viewAnchor = useRef<{ key: string; offset: number } | null>(null);
	const firstKey = useRef<string | undefined>(undefined);
	const lastKey = useRef<string | undefined>(undefined);
	const lastLen = useRef(0);

	const v = useVirtualizer({
		count: rows.length,
		getScrollElement: () => parentRef.current,
		estimateSize: (i) => (rows[i]?.type === "msg" ? 104 : 72),
		overscan: 8,
		paddingStart: 16,
		paddingEnd: 16,
		getItemKey: (i) => rows[i]?.key ?? i,
	});

	const remember = useCallback(() => {
		const el = parentRef.current;
		if (!el) return;
		const items = v.getVirtualItems();
		const first = items.find((i) => i.start + i.size > el.scrollTop) ?? items[0];
		viewAnchor.current = first ? { key: String(first.key), offset: first.start - el.scrollTop } : null;
	}, [v]);

	const { hasOlder, loading, failed, loadOlder } = history;
	const canLoad = hasOlder && !loading && !failed;

	const onScroll = useCallback(() => {
		const el = parentRef.current;
		if (!el) return;
		const near = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
		stick.current = near;
		setAtBottom(near);
		if (near) setUnseen(0);
		remember();
		if (el.scrollTop < LOAD_OLDER_THRESHOLD && canLoad) loadOlder();
	}, [canLoad, loadOlder, remember]);

	const toBottom = useCallback(() => {
		const el = parentRef.current;
		if (!el) return;
		stick.current = true;
		el.scrollTop = el.scrollHeight;
		setAtBottom(true);
		setUnseen(0);
	}, []);

	// Every render: keep the viewport where the user is (anchored when rows appear above) and follow the tail only while they are at the bottom.
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally runs after every render, size changes of rows included
	useLayoutEffect(() => {
		const el = parentRef.current;
		if (!el) return;
		const first = rows[0]?.key;
		const last = rows[rows.length - 1];
		const grew = rows.length > lastLen.current;
		const prepended = grew && lastKey.current !== undefined && last?.key === lastKey.current && first !== firstKey.current;
		const appendedOwn = grew && !prepended && last?.type === "msg" && last.message.author.kind === "human" && last.message.author.nodeId === selfNodeId;
		if (appendedOwn) stick.current = true;
		if (prepended && !stick.current && viewAnchor.current) {
			const idx = rows.findIndex((r) => r.key === viewAnchor.current?.key);
			const off = idx >= 0 ? v.getOffsetForIndex(idx, "start") : undefined;
			if (off) el.scrollTop = off[0] - viewAnchor.current.offset;
		} else if (stick.current) {
			el.scrollTop = el.scrollHeight;
		}
		firstKey.current = first;
		lastKey.current = last?.key;
		lastLen.current = rows.length;
		remember();
	});

	// The user expands or collapses a long message: stop following the tail so the page does not jump away from it.
	useEffect(() => {
		const scroller = parentRef.current;
		if (!scroller) return;
		const release = () => {
			stick.current = false;
		};
		scroller.addEventListener(RELEASE_TAIL, release);
		return () => scroller.removeEventListener(RELEASE_TAIL, release);
	}, []);

	// Rows appended at the tail while the user is reading further up.
	const prevLast = useRef<string | undefined>(undefined);
	const prevCount = useRef(0);
	useEffect(() => {
		const last = rows[rows.length - 1]?.key;
		if (prevLast.current !== undefined && last !== prevLast.current && rows.length > prevCount.current && !stick.current) setUnseen((n) => n + (rows.length - prevCount.current));
		prevLast.current = last;
		prevCount.current = rows.length;
	}, [rows]);

	useEffect(() => {
		if (active) requestAnimationFrame(toBottom);
	}, [active, toBottom]);

	// The keyboard (un)covering the bottom of the chat: stay on the latest message if the user was there.
	// biome-ignore lint/correctness/useExhaustiveDependencies: kbInset is the trigger
	useEffect(() => {
		if (stick.current) toBottom();
	}, [kbInset, toBottom]);

	// A short log may not fill the viewport: keep paging older until it does or the start is reached.
	useEffect(() => {
		const el = parentRef.current;
		if (el && canLoad && el.scrollHeight <= el.clientHeight + 8) loadOlder();
	}, [canLoad, rows.length, loadOlder]);

	// Per-author facts are resolved once per roster, not per row (a `shared` frame that changes only the unread count keeps every row as it is).
	// biome-ignore lint/correctness/useExhaustiveDependencies: the roster fields below are what the cached facts depend on
	const authors = useMemo(() => new Map<string, { hue: number; lead: boolean; target: WorkspaceTarget }>(), [shared.participants, shared.driverNodeId, shared.mirrorSessionId, shared.localSessionId, shared.localRole, selfNodeId, sessionId]);
	const authorOf = (m: SharedMessage) => {
		const key = authorKey(m.author);
		let a = authors.get(key);
		if (!a) {
			const agent = m.author.kind === "agent";
			a = { hue: hueOf(m.author.nodeId, m.author.agentId), lead: agent && m.author.nodeId === shared.driverNodeId, target: agent ? workspaceOf(shared, m.author.nodeId, selfNodeId, sessionId) : null };
			authors.set(key, a);
		}
		return a;
	};

	return (
		<div className={cn("relative min-h-0 flex-1", className)}>
			<div ref={parentRef} onScroll={onScroll} role="log" aria-label={t("Group chat")} aria-relevant="additions" className="scrollbar-thin absolute inset-0 overflow-y-auto overflow-x-hidden overscroll-contain [overflow-anchor:none]">
				<div className="relative w-full" style={{ height: v.getTotalSize() }}>
					{v.getVirtualItems().map((item) => {
						const row = rows[item.index];
						if (!row) return null;
						return (
							<div key={item.key} data-index={item.index} ref={v.measureElement} className="absolute left-0 top-0 w-full" style={{ transform: `translateY(${item.start}px)` }}>
								<div className="mx-auto w-full max-w-3xl pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]">
									{row.type === "earlier-head" ? (
										<p className="mx-auto w-fit rounded-full bg-surface-2 px-3 py-1 text-center text-2xs text-muted-foreground">
											{row.truncated ? t("Earlier in this session (most recent part) — before the group started") : t("Earlier in this session — before the group started")}
										</p>
									) : row.type === "earlier" ? (
										<EarlierBubble message={row.message} />
									) : (
										<GroupMessage
											message={row.message}
											sharedId={shared.id}
											grouped={row.grouped}
											day={row.day}
											mine={row.message.author.kind === "human" && row.message.author.nodeId === selfNodeId}
											lead={authorOf(row.message).lead}
											to={recipients(row.message, shared.participants)}
											hue={authorOf(row.message).hue}
											target={authorOf(row.message).target}
											fresh={fresh.has(row.key)}
											onOpenWorkspace={onOpenWorkspace}
										/>
									)}
								</div>
							</div>
						);
					})}
				</div>
				{working.length > 0 || waiting ? (
					<div className="mx-auto w-full max-w-3xl pb-4 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]">
						<WorkingRow agents={working} waiting={waiting} />
					</div>
				) : null}
			</div>
			{loading ? (
				<div className="pointer-events-none absolute inset-x-0 top-2 flex justify-center">
					<span role="status" className="animate-pop-in flex items-center gap-1.5 rounded-full bg-overlay px-2.5 py-1 text-2xs text-muted-foreground shadow-pop shadow-[inset_0_0_0_1px_var(--border-strong)]">
						<Loader2 className="size-3 animate-spin" aria-hidden /> {t("Loading earlier messages")}
					</span>
				</div>
			) : null}
			{failed ? (
				<div className="absolute inset-x-0 top-2 flex justify-center">
					<button
						type="button"
						onClick={loadOlder}
						className="animate-pop-in flex items-center gap-1.5 rounded-full bg-overlay px-3 py-1 text-2xs text-muted-foreground shadow-pop shadow-[inset_0_0_0_1px_var(--border-strong)] outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring coarse:min-h-11"
					>
						<RefreshCw className="size-3" aria-hidden /> {t("Could not load earlier messages — retry")}
					</button>
				</div>
			) : null}
			{!atBottom ? (
				<div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
					<button
						type="button"
						onClick={toBottom}
						className="animate-pop-in pointer-events-auto flex h-8 items-center gap-1.5 rounded-full bg-overlay pl-2.5 pr-3 text-xs font-medium shadow-pop shadow-[inset_0_0_0_1px_var(--border-strong)] outline-none transition-transform hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring active:scale-95 coarse:h-11"
					>
						<ArrowDown className="size-3.5" aria-hidden />
						{unseen > 0 ? (
							<>
								<span className="tabular rounded-full bg-accent px-1.5 py-px text-2xs text-accent-foreground">{unseen}</span> {t("{count, plural, one {new message} other {new messages}}", { count: unseen })}
							</>
						) : (
							t("Jump to latest")
						)}
					</button>
				</div>
			) : null}
		</div>
	);
}
