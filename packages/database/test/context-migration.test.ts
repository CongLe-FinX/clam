import Database from "better-sqlite3";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contextReplicas, contextSnapshots, contexts, openDatabase, resolveMigrationsFolder, type ClamDb } from "../src/index.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "clam-db-ctx-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const author = JSON.stringify({ kind: "human", nodeId: "n", nodeName: "n", agentName: null });

function seedWorkspace(db: ClamDb): void {
	const s = db.$client;
	s.prepare("insert into node(id,name,public_key,fingerprint) values('n','n','k','f')").run();
	s.prepare("insert into workspaces(id,name,owner_id) values('w','w','n')").run();
	s.prepare("insert into projects(id,workspace_id,name,path) values('p','w','p','/tmp/p')").run();
	s.prepare("insert into peers(id,name,fingerprint,public_key,key_id,url,paired_at) values('node_peer','peer','f','k','kid','http://127.0.0.1:1','2026-01-01')").run();
}

const insertContext = (db: ClamDb, id: string, o: { title?: string; body?: string; project?: string | null } = {}) =>
	db.$client
		.prepare("insert into contexts(id,workspace_id,project_id,origin_node_id,type,title,body,version,sha256,author) values(?,?,?,?,?,?,?,1,?,?)")
		.run(id, "w", o.project ?? null, "n", "memory", o.title ?? "T", o.body ?? "body text", "a".repeat(64), author);

const ftsHits = (db: ClamDb, q: string) => (db.$client.prepare("select rowid from context_fts where context_fts match ?").all(q) as unknown[]).length;

describe("0007_context", () => {
	it("creates the context tables, the FTS5 index and its triggers on a fresh file", () => {
		const db = openDatabase({ file: join(dir, "clam.db") });
		const names = (type: string) => (db.$client.prepare("select name from sqlite_master where type = ? order by name").all(type) as Array<{ name: string }>).map((r) => r.name);
		expect(names("table")).toEqual(expect.arrayContaining(["contexts", "context_snapshots", "context_replicas", "context_fts"]));
		expect(names("trigger")).toEqual(expect.arrayContaining(["contexts_fts_ai", "contexts_fts_ad", "contexts_fts_au"]));
		const cols = (t: string) => (db.$client.pragma(`table_info(${t})`) as Array<{ name: string }>).map((c) => c.name);
		expect(cols("contexts")).toEqual(["seq", "id", "workspace_id", "project_id", "project_key", "origin_node_id", "type", "title", "body", "shareable", "deleted_at", "version", "sha256", "author", "conflict", "git_path", "created_at", "updated_at"]);
		expect(cols("context_snapshots")).toEqual(["id", "context_id", "version", "sha256", "title", "body", "deleted", "base", "merged", "ancestors", "author", "origin_node_id", "git_path", "created_at"]);
		expect(cols("context_replicas")).toEqual(["context_id", "peer_id", "version", "sha256", "state", "updated_at"]);
		db.$client.close();
	});

	it("keeps the index in step with inserts, edits, tombstones and deletes", () => {
		const db = openDatabase({ file: ":memory:" });
		seedWorkspace(db);
		insertContext(db, "c1", { title: "Style", body: "tabs and spaces" });
		expect(ftsHits(db, "tabs")).toBe(1);
		db.$client.prepare("update contexts set body = 'only spaces' where id = 'c1'").run();
		expect([ftsHits(db, "tabs"), ftsHits(db, "spaces")]).toEqual([0, 1]);
		db.$client.prepare("update contexts set version = 2 where id = 'c1'").run(); // an update of other columns leaves the index alone
		expect(ftsHits(db, "spaces")).toBe(1);
		db.$client.prepare("update contexts set deleted_at = '2026-01-01', body = '' where id = 'c1'").run();
		expect(ftsHits(db, "spaces")).toBe(0);
		insertContext(db, "c2", { body: "removed later" });
		db.$client.prepare("delete from contexts where id = 'c2'").run();
		expect(ftsHits(db, "removed")).toBe(0);
		expect(() => db.$client.prepare("insert into context_fts(context_fts) values('integrity-check')").run()).not.toThrow();
		db.$client.close();
	});

	it("enforces version identity and cascades from workspace, project and peer", () => {
		const db = openDatabase({ file: ":memory:" });
		seedWorkspace(db);
		insertContext(db, "c1", { project: "p", body: "cascade me" });
		const snap = (id: string, version: number, sha: string) =>
			db.$client.prepare("insert into context_snapshots(id,context_id,version,sha256,title,body,author,origin_node_id) values(?,?,?,?,?,?,?,?)").run(id, "c1", version, sha, "T", "b", author, "n");
		snap("s1", 1, "a".repeat(64));
		snap("s2", 2, "a".repeat(64)); // same text as another version number: a different version
		snap("s3", 2, "b".repeat(64)); // concurrent version with the same number
		expect(() => snap("s4", 2, "b".repeat(64))).toThrow(/UNIQUE/);
		db.$client.prepare("insert into context_replicas(context_id,peer_id,version,sha256) values('c1','node_peer',1,?)").run("a".repeat(64));
		expect(db.select().from(contextReplicas).all()).toHaveLength(1);
		db.$client.prepare("delete from peers where id = 'node_peer'").run();
		expect(db.select().from(contextReplicas).all()).toHaveLength(0);
		db.$client.prepare("delete from projects where id = 'p'").run();
		expect(db.select().from(contexts).all()).toHaveLength(0);
		expect(db.select().from(contextSnapshots).all()).toHaveLength(0);
		expect(ftsHits(db, "cascade")).toBe(0);
		insertContext(db, "c3", { body: "workspace scoped" });
		db.$client.prepare("delete from workspaces where id = 'w'").run();
		expect(db.select().from(contexts).all()).toHaveLength(0);
		expect(ftsHits(db, "workspace")).toBe(0);
		db.$client.close();
	});

	it("round-trips the JSON columns through drizzle", () => {
		const db = openDatabase({ file: ":memory:" });
		seedWorkspace(db);
		insertContext(db, "c1");
		db.insert(contextSnapshots)
			.values({ id: "s1", contextId: "c1", version: 3, sha256: "c".repeat(64), title: "T", body: "b", base: { version: 2, sha256: "b".repeat(64) }, merged: [{ version: 2, sha256: "d".repeat(64) }], ancestors: ["2:" + "b".repeat(64)], author: { kind: "agent", nodeId: "n", nodeName: "n", agentName: "omp" }, originNodeId: "n" })
			.run();
		const row = db.select().from(contextSnapshots).get();
		expect(row?.base).toEqual({ version: 2, sha256: "b".repeat(64) });
		expect(row?.merged).toHaveLength(1);
		expect(row?.author.agentName).toBe("omp");
		expect(row?.deleted).toBe(false);
		db.$client.close();
	});

	it("upgrades a database of the previous schema, backs it up first and keeps its data", () => {
		const file = join(dir, "clam.db");
		// An older build knew the committed migrations up to 0006 only.
		const older = mkdtempSync(join(dir, "older-"));
		cpSync(resolveMigrationsFolder(), older, { recursive: true });
		const journalPath = join(older, "meta", "_journal.json");
		const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
		const at = journal.entries.findIndex((e) => e.tag === "0007_context");
		expect(at).toBeGreaterThan(0);
		journal.entries.length = at;
		writeFileSync(journalPath, JSON.stringify(journal));
		const before = openDatabase({ file, migrationsFolder: older });
		seedWorkspace(before);
		expect((before.$client.prepare("select name from sqlite_master where name = 'contexts'").all() as unknown[]).length).toBe(0);
		before.$client.close();

		const after = openDatabase({ file });
		const backups = readdirSync(dirname(file)).filter((n) => n.startsWith("clam.db.pre-migrate-") && n.endsWith(".bak"));
		expect(backups).toHaveLength(1);
		const snapshot = new Database(join(dir, backups[0] as string), { readonly: true });
		expect(snapshot.prepare("select name from sqlite_master where name in ('contexts','context_fts')").all()).toEqual([]);
		expect(snapshot.prepare("select id from workspaces").all()).toEqual([{ id: "w" }]);
		snapshot.close();
		expect(after.$client.prepare("select id from workspaces").all()).toEqual([{ id: "w" }]);
		expect(after.$client.prepare("select id from peers").all()).toEqual([{ id: "node_peer" }]);
		insertContext(after, "c1", { body: "after the upgrade" });
		expect(ftsHits(after, "upgrade")).toBe(1);
		expect(after.$client.pragma("foreign_key_check")).toEqual([]);
		after.$client.close();

		// Reopening an up-to-date file neither re-migrates nor backs up again.
		openDatabase({ file }).$client.close();
		expect(readdirSync(dirname(file)).filter((n) => n.includes(".pre-migrate-"))).toHaveLength(1);
	});
});
