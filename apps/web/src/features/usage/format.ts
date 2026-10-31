import { useEffect, useState } from "react";

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const full = new Intl.NumberFormat("en");

export function fmtTokens(n: number | null | undefined): string {
	if (n == null || !Number.isFinite(n)) return "—";
	return Math.abs(n) < 1000 ? full.format(n) : compact.format(n);
}

export function fmtInt(n: number | null | undefined): string {
	return n == null || !Number.isFinite(n) ? "—" : full.format(n);
}

export function fmtCost(n: number | null | undefined): string {
	if (n == null || !Number.isFinite(n)) return "—";
	if (n === 0) return "$0.00";
	if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
	if (Math.abs(n) < 100) return `$${n.toFixed(2)}`;
	return `$${full.format(Math.round(n))}`;
}

export function fmtPercent(fraction: number | null | undefined, digits = 0): string {
	if (fraction == null || !Number.isFinite(fraction)) return "—";
	return `${(fraction * 100).toFixed(digits)}%`;
}

export function fmtDuration(ms: number): string {
	if (!Number.isFinite(ms)) return "—";
	const abs = Math.max(0, Math.round(ms / 1000));
	const d = Math.floor(abs / 86400);
	const h = Math.floor((abs % 86400) / 3600);
	const m = Math.floor((abs % 3600) / 60);
	const s = abs % 60;
	if (d > 0) return `${d}d ${h}h`;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${s.toString().padStart(2, "0")}s`;
	return `${s}s`;
}

export function fmtAgo(iso: string | number | null | undefined, now = Date.now()): string {
	if (iso == null) return "never";
	const t = typeof iso === "number" ? iso : Date.parse(iso);
	if (!Number.isFinite(t)) return "—";
	const diff = Math.max(0, now - t);
	if (diff < 5_000) return "just now";
	if (diff < 3_600_000 * 24 * 7) return `${fmtDuration(diff)} ago`;
	return new Date(t).toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" });
}

export function fmtDate(t: number | string | null | undefined): string {
	if (t == null) return "—";
	const d = new Date(t);
	return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" });
}

export function fmtDateTime(t: number | string | null | undefined): string {
	if (t == null) return "—";
	const d = new Date(t);
	return Number.isNaN(d.getTime())
		? "—"
		: d.toLocaleString("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Re-renders every `intervalMs` so relative times and countdowns stay live. */
export function useNow(intervalMs = 1000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(id);
	}, [intervalMs]);
	return now;
}
