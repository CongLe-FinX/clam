import { readFileSync } from "node:fs";
import { QuotaReport, RecordedUsage } from "@clam/contracts";
import { describe, expect, it } from "vitest";
import { normalizeStats, normalizeUsage } from "../src/index.ts";

const fixture = (name: string): any => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const meta = { fetchedAt: "2026-10-31T06:00:00.000Z" };

describe("normalizeStats", () => {
	const raw = fixture("stats.json");
	const out = normalizeStats(raw, meta);

	it("matches the contract schema", () => {
		expect(RecordedUsage.safeParse(out).success).toBe(true);
		expect(out.source).toBe("omp-recorded");
		expect(out.stale).toBe(false);
	});

	it("maps overall totals and sums token components", () => {
		expect(out.overall.requests).toBe(raw.overall.totalRequests);
		expect(out.overall.failedRequests).toBe(raw.overall.failedRequests);
		expect(out.overall.cost).toBeCloseTo(raw.overall.totalCost, 9);
		const t = out.overall.tokens;
		expect(t.input).toBe(raw.overall.totalInputTokens);
		expect(t.total).toBe(t.input + t.output + t.cacheRead + t.cacheWrite);
		expect(out.overall.firstAt).toBe(raw.overall.firstTimestamp);
	});

	it("aggregates byProvider from byModel", () => {
		for (const p of out.byProvider) {
			const models = out.byModel.filter((m) => m.provider === p.key);
			expect(p.requests).toBe(models.reduce((s, m) => s + m.requests, 0));
			expect(p.cost).toBeCloseTo(models.reduce((s, m) => s + m.cost, 0), 9);
			expect(p.tokens.total).toBe(models.reduce((s, m) => s + m.tokens.total, 0));
		}
		expect(out.byModel[0]?.key).toBe("anthropic/claude-opus-5-5");
		expect(out.byProvider.map((p) => p.key)).toContain("anthropic");
	});

	it("sorts rows by cost descending and keeps folder keys as recorded", () => {
		const costs = out.byModel.map((m) => m.cost);
		expect(costs).toEqual([...costs].sort((a, b) => b - a));
		expect(out.byFolder[0]?.key).toMatch(/^-work-project-/);
	});

	it("derives UTC-day buckets from the hourly timeSeries when no history is supplied", () => {
		expect(out.daily.length).toBe(2);
		for (const d of out.daily) expect(d.t % 86_400_000).toBe(0);
		expect(out.daily.reduce((s, d) => s + d.requests, 0)).toBe(raw.overall.totalRequests);
		expect(out.daily.reduce((s, d) => s + d.cost, 0)).toBeCloseTo(raw.overall.totalCost, 6);
		expect(out.daily.reduce((s, d) => s + d.tokens.total, 0)).toBe(out.overall.tokens.total);
		expect(out.coverageStart).toBe(raw.timeSeries[0].timestamp);
	});

	it("prefers supplied accumulated history", () => {
		const o = normalizeStats(raw, { ...meta, history: { daily: [{ t: 0, tokens: { total: 1 }, cost: 2, requests: 3 }], coverageStart: 0 } });
		expect(o.daily).toHaveLength(1);
		expect(o.coverageStart).toBe(0);
	});

	it("rejects unexpected shapes", () => {
		expect(() => normalizeStats({ nope: 1 }, meta)).toThrow(/unexpected output shape/);
	});
});

describe("normalizeUsage", () => {
	const raw = fixture("usage.json");
	const out = normalizeUsage(raw, meta);

	it("matches the contract schema", () => {
		expect(QuotaReport.safeParse(out).success).toBe(true);
		expect(out.source).toBe("provider-reported");
	});

	it("marks providers with limits as available and keeps real numbers", () => {
		expect(out.providers).toHaveLength(3);
		const first = out.providers[0]!;
		expect(first.availability).toBe("available");
		expect(first.account).toBe("us*@*");
		const five = first.limits.find((l) => l.id === "anthropic:5h")!;
		expect(five).toMatchObject({ used: 26, limit: 100, remaining: 74, unit: "percent", status: "ok", windowLabel: "5 Hour" });
		expect(five.resetsAt).toBe(raw.reports[0].limits[0].window.resetsAt);
		expect(out.providers.some((p) => p.limits.some((l) => l.status === "warning"))).toBe(true);
	});

	it("never invents limits for accounts without usage, and skips MCP credentials", () => {
		const o = normalizeUsage(
			{
				reports: [{ provider: "openai-codex", fetchedAt: 1, limits: [] }],
				accountsWithoutUsage: [{ provider: "zai", type: "api_key" }],
				disabledCredentials: [
					{ provider: "mcp_oauth:profile:default:https://x", cause: "nope" },
					{ provider: "anthropic", cause: "oauth refresh failed", email: "a*@*" },
				],
			},
			meta,
		);
		expect(o.providers.map((p) => [p.provider, p.availability])).toEqual([
			["openai-codex", "unavailable"],
			["zai", "unavailable"],
			["anthropic", "error"],
		]);
		expect(o.providers[1]).toMatchObject({ account: null, limits: [] });
		expect(o.providers[2]?.error).toContain("oauth refresh failed");
	});

	it("converts fraction-only percent meters and leaves unknown amounts null", () => {
		const o = normalizeUsage(
			{
				reports: [
					{
						provider: "p",
						fetchedAt: 1,
						limits: [
							{ id: "a", label: "A", amount: { unit: "percent", usedFraction: 0.25 }, status: "ok" },
							{ id: "b", label: "B", amount: { unit: "tokens" } },
						],
					},
				],
			},
			meta,
		);
		expect(o.providers[0]?.limits[0]).toMatchObject({ used: 25, limit: 100, remaining: 75 });
		expect(o.providers[0]?.limits[1]).toMatchObject({ used: null, limit: null, remaining: null, status: "unknown" });
	});

	it("rejects unexpected shapes", () => {
		expect(() => normalizeUsage({}, meta)).toThrow(/unexpected output shape/);
	});
});

describe("parseJsonDocument", () => {
	it("skips the progress lines `omp stats --json` prints before the document", async () => {
		const { parseJsonDocument } = await import("../src/omp-cli.ts");
		expect(parseJsonDocument('\nSyncing session files... {x}\nSynced 0 new entries\n\n{\n  "a": 1\n}\n')).toEqual({ a: 1 });
		expect(parseJsonDocument('{"a":2}')).toEqual({ a: 2 });
		expect(() => parseJsonDocument("garbage")).toThrow();
	});
});
