import type { Task } from "@clam/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Network } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { T, t } from "@/i18n";
import { isActiveTask, useTasks } from "@/lib/queries";
import { TaskStatusPill } from "./components.tsx";
import { partyLabel } from "./format.ts";

const BOLD = { b: <span className="font-medium" /> };

function Row({ task, children }: { task: Task; children: ReactNode }) {
	return (
		<div className="flex min-h-9 items-center gap-2 px-3 text-[13px] coarse:min-h-11">
			<Network className="size-4 shrink-0 text-accent" aria-hidden />
			<span className="min-w-0 flex-1 truncate">
				{children}
			</span>
			<TaskStatusPill status={task.status} className="shrink-0" />
			<Link to="/tasks/$taskId" params={{ taskId: task.id }} className="inline-flex shrink-0 items-center gap-0.5 rounded-md px-1 py-0.5 text-xs font-medium text-accent hover:underline coarse:py-2">
				{t("Open")} <ArrowUpRight className="size-3" aria-hidden />
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
			{executing ? <Row task={executing}>
				{isActiveTask(executing) ? (
					<T text="Running task ‘<b>{title}</b>’ for {name}" params={{ title: executing.title, name: executing.sender.nodeName }} tags={BOLD} />
				) : (
					<T text="Task ‘<b>{title}</b>’ for {name}" params={{ title: executing.title, name: executing.sender.nodeName }} tags={BOLD} />
				)}
			</Row> : null}
			{delegated.slice(0, 2).map((d) => (
				<Row key={d.id} task={d} >
					<T text="Delegated ‘<b>{title}</b>’ to {name}" params={{ title: d.title, name: partyLabel(d.executor) }} tags={BOLD} />
				</Row>
			))}
			{delegated.length > 2 ? <p className="px-3 py-1.5 text-2xs text-subtle">{t("{count, plural, one {+# more delegated task} other {+# more delegated tasks}}", { count: delegated.length - 2 })}</p> : null}
		</div>
	);
}
