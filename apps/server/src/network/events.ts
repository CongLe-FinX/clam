import { networkEvents } from "@clam/database";
import type { ClamDb } from "@clam/database";
import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm";

export const NODE_STREAM = "node";

/** Keep at least this many events per stream (docs/agent-network-protocol.md §8: 7 days / 10 000 events). */
const RETAIN_EVENTS = 10_000;
const RETAIN_MS = 7 * 24 * 3600 * 1000;

export interface StoredEvent {
	stream: string;
	seq: number;
	type: string;
	payload: Record<string, unknown>;
	/** When set, only this peer may see the payload. */
	audience: string | null;
	at: string;
}

type Listener = (event: StoredEvent) => void;

/**
 * Durable, per-stream, gap-free event log behind `GET /api/v1/events`. `seq` is assigned inside one synchronous
 * SQLite statement (better-sqlite3 is synchronous and this process is the only writer), so it can neither skip
 * nor repeat; listeners (live SSE connections) are called after the row is committed.
 */
export class NetworkEventLog {
	private readonly listeners = new Map<string, Set<Listener>>();
	private appendsSincePrune = 0;

	constructor(private readonly db: ClamDb) {}

	append(stream: string, type: string, payload: Record<string, unknown> = {}, audience: string | null = null): StoredEvent {
		const row = this.db
			.insert(networkEvents)
			.values({
				stream,
				seq: sql`(select coalesce(max(seq), 0) + 1 from network_events where stream = ${stream})`,
				type,
				payload,
				audience,
				createdAt: new Date().toISOString(),
			})
			.returning()
			.get();
		const event: StoredEvent = { stream: row.stream, seq: row.seq, type: row.type, payload: row.payload, audience: row.audience, at: row.createdAt };
		for (const listener of [...(this.listeners.get(stream) ?? [])]) {
			try {
				listener(event);
			} catch {
				// A broken connection must never break the producer.
			}
		}
		if (++this.appendsSincePrune >= 500) this.prune();
		return event;
	}

	/** Events of `stream` with seq greater than `after`, oldest first. */
	after(stream: string, after: number, limit = 1000): StoredEvent[] {
		return this.db
			.select()
			.from(networkEvents)
			.where(and(eq(networkEvents.stream, stream), gt(networkEvents.seq, after)))
			.orderBy(asc(networkEvents.seq))
			.limit(limit)
			.all()
			.map((row) => ({ stream: row.stream, seq: row.seq, type: row.type, payload: row.payload, audience: row.audience, at: row.createdAt }));
	}

	/** Highest and lowest retained seq of the stream (0/0 when it is empty). */
	bounds(stream: string): { first: number; last: number } {
		const row = this.db
			.select({ first: sql<number | null>`min(${networkEvents.seq})`, last: sql<number | null>`max(${networkEvents.seq})` })
			.from(networkEvents)
			.where(eq(networkEvents.stream, stream))
			.get();
		return { first: row?.first ?? 0, last: row?.last ?? 0 };
	}

	subscribe(stream: string, listener: Listener): () => void {
		let set = this.listeners.get(stream);
		if (!set) {
			set = new Set();
			this.listeners.set(stream, set);
		}
		set.add(listener);
		return () => {
			set.delete(listener);
			if (set.size === 0 && this.listeners.get(stream) === set) this.listeners.delete(stream);
		};
	}

	/** Drop events older than the retention window, always keeping the newest RETAIN_EVENTS (and the very last one). */
	prune(now = Date.now()): void {
		this.appendsSincePrune = 0;
		const streams = this.db.selectDistinct({ stream: networkEvents.stream }).from(networkEvents).all();
		for (const { stream } of streams) {
			const newest = this.db
				.select({ seq: networkEvents.seq })
				.from(networkEvents)
				.where(eq(networkEvents.stream, stream))
				.orderBy(desc(networkEvents.seq))
				.limit(1)
				.offset(RETAIN_EVENTS - 1)
				.get();
			const cutoff = new Date(now - RETAIN_MS).toISOString();
			// Old by age AND beyond the newest RETAIN_EVENTS: both limits must allow the deletion.
			if (!newest) continue;
			this.db.delete(networkEvents).where(and(eq(networkEvents.stream, stream), lt(networkEvents.seq, newest.seq), lt(networkEvents.createdAt, cutoff))).run();
		}
	}
}
