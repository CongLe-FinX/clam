import type { SystemAlert, SystemStatus } from "@clam/contracts";
import { Link } from "@tanstack/react-router";
import { renderServerText, t, msg, tr } from "@/i18n";
import { useHealth, useNode, useSystemStatus } from "@/lib/queries";
import { cn, formatBytes } from "@/lib/utils";
import { useWsStatus } from "@/lib/ws";
import { FillBar, toneOfLevel } from "@/ui/fill-bar";
import { Skeleton } from "@/ui/skeleton";
import { StatusDot, type DotStatus } from "@/ui/status-dot";
import { Tip } from "@/ui/tooltip";

const dotWord = { ok: msg("ok"), degraded: msg("degraded"), down: msg("down"), starting: msg("starting") } as const;

export function useNodeStatus() {
	const node = useNode();
	const health = useHealth();
	const system = useSystemStatus();
	const wsStatus = useWsStatus();
	const dot: DotStatus = node.isError || wsStatus === "closed" ? "down" : health.data ? health.data.status : "starting";
	return { node, health, system, wsStatus, dot, alert: system.data?.alerts[0] };
}

const GB = 1024 ** 3;
const gb = (bytes: number) => (bytes / GB).toFixed(bytes >= 100 * GB ? 0 : 1);

const alertTone = {
	warning: { dot: "bg-warning", text: "text-warning", card: "bg-warning/10 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--warning)_45%,transparent)] hover:bg-warning/15" },
	critical: { dot: "bg-danger", text: "text-danger", card: "bg-danger/10 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--danger)_50%,transparent)] hover:bg-danger/15" },
} as const;

function AlertDot({ level, className }: { level: SystemAlert["level"]; className?: string }) {
	return (
		<span aria-hidden className={cn("relative inline-grid size-2 shrink-0 place-items-center", className)}>
			<span className={cn("absolute inline-flex size-full animate-[clam-pulse-ring_2.2s_ease-out_infinite] rounded-full", alertTone[level].dot)} />
			<span className={cn("relative size-2 rounded-full", alertTone[level].dot)} />
		</span>
	);
}

function Meter({ label, value, percent, level }: { label: string; value: string; percent: number; level: SystemAlert["level"] | undefined }) {
	return (
		<div className="grid grid-cols-[2.25rem_minmax(0,1fr)_auto] items-center gap-x-2">
			<span className="text-2xs font-medium uppercase tracking-wide text-subtle">{label}</span>
			<FillBar value={percent} tone={toneOfLevel(level)} />
			<span className={cn("text-right font-mono text-2xs tabular-nums text-muted-foreground", level && alertTone[level].text)}>{value}</span>
		</div>
	);
}

function Meters({ s }: { s: SystemStatus }) {
	const level = (kind: SystemAlert["kind"]) => s.alerts.find((a) => a.kind === kind)?.level;
	const disk = s.disks[0];
	return (
		<div className="flex flex-col gap-1.5">
			<Meter label={t("CPU")} value={`${Math.round(s.cpu.percent)}%`} percent={s.cpu.percent} level={level("cpu")} />
			<Meter label={t("RAM")} value={`${gb(s.memory.used)}/${Math.round(s.memory.total / GB)} GB`} percent={s.memory.percent} level={level("memory")} />
			{disk ? <Meter label={t("Disk")} value={t("{free} free", { free: formatBytes(disk.free) })} percent={disk.percent} level={level("disk")} /> : null}
		</div>
	);
}

/** Node identity + live host load at the top of the sidebar (full mode). The whole card opens the System page. */
export function NodeStatusCard({ className }: { className?: string }) {
	const { node, system, wsStatus, dot, alert } = useNodeStatus();
	return (
		<Link
			to="/node/system"
			preload="intent"
			aria-label={t("Open system details")}
			className={cn(
				"group/card flex flex-col gap-2 rounded-lg px-2.5 py-2 outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-ring",
				alert ? alertTone[alert.level].card : "bg-surface-2 shadow-[inset_0_0_0_1px_var(--border)] hover:bg-surface-3",
				className,
			)}
		>
			<div className="flex h-5 items-center gap-2">
				<StatusDot status={dot} label={t("Machine {status}", { status: tr(dotWord[dot]) })} />
				{node.data ? <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{node.data.name}</span> : <Skeleton className="h-4 w-24" />}
				<span className="ml-auto font-mono text-2xs text-subtle">{wsStatus === "open" ? t("live") : wsStatus === "connecting" ? "…" : t("offline")}</span>
			</div>
			{system.data ? (
				<Meters s={system.data} />
			) : system.isError ? null : (
				<div className="flex flex-col gap-2" aria-busy>
					<Skeleton className="h-2.5" />
					<Skeleton className="h-2.5" />
					<Skeleton className="h-2.5" />
				</div>
			)}
			{alert ? (
				<div className={cn("flex items-center gap-1.5 text-2xs font-medium animate-fade-in", alertTone[alert.level].text)}>
					<AlertDot level={alert.level} />
					<span className="min-w-0 truncate">{renderServerText(alert.message, alert.i18n)}</span>
				</div>
			) : null}
		</Link>
	);
}

/** Rail-mode compact indicator: the machine's health dot, tinted and pulsing while a resource alert is active. */
export function NodeStatusDot() {
	const { node, dot, alert } = useNodeStatus();
	const label = alert
		? renderServerText(alert.message, alert.i18n)
		: node.data
			? t("{name} · {status}", { name: node.data.name, status: tr(dotWord[dot]) })
			: t("Machine");
	return (
		<Tip label={label} side="right">
			<Link to="/node/system" aria-label={label} className="grid size-8 place-items-center rounded-lg outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring">
				{alert ? <AlertDot level={alert.level} /> : <StatusDot status={dot} />}
			</Link>
		</Tip>
	);
}
