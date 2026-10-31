import type { Task } from "@clam/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Network } from "lucide-react";
import { useMemo } from "react";
import { isActiveTask, useTasks } from "@/lib/queries";
import { TaskStatusPill } from "./components.tsx";
import { partyLabel } from "./format.ts";

function Row({ task, verb, other }: { task: Task; verb: string; other: string }) {
	return (
		<div className="flex min-h-9 items-center gap-2 px-3 text-[13px] coarse:min-h-11">
			<Network className="size-4 shrink-0 text-accent" aria-hidden />
			<span className="min-w-0 flex-1 truncate">
				{verb} <span className="font-medium">‘{task.title}’</span> {other}
			</span>
			<TaskStatusPill status={task.status} className="shrink-0" />
			<Link to="/tasks/$taskId" params={{ taskId: task.id }} className="inline-flex shrink-0 items-center gap-0.5 rounded-md px-1 py-0.5 text-xs font-medium text-accent hover:underline coarse:py-2">
				Open <ArrowUpRight className="size-3" aria-hidden />
			</Link>
		</div>
	);
}

/**
 * On a session that executes a delegated task: who asked for it. On a session that delegated work: where that work is.
 * Both link to the task, where the discussion lives.
 */
export function TaskBanner({ sessionId }: { sessionId: string }) {
	const tasks = useTasks().data;
	const { executing, delegated } = useMemo(() => {
		const all = tasks ?? [];
		return {
			executing: all.find((t) => t.direction === "incoming" && t.executor.sessionId === sessionId),
			delegated: all.filter((t) => t.direction === "outgoing" && t.sender.sessionId === sessionId && isActiveTask(t)),
		};
	}, [tasks, sessionId]);
	if (!executing && delegated.length === 0) return null;
	return (
		<div className="animate-fade-in flex shrink-0 flex-col divide-y border-b bg-accent-soft/60">
			{executing ? <Row task={executing} verb={isActiveTask(executing) ? "Running task" : "Task"} other={`for ${executing.sender.nodeName}`} /> : null}
			{delegated.slice(0, 2).map((t) => (
				<Row key={t.id} task={t} verb="Delegated" other={`to ${partyLabel(t.executor)}`} />
			))}
			{delegated.length > 2 ? <p className="px-3 py-1.5 text-2xs text-subtle">+{delegated.length - 2} more delegated tasks</p> : null}
		</div>
	);
}
