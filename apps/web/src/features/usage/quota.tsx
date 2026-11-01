import { AlertTriangle, Gauge } from "lucide-react";
import type { ProviderQuota, QuotaLimit, QuotaReport } from "@clam/contracts";
import { Badge } from "@/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";
import { T, msg, t, tr, type Msg } from "@/i18n";
import { formatDuration, formatNumber, formatPercent } from "@/lib/utils";
import { Progress } from "@/ui/progress";
import { fmtAgo, limitLabel, useNow, windowText } from "./format";

/** Provider-reported limit statuses other than `ok`; anything unlisted is shown as the provider wrote it. */
const LIMIT_STATUS_LABEL: Readonly<Record<string, Msg>> = { warning: msg("Warning"), exhausted: msg("Exhausted"), limited: msg("Limited"), unknown: msg("Unknown") };

/** Fraction used in [0,1], or null when the provider reported no usable numbers. */
export function usedFraction(l: QuotaLimit): number | null {
	if (l.used != null && l.limit != null && l.limit > 0) return Math.min(1, Math.max(0, l.used / l.limit));
	if (l.unit === "percent" && l.used != null) return Math.min(1, Math.max(0, l.used / 100));
	if (l.unit === "percent" && l.remaining != null) return Math.min(1, Math.max(0, 1 - l.remaining / 100));
	return null;
}

function amount(l: QuotaLimit, v: number | null): string {
	if (v == null) return "—";
	return l.unit === "percent" ? formatPercent(v / 100) : `${formatNumber(v)}${l.unit ? ` ${l.unit}` : ""}`;
}

function LimitRow({ limit, now }: { limit: QuotaLimit; now: number }) {
	const frac = usedFraction(limit);
	const remaining = limit.remaining ?? (frac != null && limit.unit === "percent" ? (1 - frac) * 100 : null);
	const reset = limit.resetsAt != null ? limit.resetsAt - now : null;
	const bad = limit.status !== "ok";
	const statusLabel = LIMIT_STATUS_LABEL[limit.status];
	return (
		<div className="space-y-1.5">
			<div className="flex items-baseline justify-between gap-3">
				<div className="min-w-0 text-sm">
					<span className="font-medium">{limitLabel(limit)}</span>
					{limit.windowLabel && <span className="ml-2 text-xs text-muted-foreground">{windowText(limit)}</span>}
				</div>
				{bad && (
					<Badge variant={limit.status === "exhausted" || limit.status === "limited" ? "danger" : "warning"}>{statusLabel ? tr(statusLabel) : limit.status}</Badge>
				)}
			</div>
			{frac != null ? (
				<Progress value={frac * 100} tone={frac >= 0.9 ? "danger" : frac >= 0.7 ? "warning" : "accent"} />
			) : (
				<div className="text-xs text-muted-foreground">{t("Usage amount not reported for this limit.")}</div>
			)}
			<div className="flex flex-wrap justify-between gap-x-4 text-xs text-muted-foreground">
				<span>
					{frac != null && (
						<T text="<m>{percent}</m> used" params={{ percent: formatPercent(frac) }} tags={{ m: <span className="font-mono text-foreground" /> }} />
					)}
					{remaining != null && (
						<>
							{frac != null && " · "}
							<T text="<m>{amount}</m> remaining" params={{ amount: amount(limit, remaining) }} tags={{ m: <span className="font-mono text-foreground" /> }} />
						</>
					)}
					{limit.used != null && limit.limit != null && limit.unit !== "percent" && (
						<> · {amount(limit, limit.used)} / {amount(limit, limit.limit)}</>
					)}
				</span>
				<span>
					{reset == null ? t("Reset time not reported") : reset <= 0 ? t("Resetting…") : t("Resets in {duration}", { duration: formatDuration(reset) })}
				</span>
			</div>
		</div>
	);
}

function ProviderCard({ q, now }: { q: ProviderQuota; now: number }) {
	return (
		<Card>
			<CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
				<div className="min-w-0">
					<CardTitle className="truncate text-sm">{q.provider}</CardTitle>
					{q.account && (
						<div className="break-all font-mono text-xs text-muted-foreground" title={q.account}>
							{q.account}
						</div>
					)}
				</div>
				<span className="shrink-0 text-xs text-muted-foreground">{t("Updated {time}", { time: fmtAgo(q.fetchedAt, now) })}</span>
			</CardHeader>
			<CardContent className="space-y-4">
				{q.availability === "error" && (
					<div className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/10 p-2.5 text-xs text-danger">
						<AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
						<span>{q.error ?? t("The provider usage request failed.")}</span>
					</div>
				)}
				{q.availability === "unavailable" && (
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						<Gauge className="size-4" />
						{t("Unavailable — this provider exposes no usage or quota API.")}
					</div>
				)}
				{q.availability === "available" && q.limits.length === 0 && (
					<div className="text-sm text-muted-foreground">{t("Unavailable — the provider reported no limits.")}</div>
				)}
				{q.limits.map((l) => (
					<LimitRow key={l.id} limit={l} now={now} />
				))}
			</CardContent>
		</Card>
	);
}

export function QuotaCards({ report }: { report: QuotaReport }) {
	const now = useNow(1000);
	if (report.providers.length === 0) {
		return (
			<div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
				{t("Unavailable — no provider quota data. Connect a provider in Settings → OMP Providers, or the connected providers do not expose a usage API.")}
			</div>
		);
	}
	return (
		<div className="grid gap-3 lg:grid-cols-2">
			{report.providers.map((q) => (
				<ProviderCard key={`${q.provider}:${q.account ?? ""}`} q={q} now={now} />
			))}
		</div>
	);
}
