import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { intlTag } from "@/i18n/core";
import { t } from "@/i18n";

export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}

/** Intl formatters are cached per locale tag; every formatter reads the active locale at call time. */
const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat | Intl.RelativeTimeFormat | Intl.ListFormat>();
function intl<T extends object>(kind: string, make: (tag: string) => T, opts = ""): T {
	const k = `${kind}|${intlTag()}|${opts}`;
	let f = cache.get(k) as T | undefined;
	if (!f) cache.set(k, (f = make(intlTag()) as T) as never);
	return f;
}
const nf = (o: Intl.NumberFormatOptions = {}) => intl("n", (t) => new Intl.NumberFormat(t, o), JSON.stringify(o));
const df = (o: Intl.DateTimeFormatOptions) => intl("d", (t) => new Intl.DateTimeFormat(t, o), JSON.stringify(o));

export const formatNumber = (n: number): string => nf().format(n);
export const formatCompact = (n: number): string => nf({ notation: "compact", maximumFractionDigits: 1 }).format(n);
export const formatPercent = (ratio: number, digits = 0): string => nf({ style: "percent", maximumFractionDigits: digits }).format(ratio);
export const formatList = (items: string[]): string => intl("l", (t) => new Intl.ListFormat(t, { style: "long", type: "conjunction" })).format(items);

const toDate = (input: string | number | Date | null | undefined): Date | null => {
	if (input == null) return null;
	const d = input instanceof Date ? input : new Date(input);
	return Number.isNaN(d.getTime()) ? null : d;
};
const DATE: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };
const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };
/** "Nov 1, 2026" / "1 thg 11, 2026". `—` for missing or invalid input. */
export const formatDate = (input: string | number | Date | null | undefined, opts: Intl.DateTimeFormatOptions = DATE): string => {
	const d = toDate(input);
	return d ? df(opts).format(d) : "—";
};
export const formatTime = (input: string | number | Date | null | undefined, opts: Intl.DateTimeFormatOptions = TIME): string => formatDate(input, opts);
export const formatDateTime = (input: string | number | Date | null | undefined, opts: Intl.DateTimeFormatOptions = { ...DATE, ...TIME }): string => formatDate(input, opts);

export function formatCost(usd: number | null | undefined): string {
	if (usd == null || Number.isNaN(usd)) return "—";
	const money = (digits: number) => nf({ style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(usd);
	if (usd === 0) return money(2);
	if (usd < 0.01) return money(4);
	return money(usd < 100 ? 2 : 0);
}

export function formatBytes(bytes: number | null | undefined): string {
	if (bytes == null) return "—";
	if (bytes < 1024) return `${formatNumber(bytes)} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let v = bytes / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	const d = v >= 10 ? 0 : 1;
	return `${nf({ minimumFractionDigits: d, maximumFractionDigits: d }).format(v)} ${units[i]}`;
}

export type DurationUnit = "millisecond" | "second" | "minute" | "hour" | "day";

/** One number with its narrow unit in the active locale: "5m" / "5 phút", "3d" / "3 ngày". */
export const formatUnit = (value: number, unit: DurationUnit, digits = 0): string => nf({ style: "unit", unit, unitDisplay: "narrow", maximumFractionDigits: digits }).format(value);

/**
 * Compact, locale-aware duration of at most two parts, never a zero trailing part: en "6m", "6m 5s", "1h 5m", "2d 3h";
 * vi "6 phút", "6 phút 5 giây", "1 giờ 5 phút", "2 ngày 3 giờ". Under a minute it is a single value ("6.5s" / "6,5 giây").
 */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms)) return "—";
	if (ms < 1000) return formatUnit(Math.round(ms), "millisecond");
	const s = ms / 1000;
	if (s < 59.5) return formatUnit(s, "second", s < 10 ? 1 : 0);
	const total = Math.round(s);
	const m = Math.floor(total / 60);
	const h = Math.floor(m / 60);
	const parts =
		m < 60
			? [formatUnit(m, "minute"), total % 60 ? formatUnit(total % 60, "second") : null]
			: h < 48
				? [formatUnit(h, "hour"), m % 60 ? formatUnit(m % 60, "minute") : null]
				: [formatUnit(Math.floor(h / 24), "day"), h % 24 ? formatUnit(h % 24, "hour") : null];
	return intl("lu", (tag) => new Intl.ListFormat(tag, { style: "narrow", type: "unit" })).format(parts.filter((p): p is string => p !== null));
}

const SPAN_UNITS: readonly [DurationUnit, number][] = [["day", 86_400_000], ["hour", 3_600_000], ["minute", 60_000], ["second", 1000]];

/** A length of time in words, using the largest unit that divides it exactly: "5 hours" / "5 giờ", "7 days" / "7 ngày". */
export function formatSpan(ms: number): string {
	const [unit, size] = SPAN_UNITS.find(([, n]) => ms >= n && ms % n === 0) ?? (["millisecond", 1] as const);
	return nf({ style: "unit", unit, unitDisplay: "long" }).format(ms / size);
}

export function relativeTime(input: string | number | Date | null | undefined, now = Date.now()): string {
	if (input == null) return "—";
	const at = input instanceof Date ? input.getTime() : typeof input === "number" ? input : Date.parse(input);
	if (Number.isNaN(at)) return "—";
	const diff = (at - now) / 1000;
	const abs = Math.abs(diff);
	if (abs < 45) return t("just now");
	const rtf = intl("r", (tag) => new Intl.RelativeTimeFormat(tag, { numeric: "auto", style: "short" }));
	if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
	if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
	if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), "day");
	return formatDate(at);
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
