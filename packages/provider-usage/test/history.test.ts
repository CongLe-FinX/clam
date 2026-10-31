import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { createSqliteHistory, extractHourlyBuckets, type HourlyBucket, type SqliteLike } from "../src/index.ts";

const H = 3_600_000;
const D = 24 * H;

function memoryDb(): SqliteLike {
	const db = new DatabaseSync(":memory:");
	db.exec(`CREATE TABLE usage_buckets (bucket_start integer primary key, requests integer not null, failed_requests integer not null, tokens_total integer not null, cost real not null, updated_at text not null)`);
	return {
		prepare: (sql) => {
			const st = db.prepare(sql);
			return { run: (...p) => st.run(...(p as never[])), all: (...p) => st.all(...(p as never[])) };
		},
		transaction: (fn) =>
			((...args) => {
				db.exec("BEGIN");
				try {
					const r = fn(...args);
					db.exec("COMMIT");
					return r;
				} catch (e) {
					db.exec("ROLLBACK");
					throw e;
				}
			}),
	};
}

const b = (t: number, requests: number, cost = requests): HourlyBucket => ({ t, requests, failedRequests: 0, tokensTotal: requests * 10, cost });

describe("usage history", () => {
	let history: ReturnType<typeof createSqliteHistory>;
	beforeEach(() => {
		history = createSqliteHistory(memoryDb());
	});

	it("is empty before any ingest", () => {
		expect(history.read()).toEqual({ daily: [], coverageStart: null });
	});

	it("re-ingesting an overlapping window replaces instead of adding", () => {
		const t0 = 100 * D;
		history.ingest([b(t0 + 1 * H, 5), b(t0 + 2 * H, 7)], t0);
		history.ingest([b(t0 + 1 * H, 5), b(t0 + 2 * H, 9), b(t0 + 3 * H, 1)], t0); // hour 2 grew, hour 3 is new
		const { daily, coverageStart } = history.read();
		expect(coverageStart).toBe(t0 + H);
		expect(daily).toEqual([{ t: t0, tokens: { total: 150 }, cost: 15, requests: 15 }]);
	});

	it("a replaced complete bucket may shrink; a partial oldest bucket never shrinks stored data", () => {
		const t0 = 200 * D;
		history.ingest([b(t0, 10)], t0); // complete
		history.ingest([b(t0, 4)], t0 + H); // now partial (before completeFrom): ignored since 4 < 10
		expect(history.read().daily[0]?.requests).toBe(10);
		history.ingest([b(t0, 4)], t0); // complete again: replaces
		expect(history.read().daily[0]?.requests).toBe(4);
	});

	it("groups hours into UTC days across the accumulated history", () => {
		const t0 = 300 * D;
		history.ingest([b(t0 + 23 * H, 1)], t0);
		history.ingest([b(t0 + D + 0 * H, 2), b(t0 + D + 5 * H, 3)], t0);
		expect(history.read().daily.map((d) => [d.t, d.requests])).toEqual([
			[t0, 1],
			[t0 + D, 5],
		]);
	});

	it("ignores windows that are not hourly 24h series", () => {
		history.ingest([b(0, 1), b(10 * D, 1)], 0);
		history.ingest([b(H / 2, 1)], 0);
		expect(history.read().coverageStart).toBeNull();
	});

	it("extractHourlyBuckets reads the real timeSeries shape", () => {
		const out = extractHourlyBuckets({ timeSeries: [{ timestamp: 2, requests: 3, errors: 1, tokens: 4, cost: 5 }, { timestamp: 1, requests: 1, errors: 0, tokens: 1, cost: 1 }] });
		expect(out.map((x) => x.t)).toEqual([1, 2]);
		expect(out[1]).toEqual({ t: 2, requests: 3, failedRequests: 1, tokensTotal: 4, cost: 5 });
	});
});
