import { Users } from "lucide-react";
import { useMemo, useState } from "react";
import { cn, formatCost } from "@/lib/utils";
import { EmptyState } from "@/ui/empty-state";
import { Skeleton } from "@/ui/skeleton";
import { type OmpStore, useOmpState } from "./omp-store.ts";
import { SubagentRow, isLive } from "./subagent-ui.tsx";

type Filter = "all" | "running" | "finished";

function FilterChip({ active, onClick, children, count }: { active: boolean; onClick: () => void; children: string; count: number }) {
	return (
		<button
			type="button"
			aria-pressed={active}
			onClick={onClick}
			className={cn(
				"inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium outline-none transition-colors focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:h-10",
				active ? "bg-surface-3 text-foreground" : "text-muted-foreground hover:bg-surface-2 hover:text-foreground",
			)}
		>
			{children}
			<span className="tabular font-mono text-2xs text-subtle">{count}</span>
		</button>
	);
}

/** Side-panel tab: every subagent of the session, running first, with the same rows (and Stop / Steer) as the Team card. */
export function SubagentsPanel({ store }: { store: OmpStore }) {
	const { subagents, loaded, live } = useOmpState(store);
	const [filter, setFilter] = useState<Filter>("all");
	const running = subagents.filter(isLive).length;
	const shown = useMemo(() => {
		const list = filter === "running" ? subagents.filter(isLive) : filter === "finished" ? subagents.filter((s) => !isLive(s)) : [...subagents];
		// Running first, then newest spawn first.
		return list.sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || b.startedAt - a.startedAt || b.index - a.index);
	}, [subagents, filter]);
	const cost = subagents.reduce((n, s) => n + s.cost, 0);

	if (!loaded) {
		return (
			<div className="flex flex-col gap-3 p-4" aria-busy="true" aria-label="Loading subagents">
				{[0, 1].map((i) => (
					<div key={i} className="flex items-center gap-3">
						<Skeleton className="size-8 rounded-lg" />
						<div className="flex flex-1 flex-col gap-1.5">
							<Skeleton className="h-3.5 w-1/3" />
							<Skeleton className="h-3 w-3/4" />
						</div>
					</div>
				))}
			</div>
		);
	}
	if (subagents.length === 0) {
		return <EmptyState className="h-full" icon={Users} title="No subagents yet" description="When the agent hands work to subagents, they appear here with live progress." />;
	}
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex shrink-0 flex-wrap items-center gap-1 border-b px-2.5 py-2">
				<FilterChip active={filter === "all"} onClick={() => setFilter("all")} count={subagents.length}>
					All
				</FilterChip>
				<FilterChip active={filter === "running"} onClick={() => setFilter("running")} count={running}>
					Running
				</FilterChip>
				<FilterChip active={filter === "finished"} onClick={() => setFilter("finished")} count={subagents.length - running}>
					Finished
				</FilterChip>
			</div>
			{!live ? <p className="shrink-0 border-b bg-surface-2/60 px-3 py-1.5 text-2xs text-subtle">The agent is not running: this is the last state it reported.</p> : null}
			<div className="scrollbar-thin min-h-0 flex-1 divide-y overflow-y-auto overscroll-contain">
				{shown.length === 0 ? <p className="px-4 py-6 text-center text-xs text-muted-foreground">Nothing {filter === "running" ? "is running" : "has finished"} yet.</p> : shown.map((s) => <SubagentRow key={s.id} store={store} s={s} />)}
			</div>
			{cost > 0 ? (
				<div className="flex shrink-0 items-center justify-between border-t bg-surface-1 px-3 py-2 text-2xs text-subtle">
					<span>Total for {subagents.length} {subagents.length === 1 ? "subagent" : "subagents"}</span>
					<span className="tabular font-mono">{formatCost(cost)}</span>
				</div>
			) : null}
		</div>
	);
}
