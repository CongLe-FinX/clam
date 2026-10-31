import type { TaskEvent } from "@clam/contracts";
import { CheckCheck, CircleDot, MessageSquare, StickyNote, Wrench, Zap, type LucideIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";

const ICON: Record<TaskEvent["type"], LucideIcon> = {
	status: CircleDot,
	progress: Zap,
	tool: Wrench,
	message: MessageSquare,
	result: CheckCheck,
	note: StickyNote,
};
const SHOWN = 12;
const time = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Newest first. Messages live in the Discussion, so they are left out here. */
export function Timeline({ events }: { events: TaskEvent[] }) {
	const [all, setAll] = useState(false);
	const list = useMemo(() => events.filter((e) => e.type !== "message").sort((a, b) => b.seq - a.seq), [events]);
	const shown = all ? list : list.slice(0, SHOWN);
	return (
		<Card>
			<CardHeader>
				<CardTitle>Timeline</CardTitle>
				<span className="tabular font-mono text-2xs text-subtle">{list.length}</span>
			</CardHeader>
			<CardContent className="pt-3">
				{list.length === 0 ? (
					<p className="text-[13px] text-subtle">No events yet.</p>
				) : (
					<ol className="flex flex-col">
						{shown.map((e, i) => {
							const Icon = ICON[e.type];
							return (
								<li key={e.seq} className="relative flex gap-3 pb-3 last:pb-0">
									{i < shown.length - 1 ? <span aria-hidden className="absolute left-[0.5rem] top-5 h-[calc(100%-1rem)] w-px bg-border" /> : null}
									<span className={cn("relative mt-0.5 grid size-4 shrink-0 place-items-center rounded-full bg-surface-3 text-muted-foreground", e.type === "result" && "bg-success/15 text-success", e.type === "status" && "text-accent")}>
										<Icon className="size-2.5" aria-hidden />
									</span>
									<div className="min-w-0 flex-1">
										<p className="break-words text-[13px] leading-snug">{e.summary}</p>
										<p className="tabular text-2xs text-subtle" title={`seq ${e.seq}`}>
											{time.format(Date.parse(e.at))} · {e.type}
										</p>
									</div>
								</li>
							);
						})}
					</ol>
				)}
				{list.length > SHOWN ? (
					<Button variant="ghost" size="sm" className="mt-2 w-full" onClick={() => setAll((v) => !v)}>
						{all ? "Show fewer" : `Show all ${list.length}`}
					</Button>
				) : null}
			</CardContent>
		</Card>
	);
}
