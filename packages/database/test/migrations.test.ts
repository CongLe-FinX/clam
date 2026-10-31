import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
	agentSessions,
	agents,
	artifacts,
	type ClamDb,
	gitSyncStates,
	idempotencyRecords,
	githubConnections,
	githubRepositories,
	networkEvents,
	node,
	nonceLog,
	openDatabase,
	outbox,
	pairingInvitations,
	pairingRequests,
	peerAgents,
	peers,
	projects,
	resolveMigrationsFolder,
	settings,
	sharedCheckpoints,
	sharedInvites,
	sharedMessages,
	sharedMirrorMessages,
	sharedMirrorState,
	sharedParticipants,
	sharedSessions,
	taskEvents,
	taskMessages,
	tasks,
	workspaceMembers,
	workspaces,
} from "../src/index.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "clam-db-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function columns(db: ReturnType<typeof openDatabase>, table: string): string[] {
	return (db.$client.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name);
}

describe("openDatabase", () => {
	it("applies committed migrations on a fresh file and is idempotent on reopen", () => {
		const file = join(dir, "nested", "clam.db");
		const db = openDatabase({ file });
		expect(db.$client.pragma("journal_mode", { simple: true })).toBe("wal");
		expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
		expect(db.$client.pragma("busy_timeout", { simple: true })).toBe(5000);
		const tables = (db.$client.prepare("select name from sqlite_master where type='table'").all() as Array<{ name: string }>).map(
			(t) => t.name,
		);
		for (const name of [
			"node",
			"settings",
			"workspaces",
			"workspace_members",
			"projects",
			"agents",
			"agent_sessions",
			"provider_usage",
			"github_connections",
			"github_repositories",
			"node_events",
		]) {
			expect(tables).toContain(name);
		}
		db.$client.close();
		const again = openDatabase({ file });
		expect(again.select().from(settings).all()).toEqual([]);
		again.$client.close();
	});

	it("exposes the exact columns ServerIntegrations depends on", () => {
		const db = openDatabase({ file: ":memory:" });
		expect(columns(db, "settings")).toEqual(["key", "value", "updated_at"]);
		expect(columns(db, "github_connections")).toEqual([
			"id",
			"login",
			"name",
			"email",
			"avatar_url",
			"scopes",
			"source",
			"is_default",
			"status",
			"credential_ref",
			"last_verified_at",
			"created_at",
		]);
		expect(columns(db, "github_repositories")).toEqual([
			"id",
			"owner",
			"name",
			"html_url",
			"default_branch",
			"account_id",
			"updated_at",
		]);
	});

	it("enforces foreign keys and cascades workspace deletion to projects", () => {
		const db = openDatabase({ file: ":memory:" });
		db.insert(node).values({ id: "n1", name: "n", publicKey: "k", fingerprint: "f" }).run();
		expect(() => db.insert(workspaces).values({ id: "w0", name: "x", ownerNodeId: "missing" }).run()).toThrow(/FOREIGN KEY/);
		db.insert(workspaces).values({ id: "w1", name: "w", ownerNodeId: "n1" }).run();
		db.insert(projects).values({ id: "p1", workspaceId: "w1", name: "p", path: "/tmp" }).run();
		db.delete(workspaces).where(eq(workspaces.id, "w1")).run();
		expect(db.select().from(projects).all()).toEqual([]);
	});

	it("round-trips JSON columns and github tables", () => {
		const db = openDatabase({ file: ":memory:" });
		db.insert(githubConnections)
			.values({ id: "c1", login: "octo", source: "oauth-device", credentialRef: "github:c1", scopes: JSON.stringify(["repo"]) })
			.run();
		db.insert(githubRepositories).values({ id: "1", owner: "octo", name: "r", htmlUrl: "https://github.com/octo/r", accountId: "c1" }).run();
		expect(() =>
			db.insert(githubConnections).values({ id: "c2", login: "octo", source: "gh-cli", credentialRef: "x" }).run(),
		).toThrow(/UNIQUE/);
		db.delete(githubConnections).where(eq(githubConnections.id, "c1")).run();
		expect(db.select().from(githubRepositories).get()?.accountId).toBeNull();
	});
});

describe("git_sync_states", () => {
	it("keys rows by (project, branch), defaults dirty to false and cascades with the project", () => {
		const db = openDatabase({ file: ":memory:" });
		expect(columns(db, "git_sync_states")).toEqual([
			"project_id", "branch", "commit_sha", "remote_sha", "ahead", "behind", "dirty",
			"last_fetched_at", "last_pushed_at", "last_pulled_at", "updated_at",
		]);
		db.insert(node).values({ id: "n1", name: "n", publicKey: "k", fingerprint: "f" }).run();
		db.insert(workspaces).values({ id: "w1", name: "w", ownerNodeId: "n1" }).run();
		db.insert(projects).values({ id: "p1", workspaceId: "w1", name: "p", path: "/tmp" }).run();
		expect(() => db.insert(gitSyncStates).values({ projectId: "nope", branch: "main", commitSha: "a" }).run()).toThrow(/FOREIGN KEY/);
		db.insert(gitSyncStates).values({ projectId: "p1", branch: "main", commitSha: "a" }).run();
		db.insert(gitSyncStates).values({ projectId: "p1", branch: "dev", commitSha: "b" }).run();
		expect(() => db.insert(gitSyncStates).values({ projectId: "p1", branch: "main", commitSha: "c" }).run()).toThrow(/UNIQUE|PRIMARY/);
		expect(db.select().from(gitSyncStates).all().every((r) => r.dirty === false)).toBe(true);
		db.delete(projects).where(eq(projects.id, "p1")).run();
		expect(db.select().from(gitSyncStates).all()).toEqual([]);
	});
});

describe("pre-migration backups", () => {
	/** A migrations folder with `count` synthetic migrations; migration k creates table `t<k>`. */
	function migrationsUpTo(count: number): string {
		const folder = mkdtempSync(join(dir, "migrations-"));
		mkdirSync(join(folder, "meta"));
		const entries = [];
		for (let k = 0; k < count; k++) {
			const tag = `000${k}_step`;
			writeFileSync(join(folder, `${tag}.sql`), `CREATE TABLE t${k} (id integer primary key, note text);`);
			entries.push({ idx: k, version: "6", when: 1_700_000_000_000 + k * 1000, tag, breakpoints: true });
		}
		writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify({ version: "7", dialect: "sqlite", entries }));
		return folder;
	}

	const backupsOf = (file: string) => readdirSync(dirname(file)).filter((n) => n.startsWith("clam.db.pre-migrate-") && n.endsWith(".bak")).sort();

	it("does not back up a brand-new database, an up-to-date one, or :memory:", () => {
		const file = join(dir, "clam.db");
		openDatabase({ file, migrationsFolder: migrationsUpTo(2) }).$client.close();
		openDatabase({ file, migrationsFolder: migrationsUpTo(2) }).$client.close();
		openDatabase({ file: ":memory:", migrationsFolder: migrationsUpTo(2) }).$client.close();
		expect(backupsOf(file)).toEqual([]);
	});

	it("snapshots the pre-migration state (including WAL contents) before applying pending migrations", () => {
		const file = join(dir, "clam.db");
		const first = openDatabase({ file, migrationsFolder: migrationsUpTo(1) });
		first.$client.prepare("insert into t0 (note) values ('precious')").run();
		// Left in the WAL on purpose: a plain copy of the main file would not contain this row.
		first.$client.close();
		const second = openDatabase({ file, migrationsFolder: migrationsUpTo(2) });
		const [backup] = backupsOf(file);
		expect(backup).toMatch(/^clam\.db\.pre-migrate-\d{8}T\d{9}Z\.bak$/);
		const snapshot = new Database(join(dir, backup as string), { readonly: true });
		expect(snapshot.prepare("select note from t0").all()).toEqual([{ note: "precious" }]);
		expect(snapshot.prepare("select name from sqlite_master where name = 't1'").get()).toBeUndefined();
		snapshot.close();
		expect(second.$client.prepare("select name from sqlite_master where name = 't1'").get()).toBeDefined();
		second.$client.close();
	});

	it("keeps only the newest three snapshots", () => {
		const file = join(dir, "clam.db");
		for (let count = 1; count <= 6; count++) openDatabase({ file, migrationsFolder: migrationsUpTo(count) }).$client.close();
		const kept = backupsOf(file);
		expect(kept).toHaveLength(3);
		// Snapshots taken before migrations 4, 5 and 6 each hold exactly the tables that existed then.
		const tablesIn = (name: string) => {
			const snapshot = new Database(join(dir, name), { readonly: true });
			const tables = (snapshot.prepare("select name from sqlite_master where type = 'table' and name like 't%' order by name").all() as Array<{ name: string }>).map((t) => t.name);
			snapshot.close();
			return tables;
		};
		expect(kept.map(tablesIn)).toEqual([["t0", "t1", "t2"], ["t0", "t1", "t2", "t3"], ["t0", "t1", "t2", "t3", "t4"]]);
	});

	it("honours a custom retention count", () => {
		const file = join(dir, "clam.db");
		for (let count = 1; count <= 4; count++) openDatabase({ file, migrationsFolder: migrationsUpTo(count), keepMigrationBackups: 1 }).$client.close();
		expect(backupsOf(file)).toHaveLength(1);
	});

	it("does not migrate when the snapshot cannot be written", () => {
		const file = join(dir, "clam.db");
		openDatabase({ file, migrationsFolder: migrationsUpTo(1) }).$client.close();
		// A directory squatting on every possible backup name is not feasible; make the directory read-only instead.
		if (process.platform === "win32" || process.getuid?.() === 0) return;
		chmodSync(dir, 0o555);
		try {
			expect(() => openDatabase({ file, migrationsFolder: migrationsUpTo(2) })).toThrow();
		} finally {
			chmodSync(dir, 0o755);
		}
		const check = new Database(file, { readonly: true });
		expect(check.prepare("select name from sqlite_master where name = 't1'").get()).toBeUndefined();
		check.close();
	});

	it("backs up a real committed-migration database when a newer migration appears", () => {
		const file = join(dir, "clam.db");
		// An older build knew every committed migration except the newest one.
		const older = mkdtempSync(join(dir, "older-"));
		cpSync(resolveMigrationsFolder(), older, { recursive: true });
		const journalPath = join(older, "meta", "_journal.json");
		const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: unknown[] };
		journal.entries.pop();
		writeFileSync(journalPath, JSON.stringify(journal));
		openDatabase({ file, migrationsFolder: older }).$client.close();
		expect(backupsOf(file)).toEqual([]);

		const db = openDatabase({ file });
		expect(backupsOf(file)).toHaveLength(1);
		expect(columns(db, "peers")).toContain("public_key");
		db.$client.close();
	});
});

describe("0003_network", () => {
	it("creates the M3 tables and extends workspace_members without touching existing rows", () => {
		const db = openDatabase({ file: ":memory:" });
		expect(columns(db, "workspace_members")).toEqual(["workspace_id", "member_id", "role", "created_at", "permissions", "granted_by", "revoked_at"]);
		expect(columns(db, "peers")).toEqual([
			"id", "name", "fingerprint", "public_key", "key_id", "url", "status", "granted_capabilities", "received_capabilities",
			"protocol_version", "latency_ms", "last_seen_at", "last_error", "last_event_cursor", "paired_at", "revoked_at", "revoked_by", "updated_at",
			"auto_accept_tasks",
		]);
		expect(columns(db, "peer_agents")).toEqual(["peer_id", "agent_id", "name", "role", "runtime", "capabilities", "status", "active_sessions", "fetched_at"]);
		expect(columns(db, "nonce_log")).toEqual(["peer_id", "nonce", "expires_at"]);
		expect(columns(db, "network_events")).toEqual(["stream", "seq", "type", "payload", "audience", "created_at"]);
		expect(columns(db, "pairing_invitations")).toContain("code_hash");
		expect(columns(db, "pairing_invitations")).not.toContain("code");
		expect(columns(db, "pairing_requests")).not.toContain("code");
		expect(columns(db, "pairing_joins")).not.toContain("code");
	});

	it("keys peers, agents, nonces and events, cascades peer agents and workspace invitations", () => {
		const db = openDatabase({ file: ":memory:" });
		db.insert(node).values({ id: "n1", name: "n", publicKey: "k", fingerprint: "f" }).run();
		db.insert(workspaces).values({ id: "w1", name: "w", ownerNodeId: "n1" }).run();
		db.insert(workspaceMembers).values({ workspaceId: "w1", memberId: "n1", role: "owner" }).run();
		expect(db.select().from(workspaceMembers).get()).toMatchObject({ permissions: [], grantedBy: null, revokedAt: null });

		db.insert(peers).values({ id: "node_b", name: "B", fingerprint: "f", publicKey: "k", keyId: "k", url: "https://b.example" }).run();
		expect(db.select().from(peers).get()).toMatchObject({ status: "offline", grantedCapabilities: [], receivedCapabilities: [], revokedBy: null });
		expect(() => db.insert(peers).values({ id: "node_b", name: "B", fingerprint: "f", publicKey: "k", keyId: "k", url: "u" }).run()).toThrow(/UNIQUE|PRIMARY/);
		expect(() => db.insert(peerAgents).values({ peerId: "ghost", agentId: "a", name: "A", runtime: "omp" }).run()).toThrow(/FOREIGN KEY/);
		db.insert(peerAgents).values({ peerId: "node_b", agentId: "a", name: "A", runtime: "omp", capabilities: ["code"] }).run();
		expect(() => db.insert(peerAgents).values({ peerId: "node_b", agentId: "a", name: "A2", runtime: "omp" }).run()).toThrow(/UNIQUE|PRIMARY/);

		db.insert(nonceLog).values({ peerId: "node_b", nonce: "n", expiresAt: 1 }).run();
		expect(() => db.insert(nonceLog).values({ peerId: "node_b", nonce: "n", expiresAt: 2 }).run()).toThrow(/UNIQUE|PRIMARY/);
		db.insert(networkEvents).values({ stream: "node", seq: 1, type: "health", payload: {} }).run();
		expect(() => db.insert(networkEvents).values({ stream: "node", seq: 1, type: "health", payload: {} }).run()).toThrow(/UNIQUE|PRIMARY/);

		db.insert(pairingInvitations).values({ id: "inv_1", workspaceId: "w1", codeHash: "h", capabilities: ["agents.read"], expiresAt: "2030-01-01T00:00:00.000Z" }).run();
		expect(db.select().from(pairingInvitations).get()).toMatchObject({ state: "pending", attempts: 0, maxAttempts: 5, consumedAt: null });
		db.insert(pairingRequests)
			.values({
				id: "pr_1", invitationId: "inv_1", workspaceId: "w1", remoteNodeId: "node_c", remoteName: "C", remotePublicKey: "k", remoteFingerprint: "f",
				remoteUrl: "https://c.example", nonceInviter: "a", nonceJoiner: "b", helloResponse: { ok: true }, correlationId: "c",
			})
			.run();
		expect(() =>
			db.insert(pairingRequests).values({ id: "pr_2", invitationId: "inv_1", workspaceId: "w1", remoteNodeId: "x", remoteName: "x", remotePublicKey: "k", remoteFingerprint: "f", remoteUrl: "u", nonceInviter: "a", nonceJoiner: "b", helloResponse: {}, correlationId: "c" }).run(),
		).toThrow(/UNIQUE/);

		db.delete(peers).where(eq(peers.id, "node_b")).run();
		expect(db.select().from(peerAgents).all()).toEqual([]);
		db.delete(workspaces).where(eq(workspaces.id, "w1")).run();
		expect(db.select().from(pairingInvitations).all()).toEqual([]);
		expect(db.select().from(pairingRequests).all()).toEqual([]);
	});
});

describe("0004_tasks", () => {
	const taskBase = {
		direction: "outgoing",
		peerId: "node_b",
		workspaceId: "w1",
		title: "T",
		repoUrl: "https://github.com/o/r",
		senderNodeId: "node_a",
		senderNodeName: "A",
		executorNodeId: "node_b",
		executorNodeName: "B",
		correlationId: "corr",
	};

	it("creates the M4 tables with the documented columns and adds peers.auto_accept_tasks", () => {
		const db = openDatabase({ file: ":memory:" });
		expect(columns(db, "tasks")).toEqual([
			"id", "direction", "peer_id", "workspace_id", "project_id", "title", "description", "status", "epoch", "repo_url", "repo_branch", "repo_commit",
			"deliver_as", "input_files", "constraints", "sender_node_id", "sender_node_name", "sender_agent_id", "sender_agent_name", "sender_session_id",
			"executor_node_id", "executor_node_name", "executor_agent_id", "executor_agent_name", "executor_session_id", "reason", "result", "cost",
			"retry_of", "correlation_id", "last_event_seq", "exec_state", "notified_status", "created_at", "updated_at", "started_at", "finished_at",
			"fenced", "highest_seen_epoch",
		]);
		expect(columns(db, "task_events")).toEqual(["task_id", "seq", "type", "summary", "payload", "created_at"]);
		expect(columns(db, "task_messages")).toEqual([
			"id", "task_id", "author_kind", "author_node_id", "author_node_name", "author_agent_id", "author_agent_name", "kind", "text", "created_at",
			"delivery", "injected_session_id", "read_at", "received_at",
		]);
		expect(columns(db, "outbox")).toEqual([
			"id", "peer_id", "task_id", "kind", "ref_id", "method", "path", "body", "idempotency_key", "correlation_id", "attempts", "next_attempt_at",
			"state", "last_error", "last_status", "created_at", "sent_at",
		]);
		expect(columns(db, "idempotency_records")).toEqual(["peer_id", "key", "method", "path", "request_hash", "status", "response_body", "created_at", "expires_at"]);
		expect(columns(db, "artifacts")).toEqual(["id", "task_id", "name", "media_type", "size", "sha256", "storage_path", "created_at"]);
		expect(columns(db, "peers")).toContain("auto_accept_tasks");
	});

	it("applies defaults, keys events by (task, seq), cascades from tasks and enforces the outbox idempotency key per peer", () => {
		const db = openDatabase({ file: ":memory:" });
		db.insert(peers).values({ id: "node_b", name: "B", fingerprint: "f", publicKey: "k", keyId: "k", url: "https://b.example" }).run();
		expect(db.select().from(peers).get()).toMatchObject({ autoAcceptTasks: false });
		db.insert(tasks).values({ id: "tsk_1", ...taskBase }).run();
		expect(db.select().from(tasks).get()).toMatchObject({ status: "offered", epoch: 0, deliverAs: "branch", constraints: {}, execState: {}, lastEventSeq: 0, projectId: null, result: null });

		db.insert(taskEvents).values({ taskId: "tsk_1", seq: 1, type: "status", summary: "offered", payload: { to: "offered" } }).run();
		expect(() => db.insert(taskEvents).values({ taskId: "tsk_1", seq: 1, type: "status", summary: "dup" }).run()).toThrow(/UNIQUE|PRIMARY/);
		expect(() => db.insert(taskEvents).values({ taskId: "ghost", seq: 1, type: "status", summary: "x" }).run()).toThrow(/FOREIGN KEY/);

		db.insert(taskMessages).values({ id: "msg_1", taskId: "tsk_1", authorKind: "human", authorNodeId: "node_a", authorNodeName: "A", kind: "note", text: "hi", createdAt: "2030-01-01T00:00:00.000Z" }).run();
		expect(db.select().from(taskMessages).get()).toMatchObject({ delivery: "local", injectedSessionId: null, readAt: null });
		expect(() => db.insert(taskMessages).values({ id: "msg_1", taskId: "tsk_1", authorKind: "human", authorNodeId: "node_a", authorNodeName: "A", kind: "note", text: "again", createdAt: "x" }).run()).toThrow(/UNIQUE|PRIMARY/);

		const call = { peerId: "node_b", taskId: "tsk_1", kind: "task.create", method: "POST", path: "/tasks", body: { taskId: "tsk_1" }, idempotencyKey: "k1", correlationId: "c", nextAttemptAt: "2030-01-01T00:00:00.000Z" };
		db.insert(outbox).values({ id: "ob_1", ...call }).run();
		expect(db.select().from(outbox).get()).toMatchObject({ state: "pending", attempts: 0, body: { taskId: "tsk_1" }, lastError: null });
		expect(() => db.insert(outbox).values({ id: "ob_2", ...call }).run()).toThrow(/UNIQUE/);
		db.insert(outbox).values({ id: "ob_3", ...call, idempotencyKey: "k2" }).run();

		db.insert(artifacts).values({ id: "art_1", taskId: "tsk_1", name: "x.patch", mediaType: "text/x-patch", size: 1, sha256: "a".repeat(64), storagePath: "tsk_1/art_1" }).run();
		db.insert(idempotencyRecords).values({ peerId: "node_a", key: "k", method: "POST", path: "/tasks", requestHash: "h", status: 201, responseBody: "{}", expiresAt: 1 }).run();
		expect(() => db.insert(idempotencyRecords).values({ peerId: "node_a", key: "k", method: "POST", path: "/tasks", requestHash: "h2", status: 200, responseBody: "{}", expiresAt: 2 }).run()).toThrow(/UNIQUE|PRIMARY/);

		db.delete(tasks).where(eq(tasks.id, "tsk_1")).run();
		expect(db.select().from(taskEvents).all()).toEqual([]);
		expect(db.select().from(taskMessages).all()).toEqual([]);
		expect(db.select().from(artifacts).all()).toEqual([]);
		// the outbox is keyed to the peer, not the task: removing the peer (re-pairing) drops what can no longer be delivered
		expect(db.select().from(outbox).all()).toHaveLength(2);
		db.delete(peers).where(eq(peers.id, "node_b")).run();
		expect(db.select().from(outbox).all()).toEqual([]);
	});

	it("migrates a database that stopped at 0003 (data kept, peers gain auto_accept_tasks = false) after a pre-migrate snapshot", () => {
		const file = join(dir, "clam.db");
		const older = mkdtempSync(join(dir, "older-"));
		cpSync(resolveMigrationsFolder(), older, { recursive: true });
		const journalPath = join(older, "meta", "_journal.json");
		const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
		expect(journal.entries.map((e) => e.tag)).toEqual(expect.arrayContaining(["0004_tasks", "0005_shared", "0006_nogit"]));
		journal.entries.length = journal.entries.findIndex((e) => e.tag === "0004_tasks"); // truncate at the cut: later migrations must not be applied either
		writeFileSync(journalPath, JSON.stringify(journal));

		const before = openDatabase({ file, migrationsFolder: older });
		expect(columns(before, "peers")).not.toContain("auto_accept_tasks");
		// Raw SQL: the drizzle table object already knows the 0004 column.
		before.$client.prepare("insert into peers (id, name, fingerprint, public_key, key_id, url, granted_capabilities) values ('node_b', 'B', 'f', 'k', 'k', 'https://b.example', '[\"tasks.send\"]')").run();
		before.$client.close();

		const db = openDatabase({ file });
		expect(db.select().from(peers).get()).toMatchObject({ id: "node_b", grantedCapabilities: ["tasks.send"], autoAcceptTasks: false });
		expect(db.select().from(tasks).all()).toEqual([]);
		db.$client.close();

		const [backup] = readdirSync(dir).filter((n) => n.startsWith("clam.db.pre-migrate-") && n.endsWith(".bak"));
		expect(backup).toBeDefined();
		const snapshot = new Database(join(dir, backup as string), { readonly: true });
		expect(snapshot.prepare("select name from sqlite_master where name = 'tasks'").get()).toBeUndefined();
		expect(snapshot.prepare("select id from peers").all()).toEqual([{ id: "node_b" }]);
		snapshot.close();
	});
});

describe("0005_shared", () => {
	it("adds kind / shared_session_id / moved_to to agent_sessions and creates the shared-session tables with the documented columns", () => {
		const db = openDatabase({ file: ":memory:" });
		expect(columns(db, "agent_sessions").slice(-3)).toEqual(["kind", "shared_session_id", "moved_to"]);
		expect(columns(db, "shared_sessions")).toEqual([
			"id", "workspace_id", "title", "goal", "vcs", "repo_url", "branch", "base_branch", "base_commit", "epoch", "driver_node_id", "driver_node_name",
			"local_role", "state", "local_session_id", "mirror_session_id", "local_project_id", "agent_message_limit", "rescue_branch", "rescue_files",
			"last_checkpoint_seq", "meta", "created_at", "updated_at",
		]);
		expect(columns(db, "shared_participants")).toEqual([
			"shared_session_id", "node_id", "node_name", "agent_id", "agent_name", "role", "state", "agent_session_id", "ui_url", "snapshot_seq",
			"briefed", "joined_at", "created_at", "updated_at",
		]);
		expect(columns(db, "shared_messages")).toEqual([
			"id", "shared_session_id", "author_kind", "author_node_id", "author_node_name", "author_agent_id", "author_agent_name", "kind", "to", "text", "epoch",
			"created_at", "hlc", "origin_seq", "delivery", "injected_session_id", "read_at", "received_at",
		]);
		expect(columns(db, "shared_checkpoints")).toEqual([
			"shared_session_id", "seq", "epoch", "node_id", "branch", "commit", "pushed", "files", "files_path", "snapshot_sha256", "snapshot_size", "snapshot_messages",
			"snapshot_path", "model", "delivered_to", "note", "created_at",
		]);
		expect(columns(db, "shared_invites")).toEqual([
			"id", "shared_session_id", "from_node_id", "from_node_name", "from_agent_id", "from_agent_name", "title", "goal", "vcs", "repo_url", "repo_branch", "workspace_id",
			"agent_id", "epoch", "driver_ui_url", "model", "state", "created_at", "decided_at",
		]);
		expect(columns(db, "shared_mirror_messages")).toEqual(["mirror_session_id", "message_id", "position", "message", "updated_at"]);
		expect(columns(db, "shared_mirror_state")).toEqual(["mirror_session_id", "shared_session_id", "epoch", "stream_id", "last_seq", "syncing", "state", "updated_at"]);
		db.$client.close();
	});

	function seedSession(db: ClamDb, id: string, over: Partial<typeof agentSessions.$inferInsert> = {}): void {
		db.insert(agentSessions).values({ id, agentId: "ag1", projectId: "p1", title: "T", sessionDir: `/tmp/${id}`, ...over }).run();
	}
	function seedBase(db: ClamDb): void {
		db.insert(node).values({ id: "n1", name: "n", publicKey: "k", fingerprint: "f" }).run();
		db.insert(workspaces).values({ id: "w1", name: "w", ownerNodeId: "n1" }).run();
		db.insert(projects).values({ id: "p1", workspaceId: "w1", name: "p", path: "/tmp/p" }).run();
		db.insert(agents).values({ id: "ag1", nodeId: "n1", name: "a", runtime: "omp" }).run();
	}

	it("applies defaults, keys rows, cascades from the shared session and the mirror session, and nulls local links", () => {
		const db = openDatabase({ file: ":memory:" });
		seedBase(db);
		seedSession(db, "ses_1");
		expect(db.select().from(agentSessions).get()).toMatchObject({ kind: "local", sharedSessionId: null, movedTo: null });
		seedSession(db, "ses_m", { kind: "mirror", sharedSessionId: "shs_1" });

		db.insert(sharedSessions)
			.values({ id: "shs_1", workspaceId: "w1", title: "T", repoUrl: "https://github.com/o/r", branch: "clam/shared/t-abc", driverNodeId: "n1", driverNodeName: "A", localRole: "driver", localSessionId: "ses_1", mirrorSessionId: "ses_m", localProjectId: "p1" })
			.run();
		expect(db.select().from(sharedSessions).get()).toMatchObject({ epoch: 1, state: "active", agentMessageLimit: 12, lastCheckpointSeq: 0, rescueBranch: null, meta: {}, goal: "" });
		expect(() => db.insert(sharedSessions).values({ id: "shs_1", workspaceId: "w1", title: "T", repoUrl: "u", branch: "b", driverNodeId: "n1", driverNodeName: "A", localRole: "driver" }).run()).toThrow(/UNIQUE|PRIMARY/);

		db.insert(sharedParticipants).values({ sharedSessionId: "shs_1", nodeId: "node_b", nodeName: "B", role: "participant", state: "invited" }).run();
		expect(db.select().from(sharedParticipants).get()).toMatchObject({ snapshotSeq: 0, briefed: false, agentId: null, joinedAt: null });
		expect(() => db.insert(sharedParticipants).values({ sharedSessionId: "shs_1", nodeId: "node_b", nodeName: "B", role: "participant", state: "active" }).run()).toThrow(/UNIQUE|PRIMARY/);
		expect(() => db.insert(sharedParticipants).values({ sharedSessionId: "ghost", nodeId: "x", nodeName: "x", role: "participant", state: "active" }).run()).toThrow(/FOREIGN KEY/);

		const message = { id: "shm_1", sharedSessionId: "shs_1", authorKind: "human", authorNodeId: "n1", authorNodeName: "A", kind: "chat", text: "hi", createdAt: "2030-01-01T00:00:00.000Z", hlc: "001893456000000-00000", originSeq: 1 };
		db.insert(sharedMessages).values(message).run();
		expect(db.select().from(sharedMessages).get()).toMatchObject({ delivery: "local", epoch: 1, injectedSessionId: null, readAt: null, to: { mode: "lead", agents: [] }, originSeq: 1 });
		expect(() => db.insert(sharedMessages).values(message).run()).toThrow(/UNIQUE|PRIMARY/);
		// one origin cannot reuse a sequence number in one session, another origin can; local-only notes (no sequence) never collide
		expect(() => db.insert(sharedMessages).values({ ...message, id: "shm_dup_seq" }).run()).toThrow(/UNIQUE/);
		db.insert(sharedMessages).values({ ...message, id: "shm_other_origin", authorNodeId: "n2", to: { mode: "agents", agents: [{ nodeId: "n1", agentId: "ag1" }] } }).run();
		db.insert(sharedMessages).values({ ...message, id: "shm_local_1", authorKind: "system", kind: "system", originSeq: null }).run();
		db.insert(sharedMessages).values({ ...message, id: "shm_local_2", authorKind: "system", kind: "system", originSeq: null }).run();
		expect(db.select().from(sharedMessages).all().find((m) => m.id === "shm_other_origin")?.to).toEqual({ mode: "agents", agents: [{ nodeId: "n1", agentId: "ag1" }] });
		for (const id of ["shm_other_origin", "shm_local_1", "shm_local_2"]) db.delete(sharedMessages).where(eq(sharedMessages.id, id)).run();

		db.insert(sharedCheckpoints).values({ sharedSessionId: "shs_1", seq: 1, epoch: 1, nodeId: "n1", branch: "clam/shared/t-abc" }).run();
		expect(db.select().from(sharedCheckpoints).get()).toMatchObject({ pushed: false, commit: null, snapshotPath: null, deliveredTo: [] });
		expect(() => db.insert(sharedCheckpoints).values({ sharedSessionId: "shs_1", seq: 1, epoch: 1, nodeId: "n1", branch: "b" }).run()).toThrow(/UNIQUE|PRIMARY/);

		db.insert(sharedInvites).values({ id: "shi_1", sharedSessionId: "shs_1", fromNodeId: "n1", fromNodeName: "A", title: "T", repoUrl: "u", repoBranch: "b", workspaceId: "w1", epoch: 1 }).run();
		expect(db.select().from(sharedInvites).get()).toMatchObject({ state: "pending", agentId: null, decidedAt: null });

		db.insert(sharedMirrorMessages).values({ mirrorSessionId: "ses_m", messageId: "m1", position: 1, message: { id: "m1", role: "user", timestamp: 1, content: [] } }).run();
		expect(() => db.insert(sharedMirrorMessages).values({ mirrorSessionId: "ses_m", messageId: "m1", position: 2, message: { id: "m1", role: "user", timestamp: 1, content: [] } }).run()).toThrow(/UNIQUE|PRIMARY/);
		db.insert(sharedMirrorState).values({ mirrorSessionId: "ses_m", sharedSessionId: "shs_1", epoch: 1 }).run();
		expect(db.select().from(sharedMirrorState).get()).toMatchObject({ lastSeq: 0, syncing: false, streamId: null, state: null });

		// Deleting the mirror session removes its transcript and stream state, and unlinks the shared session's pointer.
		db.delete(agentSessions).where(eq(agentSessions.id, "ses_m")).run();
		expect(db.select().from(sharedMirrorMessages).all()).toEqual([]);
		expect(db.select().from(sharedMirrorState).all()).toEqual([]);
		expect(db.select().from(sharedSessions).get()).toMatchObject({ mirrorSessionId: null, localSessionId: "ses_1" });
		db.delete(projects).where(eq(projects.id, "p1")).run();
		expect(db.select().from(sharedSessions).get()).toMatchObject({ localProjectId: null });

		// Deleting the shared session cascades to everything that belongs to it.
		db.delete(sharedSessions).where(eq(sharedSessions.id, "shs_1")).run();
		expect(db.select().from(sharedParticipants).all()).toEqual([]);
		expect(db.select().from(sharedMessages).all()).toEqual([]);
		expect(db.select().from(sharedCheckpoints).all()).toEqual([]);
		// Invitations are not owned by a shared session row (the session does not exist on the invited node until it accepts).
		expect(db.select().from(sharedInvites).all()).toHaveLength(1);
		db.$client.close();
	});

	it("migrates a database that stopped at 0004 (sessions and tasks kept; sessions become kind=local) after a pre-migrate snapshot", () => {
		const file = join(dir, "clam.db");
		const older = mkdtempSync(join(dir, "older-"));
		cpSync(resolveMigrationsFolder(), older, { recursive: true });
		const journalPath = join(older, "meta", "_journal.json");
		const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
		expect(journal.entries.map((e) => e.tag)).toEqual(expect.arrayContaining(["0005_shared", "0006_nogit"]));
		journal.entries.length = journal.entries.findIndex((e) => e.tag === "0005_shared"); // truncate at the cut: later migrations must not be applied either
		writeFileSync(journalPath, JSON.stringify(journal));

		const before = openDatabase({ file, migrationsFolder: older });
		expect(columns(before, "agent_sessions")).not.toContain("kind");
		expect(before.$client.prepare("select name from sqlite_master where name = 'shared_sessions'").get()).toBeUndefined();
		before.$client.prepare("insert into node (id, name, public_key, fingerprint) values ('n1', 'n', 'k', 'f')").run();
		before.$client.prepare("insert into workspaces (id, name, owner_id) values ('w1', 'w', 'n1')").run();
		before.$client.prepare("insert into projects (id, workspace_id, name, path) values ('p1', 'w1', 'p', '/tmp/p')").run();
		before.$client.prepare("insert into agents (id, node_id, name, runtime) values ('ag1', 'n1', 'a', 'omp')").run();
		before.$client.prepare("insert into agent_sessions (id, agent_id, project_id, title, session_dir) values ('ses_old', 'ag1', 'p1', 'Old session', '/tmp/ses_old')").run();
		before.$client.close();

		const db = openDatabase({ file });
		expect(db.select().from(agentSessions).get()).toMatchObject({ id: "ses_old", title: "Old session", kind: "local", sharedSessionId: null, movedTo: null });
		expect(db.select().from(sharedSessions).all()).toEqual([]);
		db.$client.close();

		const [backup] = readdirSync(dir).filter((n) => n.startsWith("clam.db.pre-migrate-") && n.endsWith(".bak"));
		expect(backup).toBeDefined();
		const snapshot = new Database(join(dir, backup as string), { readonly: true });
		expect(snapshot.prepare("select name from sqlite_master where name = 'shared_sessions'").get()).toBeUndefined();
		expect(snapshot.prepare("select id from agent_sessions").all()).toEqual([{ id: "ses_old" }]);
		snapshot.close();
	});

	it("migrates a database that stopped at 0003 straight to the latest schema in one run (the whole chain)", () => {
		const file = join(dir, "clam.db");
		const older = mkdtempSync(join(dir, "older-"));
		cpSync(resolveMigrationsFolder(), older, { recursive: true });
		const journalPath = join(older, "meta", "_journal.json");
		const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
		journal.entries.length = journal.entries.findIndex((e) => e.tag === "0004_tasks"); // truncate at the cut: later migrations must not be applied either
		writeFileSync(journalPath, JSON.stringify(journal));
		const before = openDatabase({ file, migrationsFolder: older });
		before.$client.prepare("insert into peers (id, name, fingerprint, public_key, key_id, url) values ('node_b', 'B', 'f', 'k', 'k', 'https://b.example')").run();
		before.$client.close();

		const db = openDatabase({ file });
		for (const table of ["tasks", "outbox", "shared_sessions", "shared_participants", "shared_messages", "shared_checkpoints", "shared_invites", "shared_mirror_messages", "shared_mirror_state"]) {
			expect(db.$client.prepare("select name from sqlite_master where type = 'table' and name = ?").get(table)).toBeDefined();
		}
		expect(db.select().from(peers).get()).toMatchObject({ id: "node_b", autoAcceptTasks: false });
		db.$client.close();
		expect(readdirSync(dir).filter((n) => n.startsWith("clam.db.pre-migrate-") && n.endsWith(".bak"))).toHaveLength(1);
	});
});

describe("0006_nogit", () => {
	const row = (db: ReturnType<typeof openDatabase>, sql: string, ...args: unknown[]) => db.$client.prepare(sql).get(...args);

	it("adds projects.managed (default false) and relaxes the repository columns of tasks and shared sessions", () => {
		const db = openDatabase({ file: ":memory:" });
		expect(columns(db, "projects")).toContain("managed");
		db.insert(node).values({ id: "n1", name: "n", publicKey: "k", fingerprint: "f" }).run();
		db.insert(workspaces).values({ id: "w1", name: "w", ownerNodeId: "n1" }).run();
		db.insert(projects).values({ id: "p1", workspaceId: "w1", name: "p", path: "/tmp/p" }).run();
		db.insert(projects).values({ id: "p2", workspaceId: "w1", name: "m", path: "/tmp/m", managed: true }).run();
		expect(db.select().from(projects).all().map((p) => p.managed)).toEqual([false, true]);

		db.insert(tasks)
			.values({ id: "tsk_ng", direction: "outgoing", peerId: "node_b", workspaceId: "w1", title: "T", senderNodeId: "a", senderNodeName: "A", executorNodeId: "b", executorNodeName: "B", correlationId: "c", deliverAs: "files", inputFiles: { artifactId: "art_1", sha256: "a".repeat(64), size: 3, fileCount: 1 } })
			.run();
		expect(db.select().from(tasks).get()).toMatchObject({ repoUrl: null, repoBranch: null, inputFiles: { artifactId: "art_1", fileCount: 1 } });

		db.insert(sharedSessions).values({ id: "shs_f", workspaceId: "w1", title: "T", vcs: "files", driverNodeId: "a", driverNodeName: "A", localRole: "driver" }).run();
		expect(db.select().from(sharedSessions).get()).toMatchObject({ vcs: "files", repoUrl: null, branch: null, rescueFiles: null });
		db.insert(sharedCheckpoints).values({ sharedSessionId: "shs_f", seq: 1, epoch: 1, nodeId: "a", files: { sha256: "b".repeat(64), size: 9, fileCount: 2 }, filesPath: "shs_f/1.files.tar.gz" }).run();
		expect(db.select().from(sharedCheckpoints).get()).toMatchObject({ branch: null, commit: null, files: { fileCount: 2 }, filesPath: "shs_f/1.files.tar.gz" });
		db.insert(sharedInvites).values({ id: "inv_f", sharedSessionId: "shs_f", fromNodeId: "a", fromNodeName: "A", title: "T", vcs: "files", workspaceId: "w1", epoch: 1 }).run();
		expect(db.select().from(sharedInvites).get()).toMatchObject({ vcs: "files", repoUrl: null, repoBranch: null });
		db.$client.close();
	});

	it("keeps every task, event, message, artifact and shared-session child row when the tables are rebuilt (foreign keys off while migrating)", () => {
		const file = join(dir, "clam.db");
		const older = mkdtempSync(join(dir, "older-"));
		cpSync(resolveMigrationsFolder(), older, { recursive: true });
		const journalPath = join(older, "meta", "_journal.json");
		const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
		expect(journal.entries.findIndex((e) => e.tag === "0006_nogit")).toBeGreaterThan(0);
		journal.entries.length = journal.entries.findIndex((e) => e.tag === "0006_nogit"); // truncate at the cut: later migrations must not be applied either
		writeFileSync(journalPath, JSON.stringify(journal));

		const before = openDatabase({ file, migrationsFolder: older });
		expect(columns(before, "projects")).not.toContain("managed");
		const raw = before.$client;
		raw.prepare("insert into node (id, name, public_key, fingerprint) values ('n1', 'n', 'k', 'f')").run();
		raw.prepare("insert into workspaces (id, name, owner_id) values ('w1', 'w', 'n1')").run();
		raw.prepare("insert into projects (id, workspace_id, name, path) values ('p1', 'w1', 'p', '/tmp/p')").run();
		raw.prepare("insert into peers (id, name, fingerprint, public_key, key_id, url) values ('node_b', 'B', 'f', 'k', 'k', 'https://b.example')").run();
		raw.prepare(
			"insert into tasks (id, direction, peer_id, workspace_id, project_id, title, repo_url, sender_node_id, sender_node_name, executor_node_id, executor_node_name, correlation_id) values ('tsk_1', 'outgoing', 'node_b', 'w1', 'p1', 'T', 'https://github.com/o/r', 'a', 'A', 'b', 'B', 'c')",
		).run();
		raw.prepare("insert into task_events (task_id, seq, type, summary) values ('tsk_1', 1, 'status', 'offered')").run();
		raw.prepare("insert into task_messages (id, task_id, author_kind, author_node_id, author_node_name, kind, text, created_at) values ('msg_1', 'tsk_1', 'human', 'a', 'A', 'note', 'hi', 'x')").run();
		raw.prepare("insert into artifacts (id, task_id, name, media_type, size, sha256, storage_path) values ('art_1', 'tsk_1', 'x', 't', 1, 's', 'p')").run();
		raw.prepare("insert into shared_sessions (id, workspace_id, title, repo_url, branch, driver_node_id, driver_node_name, local_role) values ('shs_1', 'w1', 'T', 'https://github.com/o/r', 'clam/shared/x', 'a', 'A', 'driver')").run();
		raw.prepare("insert into shared_participants (shared_session_id, node_id, node_name, role, state) values ('shs_1', 'a', 'A', 'driver', 'active')").run();
		raw.prepare("insert into shared_messages (id, shared_session_id, author_kind, author_node_id, author_node_name, kind, text, created_at, hlc) values ('smg_1', 'shs_1', 'human', 'a', 'A', 'chat', 'hi', 'x', '000000000000001-00000')").run();
		raw.prepare("insert into shared_checkpoints (shared_session_id, seq, epoch, node_id, branch) values ('shs_1', 1, 1, 'a', 'clam/shared/x')").run();
		raw.prepare("insert into shared_invites (id, shared_session_id, from_node_id, from_node_name, title, repo_url, repo_branch, workspace_id, epoch) values ('inv_1', 'shs_1', 'a', 'A', 'T', 'https://github.com/o/r', 'b', 'w1', 1)").run();
		raw.close();

		const db = openDatabase({ file });
		expect(db.select().from(tasks).get()).toMatchObject({ id: "tsk_1", projectId: "p1", repoUrl: "https://github.com/o/r", deliverAs: "branch", inputFiles: null });
		expect(db.select().from(taskEvents).all()).toHaveLength(1);
		expect(db.select().from(taskMessages).all()).toHaveLength(1);
		expect(db.select().from(artifacts).all()).toHaveLength(1);
		expect(db.select().from(sharedSessions).get()).toMatchObject({ id: "shs_1", vcs: "git", repoUrl: "https://github.com/o/r", branch: "clam/shared/x" });
		expect(db.select().from(sharedParticipants).all()).toHaveLength(1);
		expect(db.select().from(sharedMessages).all()).toHaveLength(1);
		expect(db.select().from(sharedCheckpoints).get()).toMatchObject({ branch: "clam/shared/x", files: null, filesPath: null });
		expect(db.select().from(sharedInvites).get()).toMatchObject({ vcs: "git", repoUrl: "https://github.com/o/r", repoBranch: "b" });
		expect(row(db, "select count(*) as n from pragma_foreign_key_check")).toEqual({ n: 0 });
		// Enforcement is back on and the rebuilt tables still cascade.
		expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
		db.delete(tasks).where(eq(tasks.id, "tsk_1")).run();
		expect(db.select().from(taskEvents).all()).toEqual([]);
		expect(db.select().from(artifacts).all()).toEqual([]);
		db.delete(sharedSessions).where(eq(sharedSessions.id, "shs_1")).run();
		expect(db.select().from(sharedCheckpoints).all()).toEqual([]);
		expect(db.select().from(sharedMessages).all()).toEqual([]);
		db.$client.close();
	});
});

describe("0009_handoff", () => {
	const handoffRow = (id: string, extra: Record<string, unknown> = {}) => ({
		id,
		kind: "task",
		role: "source",
		state: "preparing",
		peerId: "node_c",
		subjectId: "tsk_1",
		title: "T",
		workspaceId: "w1",
		sourceNodeId: "node_b",
		sourceNodeName: "B",
		targetNodeId: "node_c",
		targetNodeName: "C",
		fromEpoch: 0,
		toEpoch: 1,
		correlationId: "corr",
		...extra,
	});

	it("creates the handoff tables, adds the task fence columns and enforces one live handoff per (subject, epoch, role)", () => {
		const db = openDatabase({ file: ":memory:" });
		expect(columns(db, "handoffs")).toEqual([
			"id", "kind", "role", "state", "peer_id", "subject_id", "title", "workspace_id", "project_id", "source_node_id", "source_node_name", "source_agent_id",
			"source_agent_name", "source_session_id", "target_node_id", "target_node_name", "target_agent_id", "target_agent_name", "target_session_id", "from_epoch",
			"to_epoch", "vcs", "include_transcript", "manifest", "manifest_sha256", "conversation_summary", "environment", "setup_fingerprint", "failure_code",
			"failure_detail", "failure_step", "expires_at", "deadline_at", "ack_at", "fencing_token", "correlation_id", "meta", "created_at", "updated_at",
		]);
		expect(columns(db, "handoff_steps")).toEqual(["handoff_id", "n", "name", "state", "detail", "at"]);
		expect(columns(db, "handoff_events")).toEqual(["handoff_id", "seq", "at", "node_id", "state", "summary"]);
		expect(columns(db, "handoff_setup")).toEqual(["id", "handoff_id", "ord", "command", "cwd", "purpose", "state", "exit_code", "output_tail", "started_at", "finished_at"]);
		expect(columns(db, "handoff_artifacts")).toEqual(["handoff_id", "artifact_id", "name", "kind", "sha256", "size", "path", "created_at"]);
		expect(columns(db, "tasks").slice(-2)).toEqual(["fenced", "highest_seen_epoch"]);

		const raw = db.$client;
		const insert = (r: ReturnType<typeof handoffRow>) =>
			raw
				.prepare(
					"insert into handoffs (id, kind, role, state, peer_id, subject_id, title, workspace_id, source_node_id, source_node_name, target_node_id, target_node_name, from_epoch, to_epoch, correlation_id) values (@id, @kind, @role, @state, @peerId, @subjectId, @title, @workspaceId, @sourceNodeId, @sourceNodeName, @targetNodeId, @targetNodeName, @fromEpoch, @toEpoch, @correlationId)",
				)
				.run(r);
		insert(handoffRow("hnd_1"));
		// A competing handoff for the same (task, epoch, role) cannot exist while the first is live ...
		expect(() => insert(handoffRow("hnd_2"))).toThrow(/UNIQUE/);
		// ... the same epoch on the other role is another node's row ...
		insert(handoffRow("hnd_target", { role: "target", state: "received" }));
		// ... and an attempt that ended without consuming the epoch frees it again.
		raw.prepare("update handoffs set state = 'rejected' where id = 'hnd_1'").run();
		insert(handoffRow("hnd_2"));
		raw.prepare("update handoffs set state = 'reclaimed' where id = 'hnd_2'").run();
		expect(() => insert(handoffRow("hnd_3"))).toThrow(/UNIQUE/); // reclaimed keeps the tombstone epoch
		db.$client.close();
	});

	it("migrates a database that stopped at 0008: tasks keep their rows and become unfenced", () => {
		const file = join(dir, "clam.db");
		const older = mkdtempSync(join(dir, "older-"));
		cpSync(resolveMigrationsFolder(), older, { recursive: true });
		const journalPath = join(older, "meta", "_journal.json");
		const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
		journal.entries.length = journal.entries.findIndex((e) => e.tag === "0009_handoff");
		writeFileSync(journalPath, JSON.stringify(journal));
		const before = openDatabase({ file, migrationsFolder: older });
		before.$client.prepare("insert into node (id, name, public_key, fingerprint) values ('n1', 'n', 'k', 'f')").run();
		before.$client.prepare("insert into workspaces (id, name, owner_id) values ('w1', 'w', 'n1')").run();
		before.$client
			.prepare("insert into tasks (id, direction, peer_id, workspace_id, title, sender_node_id, sender_node_name, executor_node_id, executor_node_name, correlation_id) values ('tsk_1', 'incoming', 'node_a', 'w1', 'T', 'a', 'A', 'b', 'B', 'c')")
			.run();
		before.$client.close();

		const db = openDatabase({ file });
		expect(db.select().from(tasks).get()).toMatchObject({ id: "tsk_1", fenced: false, highestSeenEpoch: 0 });
		expect(db.$client.prepare("select count(*) as n from handoffs").get()).toEqual({ n: 0 });
		db.$client.close();
	});
});
