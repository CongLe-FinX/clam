import type { GitCommit } from "@clam/contracts";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Bot, GitBranch, RefreshCw, Tag } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { CopyButton } from "@/components/code-block";
import { errorMessage } from "@/lib/api";
import { cn, relativeTime } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty-state";
import { Skeleton } from "@/ui/skeleton";
import { useGitLog } from "./hooks.ts";
import { agentTrailer } from "./status-utils.ts";

const ROW_H = 64;

function refBadge(ref: string) {
	const isHead = ref.startsWith("HEAD");
	const isTag = ref.startsWith("tag:");
	const label = ref.replace(/^HEAD -> /, "").replace(/^tag: /, "");
	return (
		<Badge key={ref} variant={isHead ? "accent" : isTag ? "warning" : "outline"} className="max-w-[9rem] shrink-0">
			{isTag ? <Tag aria-hidden /> : <GitBranch aria-hidden />}
			<span className="truncate font-mono">{label}</span>
		</Badge>
	);
}

function CommitRow({ commit, active, onSelect }: { commit: GitCommit; active: boolean; onSelect: (c: GitCommit) => void }) {
	const agent = agentTrailer(commit.trailers);
	const others = Object.entries(commit.trailers).filter(([k]) => k.toLowerCase() !== "agent");
	return (
		<div className={cn("group/commit flex h-full items-stretch gap-1 border-b px-2 transition-colors", active ? "bg-accent-soft" : "hover:bg-surface-2")}>
			<button type="button" onClick={() => onSelect(commit)} aria-current={active || undefined} className="flex min-w-0 flex-1 flex-col justify-center gap-1 text-left outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--accent)]">
				<span className="truncate text-[13px] font-medium">{commit.subject}</span>
				<span className="flex min-w-0 items-center gap-1.5 overflow-hidden text-2xs text-subtle">
					<span className="shrink-0 font-mono text-muted-foreground">{commit.shortSha}</span>
					<span className="shrink-0 truncate">{commit.authorName}</span>
					<span className="shrink-0">· {relativeTime(commit.authoredAt)}</span>
					{agent ? (
						<Badge variant="accent" className="shrink-0" title={`Agent: ${agent}`}>
							<Bot aria-hidden />
							<span className="max-w-[10rem] truncate">{agent}</span>
						</Badge>
					) : null}
					{others.slice(0, 2).map(([k, val]) => (
						<Badge key={k} variant="neutral" className="shrink-0" title={`${k}: ${val}`}>
							<span className="max-w-[8rem] truncate">{k}</span>
						</Badge>
					))}
					{commit.refs.map(refBadge)}
				</span>
			</button>
			<CopyButton text={commit.sha} label="Copy full SHA" className="self-center opacity-0 focus-visible:opacity-100 group-hover/commit:opacity-100 coarse:opacity-100" />
		</div>
	);
}

export function HistoryList({ projectId, selectedSha, onSelect, className }: { projectId: string; selectedSha: string | null; onSelect: (c: GitCommit) => void; className?: string }) {
	const q = useGitLog(projectId);
	const commits = useMemo(() => q.data?.pages.flatMap((p) => p.commits) ?? [], [q.data]);
	const ref = useRef<HTMLDivElement>(null);
	const v = useVirtualizer({
		count: commits.length,
		getScrollElement: () => ref.current,
		estimateSize: () => ROW_H,
		getItemKey: (i) => commits[i]?.sha ?? i,
		overscan: 8,
	});
	const items = v.getVirtualItems();
	const last = items[items.length - 1]?.index ?? 0;
	const { hasNextPage, isFetchingNextPage, fetchNextPage } = q;
	useEffect(() => {
		if (hasNextPage && !isFetchingNextPage && commits.length > 0 && last >= commits.length - 6) void fetchNextPage();
	}, [last, commits.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

	if (q.isPending) {
		return (
			<div className="flex flex-col gap-px p-2" aria-busy>
				{Array.from({ length: 7 }, (_, i) => (
					<Skeleton key={i} className="h-14" />
				))}
			</div>
		);
	}
	if (q.error) {
		return (
			<EmptyState
				icon={GitBranch}
				title="Could not load history"
				description={errorMessage(q.error)}
				action={
					<Button size="sm" variant="outline" onClick={() => void q.refetch()}>
						<RefreshCw /> Retry
					</Button>
				}
			/>
		);
	}
	if (commits.length === 0) return <EmptyState icon={GitBranch} title="No commits yet" description="Commits on this branch appear here." className="py-10" />;

	return (
		<div ref={ref} className={cn("scrollbar-thin min-h-0 overflow-y-auto overscroll-contain [overflow-anchor:none]", className)}>
			<div className="relative w-full" style={{ height: v.getTotalSize() }}>
				{items.map((item) => {
					const c = commits[item.index];
					if (!c) return null;
					return (
						<div key={item.key} className="absolute left-0 top-0 w-full" style={{ height: ROW_H, transform: `translateY(${item.start}px)` }}>
							<CommitRow commit={c} active={selectedSha === c.sha} onSelect={onSelect} />
						</div>
					);
				})}
			</div>
			{isFetchingNextPage ? <div className="p-2 text-center text-2xs text-subtle">Loading more…</div> : null}
		</div>
	);
}
