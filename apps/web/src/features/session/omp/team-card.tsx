import { ChevronDown, PanelRight, Users } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { cn, formatCost } from "@/lib/utils";
import { Tip } from "@/ui/tooltip";
import { Skeleton } from "@/ui/skeleton";
import { type OmpStore, type SubagentRec, useOmpState } from "./omp-store.ts";
import { Avatar, StatusChip, SubagentRow, isLive } from "./subagent-ui.tsx";

interface PlannedTask {
	name: string;
	agent: string;
	task: string;
}

/** The members the `task` call asked for, from its arguments: shown at once, before the runtime reports each spawn. */
function plannedTasks(args: unknown): PlannedTask[] {
	if (!args || typeof args !== "object") return [];
	const a = args as { tasks?: unknown; name?: unknown; agent?: unknown; task?: unknown };
	const items = Array.isArray(a.tasks) ? a.tasks : typeof a.task === "string" ? [a] : [];
	const out: PlannedTask[] = [];
	for (const raw of items) {
		if (!raw || typeof raw !== "object") continue;
		const t = raw as { name?: unknown; agent?: unknown; task?: unknown };
		out.push({ name: typeof t.name === "string" && t.name ? t.name : `Agent ${out.length + 1}`, agent: typeof t.agent === "string" && t.agent ? t.agent : "task", task: typeof t.task === "string" ? t.task : "" });
	}
	return out;
}

function PlannedRow({ planned, index, settled }: { planned: PlannedTask; index: number; settled: boolean }) {
	return (
		<div className="flex items-start gap-3 px-3 py-2.5">
			<Avatar name={planned.name} index={index} />
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<span className="flex items-center gap-2">
					<span className="min-w-0 truncate text-[13px] font-semibold">{planned.name}</span>
					<span className="shrink-0 rounded bg-surface-3 px-1.5 py-0.5 text-2xs text-muted-foreground">{planned.agent}</span>
					<span className="flex-1" />
					{settled ? <span className="shrink-0 rounded-md bg-surface-3 px-1.5 py-0.5 text-2xs font-medium leading-none text-muted-foreground">No live data</span> : <StatusChip status="pending" />}
				</span>
				{planned.task ? <span className="line-clamp-2 break-words text-xs text-muted-foreground">{planned.task}</span> : null}
			</div>
		</div>
	);
}

export function teamOf(subagents: readonly SubagentRec[], toolCallId: string): SubagentRec[] {
	return subagents.filter((s) => s.parentToolCallId === toolCallId);
}

/**
 * A `task` tool call as a team: one row per spawned subagent with live progress, expandable to its own transcript, with Stop
 * and Steer. Falls back to the call's own arguments until (or without) runtime reports.
 */
export const TeamCard = memo(function TeamCard({ store, toolCallId, args, toolRunning }: { store: OmpStore; toolCallId: string; args: unknown; toolRunning: boolean }) {
	const { subagents, loaded } = useOmpState(store);
	const team = useMemo(() => teamOf(subagents, toolCallId), [subagents, toolCallId]);
	const planned = useMemo(() => plannedTasks(args), [args]);
	const [open, setOpen] = useState(true);
	const running = team.filter(isLive).length;
	const cost = team.reduce((n, s) => n + s.cost, 0);
	// Planned members the runtime has not reported (yet): by name, so a reported one replaces its placeholder.
	const placeholders = planned.filter((p) => !team.some((s) => s.id === p.name));
	const count = team.length + (team.length === 0 ? planned.length : 0);
	const waiting = team.length === 0 && planned.length === 0 && toolRunning;
	// A finished call whose roster has not arrived yet (page load): placeholders would flash "Queued" before the real state.
	const loading = !loaded && team.length === 0 && !toolRunning;
	const done = team.length > 0 && running === 0;

	return (
		<div data-team-status={done ? "done" : "running"} className="max-w-3xl overflow-hidden rounded-xl bg-surface-1 shadow-[inset_0_0_0_1px_var(--border)]">
			<div className="flex min-h-11 items-center gap-1 pr-1">
				<button
					type="button"
					aria-expanded={open}
					onClick={() => setOpen((v) => !v)}
					className="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl py-2 pl-3 pr-1 text-left outline-none transition-colors hover:bg-surface-2 focus-visible:bg-surface-2"
				>
					<span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
						<Users className="size-3.5" />
					</span>
					<span className="text-[13px] font-semibold">Team</span>
					{count > 0 ? (
						<span className="tabular text-xs text-muted-foreground">
							{count} {count === 1 ? "agent" : "agents"}
						</span>
					) : null}
					{running > 0 ? (
						<span className="inline-flex items-center gap-1.5 rounded-md bg-accent-soft px-1.5 py-0.5 text-2xs font-medium text-accent">
							<span aria-hidden className="relative grid size-1.5 place-items-center">
								<span className="absolute inline-flex size-full animate-[clam-pulse-ring_1.6s_ease-out_infinite] rounded-full bg-accent" />
								<span className="relative size-1.5 rounded-full bg-accent" />
							</span>
							{running} running
						</span>
					) : done ? (
						<span className="rounded-md bg-success/12 px-1.5 py-0.5 text-2xs font-medium text-success">All finished</span>
					) : null}
					<span className="flex-1" />
					{cost > 0 ? <span className="tabular font-mono text-2xs text-subtle">{formatCost(cost)}</span> : null}
					<ChevronDown className={cn("size-3.5 shrink-0 text-subtle transition-transform duration-150", !open && "-rotate-90")} aria-hidden />
				</button>
				<Tip label="All subagents in the side panel">
					<button
						type="button"
						aria-label="Show all subagents in the side panel"
						onClick={() => store.openPanel()}
						className="grid size-7 shrink-0 place-items-center rounded-md text-subtle outline-none transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:bg-surface-3 coarse:size-11"
					>
						<PanelRight className="size-3.5" />
					</button>
				</Tip>
			</div>
			{open ? (
				<div className="animate-fade-in divide-y border-t">
					{team.map((s) => (
						<SubagentRow key={s.id} store={store} s={s} />
					))}
					{(loading ? [] : team.length === 0 ? planned : placeholders).map((p, i) => (
						<PlannedRow key={`planned:${p.name}`} planned={p} index={team.length + i} settled={!toolRunning} />
					))}
					{waiting || loading ? (
						<div className="flex items-center gap-3 px-3 py-3" aria-busy="true" aria-label="Spawning agents">
							<Skeleton className="size-8 rounded-lg" />
							<div className="flex flex-1 flex-col gap-1.5">
								<Skeleton className="h-3.5 w-1/3" />
								<Skeleton className="h-3 w-2/3" />
							</div>
						</div>
					) : null}
					{team.length === 0 && planned.length === 0 && !toolRunning && loaded ? <p className="px-3 py-3 text-xs text-muted-foreground">No subagents were reported for this call.</p> : null}
				</div>
			) : null}
		</div>
	);
});
