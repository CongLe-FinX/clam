import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SnapshotCache } from "../src/index.ts";

interface Snap {
	fetchedAt: string;
	stale: boolean;
	n: number;
}

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "clam-usage-cache-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function harness(over: { now: { v: number }; failNext?: { v: boolean } }) {
	let calls = 0;
	let release: (() => void) | null = null;
	const gate = { hold: false };
	const cache = new SnapshotCache<Snap>({
		ttlMs: 1000,
		file: join(dir, "snap.json"),
		failureCooldownMs: 500,
		now: () => over.now.v,
		parse: (raw) => (typeof raw === "object" && raw && "n" in raw ? (raw as Snap) : null),
		fetch: async () => {
			calls++;
			if (gate.hold) await new Promise<void>((r) => (release = r));
			if (over.failNext?.v) throw new Error("boom");
			return { n: calls, stale: false, fetchedAt: new Date(over.now.v).toISOString() };
		},
	});
	return { cache, calls: () => calls, gate, release: () => release?.() };
}

describe("SnapshotCache", () => {
	it("single-flights concurrent cold requests", async () => {
		const now = { v: 10_000 };
		const h = harness({ now });
		h.gate.hold = true;
		const all = Promise.all([h.cache.get(), h.cache.get(), h.cache.get()]);
		await new Promise((r) => setTimeout(r, 10));
		h.release();
		const res = await all;
		expect(h.calls()).toBe(1);
		expect(res.every((r) => r.n === 1 && !r.stale)).toBe(true);
	});

	it("serves fresh data from cache and stale data while revalidating", async () => {
		const now = { v: 10_000 };
		const h = harness({ now });
		expect((await h.cache.get()).n).toBe(1);
		now.v += 500;
		expect(await h.cache.get()).toMatchObject({ n: 1, stale: false });
		expect(h.calls()).toBe(1);
		now.v += 1000; // expired
		h.gate.hold = true;
		expect(await h.cache.get()).toMatchObject({ n: 1, stale: true });
		expect(await h.cache.get()).toMatchObject({ n: 1, stale: true });
		h.gate.hold = false;
		h.release();
		await new Promise((r) => setTimeout(r, 20));
		expect(h.calls()).toBe(2); // exactly one background refresh
		expect(await h.cache.get()).toMatchObject({ n: 2, stale: false });
	});

	it("refresh=true waits for a new snapshot; a failed refresh falls back to the last good one", async () => {
		const now = { v: 10_000 };
		const failNext = { v: false };
		const h = harness({ now, failNext });
		await h.cache.get();
		now.v += 10;
		expect((await h.cache.get(true)).n).toBe(2);
		failNext.v = true;
		expect(await h.cache.get(true)).toMatchObject({ n: 2, stale: true });
	});

	it("rejects when nothing is cached and the fetch fails", async () => {
		const h = harness({ now: { v: 1 }, failNext: { v: true } });
		await expect(h.cache.get()).rejects.toThrow("boom");
	});

	it("persists snapshots and serves them stale after a restart", async () => {
		const now = { v: Date.now() };
		const h1 = harness({ now });
		await h1.cache.get();
		expect(JSON.parse(await readFile(join(dir, "snap.json"), "utf8")).n).toBe(1);

		now.v += 5000;
		const h2 = harness({ now });
		h2.gate.hold = true;
		const first = await h2.cache.get(); // instant: from disk, refresh runs in the background
		expect(first).toMatchObject({ n: 1, stale: true });
		h2.gate.hold = false;
		h2.release();
		await new Promise((r) => setTimeout(r, 50)); // let the background refresh finish writing before cleanup
		expect(await h2.cache.get()).toMatchObject({ n: 1, stale: false });
	});

	it("ignores a corrupt cache file", async () => {
		await writeFile(join(dir, "snap.json"), "{not json");
		const h = harness({ now: { v: 1 } });
		expect((await h.cache.get()).n).toBe(1);
	});
});
