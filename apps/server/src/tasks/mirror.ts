import { NetworkError, wire } from "@clam/agent-network";
import type { TaskStatus } from "@clam/contracts";
import { ACTIVE_TASK_STATUSES, isTerminalStatus } from "@clam/task-engine";
import { errorText } from "../network/util.ts";
import type { TaskHub } from "./hub.ts";
import type { TaskInsert } from "./store.ts";

/** One poll normally returns everything; more rounds only happen when the executor paged a long timeline. */
const MAX_ROUNDS = 5;

export interface AppliedRecord {
	/** The row or its timeline changed (and was published). */
	changed: boolean;
	gap: boolean;
	/**
	 * False when the executor is ahead of the timeline we hold (its answer carried no events, e.g. the answer to a
	 * `task.create`): the row was left alone and the caller should poll, so status and events arrive together.
	 */
	settled: boolean;
}

/**
 * Apply what the executor reported (a `TaskRecord`, plus the events newer than our cursor) to the sender's row.
 * Shared by the mirror poll and by the outbox (`task.create` / `task.cancel` answers carry the same record), and
 * idempotent: applying the same record twice changes and publishes nothing.
 */
export function applyRecord(hub: TaskHub, taskId: string, record: wire.TaskRecord, allEvents: readonly wire.TaskEventWire[] = []): AppliedRecord {
	const { store } = hub;
	const row = store.find(taskId);
	if (!row || row.direction !== "outgoing" || record.taskId !== taskId) return { changed: false, gap: false, settled: true };
	// A finished task is never reopened by a late answer, and a lower epoch is a node that lost ownership.
	if (isTerminalStatus(row.status as TaskStatus) || record.epoch < row.epoch) return { changed: false, gap: false, settled: true };

	// A `late_result` is a fenced executor's private note for its own human (docs/handoff-protocol.md §8.6); it is never part of our timeline.
	const events = allEvents.filter((e) => e.type !== "late_result");
	const { inserted, gap } = events.length > 0 ? store.mirrorEvents(taskId, events) : { inserted: [], gap: false };
	// `handed_off`: that executor released the task and the next one will announce itself (`TaskSender.followExecutor`). Its timeline up to the
	// seal is ours, but its status, epoch, result and end time are not adopted, and the row never ends because of it.
	if (record.status === "handed_off") {
		if (inserted.length > 0) hub.changed(taskId, { events: inserted, notifyPeer: false });
		return { changed: inserted.length > 0, gap, settled: true };
	}
	const current = store.get(taskId);
	// Every status change is an event on the executor: a record behind what we mirrored is an old answer, one ahead
	// would make the row run ahead of its timeline (and a terminal row is never polled again to fill it in).
	if (record.lastEventSeq !== current.lastEventSeq) {
		if (inserted.length > 0) hub.changed(taskId, { events: inserted, notifyPeer: false });
		return { changed: inserted.length > 0, gap, settled: record.lastEventSeq < current.lastEventSeq };
	}

	const patch: Partial<TaskInsert> = {};
	if (record.status !== current.status) patch.status = record.status;
	if ((record.reason ?? null) !== current.reason) patch.reason = record.reason ?? null;
	if (record.agentId != null && record.agentId !== current.executorAgentId) patch.executorAgentId = record.agentId;
	if (record.agentName != null && record.agentName !== current.executorAgentName) patch.executorAgentName = record.agentName;
	if (record.startedAt != null && record.startedAt !== current.startedAt) patch.startedAt = record.startedAt;
	if (isTerminalStatus(record.status)) {
		const finishedAt = record.finishedAt ?? current.finishedAt ?? new Date().toISOString();
		if (finishedAt !== current.finishedAt) patch.finishedAt = finishedAt;
	} else if (record.finishedAt != null && record.finishedAt !== current.finishedAt) {
		patch.finishedAt = record.finishedAt;
	}
	if (record.result != null && JSON.stringify(record.result) !== JSON.stringify(current.result)) patch.result = record.result;
	if (record.cost != null && record.cost !== current.cost) patch.cost = record.cost;
	if (record.epoch > current.epoch) patch.epoch = record.epoch;

	const dirty = Object.keys(patch).length > 0;
	if (!dirty && inserted.length === 0) return { changed: false, gap, settled: true };
	const updated = dirty ? store.update(taskId, patch) : current;
	hub.changed(taskId, { events: inserted, notifyPeer: false });
	if (patch.status !== undefined && (isTerminalStatus(record.status) || record.status === "blocked")) void hub.injector.injectStatusNote(updated);
	return { changed: true, gap, settled: true };
}

/** The executor knows the task, so its `task.create` reached it even if we never saw the answer. */
function reconcileCreate(hub: TaskHub, taskId: string): void {
	const item = hub.store.outboxOfTask(taskId).find((o) => o.kind === "task.create" && o.state === "pending");
	if (item) hub.store.updateOutbox(item.id, { state: "sent", sentAt: new Date().toISOString(), lastStatus: 200 });
}

/**
 * Polls the executor of every active outgoing task: `GET /tasks/:id?since=<lastEventSeq>` every
 * `timings.mirrorIntervalMs`, right when the peer comes online and on a `task.updated` hint (`syncTask`).
 * Polling is the authority; the hint only makes it happen sooner.
 */
export class TaskMirror {
	private timer: NodeJS.Timeout | null = null;
	private unsubscribe: (() => void) | null = null;
	private stopped = true;
	private abort = new AbortController();
	private readonly inFlight = new Map<string, Promise<void>>();

	constructor(private readonly hub: TaskHub) {}

	start(): void {
		this.stopped = false;
		this.abort = new AbortController();
		this.unsubscribe = this.hub.ctx.network.peers.onChange((change) => {
			if (change.type === "online") void this.syncPeer(change.peerId);
		});
		this.timer = setInterval(() => void this.syncPeer(), this.hub.timings.mirrorIntervalMs);
		this.timer.unref();
		void this.syncPeer();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.unsubscribe?.();
		this.unsubscribe = null;
		clearInterval(this.timer ?? undefined);
		this.timer = null;
		this.abort.abort();
		await Promise.all([...this.inFlight.values()]);
	}

	/** Single flight per task: a poll that is already running answers the caller too. */
	syncTask(taskId: string): Promise<void> {
		if (this.stopped) return Promise.resolve();
		const running = this.inFlight.get(taskId);
		if (running) return running;
		const poll = this.poll(taskId).finally(() => this.inFlight.delete(taskId));
		this.inFlight.set(taskId, poll);
		return poll;
	}

	/** Poll every active outgoing task (of one peer, or of all peers) now. */
	async syncPeer(peerId?: string): Promise<void> {
		const rows = this.hub.store.list({ direction: "outgoing", statuses: [...ACTIVE_TASK_STATUSES], peerId });
		await Promise.all(rows.map((row) => this.syncTask(row.id)));
	}

	/** Never throws: an unreachable executor, a 404 for a create it never got, or a revoked peer just means "try again later". */
	private async poll(taskId: string): Promise<void> {
		const { hub } = this;
		try {
			for (let round = 0; round < MAX_ROUNDS && !this.stopped; round++) {
				const row = hub.store.find(taskId);
				if (!row || row.direction !== "outgoing" || isTerminalStatus(row.status as TaskStatus)) return;
				const peer = hub.ctx.network.peers.row(row.peerId);
				if (!peer || (peer.status !== "online" && peer.status !== "degraded")) return;

				const res = await hub.ctx.network.client.request<unknown>(peer.url, { method: "GET", path: `/tasks/${taskId}?since=${row.lastEventSeq}`, retry: false, signal: this.abort.signal });
				const parsed = wire.GetTaskResponse.safeParse(res.body);
				if (!parsed.success) {
					hub.log.warn({ taskId, peerId: row.peerId }, "the executor sent a task record this node cannot read");
					return;
				}
				reconcileCreate(hub, taskId);
				const { gap } = applyRecord(hub, taskId, parsed.data, parsed.data.events);
				if (gap) hub.log.warn({ taskId, peerId: row.peerId }, "the executor's event timeline skipped sequence numbers");

				const after = hub.store.get(taskId);
				const received = parsed.data.events?.length ?? 0;
				if (received === 0 || after.lastEventSeq >= parsed.data.lastEventSeq || after.lastEventSeq === row.lastEventSeq) return;
			}
		} catch (error) {
			if (this.stopped) return;
			const entry = { taskId, err: errorText(error) };
			// An unreachable peer or an executor that answered with an error is routine; anything else is a bug worth seeing.
			if (error instanceof NetworkError) hub.log.debug(entry, "task mirror poll failed");
			else hub.log.warn(entry, "task mirror poll failed");
		}
	}
}
