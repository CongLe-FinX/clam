import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, RefreshCw } from "lucide-react";
import {
	routes,
	type DataSource,
	type MeshUsage,
	type MeshUsageRow,
	type Project,
	type RecordedUsage,
	type UsageRow,
} from "@clam/contracts";
import { t, msg, tr, type Msg } from "@/i18n";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queries";
import { cn, formatCost, formatDate, formatNumber, formatPercent } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/card";
import { Skeleton } from "@/ui/skeleton";
import { BarList, TrendChart, type BarItem } from "./charts";
import { fmtAgo, fmtTokens, useNow } from "./format";
import { useMeshUsage, useQuotaReport, useRecordedUsage, useRefreshUsage } from "./hooks";
import { QuotaCards } from "./quota";
import { SourceBadge } from "./source-badge";

function Section({
	title,
	description,
	source,
	children,
	className,
}: {
	title: string;
	description?: string;
	source?: DataSource;
	children: ReactNode;
	className?: string;
}) {
	return (
		<Card className={cn("min-w-0", className)}>
			<CardHeader className="flex-row flex-wrap items-start justify-between gap-2 space-y-0">
				<div className="min-w-0">
					<CardTitle className="text-sm">{title}</CardTitle>
					{description && <CardDescription className="mt-0.5 text-xs">{description}</CardDescription>}
				</div>
				{source && <SourceBadge source={source} />}
			</CardHeader>
			<CardContent>{children}</CardContent>
		</Card>
	);
}

function ErrorBox({ error, onRetry }: { error: unknown; onRetry: () => void }) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
			<span className="min-w-0 break-words">{errorMessage(error)}</span>
			<Button size="sm" variant="outline" onClick={onRetry}>
				{t("Retry")}
			</Button>
		</div>
	);
}

function Kpi({ label, value, sub, source }: { label: string; value: string; sub?: string; source: DataSource }) {
	return (
		<div className="min-w-0 rounded-lg border border-border bg-surface-1 p-3.5">
			<div className="truncate text-xs text-muted-foreground" title={label}>{label}</div>
			<div className="mt-1 truncate font-mono text-xl font-semibold tabular-nums tracking-tight">{value}</div>
			<div className="mt-1 flex items-center justify-between gap-2">
				<span className="truncate text-[11px] text-muted-foreground" title={sub}>{sub ?? "\u00a0"}</span>
				<span
					className={cn(
						"size-1.5 shrink-0 rounded-full",
						source === "omp-recorded" ? "bg-accent" : source === "provider-reported" ? "bg-success" : "bg-warning",
					)}
					title={source}
				/>
			</div>
		</div>
	);
}

function Kpis({ data }: { data: RecordedUsage }) {
	const o = data.overall;
	return (
		<div className="space-y-2">
		<p className="text-xs text-muted-foreground">{t("Last 24 hours — the window OMP reports. Longer history is shown in the daily trend.")}</p>
		<div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
			<Kpi label={t("Input tokens")} value={fmtTokens(o.tokens.input)} sub={formatNumber(o.tokens.input)} source="omp-recorded" />
			<Kpi label={t("Output tokens")} value={fmtTokens(o.tokens.output)} sub={formatNumber(o.tokens.output)} source="omp-recorded" />
			<Kpi
				label={t("Cached tokens")}
				value={fmtTokens(o.tokens.cacheRead)}
				sub={o.cacheRate != null ? t("{rate} cache hit rate", { rate: formatPercent(o.cacheRate) }) : undefined}
				source="omp-recorded"
			/>
			<Kpi
				label={t("Total tokens")}
				value={fmtTokens(o.tokens.total)}
				sub={
					o.failedRequests
						? t("{count, plural, one {# request} other {# requests}} · {failed} failed", { count: o.requests, failed: o.failedRequests })
						: t("{count, plural, one {# request} other {# requests}}", { count: o.requests })
				}
				source="omp-recorded"
			/>
			<Kpi label={t("Cost")} value={formatCost(o.cost)} sub={t("OMP price table · last 24 h")} source="omp-recorded" />
		</div>
		</div>
	);
}

type SortKey = "label" | "requests" | "input" | "output" | "cached" | "total" | "cost";

function sortValue(r: UsageRow, k: SortKey): number | string {
	switch (k) {
		case "label":
			return r.key.toLowerCase();
		case "requests":
			return r.requests;
		case "input":
			return r.tokens.input;
		case "output":
			return r.tokens.output;
		case "cached":
			return r.tokens.cacheRead;
		case "total":
			return r.tokens.total;
		case "cost":
			return r.cost;
	}
}

const COLUMNS: { key: SortKey; label: Msg; align?: "right" }[] = [
	{ key: "label", label: msg("Model") },
	{ key: "requests", label: msg("Requests"), align: "right" },
	{ key: "input", label: msg("Input"), align: "right" },
	{ key: "output", label: msg("Output"), align: "right" },
	{ key: "cached", label: msg("Cached"), align: "right" },
	{ key: "total", label: msg("Total"), align: "right" },
	{ key: "cost", label: msg("Cost"), align: "right" },
];

function ModelTable({ rows }: { rows: UsageRow[] }) {
	const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "cost", dir: -1 });
	const sorted = useMemo(
		() =>
			[...rows].sort((a, b) => {
				const av = sortValue(a, sort.key);
				const bv = sortValue(b, sort.key);
				return (av < bv ? -1 : av > bv ? 1 : 0) * sort.dir;
			}),
		[rows, sort],
	);
	if (rows.length === 0) return <div className="py-6 text-center text-sm text-muted-foreground">{t("No model usage recorded yet.")}</div>;
	return (
		<>
			{/* Desktop table */}
			<div className="hidden overflow-x-auto md:block">
				<table className="w-full text-sm">
					<thead>
						<tr className="border-b border-border text-xs text-muted-foreground">
							{COLUMNS.map((c) => (
								<th key={c.key} className={cn("px-2 py-2 font-medium", c.align === "right" ? "text-right" : "text-left")} aria-sort={sort.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
									<button
										type="button"
										className={cn("inline-flex items-center gap-1 rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent", c.align === "right" && "flex-row-reverse")}
										onClick={() => setSort((s) => (s.key === c.key ? { key: c.key, dir: (s.dir * -1) as 1 | -1 } : { key: c.key, dir: c.key === "label" ? 1 : -1 }))}
									>
										{tr(c.label)}
										{sort.key === c.key && (sort.dir === 1 ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
									</button>
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{sorted.map((r) => (
							<tr key={r.key} className="border-b border-border/60 last:border-0 hover:bg-surface-2">
								<td className="max-w-[18rem] px-2 py-2">
									<div className="truncate font-mono text-xs" title={r.key}>{r.model ?? r.key}</div>
									{r.provider && <div className="text-[11px] text-muted-foreground">{r.provider}</div>}
								</td>
								<td className="px-2 py-2 text-right font-mono text-xs tabular-nums">{formatNumber(r.requests)}</td>
								<td className="px-2 py-2 text-right font-mono text-xs tabular-nums">{fmtTokens(r.tokens.input)}</td>
								<td className="px-2 py-2 text-right font-mono text-xs tabular-nums">{fmtTokens(r.tokens.output)}</td>
								<td className="px-2 py-2 text-right font-mono text-xs tabular-nums">{fmtTokens(r.tokens.cacheRead)}</td>
								<td className="px-2 py-2 text-right font-mono text-xs tabular-nums">{fmtTokens(r.tokens.total)}</td>
								<td className="px-2 py-2 text-right font-mono text-xs tabular-nums">{formatCost(r.cost)}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			{/* Mobile cards */}
			<ul className="space-y-2 md:hidden">
				{sorted.map((r) => (
					<li key={r.key} className="rounded-lg border border-border bg-surface-1 p-3">
						<div className="flex items-start justify-between gap-3">
							<div className="min-w-0">
								<div className="truncate font-mono text-xs">{r.model ?? r.key}</div>
								{r.provider && <div className="text-[11px] text-muted-foreground">{r.provider}</div>}
							</div>
							<div className="shrink-0 font-mono text-sm tabular-nums">{formatCost(r.cost)}</div>
						</div>
						<dl className="mt-2 grid grid-cols-4 gap-2 text-[11px]">
							{[
								[msg("Req"), formatNumber(r.requests)] as const,
								[msg("In"), fmtTokens(r.tokens.input)] as const,
								[msg("Out"), fmtTokens(r.tokens.output)] as const,
								[msg("Cached"), fmtTokens(r.tokens.cacheRead)] as const,
							].map(([k, v], i) => (
								<div key={i}>
									<dt className="text-muted-foreground">{tr(k)}</dt>
									<dd className="font-mono tabular-nums">{v}</dd>
								</div>
							))}
						</dl>
					</li>
				))}
			</ul>
		</>
	);
}

/**
 * OMP records folders as encoded session-dir names: the home prefix is stripped and `/` becomes `-`
 * (`/Users/me/Documents/app` → `-Documents-app`). The encoding is lossy, so matches are approximate.
 */
function encodeFolder(path: string): string[] {
	const full = path.replace(/\/+$/, "").replace(/[/\\]/g, "-");
	const home = /^\/(?:Users|home)\/[^/]+/.exec(path)?.[0]?.replace(/[/\\]/g, "-");
	return home && full.startsWith(home) && full.length > home.length ? [full.slice(home.length), full] : [full];
}

function costByProject(byFolder: UsageRow[], projects: Project[]): BarItem[] {
	const candidates = projects
		.flatMap((p) => encodeFolder(p.path).map((enc) => ({ p, enc })))
		.sort((a, b) => b.enc.length - a.enc.length);
	const acc = new Map<string, { label: string; detail: string; cost: number; tokens: number; requests: number; matched: boolean }>();
	for (const f of byFolder) {
		const hit = candidates.find((c) => f.key === c.enc || f.key.startsWith(`${c.enc}-`));
		const id = hit ? hit.p.id : f.key;
		const cur = acc.get(id) ?? {
			label: hit ? hit.p.name : f.key,
			detail: hit ? hit.p.path : t("not matched to a project"),
			cost: 0,
			tokens: 0,
			requests: 0,
			matched: Boolean(hit),
		};
		cur.cost += f.cost;
		cur.tokens += f.tokens.total;
		cur.requests += f.requests;
		acc.set(id, cur);
	}
	return [...acc.entries()]
		.sort((a, b) => b[1].cost - a[1].cost)
		.slice(0, 12)
		.map(([id, v]) => ({
			key: id,
			label: v.label,
			sublabel: v.detail,
			value: v.cost,
			display: formatCost(v.cost),
			detail: t("{detail} · {tokens} tokens · {count, plural, one {# request} other {# requests}}", { detail: `${v.matched ? "≈ " : ""}${v.detail}`, tokens: fmtTokens(v.tokens), count: v.requests }),
		}));
}

function meshItems(rows: MeshUsageRow[]): BarItem[] {
	return [...rows]
		.sort((a, b) => b.cost - a.cost)
		.slice(0, 12)
		.map((r) => ({
			key: r.key,
			label: r.label,
			value: r.cost,
			display: formatCost(r.cost),
			detail: t("{tokens} tokens · {count, plural, one {# session} other {# sessions}}", { tokens: fmtTokens(r.tokens.total), count: r.sessions }),
		}));
}

function meshSource(rows: MeshUsageRow[]): DataSource {
	return rows.some((r) => r.source === "clam-estimated") ? "clam-estimated" : (rows[0]?.source ?? "clam-estimated");
}

function ProjectsAndAgents({ recorded, mesh, projects }: { recorded: RecordedUsage; mesh: MeshUsage | undefined; projects: Project[] }) {
	const proj = useMemo(() => costByProject(recorded.byFolder, projects), [recorded.byFolder, projects]);
	return (
		<div className="grid gap-3 lg:grid-cols-2">
			<Section title={t("Cost by project")} description={t("OMP working folders (last 24 h) matched to CL Agent Mesh projects.")} source="omp-recorded">
				<BarList items={proj} empty={t("No folder-level usage recorded.")} />
				{mesh && mesh.byProject.length > 0 && (
					<div className="mt-5 border-t border-border pt-4">
						<div className="mb-3 flex items-center justify-between gap-2">
							<span className="text-xs font-medium text-muted-foreground">{t("Mesh sessions")}</span>
							<SourceBadge source={meshSource(mesh.byProject)} />
						</div>
						<BarList items={meshItems(mesh.byProject)} />
					</div>
				)}
			</Section>
			<Section title={t("Cost by agent")} description={t("Roll-up of CL Agent Mesh agent sessions on this machine, from per-session OMP statistics.")} source={mesh ? meshSource(mesh.byAgent) : "clam-estimated"}>
				{mesh ? (
					<BarList items={meshItems(mesh.byAgent)} empty={t("No agent sessions have recorded usage yet.")} />
				) : (
					<Skeleton className="h-24 w-full" />
				)}
			</Section>
		</div>
	);
}

function RefreshBar({ recordedAt, stale, refreshing, onRefresh }: { recordedAt?: string; stale: boolean; refreshing: boolean; onRefresh: () => void }) {
	const now = useNow(5000);
	return (
		<div className="flex flex-wrap items-center justify-between gap-2">
			<div className="flex items-center gap-2 text-xs text-muted-foreground">
				{stale || refreshing ? (
					<span className="inline-flex items-center gap-1.5 text-warning">
						<span className="size-1.5 animate-pulse rounded-full bg-warning" />
						{t("Refreshing…")}
					</span>
				) : (
					<span>{t("Up to date")}</span>
				)}
				{recordedAt && <span>{t("· OMP stats updated {time}", { time: fmtAgo(recordedAt, now) })}</span>}
			</div>
			<Button size="sm" variant="outline" onClick={onRefresh} disabled={refreshing}>
				<RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
				{t("Refresh")}
			</Button>
		</div>
	);
}

export function UsageDashboard() {
	const recorded = useRecordedUsage();
	const quota = useQuotaReport();
	const mesh = useMeshUsage();
	const refresh = useRefreshUsage();
	const projects = useQuery({
		queryKey: qk.projects(),
		queryFn: ({ signal }) => api.get<Project[]>(routes.projects, undefined, { signal }),
	});

	const r = recorded.data;
	const byProvider = useMemo<BarItem[]>(
		() =>
			[...(r?.byProvider ?? [])]
				.sort((a, b) => b.cost - a.cost || b.tokens.total - a.tokens.total)
				.map((p) => ({
					key: p.key,
					label: p.key,
					value: p.tokens.total,
					display: `${fmtTokens(p.tokens.total)} · ${formatCost(p.cost)}`,
					detail: t("{input} in · {output} out · {cached} cached", { input: fmtTokens(p.tokens.input), output: fmtTokens(p.tokens.output), cached: fmtTokens(p.tokens.cacheRead) }),
				})),
		[r?.byProvider],
	);

	return (
		<div className="space-y-4">
			<RefreshBar
				recordedAt={r?.fetchedAt}
				stale={Boolean(r?.stale || quota.data?.stale)}
				refreshing={refresh.isPending}
				onRefresh={() => refresh.mutate()}
			/>
			{refresh.isError && <ErrorBox error={refresh.error} onRetry={() => refresh.mutate()} />}

			{recorded.isPending ? (
				<div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
					{Array.from({ length: 5 }, (_, i) => (
						<Skeleton key={i} className="h-[88px]" />
					))}
				</div>
			) : recorded.isError ? (
				<ErrorBox error={recorded.error} onRetry={() => recorded.refetch()} />
			) : (
				r && (
					<>
						<Kpis data={r} />
						<div className="grid gap-3 xl:grid-cols-[2fr_1fr]">
							<Section title={t("Daily trend")} description={r.coverageStart != null ? t("Total tokens per day (bars) and cost (line). History since {date} — OMP itself only reports the last 24 h, so CL Agent Mesh accumulates daily buckets locally.", { date: formatDate(r.coverageStart) }) : t("Total tokens per day (bars) and cost (line).")} source="omp-recorded">
								<TrendChart points={r.daily} />
							</Section>
							<Section title={t("By provider")} description={t("Tokens and cost per provider, last 24 h.")} source="omp-recorded">
								<BarList items={byProvider} empty={t("No provider usage recorded yet.")} />
							</Section>
						</div>
						<Section title={t("By model")} description={t("Last 24 h. Click a column to sort.")} source="omp-recorded">
							<ModelTable rows={r.byModel} />
						</Section>
						<ProjectsAndAgents recorded={r} mesh={mesh.data} projects={projects.data ?? []} />
					</>
				)
			)}

			<div className="pt-2">
				<div className="mb-3 flex flex-wrap items-center justify-between gap-2">
					<div>
						<h2 className="text-sm font-semibold">{t("Provider quota")}</h2>
						<p className="text-xs text-muted-foreground">{t("Limits and remaining allowance as reported by each provider. Never estimated.")}</p>
					</div>
					<SourceBadge source="provider-reported" />
				</div>
				{quota.isPending ? (
					<div className="grid gap-3 lg:grid-cols-2">
						<Skeleton className="h-36" />
						<Skeleton className="h-36" />
					</div>
				) : quota.isError ? (
					<ErrorBox error={quota.error} onRetry={() => quota.refetch()} />
				) : (
					quota.data && <QuotaCards report={quota.data} />
				)}
			</div>
		</div>
	);
}
