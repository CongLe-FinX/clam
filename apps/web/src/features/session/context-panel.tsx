import type { AgentSession, Project, TodoPhase } from "@clam/contracts";
import { RotateCw, Shrink, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/code-block";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { RUNTIME_STATE_LABEL, runtimeDot } from "@/components/session-status";
import { t, tr } from "@/i18n";
import { errorText } from "@/lib/api";
import { cn, formatCompact, formatCost, formatDuration, formatNumber, formatPercent, relativeTime } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Progress } from "@/ui/progress";
import { StatusDot } from "@/ui/status-dot";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Textarea } from "@/ui/textarea";
import { Tip } from "@/ui/tooltip";
import { ModelPicker, ThinkingPicker } from "./model-pickers.tsx";
import { isBusy, type SessionStream, useStreamMeta, useToolRec } from "./stream-store.ts";
import { StatusGlyph, ToolDetails, toolDuration, useNow } from "./tool-card.tsx";
import { summarizeArgs } from "./tool-meta.tsx";
import { PlanSection } from "./omp/plan-ui.tsx";

function Section({ title, actions, children, className }: { title: string; actions?: ReactNode; children: ReactNode; className?: string }) {
	return (
		<section className={cn("flex flex-col gap-2.5 border-b px-3.5 py-3.5 last:border-b-0", className)}>
			<div className="flex items-center justify-between gap-2">
				<h3 className="text-2xs font-semibold uppercase tracking-wider text-subtle">{title}</h3>
				{actions}
			</div>
			{children}
		</section>
	);
}

function Row({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
	return (
		<div className="flex items-baseline justify-between gap-3 text-xs">
			<span className="shrink-0 text-muted-foreground">{label}</span>
			<span className={cn("min-w-0 truncate text-right", mono && "font-mono")}>{children}</span>
		</div>
	);
}

function IdRow({ label, value }: { label: string; value: string | null | undefined }) {
	return (
		<div className="flex items-center justify-between gap-2 text-xs">
			<span className="shrink-0 text-muted-foreground">{label}</span>
			{value ? (
				<span className="flex min-w-0 items-center gap-0.5">
					<span className="min-w-0 truncate font-mono text-2xs" title={value}>
						{value}
					</span>
					<CopyButton text={value} label={t("Copy {label}", { label })} className="size-6" />
				</span>
			) : (
				<span className="text-subtle">—</span>
			)}
		</div>
	);
}

// ── tool inspector

function ToolInspector({ stream, id }: { stream: SessionStream; id: string }) {
	const rec = useToolRec(stream, id);
	const call = stream.getCall(id);
	const running = rec?.status === "running";
	const now = useNow(running);
	const name = rec?.name || call?.name || t("tool");
	const args = rec?.args ?? call?.args;
	const duration = toolDuration(rec, now);
	return (
		<Section
			title={t("Tool call")}
			className="bg-accent-soft/40"
			actions={
				<button type="button" aria-label={t("Close inspector")} onClick={() => stream.selectTool(null)} className="grid size-6 place-items-center rounded-md text-subtle outline-none hover:bg-surface-3 hover:text-foreground coarse:size-10">
					<X className="size-3.5" />
				</button>
			}
		>
			<div className="flex items-center gap-2">
				<StatusGlyph status={rec?.status ?? "none"} />
				<span className="font-mono text-[13px] font-medium">{name}</span>
				{duration !== null ? <span className="tabular ml-auto font-mono text-2xs text-subtle">{formatDuration(duration)}</span> : null}
			</div>
			{rec?.intent || call?.intent ? <p className="text-xs text-muted-foreground">{rec?.intent ?? call?.intent}</p> : null}
			{args !== undefined && !(rec?.intent || call?.intent) ? <p className="truncate font-mono text-2xs text-subtle">{summarizeArgs(args)}</p> : null}
			<ToolDetails name={name} args={args} rec={rec} />
		</Section>
	);
}

// ── context usage

/**
 * "Compact": the agent summarises the conversation so far and continues from the summary (what auto-compaction does near the limit,
 * whenever the user wants). An optional focus steers the summary. The chat on screen keeps every message.
 */
function CompactButton({ stream, pct }: { stream: SessionStream; pct: number }) {
	const busy = useStreamMeta(stream, isBusy);
	const [open, setOpen] = useState(false);
	const [focus, setFocus] = useState("");
	const [pending, setPending] = useState(false);
	const run = async () => {
		setPending(true);
		try {
			await stream.compact(focus.trim() || undefined);
			const after = stream.getMeta().live?.contextUsage;
			const now = after?.contextWindow ? Math.min(100, (after.tokens / after.contextWindow) * 100) : null;
			toast.success(t("Context compacted"), { description: now === null ? undefined : t("{before} → {after} of the context window", { before: formatPercent(pct / 100, 0), after: formatPercent(now / 100, now < 10 ? 1 : 0) }) });
			setOpen(false);
			setFocus("");
		} catch (e) {
			toast.error(t("Could not compact the context"), { description: errorText(e) });
		} finally {
			setPending(false);
		}
	};
	const trigger = (
		<Button size="sm" variant="ghost" disabled={busy || pending} loading={pending} className="-my-1 -mr-1.5 h-6 gap-1 px-2 text-2xs text-muted-foreground coarse:h-9">
			<Shrink className="size-3" /> {t("Compact")}
		</Button>
	);
	return (
		<Popover open={open} onOpenChange={(o) => !pending && setOpen(o)}>
			{busy ? (
				<Tip label={t("Available when the agent is not working")}>
					<span>{trigger}</span>
				</Tip>
			) : (
				<PopoverTrigger asChild>{trigger}</PopoverTrigger>
			)}
			<PopoverContent align="end" className="flex w-80 flex-col gap-2.5">
				<div className="flex flex-col gap-1">
					<p className="text-[13px] font-semibold">{t("Compact the context")}</p>
					<p className="text-xs text-muted-foreground">{t("The agent summarises the conversation so far and continues from the summary, freeing room in its context. The chat here keeps every message.")}</p>
				</div>
				<Textarea
					value={focus}
					onChange={(e) => setFocus(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void run();
					}}
					rows={2}
					maxLength={2000}
					placeholder={t("Optional focus, e.g. keep the API decisions and the open bugs")}
					className="min-h-14 text-xs"
				/>
				<div className="flex items-center justify-end gap-2">
					<Button size="sm" variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
						{t("Cancel")}
					</Button>
					<Button size="sm" variant="primary" loading={pending} onClick={() => void run()}>
						<Shrink /> {pending ? t("Compacting…") : t("Compact now")}
					</Button>
				</div>
			</PopoverContent>
		</Popover>
	);
}

function ContextMeter({ stream, session, viewOnly }: { stream: SessionStream; session: AgentSession; viewOnly: boolean }) {
	const usage = useStreamMeta(stream, (m) => m.live?.contextUsage) ?? session.stats?.contextUsage ?? null;
	const tps = useStreamMeta(stream, (m) => m.live?.tokensPerSecond ?? null);
	if (!usage || !usage.contextWindow) {
		return (
			<Section title={t("Context")}>
				<p className="text-xs text-muted-foreground">{t("Context usage is not available yet. It appears after the first model response.")}</p>
			</Section>
		);
	}
	const pct = Math.min(100, (usage.tokens / usage.contextWindow) * 100);
	const tone = pct >= 90 ? "danger" : pct >= 70 ? "warning" : "accent";
	return (
		<Section title={t("Context")} actions={viewOnly || usage.tokens === 0 ? null : <CompactButton stream={stream} pct={pct} />}>
			<div className="flex items-baseline justify-between gap-2">
				<span className={cn("tabular text-2xl font-semibold tracking-tight", tone === "danger" && "text-danger", tone === "warning" && "text-warning")}>{formatPercent(pct / 100, pct < 10 ? 1 : 0)}</span>
				<span className="tabular font-mono text-2xs text-muted-foreground">
					{formatCompact(usage.tokens)} / {formatCompact(usage.contextWindow)}
				</span>
			</div>
			<Progress value={pct} tone={tone} />
			{tps !== null ? <Row label={t("Speed")}>{t("{speed} tok/s", { speed: formatNumber(Math.round(tps * 10) / 10) })}</Row> : null}
		</Section>
	);
}

// ── todos

function Todos({ phases }: { phases: TodoPhase[] }) {
	return (
		<Section title={t("Plan")}>
			<PlanSection phases={phases} />
		</Section>
	);
}

// ── stats

function Stats({ session }: { session: AgentSession }) {
	const s = session.stats;
	if (!s) {
		return (
			<Section title={t("Session stats")}>
				<p className="text-xs text-muted-foreground">{t("No usage recorded yet.")}</p>
			</Section>
		);
	}
	return (
		<Section title={t("Session stats")}>
			<div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
				{(
					[
						[t("Input"), formatCompact(s.tokens.input)],
						[t("Output"), formatCompact(s.tokens.output)],
						[t("Cache read"), formatCompact(s.tokens.cacheRead)],
						[t("Cache write"), formatCompact(s.tokens.cacheWrite)],
					] as const
				).map(([k, v]) => (
					<div key={k} className="flex flex-col">
						<span className="text-2xs text-subtle">{k}</span>
						<span className="tabular font-mono text-[13px]">{v}</span>
					</div>
				))}
			</div>
			<div className="flex flex-col gap-1.5 border-t pt-2.5">
				<Row label={t("Total tokens")} mono>
					{formatNumber(s.tokens.total)}
				</Row>
				<Row label={t("Cost")} mono>
					{formatCost(s.cost)}
				</Row>
				<Row label={t("Messages")} mono>
					{t("{user, plural, one {# message from you} other {# messages from you}} · {assistant, plural, one {# reply from the agent} other {# replies from the agent}}", { user: s.userMessages, assistant: s.assistantMessages })}
				</Row>
				<Row label={t("Tool calls")} mono>
					{s.toolCalls}
				</Row>
			</div>
		</Section>
	);
}

// ── info

function SessionInfo({ stream, session, project }: { stream: SessionStream; session: AgentSession; project: Project | undefined }) {
	const runtime = useStreamMeta(stream, (m) => m.live?.runtime ?? null);
	const [confirm, setConfirm] = useState(false);
	const [restarting, setRestarting] = useState(false);
	const restart = async () => {
		setRestarting(true);
		try {
			await stream.restartRuntime();
			setConfirm(false);
			toast.success(t("Runtime restarting"));
		} catch (e) {
			toast.error(t("Could not restart the runtime: {error}", { error: errorText(e) }));
		} finally {
			setRestarting(false);
		}
	};
	const viewOnly = session.kind === "mirror" || session.movedTo !== null;
	return (
		<Section title={t("Session info")}>
			<div className="flex flex-col gap-1.5">
				<IdRow label={t("Session")} value={session.id} />
				<IdRow label={t("OMP session")} value={session.runtimeSessionId} />
				<IdRow label={t("Session file")} value={session.runtimeSessionFile} />
				<IdRow label={t("Project")} value={project?.path} />
				<Row label={t("Created")}>{relativeTime(session.createdAt)}</Row>
			</div>
			<div className="flex flex-col gap-1.5 border-t pt-2.5">
				<div className="flex items-center justify-between gap-2 text-xs">
					<span className="text-muted-foreground">{t("Runtime")}</span>
					{runtime ? (
						<span className="flex items-center gap-1.5">
							<StatusDot status={runtimeDot(runtime.state)} />
							<span className="first-letter:uppercase">{tr(RUNTIME_STATE_LABEL[runtime.state])}</span>
						</span>
					) : (
						<span className="text-subtle">—</span>
					)}
				</div>
				{runtime ? (
					<>
						<Row label={t("PID")} mono>
							{runtime.pid ?? "—"}
						</Row>
						<Row label={t("Started")}>{relativeTime(runtime.startedAt)}</Row>
						<Row label={t("Restarts")} mono>
							{runtime.restarts}
						</Row>
						<Row label={t("Last activity")}>{relativeTime(runtime.lastActivityAt)}</Row>
						{runtime.lastError ? (
							<p role="alert" className="max-h-28 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-danger/10 px-2.5 py-1.5 font-mono text-2xs text-danger">
								{runtime.lastError}
							</p>
						) : null}
					</>
				) : null}
				{viewOnly ? null : (
					<Button size="sm" variant="outline" className="mt-1 self-start" onClick={() => setConfirm(true)}>
						<RotateCw /> {t("Restart runtime")}
					</Button>
				)}
			</div>
			<ConfirmDialog
				open={confirm}
				onOpenChange={setConfirm}
				title={t("Restart the runtime?")}
				description={t("The OMP process for this session is restarted. A turn in progress is interrupted; the conversation is kept.")}
				confirmLabel={t("Restart")}
				danger
				loading={restarting}
				onConfirm={() => void restart()}
			/>
		</Section>
	);
}

export function ContextPanel({ stream, session, project, className }: { stream: SessionStream; session: AgentSession; project: Project | undefined; className?: string }) {
	const selectedToolId = useStreamMeta(stream, (m) => m.selectedToolId);
	const todos = useStreamMeta(stream, (m) => m.live?.todoPhases);
	// Live views and moved copies run no agent here: nothing to configure or restart.
	const viewOnly = session.kind === "mirror" || session.movedTo !== null;
	return (
		<div className={cn("scrollbar-thin h-full min-h-0 overflow-y-auto overscroll-contain bg-surface-1", className)}>
			{selectedToolId ? <ToolInspector key={selectedToolId} stream={stream} id={selectedToolId} /> : null}
			<ContextMeter stream={stream} session={session} viewOnly={viewOnly} />
			{viewOnly ? null : (
				<Section title={t("Model")}>
					<div className="flex flex-wrap items-center gap-1.5">
						<ModelPicker stream={stream} />
						<ThinkingPicker stream={stream} />
					</div>
				</Section>
			)}
			{todos && todos.some((p) => p.tasks.length > 0) ? <Todos phases={todos} /> : null}
			<Stats session={session} />
			<SessionInfo stream={stream} session={session} project={project} />
		</div>
	);
}
