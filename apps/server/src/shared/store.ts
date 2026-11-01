import { ulid } from "@clam/agent-network";
import { i18nMsg, type MessagesPage, type SessionLiveState, type UiMessage } from "@clam/contracts";
import {
	outbox,
	sharedCheckpoints,
	sharedInvites,
	sharedMessages,
	sharedMirrorMessages,
	sharedAttachments,
	sharedMirrorState,
	sharedParticipants,
	sharedSessions,
	type ClamDb,
	type SharedMeta,
} from "@clam/database";
import { AGENT_MESSAGE_LIMIT, wakeBudget } from "@clam/task-engine";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { ApiError } from "../http/errors.ts";

export type SharedRow = typeof sharedSessions.$inferSelect;
export type ParticipantRow = typeof sharedParticipants.$inferSelect;
export type SharedMessageRow = typeof sharedMessages.$inferSelect;
export type CheckpointRow = typeof sharedCheckpoints.$inferSelect;
export type InviteRow = typeof sharedInvites.$inferSelect;
export type AttachmentRow = typeof sharedAttachments.$inferSelect;

/** `GET /shared/:id/messages`: page size without and at most with `limit`. */
export const MESSAGES_PAGE_DEFAULT = 50;
export const MESSAGES_PAGE_MAX = 200;

/** Where a message sits in the log: its sort key `(hlc, origin node, id)`. */
export interface MessagePosition {
	hlc: string;
	origin: string;
	id: string;
}

/** The opaque cursor of a position (`before` of `GET /shared/:id/messages`). */
export function encodeMessageCursor(position: MessagePosition): string {
	return Buffer.from(JSON.stringify([position.hlc, position.origin, position.id]), "utf8").toString("base64url");
}

/** The position a cursor names; 400 for anything this node did not issue. */
export function decodeMessageCursor(cursor: string): MessagePosition {
	try {
		const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		if (Array.isArray(parsed) && parsed.length === 3 && parsed.every((part) => typeof part === "string" && part.length > 0 && part.length <= 256)) {
			return { hlc: parsed[0] as string, origin: parsed[1] as string, id: parsed[2] as string };
		}
	} catch {
		// falls through to the error below
	}
	throw ApiError.badRequest(i18nMsg("The cursor is not valid"));
}
export type MirrorStateRow = typeof sharedMirrorState.$inferSelect;

export const newSharedId = (): string => `shs_${ulid()}`;
export const newInviteId = (): string => `shi_${ulid()}`;
export const newSharedMessageId = (): string => `shm_${ulid()}`;
export const newAttachmentId = (): string => `att_${ulid()}`;
export const newStreamId = (): string => `str_${ulid()}`;
export const newTransferId = (): string => `trf_${ulid()}`;

const nowIso = (): string => new Date().toISOString();

/** Page of a transcript newest-first, like the runtime's `MessagesPage` (`cursor` = number of messages already served from the end). */
export function pageOf(all: readonly UiMessage[], query: { cursor?: string; limit?: number }): MessagesPage {
	const limit = Math.min(Math.max(query.limit ?? 50, 1), 256);
	const served = query.cursor !== undefined && /^\d{1,9}$/.test(query.cursor) ? Number(query.cursor) : 0;
	const end = Math.max(0, all.length - served);
	const start = Math.max(0, end - limit);
	return { messages: all.slice(start, end), total: all.length, nextCursor: start > 0 ? String(all.length - start) : null };
}

/**
 * Every SQL statement of the shared-session feature. Domain rules live in the units around it (and in
 * `@clam/task-engine`); this class only persists. Methods are synchronous (better-sqlite3), so the compare-and-set style
 * updates cannot interleave with another statement of this process. It never publishes and never calls peers.
 */
export class SharedStore {
	constructor(
		private readonly db: ClamDb,
		private readonly self: { nodeId: string },
	) {}

	get nodeId(): string {
		return this.self.nodeId;
	}

	transaction<T>(fn: () => T): T {
		return this.db.transaction(() => fn());
	}

	// ------------------------------------------------------------------ shared sessions

	find(id: string): SharedRow | undefined {
		return this.db.select().from(sharedSessions).where(eq(sharedSessions.id, id)).get();
	}

	get(id: string): SharedRow {
		const row = this.find(id);
		if (!row) throw ApiError.notFound("Shared session");
		return row;
	}

	list(): SharedRow[] {
		return this.db.select().from(sharedSessions).orderBy(desc(sharedSessions.updatedAt), desc(sharedSessions.id)).all();
	}

	/** Sessions this node still takes part in. */
	active(): SharedRow[] {
		return this.db.select().from(sharedSessions).where(eq(sharedSessions.state, "active")).orderBy(asc(sharedSessions.createdAt)).all();
	}

	insert(values: typeof sharedSessions.$inferInsert): SharedRow {
		return this.db.insert(sharedSessions).values(values).returning().get();
	}

	update(id: string, patch: Partial<typeof sharedSessions.$inferInsert>): SharedRow {
		const row = this.db
			.update(sharedSessions)
			.set({ ...patch, updatedAt: nowIso() })
			.where(eq(sharedSessions.id, id))
			.returning()
			.get();
		if (!row) throw ApiError.notFound("Shared session");
		return row;
	}

	/** Merge keys into the node-private bookkeeping (`undefined` deletes the key). */
	patchMeta(id: string, patch: Partial<SharedMeta>): SharedRow {
		const row = this.get(id);
		const next: Record<string, unknown> = { ...row.meta, ...patch };
		for (const [key, value] of Object.entries(next)) if (value === undefined) delete next[key];
		return this.update(id, { meta: next as SharedMeta });
	}

	/** The shared session a local agent session belongs to as driving session, moved copy, mirror (any state of this node). */
	bySession(sessionId: string): SharedRow | undefined {
		return this.db
			.select()
			.from(sharedSessions)
			.where(or(eq(sharedSessions.localSessionId, sessionId), eq(sharedSessions.mirrorSessionId, sessionId)))
			.get();
	}

	/** The shared session whose participant agent session on this node is `sessionId`. */
	byAgentSession(sessionId: string): SharedRow | undefined {
		const link = this.db
			.select({ sharedSessionId: sharedParticipants.sharedSessionId })
			.from(sharedParticipants)
			.where(and(eq(sharedParticipants.nodeId, this.self.nodeId), eq(sharedParticipants.agentSessionId, sessionId)))
			.get();
		return link ? this.find(link.sharedSessionId) : undefined;
	}

	// ------------------------------------------------------------------ participants

	participants(sharedId: string): ParticipantRow[] {
		return this.db
			.select()
			.from(sharedParticipants)
			.where(eq(sharedParticipants.sharedSessionId, sharedId))
			.orderBy(asc(sharedParticipants.createdAt), asc(sharedParticipants.nodeId))
			.all();
	}

	participant(sharedId: string, nodeId: string): ParticipantRow | undefined {
		return this.db
			.select()
			.from(sharedParticipants)
			.where(and(eq(sharedParticipants.sharedSessionId, sharedId), eq(sharedParticipants.nodeId, nodeId)))
			.get();
	}

	/** Insert or replace the row of one node of a shared session (the caller decides the full state). */
	upsertParticipant(values: typeof sharedParticipants.$inferInsert): ParticipantRow {
		const set = { ...values, updatedAt: nowIso() };
		return this.db
			.insert(sharedParticipants)
			.values(set)
			.onConflictDoUpdate({ target: [sharedParticipants.sharedSessionId, sharedParticipants.nodeId], set })
			.returning()
			.get();
	}

	updateParticipant(sharedId: string, nodeId: string, patch: Partial<typeof sharedParticipants.$inferInsert>): ParticipantRow | undefined {
		return this.db
			.update(sharedParticipants)
			.set({ ...patch, updatedAt: nowIso() })
			.where(and(eq(sharedParticipants.sharedSessionId, sharedId), eq(sharedParticipants.nodeId, nodeId)))
			.returning()
			.get();
	}

	/** Participants of other nodes that currently receive what the driver sends. */
	activePeers(sharedId: string): ParticipantRow[] {
		return this.participants(sharedId).filter((p) => p.nodeId !== this.self.nodeId && p.state === "active");
	}

	/** Every shared session this node is in together with `peerId` (active on both sides as far as we know). */
	sessionsWithPeer(peerId: string): SharedRow[] {
		const links = this.db
			.select({ sharedSessionId: sharedParticipants.sharedSessionId })
			.from(sharedParticipants)
			.where(and(eq(sharedParticipants.nodeId, peerId), inArray(sharedParticipants.state, ["invited", "active"])))
			.all();
		const ids = new Set(links.map((l) => l.sharedSessionId));
		return this.active().filter((s) => ids.has(s.id));
	}

	// ------------------------------------------------------------------ messages

	message(id: string): SharedMessageRow | undefined {
		return this.db.select().from(sharedMessages).where(eq(sharedMessages.id, id)).get();
	}

	/** The highest hybrid logical clock stamp of any message this node holds (the clock's state after a restart). */
	maxHlc(): string | null {
		return this.db.select({ hlc: sql<string | null>`max(${sharedMessages.hlc})` }).from(sharedMessages).get()?.hlc ?? null;
	}

	/**
	 * A message this node accepts (its origin). One transaction: the next per-origin sequence number is `max + 1` of this
	 * node's messages in the session, so the sequence has no gaps. A local-only note (`replicate: false`) gets none.
	 */
	appendMessage(values: Omit<typeof sharedMessages.$inferInsert, "originSeq" | "authorNodeId">, options: { replicate: boolean }): SharedMessageRow {
		return this.transaction(() => {
			const last = options.replicate
				? this.db
						.select({ seq: sql<number>`coalesce(max(${sharedMessages.originSeq}), 0)` })
						.from(sharedMessages)
						.where(and(eq(sharedMessages.sharedSessionId, values.sharedSessionId), eq(sharedMessages.authorNodeId, this.self.nodeId)))
						.get()
				: undefined;
			return this.db
				.insert(sharedMessages)
				.values({ ...values, authorNodeId: this.self.nodeId, originSeq: last ? last.seq + 1 : null })
				.returning()
				.get();
		});
	}

	/**
	 * Store a message that another node accepted. Idempotent by id: `inserted` is false for a duplicate. A different id that
	 * claims an origin sequence number already taken is a protocol violation (`409 idempotency_conflict`).
	 */
	insertReceived(values: typeof sharedMessages.$inferInsert): { row: SharedMessageRow; inserted: boolean } {
		const created = this.db.insert(sharedMessages).values(values).onConflictDoNothing().returning().get();
		if (created) return { row: created, inserted: true };
		const existing = this.message(values.id);
		if (!existing) throw new ApiError(409, "idempotency_conflict", i18nMsg("Sequence {seq} of that origin is already used by another message", { seq: String(values.originSeq) }));
		return { row: existing, inserted: false };
	}

	/** The log in its order on every node: `(hlc, origin node, id)`. */
	messages(sharedId: string): SharedMessageRow[] {
		return this.db.select().from(sharedMessages).where(eq(sharedMessages.sharedSessionId, sharedId)).orderBy(asc(sharedMessages.hlc), asc(sharedMessages.authorNodeId), asc(sharedMessages.id)).all();
	}

	/**
	 * One page of the log, ascending like `messages`: the newest `limit` messages, or the `limit` before `before` (exclusive).
	 * `older` is the position of the first message of the page when more precede it (the `before` for the next page), else null.
	 * Positions are `(hlc, origin node, id)` tuples, so a message that arrives later never moves what a cursor points at.
	 */
	messagesPage(sharedId: string, options: { before?: MessagePosition | undefined; limit: number }): { rows: SharedMessageRow[]; older: MessagePosition | null } {
		const { before, limit } = options;
		const rows = this.db
			.select()
			.from(sharedMessages)
			.where(and(eq(sharedMessages.sharedSessionId, sharedId), before ? sql`(${sharedMessages.hlc}, ${sharedMessages.authorNodeId}, ${sharedMessages.id}) < (${before.hlc}, ${before.origin}, ${before.id})` : undefined))
			.orderBy(desc(sharedMessages.hlc), desc(sharedMessages.authorNodeId), desc(sharedMessages.id))
			.limit(limit + 1)
			.all();
		const more = rows.length > limit;
		const page = rows.slice(0, limit).reverse();
		const first = page[0];
		return { rows: page, older: more && first ? { hlc: first.hlc, origin: first.authorNodeId, id: first.id } : null };
	}

	/** Catch-up cursor: per origin the highest sequence N such that this node holds 1..N (a gap stops the count, so it is asked for again). */
	cursor(sharedId: string): Record<string, number> {
		const rows = this.db
			.select({ origin: sharedMessages.authorNodeId, seq: sharedMessages.originSeq })
			.from(sharedMessages)
			.where(and(eq(sharedMessages.sharedSessionId, sharedId), isNotNull(sharedMessages.originSeq)))
			.orderBy(asc(sharedMessages.authorNodeId), asc(sharedMessages.originSeq))
			.all();
		const cursor: Record<string, number> = {};
		for (const { origin, seq } of rows) {
			const have = cursor[origin] ?? 0;
			if (seq === have + 1) cursor[origin] = seq;
		}
		return cursor;
	}

	/** Replicated messages beyond `cursor` (an origin not named in it counts from 0), in log order; at most `limit + 1` so the caller can tell whether more follow. */
	messagesAfter(sharedId: string, cursor: Readonly<Record<string, number>>, limit: number): SharedMessageRow[] {
		const named = Object.entries(cursor);
		const beyond = [
			named.length > 0 ? notInArray(sharedMessages.authorNodeId, named.map(([origin]) => origin)) : undefined,
			...named.map(([origin, seq]) => and(eq(sharedMessages.authorNodeId, origin), gt(sharedMessages.originSeq, seq))),
		].filter((c) => c !== undefined);
		return this.db
			.select()
			.from(sharedMessages)
			.where(and(eq(sharedMessages.sharedSessionId, sharedId), isNotNull(sharedMessages.originSeq), beyond.length > 0 ? or(...beyond) : undefined))
			.orderBy(asc(sharedMessages.hlc), asc(sharedMessages.authorNodeId), asc(sharedMessages.id))
			.limit(limit + 1)
			.all();
	}

	setMessageDelivery(id: string, delivery: "local" | "pending" | "delivered" | "failed"): void {
		this.db.update(sharedMessages).set({ delivery }).where(eq(sharedMessages.id, id)).run();
	}

	/** The local agent session handed these messages (as a prompt, or inside the "since your last turn" block), or `history`. */
	markInjected(ids: readonly string[], sessionId: string): void {
		if (ids.length > 0) this.db.update(sharedMessages).set({ injectedSessionId: sessionId }).where(inArray(sharedMessages.id, [...ids])).run();
	}

	/** Messages of the session no local agent session was handed yet, in log order (the buffer and the pending wake-ups). */
	uninjectedMessages(sharedId: string): SharedMessageRow[] {
		return this.db
			.select()
			.from(sharedMessages)
			.where(and(eq(sharedMessages.sharedSessionId, sharedId), isNull(sharedMessages.injectedSessionId)))
			.orderBy(asc(sharedMessages.hlc), asc(sharedMessages.authorNodeId), asc(sharedMessages.id))
			.all();
	}

	markRead(sharedId: string): number {
		return this.db
			.update(sharedMessages)
			.set({ readAt: nowIso() })
			.where(and(eq(sharedMessages.sharedSessionId, sharedId), isNull(sharedMessages.readAt), ne(sharedMessages.authorNodeId, this.self.nodeId)))
			.run().changes;
	}

	unread(sharedId: string): number {
		return (
			this.db
				.select({ n: sql<number>`count(*)` })
				.from(sharedMessages)
				.where(and(eq(sharedMessages.sharedSessionId, sharedId), isNull(sharedMessages.readAt), ne(sharedMessages.authorNodeId, this.self.nodeId)))
				.get()?.n ?? 0
		);
	}

	/** Loop guard: waking agent messages this node's agents may still post (after the latest human message of the log). */
	budget(sharedId: string, limit = AGENT_MESSAGE_LIMIT): { limit: number; used: number; remaining: number } {
		const rows = this.db
			.select({ id: sharedMessages.id, authorKind: sharedMessages.authorKind, authorNodeId: sharedMessages.authorNodeId, hlc: sharedMessages.hlc, to: sharedMessages.to })
			.from(sharedMessages)
			.where(eq(sharedMessages.sharedSessionId, sharedId))
			.all()
			.map((r) => ({ ...r, authorKind: r.authorKind as "human" | "agent" | "system" }));
		return wakeBudget(rows, this.self.nodeId, limit);
	}

	// ------------------------------------------------------------------ checkpoints

	checkpoint(sharedId: string, seq: number): CheckpointRow | undefined {
		return this.db.select().from(sharedCheckpoints).where(and(eq(sharedCheckpoints.sharedSessionId, sharedId), eq(sharedCheckpoints.seq, seq))).get();
	}

	checkpoints(sharedId: string): CheckpointRow[] {
		return this.db.select().from(sharedCheckpoints).where(eq(sharedCheckpoints.sharedSessionId, sharedId)).orderBy(asc(sharedCheckpoints.seq)).all();
	}

	latestCheckpoint(sharedId: string): CheckpointRow | undefined {
		return this.db.select().from(sharedCheckpoints).where(eq(sharedCheckpoints.sharedSessionId, sharedId)).orderBy(desc(sharedCheckpoints.seq)).limit(1).get();
	}

	/** The newest checkpoint whose snapshot (and, in files mode, folder bundle) this node holds on disk. */
	latestHeldCheckpoint(sharedId: string): CheckpointRow | undefined {
		return this.checkpoints(sharedId)
			.filter((c) => c.snapshotPath !== null && (c.files === null || c.filesPath !== null))
			.at(-1);
	}

	/** Checkpoints announced with a snapshot or folder bundle this node has not downloaded yet (restart recovery of downloads). */
	pendingSnapshots(): CheckpointRow[] {
		return this.db
			.select()
			.from(sharedCheckpoints)
			.where(
				and(
					or(and(isNull(sharedCheckpoints.snapshotPath), sql`${sharedCheckpoints.snapshotSha256} is not null`), and(isNull(sharedCheckpoints.filesPath), sql`${sharedCheckpoints.files} is not null`)),
					ne(sharedCheckpoints.nodeId, this.self.nodeId),
				),
			)
			.orderBy(asc(sharedCheckpoints.createdAt), asc(sharedCheckpoints.seq))
			.all();
	}

	/** Insert; `inserted` is false when `(shared, seq)` exists (a duplicate notice). */
	insertCheckpoint(values: typeof sharedCheckpoints.$inferInsert): { row: CheckpointRow; inserted: boolean } {
		const created = this.db.insert(sharedCheckpoints).values(values).onConflictDoNothing().returning().get();
		if (created) return { row: created, inserted: true };
		return { row: this.checkpoint(values.sharedSessionId, values.seq) as CheckpointRow, inserted: false };
	}

	updateCheckpoint(sharedId: string, seq: number, patch: Partial<typeof sharedCheckpoints.$inferInsert>): CheckpointRow | undefined {
		return this.db
			.update(sharedCheckpoints)
			.set(patch)
			.where(and(eq(sharedCheckpoints.sharedSessionId, sharedId), eq(sharedCheckpoints.seq, seq)))
			.returning()
			.get();
	}

	// ------------------------------------------------------------------ invites

	invite(id: string): InviteRow | undefined {
		return this.db.select().from(sharedInvites).where(eq(sharedInvites.id, id)).get();
	}

	getInvite(id: string): InviteRow {
		const row = this.invite(id);
		if (!row) throw ApiError.notFound("Invitation");
		return row;
	}

	invites(): InviteRow[] {
		return this.db.select().from(sharedInvites).orderBy(desc(sharedInvites.createdAt), desc(sharedInvites.id)).all();
	}

	insertInvite(values: typeof sharedInvites.$inferInsert): { row: InviteRow; inserted: boolean } {
		const created = this.db.insert(sharedInvites).values(values).onConflictDoNothing().returning().get();
		if (created) return { row: created, inserted: true };
		return { row: this.invite(values.id) as InviteRow, inserted: false };
	}

	updateInvite(id: string, patch: Partial<typeof sharedInvites.$inferInsert>): InviteRow {
		const row = this.db.update(sharedInvites).set(patch).where(eq(sharedInvites.id, id)).returning().get();
		if (!row) throw ApiError.notFound("Invitation");
		return row;
	}

	// ------------------------------------------------------------------ mirror transcripts

	mirrorMessages(mirrorSessionId: string): UiMessage[] {
		return this.db
			.select({ message: sharedMirrorMessages.message })
			.from(sharedMirrorMessages)
			.where(eq(sharedMirrorMessages.mirrorSessionId, mirrorSessionId))
			.orderBy(asc(sharedMirrorMessages.position))
			.all()
			.map((r) => r.message);
	}

	mirrorMessage(mirrorSessionId: string, messageId: string): UiMessage | undefined {
		return this.db
			.select({ message: sharedMirrorMessages.message })
			.from(sharedMirrorMessages)
			.where(and(eq(sharedMirrorMessages.mirrorSessionId, mirrorSessionId), eq(sharedMirrorMessages.messageId, messageId)))
			.get()?.message;
	}

	/** Insert or replace one message of a mirror transcript (position = first appearance). */
	putMirrorMessage(mirrorSessionId: string, message: UiMessage): void {
		const existing = this.db
			.select({ position: sharedMirrorMessages.position })
			.from(sharedMirrorMessages)
			.where(and(eq(sharedMirrorMessages.mirrorSessionId, mirrorSessionId), eq(sharedMirrorMessages.messageId, message.id)))
			.get();
		if (existing) {
			this.db
				.update(sharedMirrorMessages)
				.set({ message, updatedAt: nowIso() })
				.where(and(eq(sharedMirrorMessages.mirrorSessionId, mirrorSessionId), eq(sharedMirrorMessages.messageId, message.id)))
				.run();
			return;
		}
		const last = this.db
			.select({ position: sql<number>`coalesce(max(${sharedMirrorMessages.position}), 0)` })
			.from(sharedMirrorMessages)
			.where(eq(sharedMirrorMessages.mirrorSessionId, mirrorSessionId))
			.get();
		this.db.insert(sharedMirrorMessages).values({ mirrorSessionId, messageId: message.id, position: (last?.position ?? 0) + 1, message }).run();
	}

	removeMirrorMessage(mirrorSessionId: string, messageId: string): void {
		this.db.delete(sharedMirrorMessages).where(and(eq(sharedMirrorMessages.mirrorSessionId, mirrorSessionId), eq(sharedMirrorMessages.messageId, messageId))).run();
	}

	clearMirrorMessages(mirrorSessionId: string): void {
		this.db.delete(sharedMirrorMessages).where(eq(sharedMirrorMessages.mirrorSessionId, mirrorSessionId)).run();
	}

	mirrorState(mirrorSessionId: string): MirrorStateRow | undefined {
		return this.db.select().from(sharedMirrorState).where(eq(sharedMirrorState.mirrorSessionId, mirrorSessionId)).get();
	}

	upsertMirrorState(values: { mirrorSessionId: string; sharedSessionId: string; epoch: number; streamId?: string | null; lastSeq?: number; syncing?: boolean; state?: SessionLiveState | null }): MirrorStateRow {
		const set = { ...values, updatedAt: nowIso() };
		return this.db
			.insert(sharedMirrorState)
			.values(set)
			.onConflictDoUpdate({ target: sharedMirrorState.mirrorSessionId, set })
			.returning()
			.get();
	}

	// ------------------------------------------------------------------ outbox (delivery state of what this node queued)

	/** Every queued call of `kind` that carries entity `refId` (one per recipient node). */
	outboxOfRef(kind: string, refId: string): Array<typeof outbox.$inferSelect> {
		return this.db
			.select()
			.from(outbox)
			.where(and(eq(outbox.kind, kind), eq(outbox.refId, refId)))
			.all();
	}

	// ------------------------------------------------------------------ attachments (files posted in the group chat)

	attachment(id: string): AttachmentRow | undefined {
		return this.db.select().from(sharedAttachments).where(eq(sharedAttachments.id, id)).get();
	}

	attachmentsOfMessage(messageId: string): AttachmentRow[] {
		return this.db.select().from(sharedAttachments).where(eq(sharedAttachments.messageId, messageId)).orderBy(asc(sharedAttachments.createdAt), asc(sharedAttachments.id)).all();
	}

	/** Insert a row; false when the id exists (a replayed message). */
	insertAttachment(values: typeof sharedAttachments.$inferInsert): boolean {
		return this.db.insert(sharedAttachments).values(values).onConflictDoNothing().run().changes > 0;
	}

	/** A file with this digest is already posted in `sharedId` from this folder path (the agent shared it, or it is a group file copied into the folder). */
	postedFromFolder(sharedId: string, sha256: string, copiedPath: string): boolean {
		return (
			this.db
				.select({ id: sharedAttachments.id })
				.from(sharedAttachments)
				.where(and(eq(sharedAttachments.sharedSessionId, sharedId), eq(sharedAttachments.sha256, sha256), eq(sharedAttachments.copiedPath, copiedPath), isNotNull(sharedAttachments.messageId)))
				.limit(1)
				.get() !== undefined
		);
	}

	/** A file with exactly these bytes is already posted in `sharedId` by anybody (another member's agent shared it earlier; its copy reached this folder through folder sync). */
	postedDigest(sharedId: string, sha256: string): boolean {
		return (
			this.db
				.select({ id: sharedAttachments.id })
				.from(sharedAttachments)
				.where(and(eq(sharedAttachments.sharedSessionId, sharedId), eq(sharedAttachments.sha256, sha256), isNotNull(sharedAttachments.messageId)))
				.limit(1)
				.get() !== undefined
		);
	}

	updateAttachment(id: string, patch: Partial<typeof sharedAttachments.$inferInsert>): void {
		this.db.update(sharedAttachments).set(patch).where(eq(sharedAttachments.id, id)).run();
	}

	/** Reference uploaded attachments from the message that carries them. */
	linkAttachments(ids: readonly string[], messageId: string): void {
		if (ids.length > 0) this.db.update(sharedAttachments).set({ messageId }).where(inArray(sharedAttachments.id, [...ids])).run();
	}

	/** The bytes of a digest arrived on this node: every row with it (any session) is now stored. Returns the message ids whose attachments changed. */
	markStored(sha256: string): string[] {
		const rows = this.db.update(sharedAttachments).set({ stored: true }).where(and(eq(sharedAttachments.sha256, sha256), eq(sharedAttachments.stored, false))).returning({ messageId: sharedAttachments.messageId }).all();
		return rows.flatMap((r) => (r.messageId ? [r.messageId] : []));
	}

	/** Attachments of active shared sessions whose bytes this node does not hold yet and that a message references, oldest first. */
	missingAttachments(): AttachmentRow[] {
		return this.db
			.select({ row: sharedAttachments })
			.from(sharedAttachments)
			.innerJoin(sharedSessions, eq(sharedSessions.id, sharedAttachments.sharedSessionId))
			.where(and(eq(sharedAttachments.stored, false), isNotNull(sharedAttachments.messageId), eq(sharedSessions.state, "active")))
			.orderBy(asc(sharedAttachments.createdAt), asc(sharedAttachments.id))
			.all()
			.map((r) => r.row);
	}
}
