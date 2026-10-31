import type { Task } from "@clam/contracts";
import { Link } from "@tanstack/react-router";
import { FolderGit2, GitBranch, MessageSquare } from "lucide-react";
import { memo } from "react";
import { cn, formatCost } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { DirectionChip, PartyChip, TaskStatusPill } from "./components.tsx";
import { formatAge, otherParty } from "./format.ts";

export const TaskCard = memo(function TaskCard({ task, projectName, now, className }: { task: Task; projectName?: string; now: number; className?: string }) {
	const other = otherParty(task);
	return (
		<Link
			to="/tasks/$taskId"
			params={{ taskId: task.id }}
			preload="intent"
			data-task-id={task.id}
			className={cn(
				"group/card flex min-h-[4.5rem] flex-col gap-2 rounded-xl bg-surface-1 p-3 shadow-[inset_0_0_0_1px_var(--border)] outline-none transition-[background-color,box-shadow] hover:bg-surface-2 hover:shadow-[inset_0_0_0_1px_var(--border-strong)] focus-visible:shadow-[inset_0_0_0_1px_var(--accent)]",
				task.unreadMessages > 0 && "shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--accent)_45%,transparent)]",
				className,
			)}
		>
			<div className="flex items-center gap-1.5">
				<TaskStatusPill status={task.status} />
				<DirectionChip direction={task.direction} />
				{task.unreadMessages > 0 ? (
					<Badge variant="accent" className="gap-1" aria-label={`${task.unreadMessages} unread ${task.unreadMessages === 1 ? "message" : "messages"}`}>
						<MessageSquare aria-hidden />
						{task.unreadMessages}
					</Badge>
				) : null}
				<span className="tabular ml-auto font-mono text-2xs text-subtle" title={new Date(task.updatedAt).toLocaleString()}>
					{formatAge(task.updatedAt, now)}
				</span>
			</div>
			<h3 className="line-clamp-2 text-[13px] font-medium leading-snug">{task.title}</h3>
			<div className="flex flex-col gap-1 text-xs">
				<div className="flex items-center gap-1 text-muted-foreground">
					<span className="shrink-0 text-subtle">{task.direction === "incoming" ? "from" : "to"}</span>
					<PartyChip party={other} role={task.direction === "incoming" ? "sender" : "executor"} />
				</div>
				<div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-subtle">
					{projectName ? (
						<span className="inline-flex min-w-0 items-center gap-1">
							<FolderGit2 className="size-3 shrink-0" aria-hidden />
							<span className="truncate">{projectName}</span>
						</span>
					) : null}
					{task.deliverAs === "branch" ? (
						<span className="inline-flex items-center gap-1">
							<GitBranch className="size-3" aria-hidden /> branch
						</span>
					) : null}
					{task.cost !== null ? <span className="tabular ml-auto font-mono">{formatCost(task.cost)}</span> : null}
				</div>
			</div>
		</Link>
	);
});
