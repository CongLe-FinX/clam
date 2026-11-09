import { routes, type QuotaLimit, type QuotaReport } from "@clam/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowUpRight, Gauge, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { t } from "@/i18n";
import { api, errorText } from "@/lib/api";
import { qk } from "@/lib/queries";
import { cn, formatDuration, formatPercent, relativeTime } from "@/lib/utils";
import { FillBar, type FillTone } from "@/ui/fill-bar";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Sheet, SheetContent, SheetTitle } from "@/ui/sheet";
import { Tip } from "@/ui/tooltip";
import { limitLabel, limitTag, useNow, usedFraction } from "./format";
import { useQuotaReport } from "./hooks";

/** One quota window (a provider's 5 h, 7 d, 7 d for one model…) across every account that reports it. */
interface Pool {
	key: string;
	label: string;
	tag: string;
	windowMs: number | null;
	/** A plain window, not one for a single model ("Claude 7 Day (Fable)"). */
	general: boolean;
	/** Share of the accounts' combined capacity already used, 0..1. */
	used: number;
	accounts: number;
	/** Accounts at 90 % or more, or that the provider marks exhausted/limited. */
	strained: number;
	/** The soonest reset among the accounts (epoch ms), when one is reported. */
	nextReset: number | null;
}

const toneOf = (fraction: number): FillTone => (fraction >= 0.9 ? "danger" : fraction >= 0.7 ? "warning" : "accent");
const TEXT: Record<FillTone, string> = { accent: "text-foreground", warning: "text-warning", danger: "text-danger" };
const RING: Record<FillTone, string> = { accent: "stroke-accent", warning: "stroke-warning", danger: "stroke-danger" };

/**
 * Pools the limits of every account by provider and limit id. Capacity adds up: percentages are averaged (every account's window is
 * 100 %), absolute amounts are summed, so "57 % used" means 57 % of what all accounts together can spend in that window.
 */
function quotaPools(report: QuotaReport, now: number): Pool[] {
	const groups = new Map<string, QuotaLimit[]>();
	for (const p of report.providers) {
		if (p.availability !== "available") continue;
		for (const l of p.limits) {
			if (usedFraction(l) === null) continue;
			const key = `${p.provider}|${l.id}`;
			groups.set(key, [...(groups.get(key) ?? []), l]);
		}
	}
	return [...groups.entries()]
		.map(([key, limits]): Pool => {
			const first = limits[0] as QuotaLimit;
			const fractions = limits.map((l) => usedFraction(l) as number);
			const absolute = limits.every((l) => l.unit !== "percent" && l.used != null && l.limit != null && l.limit > 0);
			const used = absolute
				? limits.reduce((s, l) => s + (l.used as number), 0) / limits.reduce((s, l) => s + (l.limit as number), 0)
				: fractions.reduce((s, f) => s + f, 0) / fractions.length;
			const resets = limits.flatMap((l) => (l.resetsAt != null && l.resetsAt > now ? [l.resetsAt] : []));
			return {
				key,
				label: limitLabel(first),
				tag: limitTag(first),
				windowMs: first.windowMs,
				general: !/\([^)]+\)\s*$/.test(first.label),
				used: Math.min(1, Math.max(0, used)),
				accounts: limits.length,
				strained: limits.filter((l, i) => (fractions[i] as number) >= 0.9 || l.status === "exhausted" || l.status === "limited").length,
				nextReset: resets.length > 0 ? Math.min(...resets) : null,
			};
		})
		.sort((a, b) => (a.windowMs ?? Number.MAX_SAFE_INTEGER) - (b.windowMs ?? Number.MAX_SAFE_INTEGER) || Number(b.general) - Number(a.general) || a.label.localeCompare(b.label));
}

/** What the meter shows at a glance: per window length, the busiest plain pool (5 h, then 7 d); model-only pools only when there is nothing else. */
function headline(pools: Pool[]): Pool[] {
	const general = pools.filter((p) => p.general);
	const byWindow = new Map<string, Pool>();
	for (const p of general.length > 0 ? general : pools) {
		const key = String(p.windowMs);
		const seen = byWindow.get(key);
		if (!seen || p.used > seen.used) byWindow.set(key, p);
	}
	return [...byWindow.values()].slice(0, 2);
}

/** The full picture: every pool combined, then every account with its own limits. */
function QuotaDetails({ report, pools, onRefresh, refreshing }: { report: QuotaReport; pools: Pool[]; onRefresh: () => void; refreshing: boolean }) {
	const now = useNow(15_000);
	const reporting = report.providers.filter((p) => p.availability === "available" && p.limits.length > 0).length;
	const providers = new Set(report.providers.map((p) => p.provider)).size;
	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center gap-2.5">
				<span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
					<Gauge className="size-4" />
				</span>
				<div className="min-w-0 flex-1">
					<div className="text-[13px] font-semibold">{t("LLM quota")}</div>
					<div className="truncate text-2xs text-subtle">
						{t("{count, plural, one {# account} other {# accounts}} combined · updated {time}", { count: reporting, time: relativeTime(report.fetchedAt, now) })}
					</div>
				</div>
				<Tip label={t("Check quota again")}>
					<button
						type="button"
						aria-label={t("Check quota again")}
						onClick={onRefresh}
						disabled={refreshing}
						className="grid size-7 shrink-0 place-items-center rounded-md text-subtle outline-none transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 coarse:size-10"
					>
						<RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} aria-hidden />
					</button>
				</Tip>
			</div>

			<ul className="flex flex-col gap-3">
				{pools.map((p) => (
					<li key={p.key} className="flex flex-col gap-1">
						<div className="flex items-baseline justify-between gap-3 text-xs">
							<span className="min-w-0 truncate font-medium">{p.label}</span>
							<span className={cn("tabular shrink-0 font-semibold", TEXT[toneOf(p.used)])}>{t("{percent} used", { percent: formatPercent(p.used) })}</span>
						</div>
						<FillBar value={p.used * 100} tone={toneOf(p.used)} className="h-1.5" />
						<div className="flex justify-between gap-3 text-2xs text-subtle">
							<span className={cn(p.strained > 0 && "text-warning")}>
								{p.strained > 0 ? t("{count} of {total} accounts near the limit", { count: p.strained, total: p.accounts }) : t("{count, plural, one {# account} other {# accounts}}", { count: p.accounts })}
							</span>
							{p.nextReset !== null ? <span className="tabular shrink-0">{t("Next reset in {duration}", { duration: formatDuration(p.nextReset - now) })}</span> : null}
						</div>
					</li>
				))}
			</ul>

			<div className="flex flex-col gap-1.5 border-t pt-3">
				<div className="text-2xs font-semibold uppercase tracking-wider text-subtle">{t("Accounts")}</div>
				<ul className="scrollbar-thin -mx-1 flex max-h-[min(40dvh,20rem)] flex-col gap-1 overflow-y-auto px-1">
					{report.providers.map((p, i) => {
						const limits = p.availability === "available" ? p.limits : [];
						const worst = Math.max(0, ...limits.map((l) => usedFraction(l) ?? 0));
						return (
							// biome-ignore lint/suspicious/noArrayIndexKey: one provider can report the same account label twice
							<li key={`${p.provider}:${p.account ?? ""}:${i}`} className={cn("rounded-lg bg-surface-2/70 px-2.5 py-2", limits.length === 0 && "opacity-70")}>
								<div className="flex items-center gap-1.5">
									<span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={p.account ?? p.provider}>
										{p.account ?? p.provider}
									</span>
									{providers > 1 ? <span className="shrink-0 text-2xs text-subtle">{p.provider}</span> : null}
									{worst >= 0.9 ? <AlertTriangle aria-label={t("Near the limit")} className="size-3 shrink-0 text-danger" /> : null}
								</div>
								{limits.length > 0 ? (
									<div className="mt-1.5 grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-x-3 gap-y-1.5">
										{limits.map((l) => {
											const f = usedFraction(l);
											return (
												<div key={l.id} className="min-w-0" title={l.resetsAt != null && l.resetsAt > now ? t("{limit} · resets in {duration}", { limit: limitLabel(l), duration: formatDuration(l.resetsAt - now) }) : limitLabel(l)}>
													<div className="flex items-baseline justify-between gap-1 text-[10px] leading-3">
														<span className="truncate text-subtle">{limitTag(l)}</span>
														<span className={cn("tabular font-semibold", f !== null ? TEXT[toneOf(f)] : "text-subtle")}>{f !== null ? formatPercent(f) : "—"}</span>
													</div>
													<FillBar value={(f ?? 0) * 100} tone={toneOf(f ?? 0)} className="mt-1" />
												</div>
											);
										})}
									</div>
								) : (
									<div className="mt-0.5 text-2xs text-subtle">{p.availability === "error" ? (p.error ?? t("The provider usage request failed.")) : t("No quota reported for this account")}</div>
								)}
							</li>
						);
					})}
				</ul>
			</div>

			<Link to="/settings/usage" className="inline-flex w-fit items-center gap-1 rounded-md text-xs font-medium text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
				{t("Usage details")} <ArrowUpRight className="size-3.5" aria-hidden />
			</Link>
		</div>
	);
}

/**
 * The LLM quota of every connected account, combined, next to where you work: the 5 h and 7 d windows as small meters (colour turns amber
 * at 70 %, red at 90 %). Click for the combined windows and every account's own limits. Hidden when no account reports quota.
 * `compact`: plain text for the phone header, opening a bottom sheet.
 */
export function QuotaMeter({ compact = false, className }: { compact?: boolean; className?: string }) {
	const quota = useQuotaReport();
	const qc = useQueryClient();
	const [open, setOpen] = useState(false);
	const refresh = useMutation({
		mutationFn: () => api.get<QuotaReport>(routes.usageQuota, { refresh: "1" }),
		onSuccess: (report) => qc.setQueryData(qk.usageQuota, report),
		onError: (e) => toast.error(t("Could not check the quota: {error}", { error: errorText(e) })),
	});
	const report = quota.data;
	// Resets that passed since the report are skipped; the minute is enough precision for "next reset".
	const minute = Math.floor(Date.now() / 60_000);
	const pools = useMemo(() => (report ? quotaPools(report, minute * 60_000) : []), [report, minute]);
	if (!report || pools.length === 0) return null;

	const shown = headline(pools);
	const worst = Math.max(...pools.map((p) => p.used));
	const summary = shown.map((p) => `${p.tag} ${formatPercent(p.used)}`).join(" · ");
	const label = t("LLM quota: {summary}. Show every account", { summary });
	const details = <QuotaDetails report={report} pools={pools} onRefresh={() => refresh.mutate()} refreshing={refresh.isPending} />;

	if (compact) {
		// Rings from the inside out: the shorter window (5 h) inside, the longer one (7 d) around it; the busiest share in the middle.
		const rings = shown.map((p, i) => ({ pool: p, r: shown.length === 1 ? 14 : i === 0 ? 10 : 15 }));
		const peak = Math.max(...shown.map((p) => p.used));
		return (
			<>
				<button
					type="button"
					aria-label={label}
					onClick={() => setOpen(true)}
					className={cn("relative grid size-8 shrink-0 place-items-center rounded-full outline-none transition-transform active:scale-90 focus-visible:ring-2 focus-visible:ring-ring coarse:size-11", className)}
				>
					<svg viewBox="0 0 36 36" aria-hidden className="size-8 -rotate-90">
						{rings.map(({ pool, r }) => {
							const c = 2 * Math.PI * r;
							return (
								<g key={pool.key}>
									<circle cx="18" cy="18" r={r} fill="none" strokeWidth="3" className="stroke-surface-3" />
									<circle
										cx="18"
										cy="18"
										r={r}
										fill="none"
										strokeWidth="3"
										strokeLinecap="round"
										strokeDasharray={c}
										strokeDashoffset={c * (1 - Math.max(0.02, pool.used))}
										className={cn("transition-[stroke-dashoffset] duration-700 ease-[var(--ease-out-quint)]", RING[toneOf(pool.used)])}
									/>
								</g>
							);
						})}
					</svg>
					<span aria-hidden className={cn("tabular absolute text-[8px] font-bold leading-none", TEXT[toneOf(peak)], worst >= 0.9 && "animate-pulse")}>
						{Math.round(peak * 100)}
					</span>
				</button>
				<Sheet open={open} onOpenChange={setOpen}>
					<SheetContent side="bottom" aria-describedby={undefined} className="px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
						<SheetTitle className="sr-only">{t("LLM quota")}</SheetTitle>
						{details}
					</SheetContent>
				</Sheet>
			</>
		);
	}

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<Tip label={t("LLM quota of every account combined")}>
				<PopoverTrigger asChild>
					<button
						type="button"
						aria-label={label}
						className={cn(
							"inline-flex h-7 shrink-0 items-center gap-2.5 rounded-full px-2.5 text-2xs shadow-[inset_0_0_0_1px_var(--border)] outline-none transition-[background-color,box-shadow] hover:bg-surface-2 focus-visible:shadow-[inset_0_0_0_1px_var(--border),0_0_0_2px_var(--accent)] data-[state=open]:bg-surface-2 coarse:h-10",
							worst >= 0.9 && "shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--danger)_45%,transparent)]",
							className,
						)}
					>
						<Gauge aria-hidden className={cn("size-3.5 shrink-0", worst >= 0.9 ? "text-danger" : worst >= 0.7 ? "text-warning" : "text-subtle")} />
						{shown.map((p) => (
							<span key={p.key} className="flex items-center gap-1.5">
								<span className="text-subtle">{p.tag}</span>
								<FillBar value={p.used * 100} tone={toneOf(p.used)} className="hidden w-8 lg:block" />
								<span className={cn("tabular font-semibold", TEXT[toneOf(p.used)])}>{formatPercent(p.used)}</span>
							</span>
						))}
					</button>
				</PopoverTrigger>
			</Tip>
			<PopoverContent align="end" side="top" className="w-[23rem] p-4">
				{details}
			</PopoverContent>
		</Popover>
	);
}
