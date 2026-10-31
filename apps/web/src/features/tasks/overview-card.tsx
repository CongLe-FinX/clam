import { Link } from "@tanstack/react-router";
import { ArrowUpRight, ListChecks } from "lucide-react";
import { useMemo } from "react";
import { useTasks } from "@/lib/queries";
import { cn, relativeTime } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";
import { Skeleton } from "@/ui/skeleton";
import { TaskStatusPill } from "./components.tsx";
import { isTerminal, otherParty, partyLabel } from "./format.ts";

const DAY = 86_400_000;

function Count({ label, value, tone }: { label: string; value: number; tone?: "warning" | "accent" }) {
	return (
		<div className="flex flex-1 flex-col gap-0.5 rounded-lg bg-surface-2 px-3 py-2">
			<span className={cn("tabular font-mono text-xl font-semibold", value > 0 && tone === "warning" && "text-warning", value > 0 && tone === "accent" && "text-accent")}>{value}</span>
			<span className="text-2xs text-muted-foreground">{label}</span>
		</div>
	);
}

/** Overview card: tasks waiting for you, running, and the latest ones that finished. */
export function TasksCard() {
	const tasks = useTasks();
	const s = useMemo(() => {
		const all = tasks.data ?? [];
		const now = Date.now();
		const finished = all.filter((t) => isTerminal(t.status) && now - Date.parse(t.updatedAt) < DAY);
		return {
			offered: all.filter((t) => t.direction === "incoming" && t.status === "offered"),
			running: all.filter((t) => t.status === "running" || t.status === "blocked" || t.status === "accepted"),
			finished,
			list: [...all].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 4),
		};
	}, [tasks.data]);

	return (
		<Card>
			<CardHeader>
				<CardTitle>Tasks</CardTitle>
				<Link to="/tasks" preload="intent" className="inline-flex items-center gap-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
					Task board
					<ArrowUpRight className="size-3" />
				</Link>
			</CardHeader>
			<CardContent className="flex flex-col gap-3 pt-3">
				{tasks.isPending ? (
					<Skeleton className="h-16" />
				) : (
					<>
						<div className="flex gap-2">
							<Count label="Waiting for you" value={s.offered.length} tone="warning" />
							<Count label="In progress" value={s.running.length} tone="accent" />
							<Count label="Finished today" value={s.finished.length} />
						</div>
						{s.list.length === 0 ? (
							<p className="flex items-center gap-2 text-[13px] text-subtle">
								<ListChecks className="size-4" aria-hidden /> No tasks yet — delegate one from the Agent Directory.
							</p>
						) : (
							<ul className="flex flex-col">
								{s.list.map((t) => (
									<li key={t.id}>
										<Link to="/tasks/$taskId" params={{ taskId: t.id }} className="flex min-h-11 items-center gap-2 rounded-lg px-1.5 text-[13px] outline-none hover:bg-surface-2 focus-visible:bg-surface-2">
											<TaskStatusPill status={t.status} />
											<span className="min-w-0 flex-1 truncate">{t.title}</span>
											<span className="hidden shrink-0 truncate text-2xs text-subtle sm:inline">
												{t.direction === "incoming" ? "from" : "to"} {partyLabel(otherParty(t))}
											</span>
											<span className="shrink-0 text-2xs text-subtle">{relativeTime(t.updatedAt)}</span>
										</Link>
									</li>
								))}
							</ul>
						)}
					</>
				)}
			</CardContent>
		</Card>
	);
}
