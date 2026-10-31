import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, resolveMigrationsFolder, type ClamDb } from "../src/index.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "clam-db-chats-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const cols = (db: ClamDb, table: string) => (db.$client.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name);

describe("0008_chats", () => {
	it("creates shared_attachments and projects.origin on a fresh file", () => {
		const db = openDatabase({ file: ":memory:" });
		expect(cols(db, "shared_attachments")).toEqual(["id", "shared_session_id", "message_id", "name", "mime_type", "size", "sha256", "origin_node_id", "stored", "copied_path", "created_at"]);
		expect(cols(db, "projects")).toContain("origin");
		db.$client.close();
	});

	it("upgrades a database that stopped at 0007: existing projects become origin 'user', nothing is lost", () => {
		const file = join(dir, "clam.db");
		const older = mkdtempSync(join(dir, "older-"));
		cpSync(resolveMigrationsFolder(), older, { recursive: true });
		const journalPath = join(older, "meta", "_journal.json");
		const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
		const at = journal.entries.findIndex((e) => e.tag === "0008_chats");
		expect(at).toBeGreaterThan(0);
		journal.entries.length = at;
		writeFileSync(journalPath, JSON.stringify(journal));
		const before = openDatabase({ file, migrationsFolder: older });
		before.$client.prepare("insert into node(id,name,public_key,fingerprint) values('n','n','k','f')").run();
		before.$client.prepare("insert into workspaces(id,name,owner_id) values('w','w','n')").run();
		before.$client.prepare("insert into projects(id,workspace_id,name,path,managed) values('p','w','p','/tmp/p',1)").run();
		expect(cols(before, "projects")).not.toContain("origin");
		before.$client.close();

		const after = openDatabase({ file });
		expect(after.$client.prepare("select id, managed, origin from projects").all()).toEqual([{ id: "p", managed: 1, origin: "user" }]);
		expect(after.$client.pragma("foreign_key_check")).toEqual([]);
		// the attachments table cascades with its shared session
		after.$client
			.prepare("insert into shared_sessions(id,workspace_id,title,driver_node_id,driver_node_name,local_role,epoch,state) values('s','w','t','n','n','driver',1,'active')")
			.run();
		after.$client.prepare("insert into shared_attachments(id,shared_session_id,name,mime_type,size,sha256,origin_node_id) values('a','s','f.txt','text/plain',1,?,'n')").run("a".repeat(64));
		expect(after.$client.prepare("select stored from shared_attachments").all()).toEqual([{ stored: 0 }]);
		after.$client.prepare("delete from shared_sessions where id = 's'").run();
		expect(after.$client.prepare("select id from shared_attachments").all()).toEqual([]);
		after.$client.close();
	});
});
