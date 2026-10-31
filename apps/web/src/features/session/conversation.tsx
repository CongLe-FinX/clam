import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, Loader2, MessagesSquare, RefreshCw, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty-state";
import { Skeleton } from "@/ui/skeleton";
import { MessageRow } from "./message-row.tsx";
import { isBusy, type SessionStream, useOrder, useStreamMeta } from "./stream-store.ts";

const STICK_THRESHOLD = 72;
const LOAD_OLDER_THRESHOLD = 280;

const STARTERS = ["Give me a quick tour of this codebase", "Find the cause of the failing tests and fix it", "Review my uncommitted changes", "Write a plan before changing anything: what should we improve first?"];

function ConversationSkeleton() {
	return (
		<div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6" aria-busy="true" aria-label="Loading conversation">
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

export function Conversation({ stream, onPickPrompt, readOnly, className }: { stream: SessionStream; onPickPrompt: (text: string) => void; /** Mirror / moved copy: no starter prompts. */ readOnly?: boolean; className?: string }) {
	const rows = useOrder(stream);
	const historyStatus = useStreamMeta(stream, (m) => m.historyStatus);
	const historyError = useStreamMeta(stream, (m) => m.historyError);
	const hasOlder = useStreamMeta(stream, (m) => m.hasOlder);
	const loadingOlder = useStreamMeta(stream, (m) => m.loadingOlder);
	const sendTick = useStreamMeta(stream, (m) => m.sendTick);
	const busy = useStreamMeta(stream, isBusy);

	const parentRef = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const [atBottom, setAtBottom] = useState(true);
	const [unread, setUnread] = useState(0);
	const anchor = useRef<{ key: string; offset: number } | null>(null);
	const firstKey = useRef<string | undefined>(undefined);
	const lastKey = useRef<string | undefined>(undefined);
	const lastLen = useRef(0);

	const v = useVirtualizer({
		count: rows.length,
		getScrollElement: () => parentRef.current,
		estimateSize: () => 132,
		overscan: 8,
		paddingStart: 20,
		paddingEnd: 20,
		getItemKey: (i) => rows[i] ?? i,
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
		} else if (stick.current && (busy || grew || lastLen.current === 0)) {
			el.scrollTop = el.scrollHeight;
		}
		firstKey.current = first;
		lastKey.current = last;
		lastLen.current = rows.length;
	});

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
				title="Could not load the conversation"
				description={errorMessage(historyError)}
				action={
					<Button variant="outline" onClick={() => void stream.retry()}>
						<RefreshCw /> Retry
					</Button>
				}
			/>
		);
	}

	// Busy with nothing to show yet (the runtime echoes the prompt a moment after admitting it): never offer starters.
	if (rows.length === 0 && busy) {
		return (
			<div className={cn("flex min-h-0 flex-1 items-center justify-center gap-2 text-[13px] text-muted-foreground", className)} role="status">
				<Loader2 className="size-4 animate-spin" aria-hidden /> The agent is working…
			</div>
		);
	}

	if (rows.length === 0 && readOnly) {
		return <EmptyState icon={MessagesSquare} title="Nothing to show yet" description="This is a read-only copy. Messages appear here as soon as the node that runs the work sends them." className={cn("flex-1", className)} />;
	}

	if (rows.length === 0) {
		return (
			<div className={cn("flex min-h-0 flex-1 flex-col items-center justify-center gap-6 overflow-y-auto px-4 py-8", className)}>
				<EmptyState icon={MessagesSquare} title="Start the conversation" description="Describe a task, ask a question about the code, or pick a starting point." className="py-0" />
				<div className="flex w-full max-w-md flex-col gap-2">
					{STARTERS.map((s) => (
						<button
							key={s}
							type="button"
							onClick={() => onPickPrompt(s)}
							className="rounded-xl bg-surface-1 px-3.5 py-2.5 text-left text-[13px] text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)] outline-none transition-[background-color,color,transform] hover:bg-surface-2 hover:text-foreground focus-visible:bg-surface-2 active:scale-[0.99] coarse:py-3.5"
						>
							{s}
						</button>
					))}
				</div>
			</div>
		);
	}

	return (
		<div className={cn("relative min-h-0 flex-1", className)}>
			<div
				ref={parentRef}
				onScroll={onScroll}
				role="log"
				aria-label="Conversation"
				aria-relevant="additions"
				className="scrollbar-thin absolute inset-0 overflow-y-auto overscroll-contain [overflow-anchor:none]"
			>
				<div className="relative w-full" style={{ height: v.getTotalSize() }}>
					{v.getVirtualItems().map((item) => {
						const key = rows[item.index];
						if (key === undefined) return null;
						return (
							<div key={item.key} data-index={item.index} ref={v.measureElement} className="absolute left-0 top-0 w-full" style={{ transform: `translateY(${item.start}px)` }}>
								<div className="mx-auto w-full max-w-3xl px-4 pb-5">
									<MessageRow stream={stream} rowKey={key} />
								</div>
							</div>
						);
					})}
				</div>
			</div>
			{loadingOlder ? (
				<div className="pointer-events-none absolute inset-x-0 top-2 flex justify-center">
					<span className="animate-pop-in flex items-center gap-1.5 rounded-full bg-overlay px-2.5 py-1 text-2xs text-muted-foreground shadow-pop shadow-[inset_0_0_0_1px_var(--border-strong)]">
						<Loader2 className="size-3 animate-spin" /> Loading earlier messages
					</span>
				</div>
			) : null}
			{!atBottom ? (
				<div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
					<button
						type="button"
						onClick={toBottom}
						className="animate-pop-in pointer-events-auto flex h-8 items-center gap-1.5 rounded-full bg-overlay pl-2.5 pr-3 text-xs font-medium shadow-pop shadow-[inset_0_0_0_1px_var(--border-strong)] outline-none transition-transform hover:bg-surface-2 active:scale-95 coarse:h-11"
					>
						<ArrowDown className="size-3.5" aria-hidden />
						{unread > 0 ? (
							<>
								<span className="tabular rounded-full bg-accent px-1.5 py-px text-2xs text-accent-foreground">{unread}</span> new
							</>
						) : (
							"Jump to latest"
						)}
					</button>
				</div>
			) : null}
		</div>
	);
}
