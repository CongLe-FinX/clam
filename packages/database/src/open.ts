import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.ts";

export type ClamDb = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export interface OpenDatabaseOptions {
	/** Database file path, or ":memory:". Parent directories are created. */
	file: string;
	/** Override the committed migrations folder (defaults to the one shipped with this package). */
	migrationsFolder?: string;
	/** Milliseconds SQLite waits on a locked database before failing. Default 5000. */
	busyTimeoutMs?: number;
	/** How many `<file>.pre-migrate-<timestamp>.bak` snapshots to keep. Default 3. */
	keepMigrationBackups?: number;
}

const DEFAULT_KEPT_BACKUPS = 3;
const BACKUP_INFIX = ".pre-migrate-";
const BACKUP_SUFFIX = ".bak";

/**
 * Locate the committed migrations. In source form they sit at `../migrations` next to `src/`;
 * the server bundle copies them next to its entry point (`./migrations`).
 */
export function resolveMigrationsFolder(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [resolve(here, "migrations"), resolve(here, "..", "migrations")];
	for (const candidate of candidates) {
		if (existsSync(resolve(candidate, "meta", "_journal.json"))) return candidate;
	}
	throw new Error(`CL Agent Mesh database migrations not found (looked in: ${candidates.join(", ")})`);
}

interface JournalEntry {
	when: number;
	tag: string;
}

/**
 * True when the database already holds data and the journal has migrations it has not applied yet.
 * Mirrors drizzle's own rule: an entry is pending when its `when` is newer than the last applied `created_at`.
 */
function hasPendingMigrationsOnExistingData(sqlite: Database.Database, migrationsFolder: string): boolean {
	const hasUserTables = (sqlite.prepare("select count(*) as n from sqlite_master where type = 'table' and name not like 'sqlite_%'").get() as { n: number }).n > 0;
	if (!hasUserTables) return false; // brand-new file: nothing to lose
	const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8")) as { entries: JournalEntry[] };
	const hasLedger = sqlite.prepare("select 1 from sqlite_master where type = 'table' and name = '__drizzle_migrations'").get() !== undefined;
	if (!hasLedger) return journal.entries.length > 0;
	const applied = (sqlite.prepare("select max(created_at) as last from __drizzle_migrations").get() as { last: number | null }).last;
	return journal.entries.some((entry) => applied === null || entry.when > applied);
}

let lastBackupStamp = 0;

/** `20261031T063015123Z`: sortable, filesystem-safe, strictly increasing within this process. */
function nextBackupStamp(): string {
	lastBackupStamp = Math.max(Date.now(), lastBackupStamp + 1);
	return new Date(lastBackupStamp).toISOString().replace(/[-:.]/g, "");
}

/**
 * Snapshot the database before migrating it. `VACUUM INTO` writes a consistent copy (WAL contents included,
 * which a plain file copy would miss) and fails if the target exists, so a stale file is never overwritten.
 * Only the newest `keep` snapshots are retained.
 */
function backupBeforeMigrating(sqlite: Database.Database, file: string, keep: number): string {
	let target = `${file}${BACKUP_INFIX}${nextBackupStamp()}${BACKUP_SUFFIX}`;
	while (existsSync(target)) target = `${file}${BACKUP_INFIX}${nextBackupStamp()}${BACKUP_SUFFIX}`;
	sqlite.prepare("VACUUM INTO ?").run(target);
	const prefix = `${basename(file)}${BACKUP_INFIX}`;
	const backups = readdirSync(dirname(file))
		.filter((name) => name.startsWith(prefix) && name.endsWith(BACKUP_SUFFIX))
		.sort();
	for (const stale of backups.slice(0, Math.max(0, backups.length - keep))) rmSync(join(dirname(file), stale), { force: true });
	return target;
}

/**
 * Open (creating if needed) the node database: WAL, foreign keys, busy timeout, committed migrations applied.
 * Before pending migrations touch an existing non-empty file it is snapshotted to
 * `<file>.pre-migrate-<timestamp>.bak` (last 3 kept); if the snapshot fails the migration is not attempted.
 */
export function openDatabase(options: OpenDatabaseOptions): ClamDb {
	if (options.file !== ":memory:") mkdirSync(dirname(options.file), { recursive: true });
	const sqlite = new Database(options.file);
	try {
		sqlite.pragma("journal_mode = WAL");
		sqlite.pragma("foreign_keys = ON");
		sqlite.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
		sqlite.pragma("synchronous = NORMAL");
		const db = drizzle(sqlite, { schema }) as ClamDb;
		const migrationsFolder = options.migrationsFolder ?? resolveMigrationsFolder();
		if (options.file !== ":memory:" && hasPendingMigrationsOnExistingData(sqlite, migrationsFolder)) {
			backupBeforeMigrating(sqlite, options.file, options.keepMigrationBackups ?? DEFAULT_KEPT_BACKUPS);
		}
		migrate(db, { migrationsFolder });
		return db;
	} catch (error) {
		sqlite.close();
		throw error;
	}
}
