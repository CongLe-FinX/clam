import { Ban, Check, CircleDashed, Loader2, MessageSquarePlus, Square, TriangleAlert, ChevronRight } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { toast } from "sonner";
import { msg, t, tr, type Msg } from "@/i18n";
import { errorText } from "@/lib/api";
import { cn, formatCompact, formatCost, formatDuration } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Tip } from "@/ui/tooltip";
import type { OmpStore, SubagentRec } from "./omp-store.ts";

/** Ticks while `active` (elapsed timers). One interval per consumer is fine: only running rows ask for it. */
export function useClock(active: boolean, intervalMs = 1000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const id = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(id);
	}, [active, intervalMs]);
	return now;
}

export const isLive = (s: Pick<SubagentRec, "status">): boolean => s.status === "running" || s.status === "pending";

/** Run time: what the runtime last reported plus the time since it reported it while the subagent is still running. */
export function elapsedMs(s: SubagentRec, now: number): number {
	return isLive(s) ? s.durationMs + Math.max(0, now - s.recvAt) : s.durationMs;
}

const TONE = {
	accent: "bg-accent-soft text-accent",
	success: "bg-success/12 text-success",
	danger: "bg-danger/13 text-danger",
	warning: "bg-warning/14 text-warning",
	neutral: "bg-surface-3 text-muted-foreground",
} as const;

export const STATUS = {
	pending: { label: msg("Queued"), tone: "neutral", Icon: CircleDashed },
	running: { label: msg("Running"), tone: "accent", Icon: Loader2 },
	completed: { label: msg("Done"), tone: "success", Icon: Check },
	failed: { label: msg("Failed"), tone: "danger", Icon: TriangleAlert },
	aborted: { label: msg("Stopped"), tone: "warning", Icon: Ban },
} as const satisfies Record<SubagentRec["status"], { label: Msg; tone: keyof typeof TONE; Icon: typeof Check }>;

/** Status with icon and label (never colour alone). */
export function StatusChip({ status, className }: { status: SubagentRec["status"]; className?: string }) {
	const { label, tone, Icon } = STATUS[status];
	return (
		<span className={cn("inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs font-medium leading-none", TONE[tone], className)}>
			<Icon className={cn("size-3", status === "running" && "animate-spin")} aria-hidden />
			{tr(label)}
		</span>
	);
}

const PALETTE = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--chart-6)", "var(--chart-7)", "var(--chart-8)"];

export function Avatar({ name, index, className }: { name: string; index: number; className?: string }) {
	const color = PALETTE[Math.abs(index) % PALETTE.length];
	return (
		<span
			aria-hidden
			className={cn("grid size-8 shrink-0 place-items-center rounded-lg text-[13px] font-semibold uppercase", className)}
			style={{ color, backgroundColor: `color-mix(in oklab, ${color} 16%, transparent)` }}
		>
			{name.trim().charAt(0) || "?"}
		</span>
	);
}

/** `anthropic/claude-sonnet-5-5:low` → model `claude-sonnet-5-5` and thinking `low`. */
export function modelParts(model: string | null): { name: string; thinking: string | null } | null {
	if (!model) return null;
	const [id, thinking] = model.split(":");
	const name = (id ?? model).split("/").pop() ?? model;
	return { name, thinking: thinking ?? null };
}

/** The one line that says what it is doing right now. */
export function liveLine(s: SubagentRec): { kind: "tool" | "text"; text: string } | null {
	if (s.currentTool) return { kind: "tool", text: s.currentToolArgs ? `${s.currentTool} · ${s.currentToolArgs}` : s.currentTool };
	if (isLive(s)) {
		if (s.stage) return { kind: "text", text: s.stage };
		const last = s.recentOutput.at(-1);
		if (last) return { kind: "text", text: last };
		return { kind: "text", text: t("Starting…") };
	}
	const last = s.recentOutput.at(-1);
	if (s.status === "failed" && s.error) return { kind: "text", text: s.error };
	return last ? { kind: "text", text: last } : null;
}

export function SubagentStats({ s, className }: { s: SubagentRec; className?: string }) {
	const parts: string[] = [];
	if (s.tokens > 0) parts.push(t("{count} tok", { count: formatCompact(s.tokens) }));
	if (s.cost > 0) parts.push(formatCost(s.cost));
	if (s.toolCount > 0) parts.push(t("{count, plural, one {# tool} other {# tools}}", { count: s.toolCount }));
	if (parts.length === 0) return null;
	return <span className={cn("tabular font-mono text-2xs text-subtle", className)}>{parts.join(" · ")}</span>;
}

/** Stop button state shared by the card rows, the panel and the transcript viewer. */
export function useStop(store: OmpStore, s: SubagentRec): { stopping: boolean; stop: () => void } {
	const [stopping, setStopping] = useState(false);
	// The abort arrives as a status change; until it does the button shows progress.
	useEffect(() => {
		if (!isLive(s)) setStopping(false);
	}, [s]);
	return {
		stopping,
		stop: () => {
			setStopping(true);
			store
				.cancelSubagent(s.id)
				.then((r) => {
					if (!r.cancelled) {
						setStopping(false);
						toast.info(t("{id} had already finished", { id: s.id }));
					}
				})
				.catch((e) => {
					setStopping(false);
					toast.error(t("Could not stop {id}: {error}", { id: s.id, error: errorText(e) }));
				});
		},
	};
}

/**
 * One subagent: avatar, name, role/model, status, elapsed, what it is doing now, usage, and its actions. The whole row opens
 * the transcript; Stop and Steer are separate controls (never hover-only).
 */
export const SubagentRow = memo(function SubagentRow({ store, s, compact }: { store: OmpStore; s: SubagentRec; compact?: boolean }) {
	const live = isLive(s);
	const now = useClock(live);
	const model = modelParts(s.model);
	const line = liveLine(s);
	const { stopping, stop } = useStop(store, s);
	return (
		<div data-subagent-status={s.status} className="group/row relative flex items-stretch gap-1 transition-colors hover:bg-surface-2/60">
			<button
				type="button"
				onClick={() => store.openSubagent(s.id)}
				aria-label={t("Open {id} transcript", { id: s.id })}
				className={cn("flex min-w-0 flex-1 items-start gap-3 py-2.5 pr-1 pl-3 text-left outline-none focus-visible:bg-surface-2", compact && "py-2")}
			>
				<Avatar name={s.id} index={s.index} />
				<span className="flex min-w-0 flex-1 flex-col gap-1">
					<span className="flex min-w-0 items-center gap-2">
						<span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{s.id}</span>
						<StatusChip status={s.status} />
					</span>
					{s.description && !compact ? <span className="line-clamp-2 break-words text-xs text-muted-foreground">{s.description}</span> : null}
					{line ? (
						<span key={line.text} className={cn("animate-fade-in flex min-w-0 items-center gap-1.5 text-xs", s.status === "failed" ? "text-danger" : "text-muted-foreground")}>
							{line.kind === "tool" ? <span className="shrink-0 rounded bg-surface-3 px-1 font-mono text-2xs text-subtle">{t("tool")}</span> : null}
							<span className={cn("min-w-0 flex-1 truncate", line.kind === "tool" && "font-mono text-2xs")} title={line.text}>
								{line.text}
							</span>
						</span>
					) : null}
					{live && s.completionPercent !== null ? (
						<span className="h-1 w-full overflow-hidden rounded-full bg-surface-3" aria-hidden>
							<span className="block h-full origin-left rounded-full bg-accent transition-transform duration-500 ease-out" style={{ transform: `scaleX(${Math.max(0.02, Math.min(1, s.completionPercent / 100))})` }} />
						</span>
					) : null}
					<span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-2xs text-subtle">
						<span className="tabular text-muted-foreground">{formatDuration(elapsedMs(s, now))}</span>
						<span>{s.agent}</span>
						{model ? (
							<span className="truncate" title={s.model ?? undefined}>
								{model.name}
								{model.thinking ? ` · ${model.thinking}` : ""}
							</span>
						) : null}
						<SubagentStats s={s} />
					</span>
				</span>
			</button>
			<div className="flex shrink-0 flex-col items-center justify-center gap-0.5 pr-1.5">
				{live ? (
					<>
						<Tip label={t("Stop this subagent")}>
							<Button variant="ghost" size="icon-sm" aria-label={t("Stop {id}", { id: s.id })} loading={stopping} onClick={stop} className="text-danger hover:bg-danger/10 hover:text-danger">
								<Square className="fill-current" />
							</Button>
						</Tip>
						<Tip label={t("Send it a message")}>
							<Button variant="ghost" size="icon-sm" aria-label={t("Message {id}", { id: s.id })} onClick={() => store.openSubagent(s.id)}>
								<MessageSquarePlus />
							</Button>
						</Tip>
					</>
				) : (
					<ChevronRight className="size-4 text-subtle" aria-hidden />
				)}
			</div>
		</div>
	);
});
