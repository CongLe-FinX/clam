import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, Loader2, MessagesSquare, RefreshCw, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { t } from "@/i18n";
import { errorText } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty-state";
import { Skeleton } from "@/ui/skeleton";
import { MessageRow } from "./message-row.tsx";
import { Starters } from "./starters.tsx";
import { isBusy, type SessionStream, useOrder, useStreamMeta } from "./stream-store.ts";
import { TypingIndicator } from "./typing-indicator.tsx";

const STICK_THRESHOLD = 72;
const LOAD_OLDER_THRESHOLD = 280;

function ConversationSkeleton() {
	return (
		<div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6" aria-busy="true" aria-label={t("Loading conversation")}>
			<div className="flex justify-end">
				<Skeleton className="h-9 w-2/5 rounded-2xl" />
			</div>
			<div className="flex flex-col gap-2">
				<Skeleton className="h-4 w-11/12" />
				<Skeleton className="h-4 w-4/5" />
				<Skeleton className="h-4 w-3/5" />
				<Skeleton className="mt-2 h-9 w-full rounded-lg" />
			</div>
			<div className="flex justify-end">
				<Skeleton className="h-9 w-1/3 rounded-2xl" />
			</div>
			<div className="flex flex-col gap-2">
				<Skeleton className="h-4 w-10/12" />
				<Skeleton className="h-4 w-2/3" />
			</div>
		</div>
	);
}

/** First-guess row height before a row is measured (code and media rows are measured as they mount). Keeps the scrollbar honest on long logs. */
function estimateRow(stream: SessionStream, key: string | undefined): number {
	const rec = key === undefined ? undefined : stream.getRec(key);
	if (!rec) return 80;
	const user = rec.msg.role === "user";
	let h = user ? 52 : 44;
	for (const b of rec.msg.content) {
		if (b.type === "text") {
			let lines = 0;
			for (const line of b.text.split("\n", 60)) lines += Math.max(1, Math.ceil(line.length / (user ? 70 : 88)));
			h += Math.min(lines, 60) * (user ? 21 : 23) + (user ? 0 : 12);
		} else if (b.type === "toolCall") h += 46;
		else if (b.type === "thinking") h += 30;
		else h += 220;
	}
	return Math.min(h, 900);
}

export function Conversation({ stream, onPickPrompt, readOnly, className }: { stream: SessionStream; onPickPrompt: (text: string) => void; /** Mirror / moved copy: no starter prompts. */ readOnly?: boolean; className?: string }) {
	const rows = useOrder(stream);
	const historyStatus = useStreamMeta(stream, (m) => m.historyStatus);
	const historyError = useStreamMeta(stream, (m) => m.historyError);
	const hasOlder = useStreamMeta(stream, (m) => m.hasOlder);
	const loadingOlder = useStreamMeta(stream, (m) => m.loadingOlder);
	const sendTick = useStreamMeta(stream, (m) => m.sendTick);
	const busy = useStreamMeta(stream, isBusy);

	const parentRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const [atBottom, setAtBottom] = useState(true);
	const [unread, setUnread] = useState(0);
	const anchor = useRef<{ key: string; offset: number } | null>(null);
	const firstKey = useRef<string | undefined>(undefined);
	const lastKey = useRef<string | undefined>(undefined);
	const lastLen = useRef(0);
	const hasRows = rows.length > 0;

	// Stable between renders so the virtualizer's measurement cache is only rebuilt when the row list changes.
	const getItemKey = useCallback((i: number) => rows[i] ?? i, [rows]);
	const estimateSize = useCallback((i: number) => estimateRow(stream, rows[i]), [stream, rows]);
	const v = useVirtualizer({
		count: rows.length,
		getScrollElement: () => parentRef.current,
		estimateSize,
		overscan: 5,
		paddingEnd: 20,
		getItemKey,
	});

	const loadOlder = useCallback(() => {
		const el = parentRef.current;
		if (!el) return;
		const items = v.getVirtualItems();
		const first = items.find((i) => i.start + i.size > el.scrollTop) ?? items[0];
		anchor.current = first ? { key: String(first.key), offset: first.start - el.scrollTop } : null;
		void stream.loadOlder();
	}, [v, stream]);

	const onScroll = useCallback(() => {
		const el = parentRef.current;
		if (!el) return;
		const near = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
		stick.current = near;
		setAtBottom(near);
		if (near) setUnread(0);
		if (el.scrollTop < LOAD_OLDER_THRESHOLD && hasOlder && !loadingOlder) loadOlder();
	}, [hasOlder, loadingOlder, loadOlder]);

	const toBottom = useCallback(() => {
		const el = parentRef.current;
		if (!el) return;
		stick.current = true;
		el.scrollTop = el.scrollHeight;
		setAtBottom(true);
		setUnread(0);
	}, []);

	// Keep the viewport anchored after older rows are prepended, and follow the tail while the user is at the bottom.
	useLayoutEffect(() => {
		const el = parentRef.current;
		if (!el) return;
		const first = rows[0];
		const last = rows[rows.length - 1];
		const grew = rows.length > lastLen.current;
		const prepended = first !== firstKey.current && lastKey.current !== undefined && last === lastKey.current && grew;
		if (prepended && anchor.current) {
			const idx = rows.indexOf(anchor.current.key);
			const off = idx >= 0 ? v.getOffsetForIndex(idx, "start") : undefined;
			if (off) el.scrollTop = off[0] - anchor.current.offset;
			anchor.current = null;
		} else if (stick.current && (grew || lastLen.current === 0)) {
			el.scrollTop = el.scrollHeight;
		}
		firstKey.current = first;
		lastKey.current = last;
		lastLen.current = rows.length;
	});

	// Anything that changes the scrollable height or the viewport while the user is at the bottom keeps the tail in view: streamed
	// text, an image/video that finished loading, a measured row replacing its estimate, the typing indicator, the mobile keyboard
	// resizing the viewport. ResizeObserver callbacks run after layout and before paint, so there is no visible jump.
	useEffect(() => {
		const scroller = parentRef.current;
		const content = contentRef.current;
		if (!hasRows || !scroller || !content) return;
		const ro = new ResizeObserver(() => {
			if (stick.current) scroller.scrollTop = scroller.scrollHeight;
		});
		ro.observe(scroller);
		ro.observe(content);
		return () => ro.disconnect();
	}, [hasRows]);

	// Unread indicator: rows appended at the tail while the user is scrolled away.
	const prevLast = useRef<string | undefined>(undefined);
	const prevCount = useRef(0);
	useEffect(() => {
		const last = rows[rows.length - 1];
		if (prevLast.current !== undefined && last !== prevLast.current && rows.length > prevCount.current && !stick.current) {
			setUnread((u) => u + (rows.length - prevCount.current));
		}
		prevLast.current = last;
		prevCount.current = rows.length;
	}, [rows]);

	// Own prompt: always jump to the latest.
	// biome-ignore lint/correctness/useExhaustiveDependencies: sendTick is the trigger
	useEffect(() => {
		if (sendTick > 0) toBottom();
	}, [sendTick, toBottom]);

	// Short histories may not fill the viewport: keep paging older until they do.
	useEffect(() => {
		const el = parentRef.current;
		if (el && hasOlder && !loadingOlder && historyStatus === "ready" && el.scrollHeight <= el.clientHeight + 8) loadOlder();
	}, [hasOlder, loadingOlder, historyStatus, rows.length, loadOlder]);

	if (historyStatus === "loading" && rows.length === 0) return <div className={cn("min-h-0 flex-1 overflow-hidden", className)}><ConversationSkeleton /></div>;

	if (historyStatus === "error" && rows.length === 0) {
		return (
			<EmptyState
				className={cn("flex-1", className)}
				icon={TriangleAlert}
				title={t("Could not load the conversation")}
				description={errorText(historyError)}
				action={
					<Button variant="outline" onClick={() => void stream.retry()}>
						<RefreshCw /> {t("Retry")}
					</Button>
				}
			/>
		);
	}

	// Busy with nothing to show yet (the runtime echoes the prompt a moment after admitting it): never offer starters.
	if (rows.length === 0 && busy) {
		return (
			<div className={cn("flex min-h-0 flex-1 items-center justify-center gap-2 text-[13px] text-muted-foreground", className)} role="status">
				<Loader2 className="size-4 animate-spin" aria-hidden /> {t("The agent is working…")}
			</div>
		);
	}

	if (rows.length === 0 && readOnly) {
		return <EmptyState icon={MessagesSquare} title={t("Nothing to show yet")} description={t("This is a read-only copy. Messages appear here as soon as the machine that runs the work sends them.")} className={cn("flex-1", className)} />;
	}

	if (rows.length === 0) {
		return (
			<div className={cn("flex min-h-0 flex-1 flex-col items-center gap-6 overflow-y-auto px-4 py-8 [&>:first-child]:mt-auto [&>:last-child]:mb-auto", className)}>
				<EmptyState icon={MessagesSquare} title={t("Start the conversation")} description={t("Describe a task or pick an example. Anything the agent creates shows up here and in the Files panel.")} className="py-0" />
				<Starters onPick={onPickPrompt} />
			</div>
		);
	}
	return (
		<div className={cn("relative min-h-0 flex-1", className)}>
			<div
				ref={parentRef}
				onScroll={onScroll}
				role="log"
				aria-label={t("Conversation")}
				aria-relevant="additions"
				className="scrollbar-thin absolute inset-0 overflow-y-auto overscroll-contain [overflow-anchor:none]"
			>
				<div ref={contentRef}>
					<div className="relative w-full" style={{ height: v.getTotalSize() }}>
						{v.getVirtualItems().map((item) => {
							const key = rows[item.index];
							if (key === undefined) return null;
							return (
								<div key={item.key} data-index={item.index} ref={v.measureElement} className="absolute left-0 top-0 w-full" style={{ transform: `translateY(${item.start}px)` }}>
									<div className="mx-auto w-full max-w-[60rem] px-4">
										<MessageRow stream={stream} rowKey={key} prevKey={rows[item.index - 1]} />
									</div>
								</div>
							);
						})}
					</div>
					<TypingIndicator stream={stream} />
				</div>
			</div>
			{loadingOlder ? (
				<div className="pointer-events-none absolute inset-x-0 top-2 flex justify-center">
					<span className="animate-pop-in flex items-center gap-1.5 rounded-full bg-overlay px-2.5 py-1 text-2xs text-muted-foreground shadow-pop shadow-[inset_0_0_0_1px_var(--border-strong)]">
						<Loader2 className="size-3 animate-spin" /> {t("Loading earlier messages")}
					</span>
				</div>
			) : null}
			{!atBottom ? (
				<div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
					<button
						type="button"
						onClick={toBottom}
						className="animate-pop-in pointer-events-auto flex h-8 items-center gap-1.5 rounded-full bg-overlay pl-2.5 pr-3 text-xs font-medium shadow-pop shadow-[inset_0_0_0_1px_var(--border-strong)] outline-none transition-transform hover:bg-surface-2 focus-visible:shadow-[inset_0_0_0_2px_var(--accent)] active:scale-95 coarse:h-11"
					>
						<ArrowDown className="size-3.5" aria-hidden />
						{unread > 0 ? (
							<>
								<span className="tabular rounded-full bg-accent px-1.5 py-px text-2xs text-accent-foreground">{unread}</span> {t("new")}
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
