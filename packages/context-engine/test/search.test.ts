import { randomBytes } from "node:crypto";
import { openDatabase, type ClamDb } from "@clam/database";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildFtsQuery, searchContexts } from "../src/index.ts";

describe("buildFtsQuery", () => {
	it("makes bare words prefix matches and quoted text a phrase", () => {
		expect(buildFtsQuery("coding styl")).toBe('"coding"* "styl"*');
		expect(buildFtsQuery('"no semicolons" tabs')).toBe('"no semicolons" "tabs"*');
		expect(buildFtsQuery("  one  ")).toBe('"one"*');
	});

	it("never lets user text become FTS5 syntax", () => {
		expect(buildFtsQuery('title:secret NEAR(a b) OR "x" -y * ^z')).toBe('"title"* "secret"* "NEAR"* "a"* "b"* "OR"* "x" "y"* "z"*');
		expect(buildFtsQuery("(a AND b) *")).toBe('"a"* "AND"* "b"*');
		expect(buildFtsQuery('"unterminated phrase')).toBe('"unterminated"* "phrase"*');
		expect(buildFtsQuery("!!! --- ***")).toBeNull();
		expect(buildFtsQuery("")).toBeNull();
		expect(buildFtsQuery('""')).toBeNull();
	});

	it("keeps unicode letters and caps the term count and length", () => {
		expect(buildFtsQuery("quy ước đặt")).toBe('"quy"* "ước"* "đặt"*');
		expect(buildFtsQuery(Array.from({ length: 30 }, (_, i) => `w${i}`).join(" "))?.split(" ")).toHaveLength(12);
		expect(buildFtsQuery("a".repeat(200))).toBe(`"${"a".repeat(64)}"*`);
	});
});

let db: ClamDb;
beforeEach(() => {
	db = openDatabase({ file: ":memory:" });
	db.$client.prepare("insert into node(id,name,public_key,fingerprint) values('n','n','k','f')").run();
	db.$client.prepare("insert into workspaces(id,name,owner_id) values('w1','one','n'),('w2','two','n')").run();
});
afterEach(() => db.$client.close());

let counter = 0;
function add(o: { id?: string; workspace?: string; project?: string | null; projectKey?: string | null; type?: string; title: string; body: string; deleted?: boolean }): string {
	const id = o.id ?? `ctx_${(counter++).toString(16).padStart(16, "0")}`;
	db.$client
		.prepare(
			"insert into contexts(id,workspace_id,project_id,project_key,origin_node_id,type,title,body,deleted_at,version,sha256,author) values(?,?,?,?,?,?,?,?,?,1,?,'{}')",
		)
		.run(id, o.workspace ?? "w1", o.project ?? null, o.projectKey ?? null, "n", o.type ?? "memory", o.title, o.body, o.deleted ? "2026-01-01" : null, randomBytes(8).toString("hex"));
	return id;
}

describe("searchContexts", () => {
	it("finds prefix and phrase matches with a «»-marked snippet", () => {
		const style = add({ title: "Coding style", body: "We use tabs for indentation and never write semicolons in TypeScript." });
		add({ title: "Release process", body: "Tag the commit, then publish." });
		const hits = searchContexts(db.$client, "indent", { limit: 10 });
		expect(hits.map((h) => h.id)).toEqual([style]);
		expect(hits[0]?.snippet).toContain("«indentation»");
		expect(searchContexts(db.$client, '"never write semicolons"', { limit: 10 }).map((h) => h.id)).toEqual([style]);
		expect(searchContexts(db.$client, '"semicolons never"', { limit: 10 })).toEqual([]);
	});

	it("ranks a title match above a body match and returns a title snippet when only the title matched", () => {
		const body = add({ title: "Notes", body: "Remember the deployment checklist before every release." });
		const title = add({ title: "Deployment checklist", body: "Steps." });
		const hits = searchContexts(db.$client, "deployment", { limit: 10 });
		expect(hits.map((h) => h.id)).toEqual([title, body]);
		expect(hits[0]?.rank).toBeGreaterThan(hits[1]?.rank ?? 0);
		expect(hits[0]?.snippet).toContain("«Deployment»");
	});

	it("never returns tombstones and follows edits", () => {
		const id = add({ title: "Gone", body: "findable words" });
		expect(searchContexts(db.$client, "findable", { limit: 5 })).toHaveLength(1);
		db.$client.prepare("update contexts set body = 'other words' where id = ?").run(id);
		expect(searchContexts(db.$client, "findable", { limit: 5 })).toHaveLength(0);
		expect(searchContexts(db.$client, "other", { limit: 5 })).toHaveLength(1);
		db.$client.prepare("update contexts set deleted_at = '2026-01-01', body = '' where id = ?").run(id);
		expect(searchContexts(db.$client, "other", { limit: 5 })).toHaveLength(0);
		db.$client.prepare("delete from contexts where id = ?").run(id);
		expect(db.$client.prepare("insert into context_fts(context_fts) values('integrity-check')").run().changes).toBeGreaterThanOrEqual(0);
	});

	it("filters by workspace, project (id or synced key), workspace-wide scope and type", () => {
		db.$client.prepare("insert into projects(id,workspace_id,name,path) values('p1','w1','p','/tmp/p')").run();
		const own = add({ title: "alpha one", body: "x", project: "p1", projectKey: "name:p" });
		const synced = add({ title: "alpha two", body: "x", project: null, projectKey: "name:p" });
		const wide = add({ title: "alpha three", body: "x" });
		const other = add({ title: "alpha four", body: "x", workspace: "w2" });
		const plan = add({ title: "alpha plan", body: "x", type: "plan" });
		const ids = (f: Parameters<typeof searchContexts>[2]) => searchContexts(db.$client, "alpha", f).map((h) => h.id).sort();
		expect(ids({ limit: 50 })).toEqual([own, synced, wide, other, plan].sort());
		expect(ids({ limit: 50, workspaceId: "w1" })).toEqual([own, synced, wide, plan].sort());
		expect(ids({ limit: 50, workspaceId: "w1", project: { id: "p1", key: "name:p" } })).toEqual([own, synced].sort());
		expect(ids({ limit: 50, workspaceId: "w1", project: { id: "p1", key: "name:p" }, includeWorkspaceWide: true })).toEqual([own, synced, wide, plan].sort());
		expect(ids({ limit: 50, workspaceId: "w1", type: "plan" })).toEqual([plan]);
		expect(ids({ limit: 2 })).toHaveLength(2);
	});

	it("treats hostile input as plain words", () => {
		add({ title: "Normal", body: "just text" });
		for (const q of ['title:"x" OR (', "NEAR(", '" OR 1=1 --', "*", "a AND NOT"]) expect(() => searchContexts(db.$client, q, { limit: 5 })).not.toThrow();
	});
});

describe("search speed", () => {
	const WORDS = "alpha beta gamma delta epsilon zeta theta iota kappa lambda sigma omega project memory plan decision summary note build deploy release test review style format commit branch merge cache queue worker server client node peer task agent session context".split(" ");
	const word = (i: number) => WORDS[(i * 7919) % WORDS.length] as string;

	/** `contexts` contexts with `versions` snapshots each (10 000 snapshots in total in both variants). */
	function seed(contexts: number, versions: number): void {
		const sqlite = db.$client;
		const insertContext = sqlite.prepare("insert into contexts(id,workspace_id,origin_node_id,type,title,body,version,sha256,author) values(?,'w1','n','memory',?,?,?,?,'{}')");
		const insertSnapshot = sqlite.prepare("insert into context_snapshots(id,context_id,version,sha256,title,body,author,origin_node_id) values(?,?,?,?,?,?,'{}','n')");
		sqlite.transaction(() => {
			for (let c = 0; c < contexts; c++) {
				const id = `ctx_${c.toString(16).padStart(16, "0")}`;
				const make = (v: number) => ({
					title: `${word(c)} ${word(c + v)} notes ${c}`,
					body: Array.from({ length: 60 }, (_, k) => word(c * 31 + v * 17 + k)).join(" ") + ` marker${c} v${v}`,
				});
				const head = make(versions);
				insertContext.run(id, head.title, head.body, versions, `${c}`.padEnd(64, "0"));
				for (let v = 1; v <= versions; v++) {
					const { title, body } = make(v);
					insertSnapshot.run(`snap_${c}_${v}`, id, v, `${c}-${v}`.padEnd(64, "0"), title, body);
				}
			}
		})();
	}

	const timed = (q: string, limit = 20): { ms: number; hits: number } => {
		const t0 = performance.now();
		const hits = searchContexts(db.$client, q, { limit, workspaceId: "w1" });
		return { ms: performance.now() - t0, hits: hits.length };
	};

	for (const [contexts, versions] of [[10_000, 1], [2_000, 5]] as const) {
		it(`answers in under 100 ms with ${contexts} contexts / ${contexts * versions} snapshots`, () => {
			seed(contexts, versions);
			const queries = ["alpha", "deploy release", '"memory plan"', "marker77", "ker", "style form", "zzzz", "node peer task agent"];
			for (const q of queries) timed(q); // warm the page cache and the statement cache
			const worst = Math.max(...queries.map((q) => timed(q).ms));
			expect(timed("marker77").hits).toBeGreaterThanOrEqual(1);
			expect(worst).toBeLessThan(100);
		});
	}
});
