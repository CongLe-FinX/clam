import type { ActivityItem } from "@clam/contracts";
import { Link, useParams } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Activity, ChevronRight, ListChecks, Loader2, MessageSquare, Network, RefreshCw, Server, type LucideIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { errorMessage } from "@/lib/api";
import { useWorkspaces } from "@/lib/queries";
import { relativeTime } from "@/lib/utils";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty-state";
import { PageHeader } from "@/ui/page";
import { Skeleton } from "@/ui/skeleton";
import { useActivity } from "./hooks.ts";

const ICON: Record<ActivityItem["kind"], LucideIcon> = { task: ListChecks, message: MessageSquare, peer: Network, node: Server };

export default function ActivityPage() {
	const { workspaceId } = useParams({ strict: false }) as { workspaceId?: string };
	const workspace = useWorkspaces().data?.find((w) => w.id === workspaceId);
	const q = useActivity(workspaceId);
	const items = q.data ?? [];
	const ref = useRef<HTMLDivElement>(null);
	const v = useVirtualizer({ count: items.length, getScrollElement: () => ref.current, estimateSize: () => 64, overscan: 10, getItemKey: (i) => items[i]?.id ?? i });

	// Infinite scroll: ask for the next page when the last rows are rendered.
	const last = v.getVirtualItems().at(-1)?.index ?? -1;
	const { hasNextPage, isFetchingNextPage, fetchNextPage } = q;
	useEffect(() => {
		if (items.length > 0 && last >= items.length - 6 && hasNextPage && !isFetchingNextPage) void fetchNextPage();
	}, [last, items.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

	return (
		<div className="flex h-full flex-col">
			<div className="mx-auto w-full max-w-4xl shrink-0 px-4 pb-3 pt-5 sm:px-6 lg:pt-7">
				<PageHeader
					eyebrow={
						workspaceId ? (
							<Link to="/workspaces/$workspaceId" params={{ workspaceId }} className="hover:text-foreground">
								{workspace?.name ?? "Workspace"}
							</Link>
						) : undefined
					}
					title="Activity"
					description="Tasks, discussion and connection changes, newest first."
				/>
			</div>
			<div ref={ref} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-contain [overflow-anchor:none]">
				<div className="mx-auto w-full max-w-4xl px-4 pb-6 sm:px-6">
					{q.isPending ? (
						<div aria-busy className="flex flex-col gap-2">
							{[0, 1, 2, 3, 4].map((i) => (
								<Skeleton key={i} className="h-14 rounded-lg" />
							))}
						</div>
					) : q.error ? (
						<EmptyState
							icon={Activity}
							title="Could not load activity"
							description={errorMessage(q.error)}
							action={
								<Button size="sm" variant="outline" onClick={() => void q.refetch()}>
									<RefreshCw /> Retry
								</Button>
							}
						/>
					) : items.length === 0 ? (
						<EmptyState icon={Activity} title="Nothing yet" description="Delegated tasks, messages from other nodes and connection changes show up here." />
					) : (
						<>
							<ul className="relative w-full" style={{ height: v.getTotalSize() }}>
								{v.getVirtualItems().map((item) => {
									const it = items[item.index];
									if (!it) return null;
									return (
										<li key={item.key} data-index={item.index} ref={v.measureElement} className="absolute left-0 top-0 w-full" style={{ transform: `translateY(${item.start}px)` }}>
											<Row item={it} />
										</li>
									);
								})}
							</ul>
							{isFetchingNextPage ? (
								<div className="flex justify-center py-4 text-xs text-subtle" role="status">
									<Loader2 className="mr-1.5 size-4 animate-spin" aria-hidden /> Loading older activity
								</div>
							) : !hasNextPage ? (
								<p className="py-4 text-center text-xs text-subtle">That's everything.</p>
							) : null}
						</>
					)}
				</div>
			</div>
		</div>
	);
}

function Row({ item }: { item: ActivityItem }) {
	const Icon = ICON[item.kind];
	const body = (
		<>
			<span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]">
				<Icon className="size-4" aria-hidden />
			</span>
			<span className="min-w-0 flex-1">
				<span className="block break-words text-[13px] leading-snug">{item.summary}</span>
				<span className="block text-2xs text-subtle" title={new Date(item.at).toLocaleString()}>
					{item.nodeName} · {relativeTime(item.at)}
				</span>
			</span>
		</>
	);
	const cls = "flex min-h-14 items-start gap-3 border-b px-1 py-2.5";
	if (item.taskId) {
		return (
			<Link to="/tasks/$taskId" params={{ taskId: item.taskId }} className={`${cls} rounded-lg outline-none hover:bg-surface-2/60 focus-visible:bg-surface-2`}>
				{body}
				<ChevronRight className="mt-2 size-4 shrink-0 text-subtle" aria-hidden />
			</Link>
		);
	}
	return <div className={cls}>{body}</div>;
}
