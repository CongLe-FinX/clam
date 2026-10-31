import type { UsagePoint } from "@clam/contracts";
import type { HourlyBucket } from "./normalize.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Minimal structural subset of better-sqlite3's Database, so this package needs no native dependency. */
export interface SqliteLike {
	prepare(sql: string): { run(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
	transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R;
}

export interface UsageHistory {
	/**
	 * Upserts hourly buckets. A bucket entirely inside the CLI's window (`t >= completeFrom`) is
	 * complete, so it REPLACES the stored row (re-ingesting overlapping windows is idempotent).
	 * The oldest bucket of a window only holds the part after the window cutoff; it never
	 * overwrites a stored row that saw more requests.
	 */
	ingest(buckets: readonly HourlyBucket[], completeFrom: number): void;
	/** Accumulated daily (UTC) totals, oldest first, plus the oldest bucket's start. */
	read(): { daily: UsagePoint[]; coverageStart: number | null };
}

/** Table `usage_buckets` is created by the `@clam/database` migrations. */
export function createSqliteHistory(db: SqliteLike): UsageHistory {
	const upsert = db.prepare(
		`INSERT INTO usage_buckets (bucket_start, requests, failed_requests, tokens_total, cost, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(bucket_start) DO UPDATE SET
		   requests = excluded.requests,
		   failed_requests = excluded.failed_requests,
		   tokens_total = excluded.tokens_total,
		   cost = excluded.cost,
		   updated_at = excluded.updated_at
		 WHERE ? = 1 OR excluded.requests > usage_buckets.requests`,
	);
	const daily = db.prepare(
		`SELECT (bucket_start / ${DAY_MS}) * ${DAY_MS} AS t, SUM(tokens_total) AS tokens, SUM(cost) AS cost, SUM(requests) AS requests
		 FROM usage_buckets GROUP BY t ORDER BY t`,
	);
	const first = db.prepare("SELECT MIN(bucket_start) AS t FROM usage_buckets");

	const ingestAll = db.transaction((buckets: readonly HourlyBucket[], completeFrom: number) => {
		const now = new Date().toISOString();
		for (const b of buckets) {
			upsert.run(b.t, b.requests, b.failedRequests, b.tokensTotal, b.cost, now, b.t >= completeFrom ? 1 : 0);
		}
	});

	return {
		ingest(buckets, completeFrom) {
			// Only an hourly 24h window is understood; anything else could double-count against hourly rows.
			if (buckets.length === 0) return;
			const span = (buckets[buckets.length - 1]?.t ?? 0) - (buckets[0]?.t ?? 0);
			if (span >= 26 * HOUR_MS || buckets.some((b) => b.t % HOUR_MS !== 0)) return;
			ingestAll(buckets, completeFrom);
		},
		read() {
			const rows = daily.all() as { t: number; tokens: number; cost: number; requests: number }[];
			const start = (first.all()[0] as { t: number | null } | undefined)?.t ?? null;
			return {
				daily: rows.map((r) => ({ t: r.t, tokens: { total: r.tokens }, cost: r.cost, requests: r.requests })),
				coverageStart: start,
			};
		},
	};
}
