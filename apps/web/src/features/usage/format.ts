import type { QuotaLimit } from "@clam/contracts";
import { useEffect, useState } from "react";
import { t } from "@/i18n";
import { formatCompact, formatDate, formatDateTime as formatDateTimeIntl, formatDuration, formatNumber, formatSpan } from "@/lib/utils";

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
