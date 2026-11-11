import { type AppUsage, type DiskUsageReport, type SystemAlert, type SystemDisk, type SystemStatus, routes } from "@clam/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, FolderSearch, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useOmpProviders, useNode, useSystemProcesses, useSystemStatus, qk } from "@/lib/queries";
import { BatteryGauge, batteryState } from "@/components/battery";
import { renderServerText, t } from "@/i18n";
import { api, errorMessage } from "@/lib/api";
import { cn, formatBytes, formatDuration, relativeTime, shortFingerprint } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import { EmptyState } from "@/ui/empty-state";
import { FillBar, type FillTone, toneOfLevel, useFillValue } from "@/ui/fill-bar";
import { PageContainer, PageHeader, SectionTitle } from "@/ui/page";
import { Skeleton } from "@/ui/skeleton";

const PLATFORM: Record<string, string> = { darwin: "macOS", linux: "Linux", win32: "Windows" };
const STROKE: Record<FillTone, string> = { accent: "stroke-accent", warning: "stroke-warning", danger: "stroke-danger" };
const TEXT: Record<FillTone, string> = { accent: "text-foreground", warning: "text-warning", danger: "text-danger" };

const levelOf = (s: SystemStatus, kind: SystemAlert["kind"]) => s.alerts.find((a) => a.kind === kind)?.level;

// ───────────────────────────── small visual parts ─────────────────────────────

/** Eases a displayed number toward `value` (skipped under prefers-reduced-motion). */
function useCountUp(value: number, ms = 700): number {
	const [shown, setShown] = useState(0);
	const from = useRef(0);
	useEffect(() => {
		if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
			from.current = value;
			setShown(value);
			return;
		}
		const start = performance.now();
		const origin = from.current;
		let raf = 0;
		const step = (now: number) => {
			const k = Math.min(1, (now - start) / ms);
			const eased = 1 - (1 - k) ** 3;
			from.current = origin + (value - origin) * eased;
			setShown(from.current);
			if (k < 1) raf = requestAnimationFrame(step);
		};
		raf = requestAnimationFrame(step);
		return () => cancelAnimationFrame(raf);
	}, [value, ms]);
	return shown;
}

function Ring({ percent, tone, label }: { percent: number; tone: FillTone; label: string }) {
	const filled = useFillValue(percent);
	const shown = useCountUp(percent);
	const r = 42;
	const c = 2 * Math.PI * r;
	return (
		<div role="img" aria-label={`${label} ${Math.round(percent)}%`} className="relative size-28 shrink-0">
			<svg viewBox="0 0 100 100" className="size-full -rotate-90" aria-hidden>
				<circle cx="50" cy="50" r={r} fill="none" strokeWidth="7" className="stroke-surface-3" />
				<circle
					cx="50"
					cy="50"
					r={r}
					fill="none"
					strokeWidth="7"
					strokeLinecap="round"
					strokeDasharray={c}
					strokeDashoffset={c * (1 - filled / 100)}
					className={cn("transition-[stroke-dashoffset,stroke] duration-700 ease-[var(--ease-out-quint)]", STROKE[tone])}
				/>
			</svg>
			<div className="absolute inset-0 grid place-items-center">
				<span className={cn("font-mono text-2xl font-medium tabular-nums transition-colors", TEXT[tone])}>
					{Math.round(shown)}
					<span className="text-sm text-subtle">%</span>
				</span>
			</div>
		</div>
	);
}

function Sparkline({ values, tone }: { values: number[]; tone: FillTone }) {
	const filled = useFillValue(100);
	if (values.length < 2) return <div className="h-10" />;
	const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${30 - (Math.min(100, Math.max(0, v)) / 100) * 28 - 1}`);
	const line = pts.join(" ");
	return (
		<svg viewBox="0 0 100 30" preserveAspectRatio="none" className="h-10 w-full overflow-visible" aria-hidden style={{ opacity: filled / 100, transition: "opacity 600ms" }}>
			<polygon points={`0,30 ${line} 100,30`} className={cn("opacity-15", STROKE[tone].replace("stroke-", "fill-"))} />
			<polyline points={line} fill="none" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" className={STROKE[tone]} />
		</svg>
	);
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex items-baseline justify-between gap-3 text-xs">
			<dt className="text-subtle">{label}</dt>
			<dd className="min-w-0 truncate text-right font-mono tabular-nums">{children}</dd>
		</div>
	);
}

function HeroCard({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
	return (
		<Card className={cn("flex flex-col gap-3 p-4", className)}>
			<h2 className="text-2xs font-semibold uppercase tracking-wider text-subtle">{title}</h2>
			{children}
		</Card>
	);
}

// ───────────────────────────── alerts ─────────────────────────────

function AlertBanner({ alerts }: { alerts: SystemAlert[] }) {
	if (alerts.length === 0) return null;
	return (
		<div role="alert" className="flex flex-col gap-1.5 animate-slide-up">
			{alerts.map((a) => (
				<div
					key={a.kind}
					className={cn(
						"flex items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-[13px] font-medium",
						a.level === "critical" ? "bg-danger/10 text-danger shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--danger)_45%,transparent)]" : "bg-warning/10 text-warning shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--warning)_45%,transparent)]",
					)}
				>
					<span className="relative grid size-5 shrink-0 place-items-center">
						<span className={cn("absolute inset-0 animate-[clam-pulse-ring_2.2s_ease-out_infinite] rounded-full", a.level === "critical" ? "bg-danger/50" : "bg-warning/50")} />
						<AlertTriangle className="relative size-4" />
					</span>
					<span className="min-w-0">{renderServerText(a.message, a.i18n)}</span>
				</div>
			))}
		</div>
	);
}

// ───────────────────────────── hero cards ─────────────────────────────

function CpuCard({ s }: { s: SystemStatus }) {
	const tone = toneOfLevel(levelOf(s, "cpu"));
	return (
		<HeroCard title={t("CPU")}>
			<div className="flex items-center gap-4">
				<Ring percent={s.cpu.percent} tone={tone} label={t("CPU")} />
				<dl className="flex min-w-0 flex-1 flex-col gap-1.5">
					<Fact label={t("Cores")}>{s.cpu.cores}</Fact>
					<Fact label={t("Load 1 / 5 / 15 min")}>{s.cpu.load.map((l) => l.toFixed(2)).join(" · ")}</Fact>
					<p className="truncate text-2xs text-subtle" title={s.cpu.model}>
						{s.cpu.model}
					</p>
				</dl>
			</div>
			<div className="flex flex-col gap-1">
				<Sparkline values={s.cpu.history} tone={tone} />
				<span className="text-2xs text-subtle">{t("Last minute")}</span>
			</div>
		</HeroCard>
	);
}

const PRESSURE = { normal: "success", warning: "warning", critical: "danger" } as const;

function MemoryCard({ s }: { s: SystemStatus }) {
	const m = s.memory;
	const tone = toneOfLevel(levelOf(s, "memory"));
	return (
		<HeroCard title={t("Memory")}>
			<div className="flex items-center gap-4">
				<Ring percent={m.percent} tone={tone} label={t("Memory")} />
				<dl className="flex min-w-0 flex-1 flex-col gap-1.5">
					<Fact label={t("Used")}>{`${formatBytes(m.used)} / ${formatBytes(m.total)}`}</Fact>
					<Fact label={t("Available")}>{formatBytes(m.available)}</Fact>
					<Fact label={t("Swap")}>{m.swapTotal > 0 ? `${formatBytes(m.swapUsed)} / ${formatBytes(m.swapTotal)}` : t("None")}</Fact>
					{m.pressure ? (
						<Fact label={t("Pressure")}>
							<Badge variant={PRESSURE[m.pressure]}>{m.pressure === "normal" ? t("Normal") : m.pressure === "warning" ? t("Elevated") : t("Critical")}</Badge>
						</Fact>
					) : null}
				</dl>
			</div>
		</HeroCard>
	);
}

function DiskCard({ s }: { s: SystemStatus }) {
	const level = levelOf(s, "disk");
	const primary = s.disks[0];
	return (
		<HeroCard title={t("Disk")}>
			{primary ? (
				<>
					<div className="flex items-center gap-4">
						<Ring percent={primary.percent} tone={toneOfLevel(level)} label={t("Disk")} />
						<dl className="flex min-w-0 flex-1 flex-col gap-1.5">
							<Fact label={t("Free")}>{formatBytes(primary.free)}</Fact>
							<Fact label={t("Used")}>{formatBytes(primary.used)}</Fact>
							<Fact label={t("Total")}>{formatBytes(primary.total)}</Fact>
						</dl>
					</div>
					{s.disks.length > 1 ? (
						<ul className="flex flex-col gap-2 border-t pt-3">
							{s.disks.slice(1).map((d) => (
								<VolumeRow key={d.path} d={d} />
							))}
						</ul>
					) : null}
					<p className="truncate font-mono text-2xs text-subtle" title={primary.path}>
						{primary.path}
					</p>
				</>
			) : (
				<p className="text-xs text-subtle">{t("No volumes could be read.")}</p>
			)}
		</HeroCard>
	);
}

function VolumeRow({ d }: { d: SystemDisk }) {
	return (
		<li className="flex flex-col gap-1">
			<div className="flex items-baseline justify-between gap-2 text-xs">
				<span className="min-w-0 truncate font-mono text-2xs text-muted-foreground" title={d.path}>
					{d.path}
				</span>
				<span className="shrink-0 font-mono tabular-nums">{t("{free} free", { free: formatBytes(d.free) })}</span>
			</div>
			<FillBar value={d.percent} tone={d.free / d.total < 0.1 ? "warning" : "accent"} />
		</li>
	);
}

// ───────────────────────────── top apps ─────────────────────────────

function AppList({ title, hint, apps, value, format }: { title: string; hint?: string; apps: AppUsage[] | undefined; value: (a: AppUsage) => number; format: (a: AppUsage) => string }) {
	const max = Math.max(1, ...(apps ?? []).map(value));
	return (
		<section className="flex flex-col gap-2.5">
			<SectionTitle>{title}</SectionTitle>
			<Card className="p-1.5">
				{!apps ? (
					<div className="flex flex-col gap-2 p-2" aria-busy>
						{Array.from({ length: 5 }, (_, i) => (
							<Skeleton key={i} className="h-8" />
						))}
					</div>
				) : apps.length === 0 ? (
					<p className="p-4 text-center text-xs text-subtle">{t("Nothing to show.")}</p>
				) : (
					<ol className="flex flex-col">
						{apps.map((a, i) => (
							<li key={a.name} className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-2">
								<span className="text-right font-mono text-2xs text-subtle tabular-nums">{i + 1}</span>
								<div className="flex min-w-0 items-baseline gap-2">
									<span className="min-w-0 truncate text-[13px] font-medium" title={a.name}>
										{a.name}
									</span>
									<span className="shrink-0 text-2xs text-subtle">{t("{count, plural, one {# process} other {# processes}}", { count: a.processes })}</span>
								</div>
								<span className="font-mono text-xs tabular-nums">{format(a)}</span>
								<span />
								<FillBar className="col-span-2" value={(value(a) / max) * 100} />
							</li>
						))}
					</ol>
				)}
			</Card>
			{hint ? <p className="px-1 text-2xs text-subtle">{hint}</p> : null}
		</section>
	);
}

function TopApps() {
	const procs = useSystemProcesses(5000);
	if (procs.data && !procs.data.supported) {
		return <EmptyState icon={AlertTriangle} title={t("Per-app usage is not available on this system")} description={t("The list of running apps can only be read on macOS and Linux.")} className="rounded-xl bg-surface-1 shadow-[inset_0_0_0_1px_var(--border)]" />;
	}
	return (
		<div className="grid gap-5 lg:grid-cols-2">
			<AppList title={t("Top apps by CPU")} hint={t("100% is one full core; an app using several cores can go above it.")} apps={procs.data?.byCpu} value={(a) => a.cpu} format={(a) => `${Math.round(a.cpu)}%`} />
			<AppList title={t("Top apps by memory")} apps={procs.data?.byMemory} value={(a) => a.memBytes} format={(a) => formatBytes(a.memBytes)} />
		</div>
	);
}

// ───────────────────────────── largest folders ─────────────────────────────

function FolderScan() {
	const qc = useQueryClient();
	const cached = useQuery({
		queryKey: qk.systemDiskUsage,
		queryFn: ({ signal }) => api.get<DiskUsageReport>(routes.systemDiskUsage, undefined, { signal }),
		retry: false,
		staleTime: Number.POSITIVE_INFINITY,
	});
	const scan = useMutation({
		mutationFn: () => api.post<DiskUsageReport>(routes.systemDiskUsage),
		onSuccess: (report) => qc.setQueryData(qk.systemDiskUsage, report),
	});
	const report = cached.data;
	const max = Math.max(1, ...(report?.entries ?? []).map((e) => e.bytes));
	return (
		<section className="flex flex-col gap-2.5">
			<SectionTitle
				actions={
					<Button size="sm" variant="outline" loading={scan.isPending} onClick={() => scan.mutate()}>
						{report ? <RefreshCw /> : <FolderSearch />}
						{scan.isPending ? t("Analyzing…") : report ? t("Analyze again") : t("Analyze")}
					</Button>
				}
			>
				{t("Largest folders in your home")}
			</SectionTitle>
			<Card className="p-1.5">
				{scan.isPending ? (
					<div className="flex flex-col gap-2 p-3" aria-busy>
						<p className="text-xs text-muted-foreground">{t("Measuring folder sizes. This can take up to a minute on a large disk.")}</p>
						{Array.from({ length: 4 }, (_, i) => (
							<Skeleton key={i} className="h-7" />
						))}
					</div>
				) : report ? (
					<>
						<ol className="flex flex-col">
							{report.entries.map((e, i) => (
								<li key={e.name} className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-2">
									<span className="text-right font-mono text-2xs text-subtle tabular-nums">{i + 1}</span>
									<span className="min-w-0 truncate font-mono text-[13px]" title={e.name}>
										{e.name}
									</span>
									<span className="font-mono text-xs tabular-nums">{formatBytes(e.bytes)}</span>
									<span />
									<FillBar className="col-span-2" value={(e.bytes / max) * 100} />
								</li>
							))}
						</ol>
						<p className="flex flex-wrap items-center gap-x-2 px-3 pb-2 pt-1 text-2xs text-subtle">
							<span className="min-w-0 truncate font-mono" title={report.root}>
								{report.root}
							</span>
							<span>·</span>
							<span>{t("Scanned {time}", { time: relativeTime(report.scannedAt) })}</span>
							{report.partial ? <Badge variant="warning">{t("Partial: the scan hit its time limit")}</Badge> : null}
						</p>
					</>
				) : (
					<div className="flex flex-col items-center gap-1 p-6 text-center">
						<p className="text-[13px] font-medium">{t("Find what is using your disk")}</p>
						<p className="max-w-md text-xs text-muted-foreground">{t("Measures the biggest folders in your home directory. Nothing is changed or uploaded.")}</p>
						{scan.error ? <p className="mt-1 text-xs text-danger">{errorMessage(scan.error)}</p> : null}
					</div>
				)}
			</Card>
		</section>
	);
}

// ───────────────────────────── page ─────────────────────────────

export default function SystemPage() {
	const node = useNode();
	const omp = useOmpProviders();
	const status = useSystemStatus(3000);
	const s = status.data;
	const n = node.data;
	const ompVersion = omp.data?.install.installed ? (omp.data.install.version?.replace(/^omp\//, "") ?? t("ok")) : omp.data ? t("missing") : "…";
	return (
		<PageContainer wide>
			<PageHeader
				eyebrow={t("This machine")}
				title={n?.name ?? <Skeleton className="h-6 w-40" />}
				description={
					n && s
						? `${PLATFORM[s.platform] ?? s.platform} ${n.arch} · ${s.hostname} · ${t("up {time}", { time: formatDuration(s.uptimeSec * 1000) })}`
						: undefined
				}
				actions={
					<>
						{s?.battery ? (
							<span className="inline-flex items-center gap-2 rounded-md bg-surface-2 py-0.5 pl-1.5 pr-2 text-2xs text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]">
								<BatteryGauge battery={s.battery} size="md" />
								<span aria-hidden>{batteryState(s.battery)}</span>
							</span>
						) : null}
						<Badge variant={omp.data && !omp.data.install.installed ? "warning" : "neutral"}>OMP {ompVersion}</Badge>
						{n ? <span className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-2xs text-subtle" title={n.fingerprint}>{shortFingerprint(n.fingerprint)}</span> : null}
					</>
				}
			/>

			{s ? <AlertBanner alerts={s.alerts} /> : null}

			{status.isPending ? (
				<div aria-busy className="grid gap-3 md:grid-cols-3">
					{Array.from({ length: 3 }, (_, i) => (
						<Skeleton key={i} className="h-56 rounded-xl" />
					))}
				</div>
			) : s ? (
				<div className="grid gap-3 md:grid-cols-3">
					<CpuCard s={s} />
					<MemoryCard s={s} />
					<DiskCard s={s} />
				</div>
			) : (
				<EmptyState
					icon={AlertTriangle}
					title={t("Could not read system status")}
					description={errorMessage(status.error)}
					action={
						<Button size="sm" variant="outline" onClick={() => void status.refetch()}>
							<RefreshCw /> {t("Retry")}
						</Button>
					}
				/>
			)}

			<TopApps />
			<FolderScan />
		</PageContainer>
	);
}
