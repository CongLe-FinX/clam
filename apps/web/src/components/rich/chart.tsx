/**
 * Dependency-free SVG charts for ```chart fences in agent markdown. Lazy chunk: only loaded when a closed ```chart fence appears.
 *
 * The fence body is JSON. Two shapes are accepted.
 *
 * 1) Row shape (preferred):
 *    ```chart
 *    {"type": "bar", "title": "Revenue by quarter", "x": "quarter", "y": ["2024", "2025"],
 *     "xLabel": "Quarter", "yLabel": "USD (k)", "stacked": false,
 *     "data": [{"quarter": "Q1", "2024": 120, "2025": 150}, {"quarter": "Q2", "2024": 135, "2025": 180}]}
 *    ```
 *    `x` = key holding the category (or the number, for scatter); `y` = key or list of keys holding values. When `x`/`y` are omitted,
 *    `x` is the first key and `y` every other key whose values are numbers.
 *
 * 2) Chart.js-like shape:
 *    ```chart
 *    {"type": "line", "title": "Signups", "labels": ["Mon", "Tue", "Wed"],
 *     "datasets": [{"label": "Web", "data": [12, 18, 9]}, {"label": "App", "data": [7, 11, 15]}]}
 *    ```
 *    Scatter datasets take points: `{"label": "Runs", "data": [{"x": 1, "y": 2}, {"x": 3, "y": 5}]}`.
 *    A single series may also be given as `{"labels": [...], "data": [1, 2, 3]}`.
 *
 * `type`: bar | line | area | pie | donut | scatter (default bar). Optional: `title`, `xLabel`, `yLabel`, `stacked` (bar, area).
 * Pie/donut use the first series; slices beyond 12 are merged into "Other". Non-numeric / missing values leave gaps.
 * At most 2000 points are drawn. Colours come from the `--chart-1…8` CSS variables, so charts follow light/dark.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";

type ChartType = "bar" | "line" | "area" | "pie" | "donut" | "scatter";
interface Pt {
	x: number;
	y: number | null;
}
interface Series {
	name: string;
	/** Category index → value (cartesian), or explicit x (scatter). */
	pts: Pt[];
}
export interface ChartSpec {
	type: ChartType;
	title?: string;
	xLabel?: string;
	yLabel?: string;
	stacked: boolean;
	categories: string[];
	series: Series[];
	truncated: boolean;
}

const TYPES: ChartType[] = ["bar", "line", "area", "pie", "donut", "scatter"];
const MAX_POINTS = 2000;
const rec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => {
	if (typeof v === "number") return Number.isFinite(v) ? v : null;
	if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
	return null;
};
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : typeof v === "number" ? String(v) : undefined);

export function parseChart(source: string): ChartSpec | { error: string } {
	let raw: unknown;
	try {
		raw = JSON.parse(source);
	} catch (e) {
		return { error: `Invalid JSON: ${(e as Error).message}` };
	}
	if (!rec(raw)) return { error: "A chart must be a JSON object." };
	const type = (str(raw.type)?.toLowerCase() ?? "bar") as ChartType;
	if (!TYPES.includes(type)) return { error: `Unknown chart type “${String(raw.type)}”. Use ${TYPES.join(", ")}.` };
	const base = {
		type,
		title: str(raw.title),
		xLabel: str(raw.xLabel),
		yLabel: str(raw.yLabel),
		stacked: raw.stacked === true && (type === "bar" || type === "area"),
		truncated: false,
	};
	let categories: string[] = [];
	let series: Series[] = [];
	const scatter = type === "scatter";
	let budget = MAX_POINTS;

	if (Array.isArray(raw.datasets) || (Array.isArray(raw.labels) && Array.isArray(raw.data))) {
		const sets = Array.isArray(raw.datasets) ? raw.datasets : [{ label: base.title ?? "Value", data: raw.data }];
		categories = Array.isArray(raw.labels) ? raw.labels.map((l) => String(l ?? "")) : [];
		for (const [i, ds] of sets.entries()) {
			if (!rec(ds) || !Array.isArray(ds.data)) return { error: `datasets[${i}] needs a “data” array.` };
			const name = str(ds.label) ?? `Series ${i + 1}`;
			const pts: Pt[] = [];
			for (const [j, d] of ds.data.entries()) {
				if (budget-- <= 0) {
					base.truncated = true;
					break;
				}
				if (rec(d)) pts.push({ x: num(d.x) ?? j, y: num(d.y) });
				else pts.push({ x: j, y: num(d) });
			}
			series.push({ name, pts });
			if (!scatter && categories.length < pts.length) for (let k = categories.length; k < pts.length; k++) categories.push(String(k + 1));
		}
	} else if (Array.isArray(raw.data)) {
		const rows = raw.data.filter(rec);
		if (rows.length === 0) return { error: "No data rows to plot." };
		const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
		const xKey = str(raw.x) ?? keys[0] ?? "x";
		let yKeys = Array.isArray(raw.y) ? raw.y.map(str).filter((k): k is string => !!k) : str(raw.y) ? [str(raw.y) as string] : [];
		if (yKeys.length === 0) yKeys = keys.filter((k) => k !== xKey && rows.some((r) => num(r[k]) !== null));
		if (yKeys.length === 0) return { error: "No numeric columns found. Set “y” to the key holding the values." };
		const slice = rows.slice(0, Math.max(1, Math.floor(MAX_POINTS / yKeys.length)));
		base.truncated = slice.length < rows.length;
		if (scatter) categories = [];
		else categories = slice.map((r, i) => str(r[xKey]) ?? String(i + 1));
		series = yKeys.map((k) => ({ name: k, pts: slice.map((r, i) => ({ x: scatter ? (num(r[xKey]) ?? i) : i, y: num(r[k]) })) }));
	} else {
		return { error: "Provide “data” (array of rows) or “labels” + “datasets”." };
	}
	if (series.length === 0 || series.every((s) => s.pts.length === 0)) return { error: "No data to plot." };
	if (series.every((s) => s.pts.every((p) => p.y === null))) return { error: "None of the values are numbers." };
	return { ...base, categories, series };
}

/* ───────────── layout helpers ───────────── */

const fmt = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 });
const fmtFull = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 });
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function niceTicks(min: number, max: number, count = 5): number[] {
	if (min === max) {
		if (min === 0) return [0, 1];
		const d = Math.abs(min) * 0.1;
		min -= d;
		max += d;
	}
	const raw = (max - min) / count;
	const pow = 10 ** Math.floor(Math.log10(raw));
	const step = ([1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow);
	const out: number[] = [];
	for (let v = Math.floor(min / step) * step; v <= max + step * 0.999; v += step) {
		out.push(Math.round(v / step) * step);
		if (v >= max) break;
	}
	return out;
}

const color = (i: number) => `var(--chart-${(i % 8) + 1})`;

function useWidth<T extends HTMLElement>() {
	const ref = useRef<T>(null);
	const [w, setW] = useState(560);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const ro = new ResizeObserver(([e]) => {
			const next = Math.round(e?.contentRect.width ?? 0);
			if (next > 0) setW(next);
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	return [ref, w] as const;
}

interface Tip {
	x: number;
	y: number;
	title: string;
	rows: { name: string; value: string; color: string }[];
}

const polar = (cx: number, cy: number, r: number, a: number) => [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;

function linePath(pts: { x: number; y: number | null }[], sx: (x: number) => number, sy: (y: number) => number): string {
	let d = "";
	let pen = false;
	for (const p of pts) {
		if (p.y === null) {
			pen = false;
			continue;
		}
		d += `${pen ? "L" : "M"}${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`;
		pen = true;
	}
	return d;
}

export default function Chart({ source }: { source: string }) {
	const spec = useMemo(() => parseChart(source), [source]);
	if ("error" in spec) throw new Error(spec.error);
	return <ChartView spec={spec} />;
}

function ChartView({ spec }: { spec: ChartSpec }) {
	const uid = useId();
	const [wrapRef, width] = useWidth<HTMLDivElement>();
	const [hidden, setHidden] = useState<ReadonlySet<number>>(new Set());
	const [tip, setTip] = useState<Tip | null>(null);
	const [active, setActive] = useState<number | null>(null);
	const pie = spec.type === "pie" || spec.type === "donut";

	const slices = useMemo(() => {
		if (!pie) return [];
		const s = spec.series[0];
		if (!s) return [];
		const items = s.pts.map((p, i) => ({ name: spec.categories[i] ?? String(i + 1), value: p.y !== null && p.y > 0 ? p.y : 0 })).filter((p) => p.value > 0);
		if (items.length <= 12) return items;
		const head = items.slice().sort((a, b) => b.value - a.value);
		const rest = head.slice(11).reduce((n, p) => n + p.value, 0);
		return [...head.slice(0, 11), { name: "Other", value: rest }];
	}, [pie, spec]);

	const toggle = (i: number) =>
		setHidden((h) => {
			const n = new Set(h);
			if (n.has(i)) n.delete(i);
			else if (n.size < (pie ? slices.length : spec.series.length) - 1) n.add(i);
			return n;
		});

	const legendItems = pie ? slices.map((s, i) => ({ name: s.name, i })) : spec.series.map((s, i) => ({ name: s.name, i }));
	const showLegend = pie || spec.series.length > 1;

	const summary = `${spec.title ? `${spec.title}: ` : ""}${spec.type} chart, ${pie ? `${slices.length} slices` : `${spec.series.length} series`}${pie ? "" : `, ${spec.categories.length || spec.series[0]?.pts.length || 0} points`}.`;

	/* ── geometry ── */
	const H = pie ? Math.max(220, Math.min(300, Math.round(width * 0.55))) : Math.max(210, Math.min(320, Math.round(width * 0.56)));
	const labelFor = (n: number) => fmt.format(n);
	let plot: React.ReactNode = null;
	let onKey: ((e: React.KeyboardEvent) => void) | undefined;

	if (pie) {
		const visible = slices.map((s, i) => ({ ...s, i })).filter((s) => !hidden.has(s.i));
		const total = visible.reduce((n, s) => n + s.value, 0) || 1;
		const cx = width / 2;
		const cy = H / 2;
		const r = Math.max(60, Math.min(width / 2 - 8, H / 2 - 8));
		const inner = spec.type === "donut" ? r * 0.6 : 0;
		let a0 = -Math.PI / 2;
		plot = (
			<g>
				{visible.map((s) => {
					const frac = s.value / total;
					const a1 = a0 + frac * Math.PI * 2;
					const end = frac >= 0.9999 ? a0 + Math.PI * 2 - 0.0001 : a1;
					const [x0, y0] = polar(cx, cy, r, a0);
					const [x1, y1] = polar(cx, cy, r, end);
					const large = end - a0 > Math.PI ? 1 : 0;
					let d: string;
					if (inner) {
						const [x2, y2] = polar(cx, cy, inner, end);
						const [x3, y3] = polar(cx, cy, inner, a0);
						d = `M${x0} ${y0}A${r} ${r} 0 ${large} 1 ${x1} ${y1}L${x2} ${y2}A${inner} ${inner} 0 ${large} 0 ${x3} ${y3}Z`;
					} else d = `M${cx} ${cy}L${x0} ${y0}A${r} ${r} 0 ${large} 1 ${x1} ${y1}Z`;
					a0 = a1;
					const mid = (a0 + (a0 - frac * Math.PI * 2)) / 2;
					const [tx, ty] = polar(cx, cy, r * 0.7, mid);
					const show = (a: boolean) => () =>
						setTip(a ? { x: tx, y: ty, title: s.name, rows: [{ name: `${(frac * 100).toFixed(1)}%`, value: fmtFull.format(s.value), color: color(s.i) }] } : null);
					return (
						<path
							key={s.i}
							d={d}
							fill={color(s.i)}
							stroke="var(--surface-1)"
							strokeWidth={1.5}
							opacity={tip && tip.title !== s.name ? 0.55 : 1}
							onPointerEnter={show(true)}
							onPointerLeave={show(false)}
							onPointerDown={show(true)}
						/>
					);
				})}
				{inner ? (
					<g textAnchor="middle" pointerEvents="none">
						<text x={cx} y={cy - 2} fontSize={20} fontWeight={600} fill="var(--foreground)">{labelFor(total)}</text>
						<text x={cx} y={cy + 16} fontSize={11} fill="var(--subtle)">total</text>
					</g>
				) : null}
			</g>
		);
	} else {
		const vis = spec.series.map((s, i) => ({ s, i })).filter(({ i }) => !hidden.has(i));
		const scatter = spec.type === "scatter";
		const n = Math.max(spec.categories.length, ...spec.series.map((s) => s.pts.length));
		// y domain
		let lo = Infinity;
		let hi = -Infinity;
		const stackedTotals: number[] = [];
		for (const { s } of vis)
			for (const [k, p] of s.pts.entries()) {
				if (p.y === null) continue;
				if (spec.stacked) {
					stackedTotals[k] = (stackedTotals[k] ?? 0) + Math.max(0, p.y);
				} else {
					lo = Math.min(lo, p.y);
					hi = Math.max(hi, p.y);
				}
			}
		if (spec.stacked) {
			lo = 0;
			hi = Math.max(0, ...stackedTotals.filter(Number.isFinite));
		}
		if (!Number.isFinite(lo)) {
			lo = 0;
			hi = 1;
		}
		if (spec.type === "bar" || spec.type === "area") lo = Math.min(lo, 0);
		const ticks = niceTicks(lo, hi);
		const y0 = ticks[0] ?? 0;
		const y1 = ticks[ticks.length - 1] ?? 1;
		const tickW = Math.max(...ticks.map((t) => labelFor(t).length)) * 6.4 + 10;
		const left = Math.round(tickW + (spec.yLabel ? 16 : 0));
		const right = 12;
		const top = 10;
		const hasXLabel = Boolean(spec.xLabel);
		const bottom = 24 + (hasXLabel ? 16 : 0);
		const iw = Math.max(40, width - left - right);
		const ih = Math.max(60, H - top - bottom);
		const sy = (v: number) => top + ih - ((v - y0) / (y1 - y0 || 1)) * ih;

		let xs: number[] = [];
		let sx: (x: number) => number;
		let band = 0;
		let xTicks: { x: number; label: string }[] = [];
		if (scatter) {
			let xlo = Infinity;
			let xhi = -Infinity;
			for (const { s } of vis) for (const p of s.pts) if (p.y !== null) {
				xlo = Math.min(xlo, p.x);
				xhi = Math.max(xhi, p.x);
			}
			if (!Number.isFinite(xlo)) {
				xlo = 0;
				xhi = 1;
			}
			const tx = niceTicks(xlo, xhi);
			const a = tx[0] ?? 0;
			const b = tx[tx.length - 1] ?? 1;
			sx = (v) => left + ((v - a) / (b - a || 1)) * iw;
			xTicks = tx.map((t) => ({ x: sx(t), label: labelFor(t) }));
		} else {
			band = iw / Math.max(1, n);
			const bars = spec.type === "bar";
			sx = (k) => left + (bars ? band * (k + 0.5) : n <= 1 ? iw / 2 : (iw * k) / (n - 1));
			xs = Array.from({ length: n }, (_, k) => sx(k));
			const slot = bars ? band : iw / Math.max(1, n - 1);
			const maxChars = Math.min(14, Math.max(...spec.categories.map((c) => c.length), 1));
			const step = Math.max(1, Math.ceil((maxChars * 6.2 + 10) / Math.max(slot, 1)));
			xTicks = spec.categories.flatMap((c, k) => (k % step === 0 ? [{ x: sx(k), label: clip(c, 14) }] : []));
		}

		const stackBase: number[] = [];
		const bars: React.ReactNode[] = [];
		const lines: React.ReactNode[] = [];
		const nVis = vis.length;
		for (const [vi, { s, i }] of vis.entries()) {
			if (spec.type === "bar") {
				const groupW = Math.min(band * 0.76, spec.stacked ? 56 : 44 * nVis);
				const bw = spec.stacked ? groupW : groupW / nVis;
				for (const [k, p] of s.pts.entries()) {
					if (p.y === null) continue;
					const cxk = sx(k);
					let ya: number;
					let yb: number;
					if (spec.stacked) {
						const base = stackBase[k] ?? 0;
						const v = Math.max(0, p.y);
						stackBase[k] = base + v;
						ya = sy(base + v);
						yb = sy(base);
					} else {
						ya = sy(Math.max(p.y, 0));
						yb = sy(Math.min(p.y, 0));
					}
					const bx = spec.stacked ? cxk - bw / 2 : cxk - groupW / 2 + vi * bw;
					bars.push(<rect key={`${i}-${k}`} x={bx} y={ya} width={Math.max(1, bw - (bw > 6 ? 1.5 : 0))} height={Math.max(1, yb - ya)} rx={bw > 8 ? 2 : 0} fill={color(i)} opacity={active !== null && active !== k ? 0.45 : 1} />);
				}
			} else if (spec.type === "line" || spec.type === "area") {
				let pts = s.pts;
				if (spec.stacked && spec.type === "area") {
					pts = s.pts.map((p, k) => {
						if (p.y === null) return p;
						const v = (stackBase[k] ?? 0) + Math.max(0, p.y);
						return { x: p.x, y: v };
					});
				}
				const d = linePath(pts, sx, sy);
				if (spec.type === "area") {
					const prev = spec.stacked ? s.pts.map((_, k) => stackBase[k] ?? 0) : s.pts.map(() => 0);
					// area polygon between this line and previous baseline (continuous runs only)
					let run: number[] = [];
					const flush = () => {
						if (run.length === 0) return;
						const top = run.map((k) => `${sx(k).toFixed(1)} ${sy(pts[k]?.y ?? 0).toFixed(1)}`);
						const bot = run.slice().reverse().map((k) => `${sx(k).toFixed(1)} ${sy(prev[k] ?? 0).toFixed(1)}`);
						lines.push(<path key={`a${i}-${run[0]}`} d={`M${top.join("L")}L${bot.join("L")}Z`} fill={color(i)} opacity={0.22} />);
						run = [];
					};
					for (const [k, p] of pts.entries()) {
						if (p.y === null) flush();
						else run.push(k);
					}
					flush();
					if (spec.stacked) for (const [k, p] of pts.entries()) if (p.y !== null) stackBase[k] = p.y;
				}
				lines.push(<path key={`l${i}`} d={d} fill="none" stroke={color(i)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />);
				if (n <= 40)
					for (const [k, p] of pts.entries()) {
						if (p.y === null) continue;
						lines.push(<circle key={`p${i}-${k}`} cx={sx(k)} cy={sy(p.y)} r={active === k ? 4.5 : 2.8} fill="var(--surface-1)" stroke={color(i)} strokeWidth={2} />);
					}
			} else {
				for (const [k, p] of s.pts.entries()) {
					if (p.y === null) continue;
					lines.push(<circle key={`${i}-${k}`} cx={sx(p.x)} cy={sy(p.y)} r={4} fill={color(i)} fillOpacity={0.7} stroke={color(i)} />);
				}
			}
		}

		const onMove = (e: React.PointerEvent<SVGRectElement>) => {
			const box = e.currentTarget.getBoundingClientRect();
			const px = e.clientX - box.left + left;
			const py = e.clientY - box.top + top;
			if (scatter) {
				let best: { d: number; si: number; k: number; x: number; y: number } | null = null;
				for (const { s, i } of vis) for (const [k, p] of s.pts.entries()) {
					if (p.y === null) continue;
					const d = Math.hypot(sx(p.x) - px, sy(p.y) - py);
					if (!best || d < best.d) best = { d, si: i, k, x: sx(p.x), y: sy(p.y) };
				}
				if (best && best.d < 32) {
					const s = spec.series[best.si];
					const p = s?.pts[best.k];
					setTip({ x: best.x, y: best.y, title: s?.name ?? "", rows: [{ name: `x ${fmtFull.format(p?.x ?? 0)}`, value: fmtFull.format(p?.y ?? 0), color: color(best.si) }] });
				} else setTip(null);
				return;
			}
			const k = Math.max(0, Math.min(n - 1, Math.round(spec.type === "bar" ? (px - left) / band - 0.5 : n <= 1 ? 0 : ((px - left) / iw) * (n - 1))));
			setActive(k);
			setTip(tipAt(k));
		};
		const tipAt = (k: number): Tip => ({
			x: sx(k),
			y: top,
			title: spec.categories[k] ?? String(k + 1),
			rows: vis.map(({ s, i }) => ({ name: s.name, value: s.pts[k]?.y == null ? "–" : fmtFull.format(s.pts[k]?.y as number), color: color(i) })),
		});
		onKey = (e: React.KeyboardEvent) => {
			if (scatter || (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Escape")) return;
			e.preventDefault();
			if (e.key === "Escape") {
				setActive(null);
				setTip(null);
				return;
			}
			const k = Math.max(0, Math.min(n - 1, (active ?? (e.key === "ArrowRight" ? -1 : n)) + (e.key === "ArrowRight" ? 1 : -1)));
			setActive(k);
			setTip(tipAt(k));
		};
		plot = (
			<g>
				{ticks.map((t) => (
					<g key={t}>
						<line x1={left} x2={left + iw} y1={sy(t)} y2={sy(t)} stroke="var(--border)" strokeDasharray={t === 0 ? undefined : "3 4"} />
						<text x={left - 6} y={sy(t) + 3.5} textAnchor="end" fontSize={11} fill="var(--subtle)">{labelFor(t)}</text>
					</g>
				))}
				{y0 < 0 && y1 > 0 ? <line x1={left} x2={left + iw} y1={sy(0)} y2={sy(0)} stroke="var(--border-strong)" /> : null}
				{xTicks.map((t, k) => (
					<text key={k} x={t.x} y={top + ih + 15} textAnchor="middle" fontSize={11} fill="var(--subtle)">{t.label}</text>
				))}
				{active !== null && !scatter && spec.type !== "bar" && xs[active] !== undefined ? <line x1={xs[active]} x2={xs[active]} y1={top} y2={top + ih} stroke="var(--border-strong)" /> : null}
				{bars}
				{lines}
				{hasXLabel ? <text x={left + iw / 2} y={H - 4} textAnchor="middle" fontSize={11} fill="var(--muted-foreground)">{spec.xLabel}</text> : null}
				{spec.yLabel ? <text transform={`translate(11 ${top + ih / 2}) rotate(-90)`} textAnchor="middle" fontSize={11} fill="var(--muted-foreground)">{spec.yLabel}</text> : null}
				<rect
					x={left}
					y={top}
					width={iw}
					height={ih}
					fill="transparent"
					onPointerMove={onMove}
					onPointerDown={onMove}
					onPointerLeave={() => {
						setTip(null);
						setActive(null);
					}}
				/>
			</g>
		);
	}

	const tipLeft = tip ? Math.max(8, Math.min(width - 168, tip.x + 12)) : 0;
	return (
		<div ref={wrapRef} className="relative w-full">
			{spec.title ? <p className="mb-1 px-1 text-[13px] font-semibold tracking-tight">{spec.title}</p> : null}
			<div
				className="relative rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
				tabIndex={0}
				onKeyDown={onKey}
				onBlur={() => {
					setTip(null);
					setActive(null);
				}}
			>
				<svg
					viewBox={`0 0 ${width} ${H}`}
					width="100%"
					height={H}
					role="img"
					aria-labelledby={`${uid}-t`}
					className="block max-w-full touch-pan-y select-none"
				>
					<title id={`${uid}-t`}>{summary}</title>
					{plot}
				</svg>
				{tip ? (
					<div
						role="status"
						className="pointer-events-none absolute z-10 min-w-28 max-w-40 rounded-lg bg-overlay px-2.5 py-1.5 text-xs shadow-pop shadow-[inset_0_0_0_1px_var(--border-strong)]"
						style={{ left: tipLeft, top: Math.max(0, Math.min(H - 60, tip.y)) }}
					>
						<p className="mb-0.5 truncate font-semibold">{tip.title}</p>
						{tip.rows.map((r, i) => (
							<p key={i} className="flex items-center gap-1.5">
								<span className="size-2 shrink-0 rounded-sm" style={{ background: r.color }} />
								<span className="min-w-0 flex-1 truncate text-muted-foreground">{r.name}</span>
								<span className="tabular font-medium">{r.value}</span>
							</p>
						))}
					</div>
				) : null}
			</div>
			{showLegend ? (
				<ul className="mt-1.5 flex flex-wrap gap-x-1 gap-y-0.5 px-1" aria-label="Legend">
					{legendItems.map(({ name, i }) => (
						<li key={i}>
							<button
								type="button"
								aria-pressed={!hidden.has(i)}
								onClick={() => toggle(i)}
								className={cn("inline-flex max-w-44 items-center gap-1.5 rounded-md px-1.5 py-1 text-xs outline-none transition-opacity hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-ring coarse:min-h-11", hidden.has(i) && "opacity-40")}
							>
								<span className="size-2.5 shrink-0 rounded-sm" style={{ background: color(i) }} />
								<span className="truncate">{name}</span>
							</button>
						</li>
					))}
				</ul>
			) : null}
			{spec.truncated ? <p className="px-1 pt-1 text-2xs text-subtle">Showing the first {MAX_POINTS} points.</p> : null}
			<table className="sr-only">
				<caption>{summary}</caption>
				<thead>
					<tr>
						<th scope="col">{spec.xLabel ?? "Label"}</th>
						{(pie ? [{ name: "Value" }] : spec.series).map((s, i) => (
							<th key={i} scope="col">{s.name}</th>
						))}
					</tr>
				</thead>
				<tbody>
					{(pie ? slices.map((s) => [s.name, String(s.value)]) : tableRows(spec)).slice(0, 200).map((r, k) => (
						<tr key={k}>
							{r.map((c, j) => (j === 0 ? <th key={j} scope="row">{c}</th> : <td key={j}>{c}</td>))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function tableRows(spec: ChartSpec): string[][] {
	const n = Math.max(...spec.series.map((s) => s.pts.length));
	return Array.from({ length: n }, (_, k) => [
		spec.type === "scatter" ? String(spec.series[0]?.pts[k]?.x ?? k) : (spec.categories[k] ?? String(k + 1)),
		...spec.series.map((s) => (s.pts[k]?.y == null ? "" : String(s.pts[k]?.y))),
	]);
}
