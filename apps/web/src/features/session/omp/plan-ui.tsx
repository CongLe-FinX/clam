import type { TodoPhase } from "@clam/contracts";
import { Check, ChevronUp, CircleDashed, CircleSlash, ListChecks, X } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { useBreakpoint } from "@/hooks/use-breakpoint";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/ui/sheet";
import { type SessionStream, useStreamMeta } from "../stream-store.ts";
import { isActive, isDone, isDropped, planSignature, planStats } from "./plan-model.ts";

const taskKey = (phase: string, content: string): string => `${phase}\u0000${content}`;

/** Status marker: done = check (springs in when it flips), active = pulsing dot, dropped = struck, else an empty ring. */
function Marker({ status, flash }: { status: string; flash: boolean }) {
	if (isDone(status)) {
		return (
			<span aria-label={t("Completed")} className={cn("mt-px grid size-4 shrink-0 place-items-center rounded-full bg-success text-background", flash && "animate-pop-in")}>
				<Check className="size-2.5" strokeWidth={3.5} />
			</span>
		);
	}
	if (isActive(status)) {
		return (
			<span aria-label={t("In progress")} className="relative mt-px grid size-4 shrink-0 place-items-center">
				<span aria-hidden className="absolute size-2.5 animate-[clam-pulse-ring_1.8s_ease-out_infinite] rounded-full bg-accent/60" />
				<span aria-hidden className="relative size-2.5 rounded-full bg-accent shadow-[0_0_0_3px_var(--accent-soft)]" />
			</span>
		);
	}
	if (isDropped(status)) return <CircleSlash aria-label={t("Dropped")} className="mt-px size-4 shrink-0 text-subtle" />;
	return <CircleDashed aria-label={status === "blocked" ? t("Blocked") : t("Pending")} className={cn("mt-px size-4 shrink-0", status === "blocked" ? "text-warning" : "text-subtle")} />;
}

export function PlanBar({ done, total, className }: { done: number; total: number; className?: string }) {
	return (
		<div role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label={t("Plan progress")} className={cn("h-1.5 w-full overflow-hidden rounded-full bg-surface-3", className)}>
			<div className="h-full origin-left rounded-full bg-success transition-transform duration-500 ease-out" style={{ transform: `scaleX(${total === 0 ? 0 : done / total})` }} />
		</div>
	);
}

/** Phases with their own progress; the task in progress is highlighted and a task that just finished springs its check in. */
export const PlanList = memo(function PlanList({ phases, className }: { phases: readonly TodoPhase[]; className?: string }) {
	const prev = useRef<Map<string, string>>(new Map());
	const [flash, setFlash] = useState<ReadonlySet<string>>(new Set());

	useEffect(() => {
		const next = new Map<string, string>();
		const flipped: string[] = [];
		for (const p of phases) {
			for (const t of p.tasks) {
				const key = taskKey(p.name, t.content);
				next.set(key, t.status);
				const before = prev.current.get(key);
				if (before !== undefined && !isDone(before) && isDone(t.status)) flipped.push(key);
			}
		}
		prev.current = next;
		if (flipped.length === 0) return;
		setFlash((s) => new Set([...s, ...flipped]));
		const id = setTimeout(() => setFlash((s) => new Set([...s].filter((k) => !flipped.includes(k)))), 900);
		return () => clearTimeout(id);
	}, [phases]);

	return (
		<div className={cn("flex flex-col gap-4", className)}>
			{phases.map((p, i) => {
				const counted = p.tasks.filter((t) => !isDropped(t.status));
				const done = counted.filter((t) => isDone(t.status)).length;
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: phases carry no id; names can repeat
					<section key={`${i}:${p.name}`} className="flex flex-col gap-2">
						<header className="flex items-center gap-2">
							<h4 className="min-w-0 flex-1 truncate text-xs font-semibold">{p.name || t("Tasks")}</h4>
							<span className="tabular font-mono text-2xs text-subtle">
								{done}/{counted.length}
							</span>
						</header>
						<PlanBar done={done} total={counted.length} className="h-1" />
						<ul className="flex flex-col gap-0.5">
							{p.tasks.map((t, j) => {
								const active = isActive(t.status);
								return (
									<li
										// biome-ignore lint/suspicious/noArrayIndexKey: tasks carry no id; content can repeat
										key={`${j}:${t.content}`}
										aria-current={active ? "step" : undefined}
										className={cn("flex items-start gap-2.5 rounded-lg px-2 py-1.5 text-[13px] leading-snug transition-colors duration-300", active && "bg-accent-soft")}
									>
										<Marker status={t.status} flash={flash.has(taskKey(p.name, t.content))} />
										<span className={cn("min-w-0 flex-1 break-words transition-colors duration-300", isDone(t.status) && "text-muted-foreground", isDropped(t.status) && "text-subtle line-through", active && "font-medium")}>{t.content}</span>
									</li>
								);
							})}
						</ul>
					</section>
				);
			})}
		</div>
	);
});

/** The plan with its overall progress, for the side panel and the chip's sheet. */
export function PlanSection({ phases }: { phases: readonly TodoPhase[] }) {
	const stats = planStats(phases);
	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center gap-3">
				<PlanBar done={stats.done} total={stats.total} />
				<span className="tabular shrink-0 font-mono text-2xs text-muted-foreground">
					{stats.done}/{stats.total}
				</span>
			</div>
			<PlanList phases={phases} />
		</div>
	);
}

// ───────────────────────────── chip above the composer ─────────────────────────────

/**
 * "Plan 3/8 · Writing tests": always visible above the composer while the agent has a plan. Expands into the list (a popover on
 * desktop, a bottom sheet on phones). Once everything is done it says so and can be dismissed; a new plan brings it back.
 */
export function PlanChip({ stream, className }: { stream: SessionStream; className?: string }) {
	const phases = useStreamMeta(stream, (m) => m.live?.todoPhases);
	const stats = planStats(phases);
	const signature = planSignature(phases);
	const [dismissed, setDismissed] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const mobile = useBreakpoint() === "mobile";
	if (!phases || stats.total === 0 || dismissed === signature) return null;

	const label = stats.complete ? t("Plan complete") : t("Plan");
	const chip = (
		<button
			type="button"
			aria-expanded={open}
			aria-label={stats.current ? t("{label} {done} of {total}, now: {task}", { label, done: stats.done, total: stats.total, task: stats.current.content }) : t("{label} {done} of {total}", { label, done: stats.done, total: stats.total })}
			onClick={() => setOpen((v) => !v)}
			className={cn(
				"group/chip animate-slide-up relative flex h-9 min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-full bg-surface-2 pr-3 pl-2.5 text-xs outline-none shadow-[inset_0_0_0_1px_var(--border)] transition-[background-color,transform] duration-150 hover:bg-surface-3 active:scale-[0.98] focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:h-11",
				stats.complete && "bg-success/10 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--success)_35%,transparent)]",
			)}
		>
			{stats.complete ? <Check className="size-3.5 shrink-0 text-success" aria-hidden /> : <ListChecks className="size-3.5 shrink-0 text-accent" aria-hidden />}
			<span className="shrink-0 font-semibold">{label}</span>
			<span className="tabular shrink-0 font-mono text-2xs text-muted-foreground">
				{stats.done}/{stats.total}
			</span>
			{stats.current && !stats.complete ? (
				<>
					<span aria-hidden className="text-subtle">
						·
					</span>
					<span key={stats.current.content} className="animate-fade-in min-w-0 truncate text-muted-foreground">
						{stats.current.content}
					</span>
				</>
			) : null}
			<ChevronUp className={cn("size-3.5 shrink-0 text-subtle transition-transform duration-150", !open && "rotate-180")} aria-hidden />
			<span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 bg-transparent">
				<span className={cn("block h-full origin-left transition-transform duration-500 ease-out", stats.complete ? "bg-success" : "bg-accent")} style={{ transform: `scaleX(${stats.percent / 100})` }} />
			</span>
		</button>
	);

	return (
		<div className={cn("flex items-center gap-1.5", className)}>
			{mobile ? (
				<>
					{chip}
					<Sheet open={open} onOpenChange={setOpen}>
						<SheetContent side="bottom" className="max-h-[78dvh] p-0" aria-describedby={undefined}>
							<SheetTitle className="px-4 pt-3 pb-1">{t("Plan")}</SheetTitle>
							<SheetDescription className="sr-only">{t("What the agent plans to do and how far it is.")}</SheetDescription>
							<div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 pt-2 pb-4">
								<PlanSection phases={phases} />
							</div>
						</SheetContent>
					</Sheet>
				</>
			) : (
				<Popover open={open} onOpenChange={setOpen}>
					<PopoverTrigger asChild>{chip}</PopoverTrigger>
					<PopoverContent side="top" align="start" className="w-[min(26rem,calc(100vw-1.5rem))] p-0">
						<div className="flex items-center gap-2 border-b px-3.5 py-2.5">
							<ListChecks className="size-4 text-accent" aria-hidden />
							<span className="text-[13px] font-semibold">{t("Plan")}</span>
						</div>
						<div className="scrollbar-thin max-h-[min(55dvh,26rem)] overflow-y-auto px-3.5 py-3">
							<PlanSection phases={phases} />
						</div>
					</PopoverContent>
				</Popover>
			)}
			{stats.complete ? (
				<Button variant="ghost" size="icon-sm" aria-label={t("Dismiss plan")} onClick={() => setDismissed(signature)}>
					<X />
				</Button>
			) : null}
		</div>
	);
}
