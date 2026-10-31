import { nonceLog } from "@clam/database";
import type { ClamDb } from "@clam/database";
import { gt, lte } from "drizzle-orm";

/**
 * Replay protection that survives restarts: every accepted `(peer, nonce)` is held in memory (hot path) and written
 * to `nonce_log` before the request is allowed to proceed, so a restart cannot reopen the window. `checkAndRemember`
 * answers false when the pair was already seen and has not yet expired.
 */
export class SqliteNonceStore {
	private readonly memory = new Map<string, number>();
	private timer: NodeJS.Timeout | null = null;

	constructor(
		private readonly db: ClamDb,
		private readonly now: () => number = Date.now,
	) {
		// Warm the in-memory set from disk: after a restart the database is the only memory of what was seen.
		for (const row of db.select().from(nonceLog).where(gt(nonceLog.expiresAt, now())).all()) this.memory.set(key(row.peerId, row.nonce), row.expiresAt);
	}

	checkAndRemember(peerId: string, nonce: string, expiresAtMs: number): boolean {
		const now = this.now();
		const k = key(peerId, nonce);
		const known = this.memory.get(k);
		if (known !== undefined && known > now) return false;
		// The conditional upsert is the authority: it only overwrites a row whose window has already closed.
		const result = this.db.$client
			.prepare("insert into nonce_log (peer_id, nonce, expires_at) values (?, ?, ?) on conflict (peer_id, nonce) do update set expires_at = excluded.expires_at where nonce_log.expires_at <= ?")
			.run(peerId, nonce, expiresAtMs, now);
		if (result.changes === 0) {
			// Persisted but not in memory (e.g. written by an earlier process after our warm-up): remember it.
			const row = this.db.$client.prepare("select expires_at as e from nonce_log where peer_id = ? and nonce = ?").get(peerId, nonce) as { e: number } | undefined;
			if (row) this.memory.set(k, row.e);
			return false;
		}
		this.memory.set(k, expiresAtMs);
		return true;
	}

	/** Remove expired entries from memory and disk. */
	prune(): void {
		const now = this.now();
		for (const [k, expires] of this.memory) if (expires <= now) this.memory.delete(k);
		this.db.delete(nonceLog).where(lte(nonceLog.expiresAt, now)).run();
	}

	startPruning(intervalMs = 60_000): void {
		this.prune();
		this.timer = setInterval(() => this.prune(), intervalMs);
		this.timer.unref();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}
}

function key(peerId: string, nonce: string): string {
	return `${peerId}\u0000${nonce}`;
}
