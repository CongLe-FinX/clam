import { type HealthCheck, type NodeSettings, type RuntimeState, type RuntimeStatus, routes } from "@clam/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Cpu, RefreshCw, RotateCw, Square } from "lucide-react";
import { Fragment, useMemo, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { RUNTIME_STATE_LABEL, runtimeDot } from "@/components/session-status";
import { useIsMobile } from "@/hooks/use-breakpoint";
import { api, errorMessage } from "@/lib/api";
import { qk, useHealth, useRuntime, useSessions } from "@/lib/queries";
import { renderServerText, t, tr } from "@/i18n";
import { cn, formatBytes, formatDuration, formatNumber, relativeTime, shortId } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty-state";
import { PageContainer, PageHeader, SectionTitle } from "@/ui/page";
import { Skeleton } from "@/ui/skeleton";
import { DOT_STATUS_LABEL, StatusDot } from "@/ui/status-dot";
import { Table, TBody, Td, Th, THead, Tr } from "@/ui/table";

// ───────────────────────────── shared 1s ticker (visible tab only) ─────────────────────────────

const tickListeners = new Set<() => void>();
let tickTimer: ReturnType<typeof setInterval> | null = null;
let tickNow = Date.now();

function syncTimer() {
	const shouldRun = tickListeners.size > 0 && document.visibilityState === "visible";
	if (shouldRun && tickTimer === null) {
		tickNow = Date.now();
		tickTimer = setInterval(() => {
			tickNow = Date.now();
			for (const l of tickListeners) l();
		}, 1000);
	} else if (!shouldRun && tickTimer !== null) {
		clearInterval(tickTimer);
		tickTimer = null;
	}
}

function subscribeTick(cb: () => void): () => void {
	tickListeners.add(cb);
	document.addEventListener("visibilitychange", syncTimer);
	syncTimer();
	return () => {
		tickListeners.delete(cb);
		document.removeEventListener("visibilitychange", syncTimer);
		syncTimer();
	};
}
const getTick = () => tickNow;

/** Re-renders only the leaf that uses it, once per second while the tab is visible. */
function Uptime({ since }: { since: string | null }) {
	const now = useSyncExternalStore(subscribeTick, getTick, getTick);
	if (!since) return <span className="text-subtle">—</span>;
	const started = Date.parse(since);
	if (Number.isNaN(started)) return <span className="text-subtle">—</span>;
	return <span className="tabular">{formatDuration(Math.max(0, now - started))}</span>;
}

// ───────────────────────────── helpers ─────────────────────────────

const ACTIVE: ReadonlySet<RuntimeState> = new Set(["starting", "ready", "busy", "restarting"]);
const stateVariant = (s: RuntimeState) => (s === "crashed" ? "danger" : s === "busy" ? "accent" : s === "ready" ? "success" : s === "stopped" ? "neutral" : "warning");

function useRuntimeActions() {
	const qc = useQueryClient();
	const patch = (sessionId: string, state: RuntimeState) =>
		qc.setQueryData<RuntimeStatus[]>(qk.runtime, (d) => d?.map((r) => (r.sessionId === sessionId ? { ...r, state, pid: state === "stopped" ? null : r.pid } : r)));
	const base = async (sessionId: string, state: RuntimeState) => {
		await qc.cancelQueries({ queryKey: qk.runtime });
		const prev = qc.getQueryData<RuntimeStatus[]>(qk.runtime);
		patch(sessionId, state);
		return { prev };
	};
	const rollback = (prev?: RuntimeStatus[]) => {
		if (prev) qc.setQueryData(qk.runtime, prev);
	};
	const stop = useMutation({
		mutationFn: (sessionId: string) => api.post(routes.runtimeStop(sessionId)),
		onMutate: (id) => base(id, "stopped"),
		onError: (e, _id, ctx) => {
			rollback(ctx?.prev);
			toast.error(t("Could not stop runtime"), { description: errorMessage(e) });
		},
		onSuccess: () => toast.success(t("Runtime stopped")),
		onSettled: () => void qc.invalidateQueries({ queryKey: qk.runtime }),
	});
	const restart = useMutation({
		mutationFn: (sessionId: string) => api.post<RuntimeStatus>(routes.runtimeRestart(sessionId)),
		onMutate: (id) => base(id, "restarting"),
		onError: (e, _id, ctx) => {
			rollback(ctx?.prev);
			toast.error(t("Could not restart runtime"), { description: errorMessage(e) });
		},
		onSuccess: (status) => {
			if (status) qc.setQueryData<RuntimeStatus[]>(qk.runtime, (d) => d?.map((r) => (r.sessionId === status.sessionId ? status : r)));
			toast.success(t("Runtime restarted"));
		},
		onSettled: () => void qc.invalidateQueries({ queryKey: qk.runtime }),
	});
	return { stop, restart };
}

function Actions({ r }: { r: RuntimeStatus }) {
	const { stop, restart } = useRuntimeActions();
	const stopping = stop.isPending && stop.variables === r.sessionId;
	const restarting = restart.isPending && restart.variables === r.sessionId;
	return (
		<div className="flex items-center gap-1.5">
			{ACTIVE.has(r.state) ? (
				<Button size="sm" variant="outline" loading={stopping} disabled={restarting} onClick={() => stop.mutate(r.sessionId)}>
					<Square /> {t("Stop")}
				</Button>
			) : null}
			<Button size="sm" variant="secondary" loading={restarting} disabled={stopping} onClick={() => restart.mutate(r.sessionId)}>
				<RotateCw /> {t("Restart")}
			</Button>
		</div>
	);
}

// ───────────────────────────── page ─────────────────────────────

export default function NodeRuntimePage() {
	const runtime = useRuntime();
	const sessions = useSessions();
	const mobile = useIsMobile();
	const titles = useMemo(() => new Map((sessions.data ?? []).map((s) => [s.id, s.title || t("Untitled session")] as const)), [sessions.data]);
	const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
	const toggle = (id: string) =>
		setOpen((prev) => {
			const next = new Set(prev);
			if (!next.delete(id)) next.add(id);
			return next;
		});

	const rows = useMemo(() => {
		const rank = (s: RuntimeState) => (s === "crashed" ? 0 : ACTIVE.has(s) ? 1 : 2);
		return [...(runtime.data ?? [])].sort((a, b) => rank(a.state) - rank(b.state) || Date.parse(b.lastActivityAt ?? "0") - Date.parse(a.lastActivityAt ?? "0"));
	}, [runtime.data]);
	const activeCount = rows.filter((r) => ACTIVE.has(r.state)).length;
	const crashedCount = rows.filter((r) => r.state === "crashed").length;

	return (
		<PageContainer wide>
			<PageHeader title={t("Runtime")} description={t("OMP processes backing your sessions. They start on demand and stop when idle.")} />

			<NodeSummary active={runtime.data ? activeCount : null} crashed={runtime.data ? crashedCount : null} />

			<section className="flex flex-col gap-2.5">
				<SectionTitle>{t("Processes")}</SectionTitle>
				{runtime.isPending ? (
					<div aria-busy className="flex flex-col gap-2">
						{Array.from({ length: 3 }, (_, i) => (
							<Skeleton key={i} className="h-14 rounded-lg" />
						))}
					</div>
				) : runtime.error ? (
					<EmptyState
						icon={Cpu}
						title={t("Could not load runtime status")}
						description={errorMessage(runtime.error)}
						action={
							<Button size="sm" variant="outline" onClick={() => void runtime.refetch()}>
								<RefreshCw /> {t("Retry")}
							</Button>
						}
					/>
				) : rows.length === 0 ? (
					<EmptyState icon={Cpu} title={t("No runtimes")} description={t("Runtimes start on demand when you open a session.")} className="rounded-xl bg-surface-1 shadow-[inset_0_0_0_1px_var(--border)]" />
				) : mobile ? (
					<ul className="flex flex-col gap-2">
						{rows.map((r) => (
							<li key={r.sessionId} className="flex flex-col gap-2.5 rounded-xl bg-surface-1 p-3 shadow-[inset_0_0_0_1px_var(--border)]">
								<div className="flex items-start justify-between gap-2">
									<div className="flex min-w-0 flex-col gap-0.5">
										<Link to="/sessions/$sessionId" params={{ sessionId: r.sessionId }} className="truncate text-[13px] font-medium hover:underline">
											{titles.get(r.sessionId) ?? t("Session {id}", { id: shortId(r.sessionId) })}
										</Link>
										<span className="font-mono text-2xs text-subtle">{shortId(r.sessionId, 12)}</span>
									</div>
									<StateBadge state={r.state} />
								</div>
								<dl className="grid grid-cols-4 gap-2 text-xs">
									<Meta label="PID" value={r.pid ?? "—"} mono />
									<Meta label={t("Uptime")} value={ACTIVE.has(r.state) ? <Uptime since={r.startedAt} /> : "—"} />
									<Meta label={t("Restarts")} value={formatNumber(r.restarts)} />
									<Meta label={t("Active")} value={relativeTime(r.lastActivityAt)} />
								</dl>
								{r.lastError ? <ErrorText text={r.lastError} /> : null}
								<Actions r={r} />
							</li>
						))}
					</ul>
				) : (
					<div className="overflow-hidden rounded-xl bg-surface-1 shadow-[inset_0_0_0_1px_var(--border)]">
						<Table>
							<THead>
								<tr>
									<Th className="w-8" />
									<Th>{t("Session")}</Th>
									<Th>{t("State")}</Th>
									<Th>PID</Th>
									<Th>{t("Uptime")}</Th>
									<Th>{t("Restarts")}</Th>
									<Th>{t("Last activity")}</Th>
									<Th className="text-right">{t("Actions")}</Th>
								</tr>
							</THead>
							<TBody>
								{rows.map((r) => {
									const expanded = open.has(r.sessionId);
									return (
										<Fragment key={r.sessionId}>
											<Tr>
												<Td className="w-8 pr-0">
													{r.lastError ? (
														<button
															type="button"
															aria-label={expanded ? t("Hide last error") : t("Show last error")}
															aria-expanded={expanded}
															onClick={() => toggle(r.sessionId)}
															className="grid size-6 place-items-center rounded text-danger hover:bg-surface-3"
														>
															<ChevronRight className={cn("size-3.5 transition-transform duration-150", expanded && "rotate-90")} />
														</button>
													) : null}
												</Td>
												<Td className="max-w-72">
													<Link to="/sessions/$sessionId" params={{ sessionId: r.sessionId }} className="block truncate font-medium hover:underline">
														{titles.get(r.sessionId) ?? t("Session {id}", { id: shortId(r.sessionId) })}
													</Link>
													<span className="font-mono text-2xs text-subtle">{shortId(r.sessionId, 12)}</span>
												</Td>
												<Td>
													<StateBadge state={r.state} />
												</Td>
												<Td className="font-mono text-xs">{r.pid ?? "—"}</Td>
												<Td className="text-xs">{ACTIVE.has(r.state) ? <Uptime since={r.startedAt} /> : <span className="text-subtle">—</span>}</Td>
												<Td className="tabular text-xs">{formatNumber(r.restarts)}</Td>
												<Td className="whitespace-nowrap text-xs text-muted-foreground">{relativeTime(r.lastActivityAt)}</Td>
												<Td className="text-right">
													<div className="flex justify-end">
														<Actions r={r} />
													</div>
												</Td>
											</Tr>
											{expanded && r.lastError ? (
												<tr className="border-b bg-danger/5">
													<td colSpan={8} className="px-4 py-2.5">
														<ErrorText text={r.lastError} expanded />
													</td>
												</tr>
											) : null}
										</Fragment>
									);
								})}
							</TBody>
						</Table>
					</div>
				)}
			</section>
		</PageContainer>
	);
}

function StateBadge({ state }: { state: RuntimeState }) {
	return (
		<Badge variant={stateVariant(state)} className="gap-1.5">
			<StatusDot status={runtimeDot(state)} label={tr(RUNTIME_STATE_LABEL[state])} className="size-1.5 [&>span]:size-1.5" />
			{tr(RUNTIME_STATE_LABEL[state])}
		</Badge>
	);
}

function Meta({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
	return (
		<div className="flex min-w-0 flex-col gap-0.5">
			<dt className="text-2xs uppercase tracking-wider text-subtle">{label}</dt>
			<dd className={cn("truncate tabular", mono && "font-mono")}>{value}</dd>
		</div>
	);
}

function ErrorText({ text, expanded }: { text: string; expanded?: boolean }) {
	return <pre className={cn("whitespace-pre-wrap break-words font-mono text-2xs text-danger", !expanded && "line-clamp-3")}>{text}</pre>;
}

// ───────────────────────────── node summary ─────────────────────────────

const checkVariant = (s: HealthCheck["status"]) => (s === "ok" ? "success" : s === "degraded" ? "warning" : "danger");

function NodeSummary({ active, crashed }: { active: number | null; crashed: number | null }) {
	const health = useHealth();
	const settings = useQuery({ queryKey: qk.settings, queryFn: ({ signal }) => api.get<NodeSettings>(routes.settings, undefined, { signal }) });
	const h = health.data;
	const s = settings.data;
	return (
		<section className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
			<dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-border shadow-[inset_0_0_0_1px_var(--border)]">
				<Tile label={t("Active")} value={active === null ? null : formatNumber(active)} hint={s ? t("of {max} max", { max: s.maxConcurrentRuntimes }) : undefined} accent={(active ?? 0) > 0} />
				<Tile label={t("Crashed")} value={crashed === null ? null : formatNumber(crashed)} danger={(crashed ?? 0) > 0} />
				<Tile label={t("Idle timeout")} value={settings.isPending ? null : s ? t("{count} min", { count: s.runtimeIdleTimeoutMin }) : "—"} />
				<Tile label={t("Machine memory")} value={health.isPending ? null : h ? formatBytes(h.memory.rss) : "—"} hint={h ? "RSS" : undefined} />
			</dl>
			<div className="flex flex-col gap-2 rounded-xl bg-surface-1 p-3.5 shadow-[inset_0_0_0_1px_var(--border)]">
				<div className="flex items-center justify-between gap-2">
					<span className="text-2xs font-semibold uppercase tracking-wider text-subtle">{t("Machine health")}</span>
					{h ? (
						<span className="inline-flex items-center gap-1.5 text-xs">
							<StatusDot status={h.status} label={tr(DOT_STATUS_LABEL[h.status])} />
							<span>{tr(DOT_STATUS_LABEL[h.status])}</span>
						</span>
					) : null}
				</div>
				{health.isPending ? (
					<div className="flex flex-col gap-2">
						<Skeleton className="h-4 w-2/3" />
						<Skeleton className="h-4 w-1/2" />
					</div>
				) : health.error ? (
					<p className="text-xs text-danger">
						{errorMessage(health.error)}{" "}
						<button type="button" className="font-medium text-accent hover:underline" onClick={() => void health.refetch()}>
							{t("Retry")}
						</button>
					</p>
				) : h && h.checks.length > 0 ? (
					<ul className="flex flex-col divide-y">
						{h.checks.map((c) => (
							<li key={c.name} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-1.5 text-xs first:pt-0 last:pb-0">
								<StatusDot status={c.status} label={tr(DOT_STATUS_LABEL[c.status])} />
								<span className="font-mono">{c.name}</span>
								<Badge variant={checkVariant(c.status)}>{tr(DOT_STATUS_LABEL[c.status])}</Badge>
								{c.latencyMs !== undefined ? <span className="font-mono text-2xs text-subtle tabular">{`${formatNumber(Math.round(c.latencyMs))} ms`}</span> : null}
								{c.message ? <span className="min-w-0 basis-full truncate text-muted-foreground sm:basis-auto">{renderServerText(c.message, c.i18n)}</span> : null}
							</li>
						))}
					</ul>
				) : (
					<p className="text-xs text-subtle">{t("No health checks reported.")}</p>
				)}
			</div>
		</section>
	);
}

function Tile({ label, value, hint, accent, danger }: { label: string; value: string | null; hint?: string; accent?: boolean; danger?: boolean }) {
	return (
		<div className="flex flex-col gap-0.5 bg-surface-1 px-4 py-3">
			<dt className="text-2xs font-medium uppercase tracking-wider text-subtle">{label}</dt>
			<dd className={cn("flex items-baseline gap-1.5 font-mono text-lg font-medium tabular", accent && "text-accent", danger && "text-danger")}>
				{value ?? <span className="inline-block h-5 w-10 animate-pulse rounded bg-surface-3" />}
				{hint ? <span className="font-sans text-2xs font-normal text-subtle">{hint}</span> : null}
			</dd>
		</div>
	);
}
