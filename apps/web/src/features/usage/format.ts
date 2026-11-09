import type { QuotaLimit } from "@clam/contracts";
import { useEffect, useState } from "react";
import { t } from "@/i18n";
import { formatCompact, formatDate, formatDateTime as formatDateTimeIntl, formatDuration, formatNumber, formatSpan, formatUnit } from "@/lib/utils";

/** Token counts: exact below 1000, compact ("1.2K" / "1,2 N") above. */
export function fmtTokens(n: number | null | undefined): string {
	if (n == null || !Number.isFinite(n)) return "—";
	return Math.abs(n) < 1000 ? formatNumber(n) : formatCompact(n);
}

/** The quota window in words in the active language ("5 hours" / "5 giờ"); the provider's own text when it did not report the window length. */
export function windowText(l: Pick<QuotaLimit, "windowLabel" | "windowMs">): string | null {
	return l.windowLabel !== null && l.windowMs ? formatSpan(l.windowMs) : l.windowLabel;
}

/** Limit label with the provider's English window text ("Claude 7 Day (Fable)") replaced by `windowText`. */
export function limitLabel(l: QuotaLimit): string {
	const w = windowText(l);
	return l.windowLabel && w && w !== l.windowLabel ? l.label.replace(l.windowLabel, w) : l.label;
}

/** Fraction used in [0,1], or null when the provider reported no usable numbers. */
export function usedFraction(l: QuotaLimit): number | null {
	if (l.used != null && l.limit != null && l.limit > 0) return Math.min(1, Math.max(0, l.used / l.limit));
	if (l.unit === "percent" && l.used != null) return Math.min(1, Math.max(0, l.used / 100));
	if (l.unit === "percent" && l.remaining != null) return Math.min(1, Math.max(0, 1 - l.remaining / 100));
	return null;
}

/**
 * A limit as a short tag in the active language: its window ("5h" / "5 giờ", "7d" / "7 ngày") plus the model it is for when the
 * provider names one in the label ("Claude 7 Day (Fable)" → "7d Fable"). Falls back to the provider's own text.
 */
export function limitTag(l: QuotaLimit): string {
	const ms = l.windowMs;
	const window = !ms
		? (l.windowLabel ?? l.label)
		: ms % 86_400_000 === 0
			? formatUnit(ms / 86_400_000, "day")
			: ms >= 3_600_000
				? formatUnit(ms / 3_600_000, "hour", 1)
				: formatUnit(ms / 60_000, "minute");
	const variant = /\(([^)]+)\)\s*$/.exec(l.label)?.[1];
	return variant ? `${window} ${variant}` : window;
}

/** "5m 3s ago" / "just now" / "never"; falls back to an absolute date after a week. */
export function fmtAgo(iso: string | number | null | undefined, now = Date.now()): string {
	if (iso == null) return t("never");
	const at = typeof iso === "number" ? iso : Date.parse(iso);
	if (!Number.isFinite(at)) return "—";
	const diff = Math.max(0, now - at);
	if (diff < 5_000) return t("just now");
	if (diff < 3_600_000 * 24 * 7) return t("{duration} ago", { duration: formatDuration(diff) });
	return formatDate(at);
}

/** Date + time without the year ("Nov 1, 02:30 PM"). */
export function fmtDateTime(at: number | string | null | undefined): string {
	return formatDateTimeIntl(at, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
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
