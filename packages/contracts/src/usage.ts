import { z } from "zod";
import { DataSource, IsoDate } from "./common.ts";

export const TokenTotals = z.object({
	input: z.number(),
	output: z.number(),
	cacheRead: z.number(),
	cacheWrite: z.number(),
	total: z.number(),
});
export type TokenTotals = z.infer<typeof TokenTotals>;

export const UsageRow = z.object({
	key: z.string(),
	provider: z.string().optional(),
	model: z.string().optional(),
	requests: z.number(),
	failedRequests: z.number(),
	tokens: TokenTotals,
	/** USD. */
	cost: z.number(),
});
export type UsageRow = z.infer<typeof UsageRow>;

export const UsagePoint = z.object({
	/** Bucket start, epoch ms (UTC day). */
	t: z.number(),
	/** `omp stats --json` reports only a total per bucket; it has no per-bucket input/output/cache split. */
	tokens: TokenTotals.pick({ total: true }),
	cost: z.number(),
	requests: z.number(),
});
export type UsagePoint = z.infer<typeof UsagePoint>;

/** Normalized `omp stats --json`. Always `source: "omp-recorded"`. */
export const RecordedUsage = z.object({
	source: z.literal("omp-recorded"),
	overall: z.object({
		requests: z.number(),
		failedRequests: z.number(),
		tokens: TokenTotals,
		cost: z.number(),
		cacheRate: z.number().nullable(),
		avgTtftMs: z.number().nullable(),
		avgTokensPerSecond: z.number().nullable(),
		firstAt: z.number().nullable(),
		lastAt: z.number().nullable(),
	}),
	byProvider: z.array(UsageRow),
	byModel: z.array(UsageRow),
	/** Keyed by working-directory path as recorded by OMP. */
	byFolder: z.array(UsageRow),
	/**
	 * Daily buckets (UTC) accumulated locally across refreshes: `omp stats --json` itself only covers
	 * the last 24h, so history starts at the first ingest (see `coverageStart`).
	 */
	daily: z.array(UsagePoint),
	/** Epoch ms of the oldest ingested bucket (history start); null when nothing was ingested. */
	coverageStart: z.number().nullable(),
	fetchedAt: IsoDate,
	/** True when served from cache while a refresh runs. */
	stale: z.boolean(),
});
export type RecordedUsage = z.infer<typeof RecordedUsage>;

export const QuotaLimit = z.object({
	id: z.string(),
	label: z.string(),
	windowLabel: z.string().nullable(),
	resetsAt: z.number().nullable(),
	used: z.number().nullable(),
	limit: z.number().nullable(),
	remaining: z.number().nullable(),
	unit: z.string(),
	status: z.string(),
});
export type QuotaLimit = z.infer<typeof QuotaLimit>;

export const ProviderQuota = z.object({
	provider: z.string(),
	/** Account label as reported (redacted when the UI asks for it). */
	account: z.string().nullable(),
	fetchedAt: z.number().nullable(),
	limits: z.array(QuotaLimit),
	/** "available" when the provider reported limits; "unavailable" when it exposes none. */
	availability: z.enum(["available", "unavailable", "error"]),
	error: z.string().optional(),
});
export type ProviderQuota = z.infer<typeof ProviderQuota>;

/** Normalized `omp usage --json`. Always `source: "provider-reported"`. */
export const QuotaReport = z.object({
	source: z.literal("provider-reported"),
	providers: z.array(ProviderQuota),
	fetchedAt: IsoDate,
	stale: z.boolean(),
});
export type QuotaReport = z.infer<typeof QuotaReport>;

/** CL Agent Mesh per-session accounting (from RPC `get_session_stats`), rolled up. */
export const MeshUsageRow = z.object({
	key: z.string(),
	label: z.string(),
	sessions: z.number(),
	tokens: TokenTotals,
	cost: z.number(),
	source: DataSource,
});
export type MeshUsageRow = z.infer<typeof MeshUsageRow>;

export const MeshUsage = z.object({
	byProject: z.array(MeshUsageRow),
	byAgent: z.array(MeshUsageRow),
	fetchedAt: IsoDate,
});
export type MeshUsage = z.infer<typeof MeshUsage>;
