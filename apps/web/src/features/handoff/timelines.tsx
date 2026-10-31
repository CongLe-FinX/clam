import type { Handoff, HandoffEvent, HandoffStep } from "@clam/contracts";
import { Check, Circle, Loader2, MinusCircle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";
import { stateLabel } from "./meta.ts";

const STEP_ICON = {
	pending: { icon: Circle, cls: "text-subtle" },
	running: { icon: Loader2, cls: "animate-spin text-accent" },
	done: { icon: Check, cls: "text-success" },
	failed: { icon: XCircle, cls: "text-danger" },
	skipped: { icon: MinusCircle, cls: "text-subtle" },
} as const satisfies Record<HandoffStep["state"], { icon: typeof Circle; cls: string }>;

const time = (iso: string | null): string => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");

/** The ten target steps (docs §4). Source records without steps show nothing. */
export function StepTimeline({ steps }: { steps: HandoffStep[] }) {
	const list = steps.filter((s) => s.n >= 1).sort((a, b) => a.n - b.n);
	if (list.length === 0) return null;
	return (
		<Card>
			<CardHeader>
				<CardTitle>Restore steps</CardTitle>
			</CardHeader>
			<CardContent className="pt-3">
				<ol className="flex flex-col">
					{list.map((s, i) => {
						const { icon: Icon, cls } = STEP_ICON[s.state];
						return (
							<li key={s.n} className="relative flex gap-3 pb-3.5 last:pb-0" aria-current={s.state === "running" ? "step" : undefined}>
								{i < list.length - 1 ? <span aria-hidden className="absolute left-[9px] top-5 h-[calc(100%-1.25rem)] w-px bg-border" /> : null}
								<Icon className={cn("relative mt-0.5 size-[18px] shrink-0 rounded-full bg-surface-1", cls)} aria-hidden />
								<div className="min-w-0 flex-1">
									<div className="flex items-baseline justify-between gap-2">
										<span className={cn("text-[13px]", s.state === "pending" || s.state === "skipped" ? "text-muted-foreground" : "font-medium")}>
											<span className="mr-1.5 font-mono text-2xs text-subtle">{s.n}</span>
											{s.name}
										</span>
										<span className="tabular shrink-0 font-mono text-2xs text-subtle">
											<span className="sr-only">{s.state}</span>
											{time(s.at)}
										</span>
									</div>
									{s.detail ? <p className={cn("mt-0.5 break-words text-xs", s.state === "failed" ? "text-danger" : "text-subtle")}>{s.detail}</p> : null}
								</div>
							</li>
						);
					})}
				</ol>
			</CardContent>
		</Card>
	);
}

/** Identical on both machines: one gap-free sequence of state changes. */
export function EventTimeline({ events, h }: { events: HandoffEvent[]; h: Handoff }) {
	const nodeName = (id: string): string => (id === h.source.nodeId ? h.source.nodeName : id === h.target.nodeId ? h.target.nodeName : id);
	return (
		<Card>
			<CardHeader>
				<CardTitle>Events</CardTitle>
			</CardHeader>
			<CardContent className="pt-3">
				{events.length === 0 ? (
					<p className="text-[13px] text-subtle">No events yet.</p>
				) : (
					<ol className="flex flex-col gap-3">
						{[...events]
							.sort((a, b) => b.seq - a.seq)
							.map((e) => (
								<li key={e.seq} className="flex gap-3 text-[13px]">
									<span className="tabular w-6 shrink-0 text-right font-mono text-2xs leading-5 text-subtle">{e.seq}</span>
									<div className="min-w-0 flex-1">
										<div className="flex flex-wrap items-baseline gap-x-2">
											<span className="font-medium">{stateLabel(e.state)}</span>
											<span className="text-xs text-subtle">{nodeName(e.nodeId)}</span>
											<time dateTime={e.at} className="tabular ml-auto font-mono text-2xs text-subtle">
												{new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
											</time>
										</div>
										<p className="break-words text-xs text-muted-foreground">{e.summary}</p>
									</div>
								</li>
							))}
					</ol>
				)}
			</CardContent>
		</Card>
	);
}
