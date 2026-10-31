import type { AgentSession, Project, TodoPhase } from "@clam/contracts";
import { Check, CircleDashed, CircleDot, CircleSlash, RotateCw, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/code-block";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { runtimeDot } from "@/components/session-status";
import { errorMessage } from "@/lib/api";
import { cn, formatCompact, formatCost, formatDuration, relativeTime } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Progress } from "@/ui/progress";
import { StatusDot } from "@/ui/status-dot";
import { ModelPicker, ThinkingPicker } from "./model-pickers.tsx";
import { type SessionStream, useStreamMeta, useToolRec } from "./stream-store.ts";
import { StatusGlyph, ToolDetails, toolDuration, useNow } from "./tool-card.tsx";
import { summarizeArgs } from "./tool-meta.tsx";

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
					<CopyButton text={value} label={`Copy ${label}`} className="size-6" />
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
	const name = rec?.name || call?.name || "tool";
	const args = rec?.args ?? call?.args;
	const duration = toolDuration(rec, now);
	return (
		<Section
			title="Tool call"
			className="bg-accent-soft/40"
			actions={
				<button type="button" aria-label="Close inspector" onClick={() => stream.selectTool(null)} className="grid size-6 place-items-center rounded-md text-subtle outline-none hover:bg-surface-3 hover:text-foreground coarse:size-10">
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

function ContextMeter({ stream, session }: { stream: SessionStream; session: AgentSession }) {
	const usage = useStreamMeta(stream, (m) => m.live?.contextUsage) ?? session.stats?.contextUsage ?? null;
	const tps = useStreamMeta(stream, (m) => m.live?.tokensPerSecond ?? null);
	if (!usage || !usage.contextWindow) {
		return (
			<Section title="Context">
				<p className="text-xs text-muted-foreground">Context usage is not available yet. It appears after the first model response.</p>
			</Section>
		);
	}
	const pct = Math.min(100, (usage.tokens / usage.contextWindow) * 100);
	const tone = pct >= 90 ? "danger" : pct >= 70 ? "warning" : "accent";
	return (
		<Section title="Context">
			<div className="flex items-baseline justify-between gap-2">
				<span className={cn("tabular text-2xl font-semibold tracking-tight", tone === "danger" && "text-danger", tone === "warning" && "text-warning")}>{pct.toFixed(pct < 10 ? 1 : 0)}%</span>
				<span className="tabular font-mono text-2xs text-muted-foreground">
					{formatCompact(usage.tokens)} / {formatCompact(usage.contextWindow)}
				</span>
			</div>
			<Progress value={pct} tone={tone} />
			{tps !== null ? <Row label="Speed">{tps.toFixed(1)} tok/s</Row> : null}
		</Section>
	);
}

// ── todos

function TodoIcon({ status }: { status: string }) {
	const cls = "mt-0.5 size-3.5 shrink-0";
	switch (status) {
		case "completed":
		case "done":
			return <Check className={cn(cls, "text-success")} aria-label="Completed" />;
		case "in_progress":
		case "active":
			return <CircleDot className={cn(cls, "text-accent")} aria-label="In progress" />;
		case "abandoned":
		case "cancelled":
			return <CircleSlash className={cn(cls, "text-subtle")} aria-label="Abandoned" />;
		default:
			return <CircleDashed className={cn(cls, "text-subtle")} aria-label={status || "Pending"} />;
	}
}

function Todos({ phases }: { phases: TodoPhase[] }) {
	const total = phases.reduce((n, p) => n + p.tasks.length, 0);
	const done = phases.reduce((n, p) => n + p.tasks.filter((t) => t.status === "completed" || t.status === "done").length, 0);
	return (
		<Section title="Plan" actions={<span className="tabular font-mono text-2xs text-subtle">{done}/{total}</span>}>
			<div className="flex flex-col gap-3">
				{phases.map((p, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: phases carry no id
					<div key={i} className="flex flex-col gap-1.5">
						{p.name ? <div className="text-xs font-medium">{p.name}</div> : null}
						<ul className="flex flex-col gap-1.5">
							{p.tasks.map((t, j) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: tasks carry no id
								<li key={j} className="flex items-start gap-2 text-xs">
									<TodoIcon status={t.status} />
									<span className={cn("min-w-0 flex-1 break-words", (t.status === "abandoned" || t.status === "cancelled") && "text-subtle line-through", t.status === "in_progress" && "font-medium")}>{t.content}</span>
								</li>
							))}
						</ul>
					</div>
				))}
			</div>
		</Section>
	);
}

// ── stats

function Stats({ session }: { session: AgentSession }) {
	const s = session.stats;
	if (!s) {
		return (
			<Section title="Session stats">
				<p className="text-xs text-muted-foreground">No usage recorded yet.</p>
			</Section>
		);
	}
	return (
		<Section title="Session stats">
			<div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
				{(
					[
						["Input", formatCompact(s.tokens.input)],
						["Output", formatCompact(s.tokens.output)],
						["Cache read", formatCompact(s.tokens.cacheRead)],
						["Cache write", formatCompact(s.tokens.cacheWrite)],
					] as const
				).map(([k, v]) => (
					<div key={k} className="flex flex-col">
						<span className="text-2xs text-subtle">{k}</span>
						<span className="tabular font-mono text-[13px]">{v}</span>
					</div>
				))}
			</div>
			<div className="flex flex-col gap-1.5 border-t pt-2.5">
				<Row label="Total tokens" mono>
					{s.tokens.total.toLocaleString("en-US")}
				</Row>
				<Row label="Cost" mono>
					{formatCost(s.cost)}
				</Row>
				<Row label="Messages" mono>
					{s.userMessages} user · {s.assistantMessages} assistant
				</Row>
				<Row label="Tool calls" mono>
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
			toast.success("Runtime restarting");
		} catch (e) {
			toast.error(`Could not restart the runtime: ${errorMessage(e)}`);
		} finally {
			setRestarting(false);
		}
	};
	const viewOnly = session.kind === "mirror" || session.movedTo !== null;
	return (
		<Section title="Session info">
			<div className="flex flex-col gap-1.5">
				<IdRow label="Session" value={session.id} />
				<IdRow label="OMP session" value={session.runtimeSessionId} />
				<IdRow label="Session file" value={session.runtimeSessionFile} />
				<IdRow label="Project" value={project?.path} />
				<Row label="Created">{relativeTime(session.createdAt)}</Row>
			</div>
			<div className="flex flex-col gap-1.5 border-t pt-2.5">
				<div className="flex items-center justify-between gap-2 text-xs">
					<span className="text-muted-foreground">Runtime</span>
					{runtime ? (
						<span className="flex items-center gap-1.5">
							<StatusDot status={runtimeDot(runtime.state)} />
							<span className="capitalize">{runtime.state}</span>
						</span>
					) : (
						<span className="text-subtle">—</span>
					)}
				</div>
				{runtime ? (
					<>
						<Row label="PID" mono>
							{runtime.pid ?? "—"}
						</Row>
						<Row label="Started">{relativeTime(runtime.startedAt)}</Row>
						<Row label="Restarts" mono>
							{runtime.restarts}
						</Row>
						<Row label="Last activity">{relativeTime(runtime.lastActivityAt)}</Row>
						{runtime.lastError ? (
							<p role="alert" className="max-h-28 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-danger/10 px-2.5 py-1.5 font-mono text-2xs text-danger">
								{runtime.lastError}
							</p>
						) : null}
					</>
				) : null}
				{viewOnly ? null : (
					<Button size="sm" variant="outline" className="mt-1 self-start" onClick={() => setConfirm(true)}>
						<RotateCw /> Restart runtime
					</Button>
				)}
			</div>
			<ConfirmDialog
				open={confirm}
				onOpenChange={setConfirm}
				title="Restart the runtime?"
				description="The OMP process for this session is restarted. A turn in progress is interrupted; the conversation is kept."
				confirmLabel="Restart"
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
			<ContextMeter stream={stream} session={session} />
			{viewOnly ? null : (
				<Section title="Model">
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
