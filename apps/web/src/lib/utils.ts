import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}

const nf = new Intl.NumberFormat("en-US");
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export const formatNumber = (n: number): string => nf.format(n);
export const formatCompact = (n: number): string => compact.format(n);

export function formatCost(usd: number | null | undefined): string {
	if (usd == null || Number.isNaN(usd)) return "—";
	if (usd === 0) return "$0.00";
	if (usd < 0.01) return `$${usd.toFixed(4)}`;
	if (usd < 100) return `$${usd.toFixed(2)}`;
	return `$${nf.format(Math.round(usd))}`;
}

export function formatBytes(bytes: number | null | undefined): string {
	if (bytes == null) return "—";
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let v = bytes / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
	const h = Math.floor(m / 60);
	if (h < 48) return `${h}h ${m % 60}m`;
	return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "short" });
export function relativeTime(input: string | number | Date | null | undefined, now = Date.now()): string {
	if (input == null) return "—";
	const t = input instanceof Date ? input.getTime() : typeof input === "number" ? input : Date.parse(input);
	if (Number.isNaN(t)) return "—";
	const diff = (t - now) / 1000;
	const abs = Math.abs(diff);
	if (abs < 45) return "just now";
	if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
	if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
	if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), "day");
	return new Date(t).toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" });
}

export const shortId = (id: string, n = 8): string => (id.length > n ? id.slice(0, n) : id);
export const shortFingerprint = (fp: string): string => (fp.length > 12 ? `${fp.slice(0, 6)}…${fp.slice(-4)}` : fp);

export function basename(p: string): string {
	const parts = p.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] ?? p;
}

export function newClientId(): string {
	return globalThis.crypto?.randomUUID?.() ?? `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function clamp(n: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, n));
}
