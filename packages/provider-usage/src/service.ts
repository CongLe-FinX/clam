import { join } from "node:path";
import { QuotaReport, RecordedUsage, type UsagePoint } from "@clam/contracts";
import { SnapshotCache } from "./cache.ts";
import { UsageError } from "./errors.ts";
import type { UsageHistory } from "./history.ts";
import { extractHourlyBuckets, normalizeStats, normalizeUsage } from "./normalize.ts";
import { runOmpJson } from "./omp-cli.ts";

export interface UsageService {
	recorded(opts?: { refresh?: boolean }): Promise<RecordedUsage>;
	quota(opts?: { refresh?: boolean }): Promise<QuotaReport>;
	/** Refreshes `omp stats` every `intervalMs` so history keeps accumulating; returns a stopper. */
	startBackgroundRefresh(intervalMs?: number): () => void;
}

export interface UsageServiceOptions {
	dataDir: string;
	/** Current omp binary path; null when OMP is not installed. */
	binaryPath: () => string | null;
	/** OMP profile to pass as `--profile`; null/absent uses the default profile. */
	profile?: () => string | null;
	/** Accumulated hourly history (SQLite). Without it `daily` covers only the CLI's 24h window. */
	history?: UsageHistory;
	onError?: (label: "stats" | "usage" | "history", err: unknown) => void;
	statsTtlMs?: number;
	usageTtlMs?: number;
}

const STATS_TIMEOUT_MS = 60_000;
const USAGE_TIMEOUT_MS = 30_000;
const DAY_MS = 86_400_000;

export function createUsageService(opts: UsageServiceOptions): UsageService {
	const binary = (): string => {
		const path = opts.binaryPath();
		if (!path) throw new UsageError("omp_missing", "OMP is not installed or could not be located");
		return path;
	};
	const base = (): string[] => {
		const profile = opts.profile?.();
		return profile ? ["--profile", profile] : [];
	};
	const cacheDir = join(opts.dataDir, "cache");

	const recorded = new SnapshotCache<RecordedUsage>({
		ttlMs: opts.statsTtlMs ?? 60_000,
		file: join(cacheDir, "usage-recorded.json"),
		parse: (raw) => {
			const res = RecordedUsage.safeParse(raw);
			return res.success ? res.data : null;
		},
		fetch: async () => {
			const raw = await runOmpJson(binary(), [...base(), "stats", "--json"], STATS_TIMEOUT_MS);
			const finishedAt = Date.now();
			let history: { daily: UsagePoint[]; coverageStart: number | null } | undefined;
			if (opts.history) {
				try {
					// The CLI's cutoff is `now - 24h` taken before it exits, so buckets starting at or after
					// `finishedAt - 24h` are fully inside the window.
					opts.history.ingest(extractHourlyBuckets(raw), finishedAt - DAY_MS);
					history = opts.history.read();
				} catch (err) {
					opts.onError?.("history", err);
				}
			}
			return normalizeStats(raw, { fetchedAt: new Date(finishedAt).toISOString(), history });
		},
		onError: (err) => opts.onError?.("stats", err),
	});

	const quota = new SnapshotCache<QuotaReport>({
		ttlMs: opts.usageTtlMs ?? 120_000,
		file: join(cacheDir, "usage-quota.json"),
		parse: (raw) => {
			const res = QuotaReport.safeParse(raw);
			return res.success ? res.data : null;
		},
		fetch: async () => {
			// Full account identifiers (email / account id): the owner needs to tell accounts apart. The quota report stays on this
			// machine (local API and the owner's remote UI only; it is never sent to peers).
			const raw = await runOmpJson(binary(), [...base(), "usage", "--json"], USAGE_TIMEOUT_MS);
			return normalizeUsage(raw, { fetchedAt: new Date().toISOString() });
		},
		onError: (err) => opts.onError?.("usage", err),
	});

	return {
		recorded: ({ refresh } = {}) => recorded.get(refresh),
		quota: ({ refresh } = {}) => quota.get(refresh),
		startBackgroundRefresh(intervalMs = 30 * 60_000) {
			const tick = () => void recorded.get(true).catch(() => {}); // failures are reported through onError
			tick();
			const timer = setInterval(tick, intervalMs);
			timer.unref();
			return () => clearInterval(timer);
		},
	};
}
