import type { ProviderQuota, QuotaLimit, QuotaReport, RecordedUsage, TokenTotals, UsagePoint, UsageRow } from "@clam/contracts";
import { UsageError } from "./errors.ts";

type Obj = Record<string, unknown>;
const DAY_MS = 86_400_000;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);

function tokensOf(o: Obj): TokenTotals {
	const input = num(o.totalInputTokens);
	const output = num(o.totalOutputTokens);
	const cacheRead = num(o.totalCacheReadTokens);
	const cacheWrite = num(o.totalCacheWriteTokens);
	return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

function addTokens(a: TokenTotals, b: TokenTotals): TokenTotals {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		total: a.total + b.total,
	};
}

const byCostDesc = (a: UsageRow, b: UsageRow) => b.cost - a.cost || b.requests - a.requests || a.key.localeCompare(b.key);

export interface HourlyBucket {
	/** Bucket start, epoch ms (UTC hour). */
	t: number;
	requests: number;
	failedRequests: number;
	tokensTotal: number;
	cost: number;
}

/** Hourly buckets of `omp stats --json` (`timeSeries`); the CLI's window is the last 24 hours. */
export function extractHourlyBuckets(raw: unknown): HourlyBucket[] {
	if (!isObj(raw)) return [];
	const out: HourlyBucket[] = [];
	for (const p of arr(raw.timeSeries)) {
		const t = numOrNull(p.timestamp);
		if (t === null) continue;
		out.push({ t, requests: num(p.requests), failedRequests: num(p.errors), tokensTotal: num(p.tokens), cost: num(p.cost) });
	}
	return out.sort((a, b) => a.t - b.t);
}

/** Groups buckets by UTC day. */
export function groupDaily(buckets: readonly HourlyBucket[]): UsagePoint[] {
	const days = new Map<number, UsagePoint>();
	for (const b of buckets) {
		const t = Math.floor(b.t / DAY_MS) * DAY_MS;
		const day = days.get(t) ?? { t, tokens: { total: 0 }, cost: 0, requests: 0 };
		day.tokens.total += b.tokensTotal;
		day.cost += b.cost;
		day.requests += b.requests;
		days.set(t, day);
	}
	return [...days.values()].sort((a, b) => a.t - b.t);
}

/**
 * `omp stats --json` → RecordedUsage.
 * That command reports only OMP's default dashboard window (the last 24 hours), so
 * `overall`/`byModel`/`byFolder` cover 24h. `daily`/`coverageStart` come from `meta.history`
 * (accumulated across refreshes); without it they are derived from this single window.
 */
export function normalizeStats(
	raw: unknown,
	meta: { fetchedAt: string; stale?: boolean; history?: { daily: UsagePoint[]; coverageStart: number | null } },
): RecordedUsage {
	if (!isObj(raw) || !isObj(raw.overall)) throw new UsageError("bad_output", "omp stats --json: unexpected output shape");
	const overall = raw.overall;

	const byModel: UsageRow[] = arr(raw.byModel).map((m) => {
		const provider = str(m.provider) ?? "unknown";
		const model = str(m.model) ?? "unknown";
		return {
			key: `${provider}/${model}`,
			provider,
			model,
			requests: num(m.totalRequests),
			failedRequests: num(m.failedRequests),
			tokens: tokensOf(m),
			cost: num(m.totalCost),
		};
	});

	const providers = new Map<string, UsageRow>();
	for (const row of byModel) {
		const provider = row.provider ?? "unknown";
		const acc = providers.get(provider);
		if (!acc) {
			providers.set(provider, { key: provider, provider, requests: row.requests, failedRequests: row.failedRequests, tokens: { ...row.tokens }, cost: row.cost });
		} else {
			acc.requests += row.requests;
			acc.failedRequests += row.failedRequests;
			acc.tokens = addTokens(acc.tokens, row.tokens);
			acc.cost += row.cost;
		}
	}

	const byFolder: UsageRow[] = arr(raw.byFolder).map((f) => ({
		key: str(f.folder) ?? "unknown",
		requests: num(f.totalRequests),
		failedRequests: num(f.failedRequests),
		tokens: tokensOf(f),
		cost: num(f.totalCost),
	}));

	const windowBuckets = extractHourlyBuckets(raw);
	const history = meta.history ?? { daily: groupDaily(windowBuckets), coverageStart: windowBuckets[0]?.t ?? null };
	return {
		source: "omp-recorded",
		overall: {
			requests: num(overall.totalRequests),
			failedRequests: num(overall.failedRequests),
			tokens: tokensOf(overall),
			cost: num(overall.totalCost),
			cacheRate: numOrNull(overall.cacheRate),
			avgTtftMs: numOrNull(overall.avgTtft),
			avgTokensPerSecond: numOrNull(overall.avgTokensPerSecond),
			firstAt: numOrNull(overall.firstTimestamp),
			lastAt: numOrNull(overall.lastTimestamp),
		},
		byProvider: [...providers.values()].sort(byCostDesc),
		byModel: byModel.sort(byCostDesc),
		byFolder: byFolder.sort(byCostDesc),
		daily: history.daily,
		coverageStart: history.coverageStart,
		fetchedAt: meta.fetchedAt,
		stale: meta.stale ?? false,
	};
}

function normalizeLimit(l: Obj): QuotaLimit {
	const amount = isObj(l.amount) ? l.amount : {};
	const window = isObj(l.window) ? l.window : {};
	const unit = str(amount.unit) ?? "unknown";
	let used = numOrNull(amount.used);
	let limit = numOrNull(amount.limit);
	let remaining = numOrNull(amount.remaining);
	// Percent meters may carry only a fraction; scaling it to 0..100 is a unit conversion, not a guess.
	if (unit === "percent" && used === null && limit === null) {
		const usedFraction = numOrNull(amount.usedFraction);
		const remainingFraction = numOrNull(amount.remainingFraction);
		if (usedFraction !== null) {
			used = usedFraction * 100;
			limit = 100;
			remaining = remainingFraction !== null ? remainingFraction * 100 : 100 - used;
		}
	}
	return {
		id: str(l.id) ?? "unknown",
		label: str(l.label) ?? str(l.id) ?? "Limit",
		windowLabel: str(window.label),
		resetsAt: numOrNull(window.resetsAt),
		used,
		limit,
		remaining,
		unit,
		status: str(l.status) ?? "unknown",
	};
}

/**
 * `omp usage --json --redact` → QuotaReport. Identifiers arrive already masked by `--redact`
 * (e.g. `sh*a@*`); callers must always pass that flag.
 */
export function normalizeUsage(raw: unknown, meta: { fetchedAt: string; stale?: boolean }): QuotaReport {
	if (!isObj(raw) || !Array.isArray(raw.reports)) throw new UsageError("bad_output", "omp usage --json: unexpected output shape");
	const providers: ProviderQuota[] = [];

	for (const r of arr(raw.reports)) {
		const metadata = isObj(r.metadata) ? r.metadata : {};
		const limits = arr(r.limits).map(normalizeLimit);
		providers.push({
			provider: str(r.provider) ?? "unknown",
			account: str(metadata.email) ?? str(metadata.accountId) ?? str(metadata.orgName),
			fetchedAt: numOrNull(r.fetchedAt),
			limits,
			availability: limits.length > 0 ? "available" : "unavailable",
		});
	}

	for (const a of arr(raw.accountsWithoutUsage)) {
		providers.push({
			provider: str(a.provider) ?? "unknown",
			account: str(a.email) ?? str(a.accountId) ?? str(a.projectId) ?? str(a.orgName),
			fetchedAt: null,
			limits: [],
			availability: "unavailable",
		});
	}

	// LLM-provider credentials OMP disabled (e.g. a failed OAuth refresh); MCP OAuth entries (`mcp_oauth:…`) are not providers.
	for (const d of arr(raw.disabledCredentials)) {
		const provider = str(d.provider);
		if (!provider || provider.includes(":")) continue;
		providers.push({
			provider,
			account: str(d.email) ?? str(d.accountId) ?? str(d.orgName),
			fetchedAt: null,
			limits: [],
			availability: "error",
			error: `Credential disabled by OMP${str(d.cause) ? `: ${str(d.cause)}` : ""}`.slice(0, 300),
		});
	}

	return { source: "provider-reported", providers, fetchedAt: meta.fetchedAt, stale: meta.stale ?? false };
}
