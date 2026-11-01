import { ulid, type wire } from "@clam/agent-network";
import { i18nMsg, type I18nMessage, type Task, type TaskEvent, type TaskMessage, type TaskResult, type TaskStatus } from "@clam/contracts";
import { TERMINAL_TASK_STATUSES } from "@clam/contracts";
import { artifacts, outbox, taskEvents, taskMessages, tasks, type ClamDb } from "@clam/database";
import { AGENT_MESSAGE_LIMIT, agentMessageBudget, applyMirroredEvents, assertTransition, statusChangeMessage, orderMessages, TaskTransitionError } from "@clam/task-engine";
import { and, asc, desc, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { ApiError } from "../http/errors.ts";

export type TaskRow = typeof tasks.$inferSelect;
export type TaskInsert = typeof tasks.$inferInsert;
export type TaskEventRow = typeof taskEvents.$inferSelect;
export type TaskMessageRow = typeof taskMessages.$inferSelect;
export type TaskMessageInsert = typeof taskMessages.$inferInsert;
export type OutboxRow = typeof outbox.$inferSelect;
export type ArtifactRow = typeof artifacts.$inferSelect;
export type EventKind = "status" | "progress" | "tool" | "message" | "result" | "note" | "late_result";
export type MessageDelivery = TaskMessage["delivery"];

export const newTaskId = (): string => `tsk_${ulid()}`;
export const newMessageId = (): string => `msg_${ulid()}`;
export const newArtifactId = (): string => `art_${ulid()}`;
const newOutboxId = (): string => `obx_${ulid()}`;

/** Results stored before result files existed have no `files` key. */
const withFiles = (result: TaskRow["result"]): TaskResult | null => (result ? { ...result, files: result.files ?? null } : null);

const nowIso = (): string => new Date().toISOString();

/** Executor-side load per local agent: `active` = accepted + running + blocked, `running` = running + blocked. */
export function activeTasksByAgent(db: ClamDb): Map<string, { active: number; running: number }> {
	const rows = db
		.select({ agentId: tasks.executorAgentId, status: tasks.status, n: sql<number>`count(*)` })
		.from(tasks)
		.where(and(eq(tasks.direction, "incoming"), inArray(tasks.status, ["accepted", "running", "blocked"])))
		.groupBy(tasks.executorAgentId, tasks.status)
		.all();
	const out = new Map<string, { active: number; running: number }>();
	for (const row of rows) {
		if (!row.agentId) continue;
		const entry = out.get(row.agentId) ?? { active: 0, running: 0 };
		entry.active += row.n;
		if (row.status !== "accepted") entry.running += row.n;
		out.set(row.agentId, entry);
	}
	return out;
}

export interface TaskFilter {
	direction?: "outgoing" | "incoming";
	statuses?: TaskStatus[];
	peerId?: string;
	projectId?: string;
	workspaceId?: string;
}

export interface NewOutboxItem {
	peerId: string;
	taskId: string | null;
	/** Free-form dispatch key (`task.create`, `task.message`, `task.cancel`, ...); `OutboxService.register` attaches the handler. */
	kind: string;
	/** The entity the call carries (the message id of `task.message`). */
	refId?: string | null;
	method?: string;
	/** Path relative to `/api/v1`. */
	path: string;
	body: unknown;
	/** Defaults to `<kind>:<refId ?? taskId>`: re-enqueueing the same logical call is a no-op. */
	idempotencyKey?: string;
	correlationId?: string;
	/** Earliest first attempt (default: now). */
	nextAttemptAt?: string;
}

export interface StatusTransitionOptions {
	/** Why (rejected / failed / blocked ...). Cleared (null) when omitted. */
	reason?: string | I18nMessage | null;
	/** Extra columns written together with the status. */
	patch?: Partial<TaskInsert>;
	/** Only transition when the current status is one of these; otherwise `ApiError` 409 `conflict`. */
	from?: readonly TaskStatus[];
	/** Extra fields merged into the status event payload. */
	payload?: Record<string, unknown>;
}

/**
 * Every SQL statement of the task engine. Domain rules live in `@clam/task-engine`; this class only persists them
 * and maps rows to the contract types. It never publishes, never calls peers and never touches sessions: its
 * callers (`TaskService` and the units around it) do. All methods are synchronous (better-sqlite3), so the
 * compare-and-set style updates below cannot interleave with another statement of this process.
 */
export class TaskStore {
	constructor(
		private readonly db: ClamDb,
		private readonly self: { nodeId: string },
	) {}

	get nodeId(): string {
		return this.self.nodeId;
	}

	/**
	 * A task that came home: this node delegated it, handed-over work returned to it (M7), so it executes its own task. Such a row is an
	 * `incoming` row whose peer is this node; nothing about it ever goes over the wire.
	 */
	isSelfPeer(row: Pick<TaskRow, "direction" | "peerId">): boolean {
		return row.direction === "incoming" && row.peerId === this.self.nodeId;
	}

	// ------------------------------------------------------------------ tasks

	find(id: string): TaskRow | undefined {
		return this.db.select().from(tasks).where(eq(tasks.id, id)).get();
	}

	get(id: string): TaskRow {
		const row = this.find(id);
		if (!row) throw ApiError.notFound("Task");
		return row;
	}

	list(filter: TaskFilter = {}): TaskRow[] {
		const conditions = [];
		if (filter.direction) conditions.push(eq(tasks.direction, filter.direction));
		if (filter.statuses && filter.statuses.length > 0) conditions.push(inArray(tasks.status, filter.statuses));
		if (filter.peerId) conditions.push(eq(tasks.peerId, filter.peerId));
		if (filter.projectId) conditions.push(eq(tasks.projectId, filter.projectId));
		if (filter.workspaceId) conditions.push(eq(tasks.workspaceId, filter.workspaceId));
		return this.db
			.select()
			.from(tasks)
			.where(conditions.length > 0 ? and(...conditions) : undefined)
			.orderBy(desc(tasks.updatedAt), desc(tasks.id))
			.all();
	}

	insert(values: TaskInsert): TaskRow {
		return this.db.insert(tasks).values(values).returning().get();
	}

	/** Update columns (and `updated_at`). Throws 404 for an unknown task. */
	update(id: string, patch: Partial<TaskInsert>): TaskRow {
		const row = this.db
			.update(tasks)
			.set({ ...patch, updatedAt: nowIso() })
			.where(eq(tasks.id, id))
			.returning()
			.get();
		if (!row) throw ApiError.notFound("Task");
		return row;
	}

	/** Merge keys into the executor-private run state (`undefined` values delete the key). */
	patchExecState(id: string, patch: Record<string, unknown>): TaskRow {
		const row = this.get(id);
		const next: Record<string, unknown> = { ...row.execState, ...patch };
		for (const [key, value] of Object.entries(next)) if (value === undefined) delete next[key];
		return this.update(id, { execState: next });
	}

	byExecutorSession(sessionId: string): TaskRow | undefined {
		return this.db.select().from(tasks).where(and(eq(tasks.executorSessionId, sessionId), eq(tasks.direction, "incoming"))).get();
	}

	bySenderSession(sessionId: string): TaskRow[] {
		return this.db.select().from(tasks).where(and(eq(tasks.senderSessionId, sessionId), eq(tasks.direction, "outgoing"))).orderBy(desc(tasks.createdAt)).all();
	}

	/**
	 * Move a task to `to` and append the status event, atomically. Illegal transitions throw `ApiError` 409
	 * `illegal_transition`; `options.from` adds a compare-and-set guard (409 `conflict`).
	 */
	transition(id: string, to: TaskStatus, options: StatusTransitionOptions = {}): { row: TaskRow; event: TaskEventRow } {
		return this.db.transaction((tx) => {
			const row = tx.select().from(tasks).where(eq(tasks.id, id)).get();
			if (!row) throw ApiError.notFound("Task");
			const from = row.status as TaskStatus;
			if (options.from && !options.from.includes(from)) throw ApiError.conflict(i18nMsg("Task is {status}, expected {expected}", { status: from, expected: options.from.join(" or ") }), { status: from });
			try {
				assertTransition(from, to);
			} catch (error) {
				if (error instanceof TaskTransitionError) throw new ApiError(409, "illegal_transition", i18nMsg("illegal task transition {fromStatus} → {toStatus}", { fromStatus: from, toStatus: to }), { from, to });
				throw error;
			}
			const at = nowIso();
			const say = typeof options.reason === "string" ? { text: options.reason, i18n: undefined } : (options.reason ?? null);
			const reason = say?.text ?? null;
			const seq = row.lastEventSeq + 1;
			const event = tx
				.insert(taskEvents)
				.values({ taskId: id, seq, type: "status", ...statusSummary(from, to, reason), payload: { from, to, reason, ...options.payload }, createdAt: at })
				.returning()
				.get();
			const updated = tx
				.update(tasks)
				.set({
					...options.patch,
					status: to,
					reason,
					reasonI18n: say?.i18n ?? null,
					lastEventSeq: seq,
					updatedAt: at,
					...(to === "running" && row.startedAt === null && { startedAt: at }),
					...(TERMINAL_TASK_STATUSES.includes(to) && { finishedAt: at }),
				})
				.where(eq(tasks.id, id))
				.returning()
				.get() as TaskRow;
			return { row: updated, event };
		});
	}

	// ------------------------------------------------------------------ events

	/** Append an event, allocating the next gap-free `seq` (executor side; the sender stores mirrored events with `mirrorEvents`). */
	appendEvent(taskId: string, e: { type: EventKind; summary: I18nMessage; payload?: unknown }): TaskEventRow {
		return this.db.transaction((tx) => {
			const row = tx.select({ seq: tasks.lastEventSeq }).from(tasks).where(eq(tasks.id, taskId)).get();
			if (!row) throw ApiError.notFound("Task");
			const seq = row.seq + 1;
			const at = nowIso();
			const event = tx.insert(taskEvents).values({ taskId, seq, type: e.type, ...eventSummary(e.summary), payload: e.payload ?? null, createdAt: at }).returning().get();
			tx.update(tasks).set({ lastEventSeq: seq, updatedAt: at }).where(eq(tasks.id, taskId)).run();
			return event;
		});
	}

	eventsSince(taskId: string, since: number, limit = 2000): TaskEventRow[] {
		return this.db
			.select()
			.from(taskEvents)
			.where(and(eq(taskEvents.taskId, taskId), sql`${taskEvents.seq} > ${since}`))
			.orderBy(asc(taskEvents.seq))
			.limit(limit)
			.all();
	}

	/**
	 * Sender side: store the executor's events under the executor's own seq. Duplicates and out-of-order batches are
	 * dropped by `applyMirroredEvents`; `gap` means events are missing (the caller re-polls from `lastEventSeq`).
	 */
	mirrorEvents(taskId: string, incoming: readonly wire.TaskEventWire[]): { inserted: TaskEventRow[]; gap: boolean } {
		return this.db.transaction((tx) => {
			const row = tx.select({ seq: tasks.lastEventSeq }).from(tasks).where(eq(tasks.id, taskId)).get();
			if (!row) throw ApiError.notFound("Task");
			const { accepted, lastSeq, gap } = applyMirroredEvents(row.seq, incoming);
			const inserted: TaskEventRow[] = [];
			for (const e of accepted) {
				const created = tx
					.insert(taskEvents)
					.values({ taskId, seq: e.seq, type: e.type, summary: e.summary, i18n: e.i18n ?? null, payload: e.payload ?? null, createdAt: e.at })
					.onConflictDoNothing()
					.returning()
					.get();
				if (created) inserted.push(created);
			}
			if (accepted.length > 0) tx.update(tasks).set({ lastEventSeq: lastSeq, updatedAt: nowIso() }).where(eq(tasks.id, taskId)).run();
			return { inserted, gap };
		});
	}

	// ------------------------------------------------------------------ messages

	message(id: string): TaskMessageRow | undefined {
		return this.db.select().from(taskMessages).where(eq(taskMessages.id, id)).get();
	}

	/** Insert a message; `inserted` is false when the id already exists (a duplicate delivery). */
	insertMessage(values: TaskMessageInsert): { row: TaskMessageRow; inserted: boolean } {
		const created = this.db.insert(taskMessages).values(values).onConflictDoNothing().returning().get();
		if (created) return { row: created, inserted: true };
		return { row: this.message(values.id) as TaskMessageRow, inserted: false };
	}

	/** Chronological (createdAt, then id) — the order of the thread on both nodes. */
	messages(taskId: string): TaskMessageRow[] {
		return orderMessages(this.db.select().from(taskMessages).where(eq(taskMessages.taskId, taskId)).all());
	}

	setMessageDelivery(id: string, delivery: MessageDelivery): void {
		this.db.update(taskMessages).set({ delivery }).where(eq(taskMessages.id, id)).run();
	}

	markInjected(id: string, sessionId: string): void {
		this.db.update(taskMessages).set({ injectedSessionId: sessionId }).where(eq(taskMessages.id, id)).run();
	}

	/** Messages that should be (re-)injected into a local session after a restart: not injected yet, written by someone else or by a human. */
	uninjectedMessages(): TaskMessageRow[] {
		return this.db
			.select()
			.from(taskMessages)
			.where(and(isNull(taskMessages.injectedSessionId), or(ne(taskMessages.authorNodeId, this.self.nodeId), eq(taskMessages.authorKind, "human"))))
			.orderBy(asc(taskMessages.receivedAt), asc(taskMessages.id))
			.all();
	}

	/** Mark every unread message of the task (those authored elsewhere) as read. Returns how many changed. */
	markRead(taskId: string): number {
		return this.db
			.update(taskMessages)
			.set({ readAt: nowIso() })
			.where(and(eq(taskMessages.taskId, taskId), isNull(taskMessages.readAt), ne(taskMessages.authorNodeId, this.self.nodeId)))
			.run().changes;
	}

	unread(taskId: string): number {
		return this.db
			.select({ n: sql<number>`count(*)` })
			.from(taskMessages)
			.where(and(eq(taskMessages.taskId, taskId), isNull(taskMessages.readAt), ne(taskMessages.authorNodeId, this.self.nodeId)))
			.get()?.n ?? 0;
	}

	/** Loop guard: agent messages this node may still author for the task (docs/architecture.md, "loop guard"). */
	budget(taskId: string): { limit: number; used: number; remaining: number } {
		const rows = this.db
			.select({ id: taskMessages.id, authorKind: taskMessages.authorKind, authorNodeId: taskMessages.authorNodeId, createdAt: taskMessages.createdAt })
			.from(taskMessages)
			.where(eq(taskMessages.taskId, taskId))
			.all()
			.map((r) => ({ ...r, authorKind: r.authorKind as "human" | "agent" | "system" }));
		return agentMessageBudget(rows, this.self.nodeId, AGENT_MESSAGE_LIMIT);
	}

	// ------------------------------------------------------------------ outbox

	outboxRow(id: string): OutboxRow | undefined {
		return this.db.select().from(outbox).where(eq(outbox.id, id)).get();
	}

	outboxByKey(peerId: string, key: string): OutboxRow | undefined {
		return this.db.select().from(outbox).where(and(eq(outbox.peerId, peerId), eq(outbox.idempotencyKey, key))).get();
	}

	/** Queue a mutating peer call. Re-enqueueing the same idempotency key returns the existing row untouched. */
	enqueue(item: NewOutboxItem): OutboxRow {
		const key = item.idempotencyKey ?? `${item.kind}:${item.refId ?? item.taskId ?? ulid()}`;
		const now = nowIso();
		const created = this.db
			.insert(outbox)
			.values({
				id: newOutboxId(),
				peerId: item.peerId,
				taskId: item.taskId,
				kind: item.kind,
				refId: item.refId ?? null,
				method: item.method ?? "POST",
				path: item.path,
				body: item.body,
				idempotencyKey: key,
				correlationId: item.correlationId ?? ulid(),
				nextAttemptAt: item.nextAttemptAt ?? now,
				createdAt: now,
			})
			.onConflictDoNothing()
			.returning()
			.get();
		return created ?? (this.outboxByKey(item.peerId, key) as OutboxRow);
	}

	/** Pending calls due at `now`, oldest first. */
	dueOutbox(now: string, peerIds?: readonly string[], limit = 200): OutboxRow[] {
		const conditions = [eq(outbox.state, "pending"), lte(outbox.nextAttemptAt, now)];
		if (peerIds) {
			if (peerIds.length === 0) return [];
			conditions.push(inArray(outbox.peerId, [...peerIds]));
		}
		return this.db
			.select()
			.from(outbox)
			.where(and(...conditions))
			.orderBy(asc(outbox.createdAt), asc(outbox.id))
			.limit(limit)
			.all();
	}

	/** Every pending call (due or not), oldest first — what the UI and recovery code look at. */
	pendingOutbox(peerId?: string): OutboxRow[] {
		return this.db
			.select()
			.from(outbox)
			.where(peerId ? and(eq(outbox.state, "pending"), eq(outbox.peerId, peerId)) : eq(outbox.state, "pending"))
			.orderBy(asc(outbox.createdAt), asc(outbox.id))
			.all();
	}

	outboxOfTask(taskId: string): OutboxRow[] {
		return this.db.select().from(outbox).where(eq(outbox.taskId, taskId)).orderBy(asc(outbox.createdAt), asc(outbox.id)).all();
	}

	updateOutbox(id: string, patch: Partial<typeof outbox.$inferInsert>): OutboxRow | undefined {
		// `last_error` and its twin always change together: a patch that sets one without the other clears the stale twin.
		const withTwin = "lastError" in patch && !("lastErrorI18n" in patch) ? { ...patch, lastErrorI18n: null } : patch;
		return this.db.update(outbox).set(withTwin).where(eq(outbox.id, id)).returning().get();
	}

	// ------------------------------------------------------------------ artifacts

	insertArtifact(values: typeof artifacts.$inferInsert): ArtifactRow {
		return this.db.insert(artifacts).values(values).returning().get();
	}

	artifacts(taskId: string): ArtifactRow[] {
		return this.db.select().from(artifacts).where(eq(artifacts.taskId, taskId)).orderBy(asc(artifacts.createdAt), asc(artifacts.id)).all();
	}

	artifact(taskId: string, artifactId: string): ArtifactRow | undefined {
		return this.db.select().from(artifacts).where(and(eq(artifacts.taskId, taskId), eq(artifacts.id, artifactId))).get();
	}

	// ------------------------------------------------------------------ counts (agents directory, health)

	activeTasksByAgent(): Map<string, { active: number; running: number }> {
		return activeTasksByAgent(this.db);
	}

	/** Executor-side totals for the signed health answer. */
	taskCounts(): { running: number; queued: number } {
		const rows = this.db
			.select({ status: tasks.status, n: sql<number>`count(*)` })
			.from(tasks)
			.where(and(eq(tasks.direction, "incoming"), inArray(tasks.status, ["accepted", "running", "blocked"])))
			.groupBy(tasks.status)
			.all();
		let running = 0;
		let queued = 0;
		for (const row of rows) {
			if (row.status === "accepted") queued += row.n;
			else running += row.n;
		}
		return { running, queued };
	}

	// ------------------------------------------------------------------ mapping

	/** The delivery state of the task itself (sender side), derived from the `task.create` outbox row. */
	private createDelivery(taskId: string): Task["delivery"] {
		const row = this.db
			.select()
			.from(outbox)
			.where(and(eq(outbox.taskId, taskId), eq(outbox.kind, "task.create")))
			.orderBy(desc(outbox.createdAt))
			.limit(1)
			.get();
		if (!row) return { state: "delivered", attempts: 0, lastError: null };
		const state = row.state === "pending" ? "pending" : row.state === "sent" ? "delivered" : "failed";
		return { state, attempts: row.attempts, lastError: row.lastError, ...(row.lastErrorI18n && { lastErrorI18n: row.lastErrorI18n }) };
	}

	toTask(row: TaskRow): Task {
		const outgoing = row.direction === "outgoing";
		return {
			id: row.id,
			direction: outgoing ? "outgoing" : "incoming",
			workspaceId: row.workspaceId,
			title: row.title,
			description: row.description,
			status: row.status as TaskStatus,
			epoch: row.epoch,
			repo: row.repoUrl === null ? null : { url: row.repoUrl, branch: row.repoBranch, commit: row.repoCommit },
			inputFiles: row.inputFiles ?? null,
			projectId: row.projectId,
			sender: { nodeId: row.senderNodeId, nodeName: row.senderNodeName, agentId: row.senderAgentId, agentName: row.senderAgentName, sessionId: row.senderSessionId },
			executor: { nodeId: row.executorNodeId, nodeName: row.executorNodeName, agentId: row.executorAgentId, agentName: row.executorAgentName, sessionId: row.executorSessionId },
			deliverAs: row.deliverAs === "summary" ? "summary" : row.deliverAs === "files" ? "files" : "branch",
			constraints: row.constraints,
			reason: row.reason,
			...(row.reasonI18n && { reasonI18n: row.reasonI18n }),
			result: withFiles(row.result),
			cost: row.cost,
			delivery: outgoing ? this.createDelivery(row.id) : { state: "delivered", attempts: 0, lastError: null },
			agentMessageBudget: this.budget(row.id).remaining,
			unreadMessages: this.unread(row.id),
			retryOf: row.retryOf,
			lastEventSeq: row.lastEventSeq,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			startedAt: row.startedAt,
			finishedAt: row.finishedAt,
		};
	}

	toEvent(row: TaskEventRow): TaskEvent {
		return { seq: row.seq, type: row.type as TaskEvent["type"], at: row.createdAt, summary: row.summary, ...(row.i18n && { i18n: row.i18n }), payload: row.payload ?? null };
	}

	toMessage(row: TaskMessageRow): TaskMessage {
		return {
			id: row.id,
			taskId: row.taskId,
			author: { kind: row.authorKind as TaskMessage["author"]["kind"], nodeId: row.authorNodeId, nodeName: row.authorNodeName, agentId: row.authorAgentId, agentName: row.authorAgentName },
			kind: row.kind as TaskMessage["kind"],
			text: row.text,
			createdAt: row.createdAt,
			delivery: row.delivery as TaskMessage["delivery"],
			injectedIntoSession: row.injectedSessionId !== null,
		};
	}

	/** What the executor tells the sender (`TaskRecord`, protocol §5.5). */
	toWireRecord(row: TaskRow): wire.TaskRecord {
		return {
			taskId: row.id,
			status: row.status as TaskStatus,
			epoch: row.epoch,
			agentId: row.executorAgentId,
			agentName: row.executorAgentName,
			reason: row.reason,
			...(row.reasonI18n && { reasonI18n: row.reasonI18n }),
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			startedAt: row.startedAt,
			finishedAt: row.finishedAt,
			result: withFiles(row.result),
			cost: row.cost,
			lastEventSeq: row.lastEventSeq,
		};
	}
}

/** Row columns of an event summary. A truncated text no longer equals its template rendering, so it is stored without the structured twin. */
function eventSummary(say: I18nMessage): { summary: string; i18n: I18nMessage["i18n"] | null } {
	return { summary: say.text.slice(0, 2000), i18n: say.text.length <= 2000 ? (say.i18n ?? null) : null };
}

function statusSummary(from: TaskStatus | null, to: TaskStatus, reason: string | null) {
	return eventSummary(statusChangeMessage(from, to, reason));
}
