import { useEffect, useMemo, useRef, useState } from "react";
import type { UsagePoint } from "@clam/contracts";
import { T, t } from "@/i18n";
import { cn, formatCost, formatDate } from "@/lib/utils";
import { fmtTokens } from "./format";

function useWidth<T extends HTMLElement>() {
	const ref = useRef<T>(null);
	const [width, setWidth] = useState(0);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry?.contentRect.width ?? 0)));
		ro.observe(el);
		setWidth(Math.floor(el.getBoundingClientRect().width));
		return () => ro.disconnect();
	}, []);
	return [ref, width] as const;
}

function niceMax(v: number): number {
	if (v <= 0) return 1;
	const p = 10 ** Math.floor(Math.log10(v));
	const n = v / p;
	return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

/**
 * Daily trend: bars = total tokens (left scale), line = cost in USD (right scale).
 * Zero-dependency SVG; hover/touch scrubs a readout above the plot.
 */
export function TrendChart({ points, height = 220 }: { points: UsagePoint[]; height?: number }) {
	const [ref, width] = useWidth<HTMLDivElement>();
	const [hover, setHover] = useState<number | null>(null);

	const geom = useMemo(() => {
		const padL = 44;
		const padR = 44;
		const padT = 8;
		const padB = 22;
		const w = Math.max(0, width - padL - padR);
		const h = height - padT - padB;
		const maxTok = niceMax(Math.max(0, ...points.map((p) => p.tokens.total)));
		const maxCost = niceMax(Math.max(0, ...points.map((p) => p.cost)));
		const step = points.length > 0 ? w / points.length : w;
		const barW = Math.max(1, Math.min(28, step * 0.62));
		const x = (i: number) => padL + step * i + step / 2;
		const yTok = (v: number) => padT + h - (v / maxTok) * h;
		const yCost = (v: number) => padT + h - (v / maxCost) * h;
		const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${yCost(p.cost).toFixed(1)}`).join(" ");
		return { padL, padR, padT, padB, w, h, maxTok, maxCost, step, barW, x, yTok, yCost, line };
	}, [points, width, height]);

	if (points.length === 0) {
		return <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">{t("No daily history recorded yet.")}</div>;
	}

	const active = hover != null ? points[hover] : null;
	const shown = active ?? points[points.length - 1]!;
	const ticks = [0, 0.5, 1];
	const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(geom.w / 72))));

	const onMove = (clientX: number, rect: DOMRect) => {
		const rel = clientX - rect.left - geom.padL;
		const i = Math.floor(rel / geom.step);
		setHover(i >= 0 && i < points.length ? i : null);
	};

	return (
		<div ref={ref} className="w-full">
			<div className="mb-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
				<span className="font-mono text-muted-foreground">{active ? formatDate(shown.t) : t("{date} (latest)", { date: formatDate(shown.t) })}</span>
				<span className="flex items-center gap-1.5">
					<i className="inline-block size-2 rounded-sm bg-accent" />
					<T text="<m>{tokens}</m> tokens" params={{ tokens: fmtTokens(shown.tokens.total) }} tags={{ m: <span className="font-mono tabular-nums" /> }} />
				</span>
				<span className="flex items-center gap-1.5">
					<i className="inline-block h-0.5 w-3 rounded bg-warning" />
					<span className="font-mono tabular-nums">{formatCost(shown.cost)}</span>
				</span>
				<span className="text-muted-foreground">{t("{count, plural, one {# request} other {# requests}}", { count: shown.requests })}</span>
			</div>
			{width > 0 && (
				<svg
					width={width}
					height={height}
					role="img"
					aria-label={t("Daily token and cost trend")}
					className="touch-pan-y select-none"
					onPointerMove={(e) => onMove(e.clientX, e.currentTarget.getBoundingClientRect())}
					onPointerLeave={() => setHover(null)}
				>
					{ticks.map((tick) => {
						const y = geom.padT + geom.h - tick * geom.h;
						return (
							<g key={tick}>
								<line x1={geom.padL} x2={geom.padL + geom.w} y1={y} y2={y} className="stroke-border" strokeDasharray={tick === 0 ? undefined : "2 4"} />
								<text x={geom.padL - 6} y={y + 3} textAnchor="end" className="fill-muted-foreground font-mono text-[10px]">
									{fmtTokens(geom.maxTok * tick)}
								</text>
								<text x={geom.padL + geom.w + 6} y={y + 3} className="fill-muted-foreground font-mono text-[10px]">
									{formatCost(geom.maxCost * tick)}
								</text>
							</g>
						);
					})}
					{points.map((p, i) => {
						const y = geom.yTok(p.tokens.total);
						return (
							<rect
								key={p.t}
								x={geom.x(i) - geom.barW / 2}
								y={y}
								width={geom.barW}
								height={Math.max(0, geom.padT + geom.h - y)}
								rx={2}
								className={cn("fill-accent transition-opacity", hover != null && hover !== i ? "opacity-35" : "opacity-85")}
							/>
						);
					})}
					<path d={geom.line} fill="none" strokeWidth={1.75} strokeLinejoin="round" className="stroke-warning" />
					{hover != null && <circle cx={geom.x(hover)} cy={geom.yCost(points[hover]!.cost)} r={3.5} className="fill-warning" />}
					{points.map((p, i) =>
						i % labelEvery === 0 ? (
							<text key={p.t} x={geom.x(i)} y={height - 6} textAnchor="middle" className="fill-muted-foreground font-mono text-[10px]">
								{formatDate(p.t, { month: "short", day: "numeric" })}
							</text>
						) : null,
					)}
				</svg>
			)}
		</div>
	);
}

export interface BarItem {
	key: string;
	label: string;
	sublabel?: string;
	value: number;
	display: string;
	detail?: string;
}

/** Horizontal ranked bars; width animates via transform (scaleX). */
export function BarList({ items, empty }: { items: BarItem[]; empty?: string }) {
	const max = Math.max(0, ...items.map((i) => i.value));
	if (items.length === 0) return <div className="py-6 text-center text-sm text-muted-foreground">{empty ?? t("No data.")}</div>;
	return (
		<ul className="space-y-2.5">
			{items.map((it) => (
				<li key={it.key} className="min-w-0">
					<div className="flex items-baseline justify-between gap-3 text-sm">
						<span className="min-w-0 truncate" title={it.sublabel ?? it.label}>
							{it.label}
						</span>
						<span className="shrink-0 font-mono text-xs tabular-nums">{it.display}</span>
					</div>
					<div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3">
						<div
							className="h-full origin-left rounded-full bg-accent transition-transform duration-300 ease-out"
							style={{ transform: `scaleX(${max > 0 ? it.value / max : 0})` }}
						/>
					</div>
					{it.detail && <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{it.detail}</div>}
				</li>
			))}
		</ul>
	);
}
