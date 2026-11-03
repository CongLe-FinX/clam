import type { SystemAlert, SystemStatus } from "@clam/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { type CSSProperties, useId } from "react";
import { renderServerText, t, msg, tr } from "@/i18n";
import { useHealth, useNode, useSystemStatus } from "@/lib/queries";
import { cn, formatBytes } from "@/lib/utils";
import { useWsStatus } from "@/lib/ws";
import { useFillValue } from "@/ui/fill-bar";
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

/** Each resource keeps its own colour (violet CPU, cyan RAM, green disk) until it raises an alert; then it turns warning/danger. */
const HUE = { cpu: 285, memory: 215, disk: 160 } as const;
const RING_TINT = "text-[oklch(0.58_0.17_var(--hue))] dark:text-[oklch(0.74_0.14_var(--hue))]";
const R = 17;
const C = 2 * Math.PI * R;

/**
 * A small ring gauge: the arc sweeps up from empty on mount and glides between polls (stroke-dashoffset, CSS transition; reduced motion
 * turns it off globally), drawn with a soft gradient of the resource's colour, the percentage in the middle, the label and a fact below.
 */
function Gauge({ kind, label, sub, percent, level }: { kind: keyof typeof HUE; label: string; sub: string; percent: number; level: SystemAlert["level"] | undefined }) {
	const gradient = useId();
	const shown = useFillValue(percent);
	const tone = level === "critical" ? "text-danger" : level === "warning" ? "text-warning" : RING_TINT;
	return (
		<div className="flex min-w-0 flex-col items-center gap-1" style={{ "--hue": HUE[kind] } as CSSProperties}>
			<div className={cn("relative grid size-11 place-items-center", tone, level && "drop-shadow-[0_0_6px_currentColor]")}>
				<svg viewBox="0 0 40 40" className="absolute inset-0 size-full -rotate-90" aria-hidden>
					<defs>
						<linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
							<stop offset="0%" stopColor="currentColor" stopOpacity="0.55" />
							<stop offset="100%" stopColor="currentColor" />
						</linearGradient>
					</defs>
					<circle cx="20" cy="20" r={R} fill="none" strokeWidth="3.5" className="stroke-surface-3" />
					<circle
						cx="20"
						cy="20"
						r={R}
						fill="none"
						strokeWidth="3.5"
						strokeLinecap="round"
						stroke={`url(#${gradient})`}
						strokeDasharray={C}
						strokeDashoffset={C * (1 - shown / 100)}
						className="transition-[stroke-dashoffset] duration-1000 ease-[var(--ease-out-quint)]"
					/>
				</svg>
				<span className="tabular relative text-[11px] font-semibold leading-none tracking-tight text-foreground">
					{Math.round(percent)}
					<span className="text-[8px] font-medium text-muted-foreground">%</span>
				</span>
			</div>
			<span className={cn("text-[10px] font-semibold uppercase leading-none tracking-wider", level ? tone : "text-muted-foreground")}>{label}</span>
			<span className="max-w-full truncate font-mono text-[10px] leading-none text-subtle">{sub}</span>
		</div>
	);
}

function Gauges({ s }: { s: SystemStatus }) {
	const level = (kind: SystemAlert["kind"]) => s.alerts.find((a) => a.kind === kind)?.level;
	const disk = s.disks[0];
	return (
		<div className="grid grid-cols-3 gap-1">
			<Gauge kind="cpu" label={t("CPU")} sub={t("{cores} cores", { cores: s.cpu.cores })} percent={s.cpu.percent} level={level("cpu")} />
			<Gauge kind="memory" label={t("RAM")} sub={`${gb(s.memory.used)}/${Math.round(s.memory.total / GB)} GB`} percent={s.memory.percent} level={level("memory")} />
			{disk ? <Gauge kind="disk" label={t("Disk")} sub={t("{free} free", { free: formatBytes(disk.free) })} percent={disk.percent} level={level("disk")} /> : null}
		</div>
	);
}

/** Node identity + live host load at the top of the sidebar (full mode). The whole card opens the System page. */
export function NodeStatusCard({ className }: { className?: string }) {
	const { node, system, wsStatus, dot, alert } = useNodeStatus();
	const live = wsStatus === "open";
	return (
		<Link
			to="/node/system"
			preload="intent"
			aria-label={t("Open system details")}
			className={cn(
				"group/card relative flex flex-col gap-2.5 overflow-hidden rounded-xl px-2.5 pb-2.5 pt-2 outline-none transition-[background-color,box-shadow] duration-200 focus-visible:ring-2 focus-visible:ring-ring",
				alert
					? alertTone[alert.level].card
					: "bg-gradient-to-b from-surface-2 to-surface-1 shadow-[inset_0_0_0_1px_var(--border)] hover:shadow-[inset_0_0_0_1px_var(--border-strong),0_6px_16px_-10px_rgb(0_0_0/0.25)]",
				className,
			)}
		>
			<div className="flex h-5 items-center gap-2">
				<StatusDot status={dot} label={t("Machine {status}", { status: tr(dotWord[dot]) })} />
				{node.data ? <span className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-tight">{node.data.name}</span> : <Skeleton className="h-4 w-24" />}
				<span
					className={cn(
						"ml-auto inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-medium leading-4 transition-opacity group-hover/card:opacity-0",
						live ? "bg-success/12 text-success" : "bg-surface-3 text-subtle",
					)}
				>
					{live ? <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-success" /> : null}
					{live ? t("live") : wsStatus === "connecting" ? "…" : t("offline")}
				</span>
				<ArrowUpRight aria-hidden className="absolute right-2.5 top-2.5 size-3.5 translate-x-1 text-muted-foreground opacity-0 transition-[opacity,transform] duration-200 group-hover/card:translate-x-0 group-hover/card:opacity-100" />
			</div>
			{system.data ? (
				<Gauges s={system.data} />
			) : system.isError ? null : (
				<div className="grid grid-cols-3 gap-1" aria-busy>
					{[0, 1, 2].map((i) => (
						<div key={i} className="flex flex-col items-center gap-1.5">
							<Skeleton className="size-11 rounded-full" />
							<Skeleton className="h-2 w-8" />
						</div>
					))}
				</div>
			)}
			{alert ? (
				<div className={cn("flex items-center gap-1.5 rounded-md bg-background/50 px-2 py-1 text-2xs font-medium animate-fade-in", alertTone[alert.level].text)}>
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
