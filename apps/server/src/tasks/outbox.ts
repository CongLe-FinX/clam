import { NetworkError, wire, type RequestResult } from "@clam/agent-network";
import { i18nMsg } from "@clam/contracts";
import type { peers } from "@clam/database";
import { decideAfterFailure, outboxBackoffMs } from "@clam/task-engine";
import { errorText } from "../network/util.ts";
import type { OutboxApi, TaskHub } from "./hub.ts";
import { applyRecord } from "./mirror.ts";
import type { OutboxRow, TaskMessageRow } from "./store.ts";

type PeerRow = typeof peers.$inferSelect;

/**
 * What a queued call does when its delivery settles. `outbox.kind` is a plain string and the service dispatches on it
 * through this table, so a feature adds its own kinds with `OutboxService.register` without touching the delivery loop
 * (ordering, backoff, peer reachability and attempt counting stay here).
 */
export interface OutboxHandler {
	/** The peer answered 2xx. The item is already marked `sent`. */
	sent(item: OutboxRow, status: number, body: unknown): void;
	/** Permanent refusal or attempts exhausted. The item is already marked `dead`. */
	dead(item: OutboxRow, reason: string): void;
	/** A failed attempt will be retried (progress for the UI). */
	retrying?(item: OutboxRow): void;
}

/**
 * Durable at-least-once delivery of the mutating peer calls (`task.create`, `task.message`, `task.cancel`;
 * protocol §6–7). Every attempt re-sends the same body with the same `Idempotency-Key`, so the receiver's response
 * store and the natural keys (`taskId`, `messageId`) make a duplicate delivery harmless.
 *
 * Per peer the items go out one at a time, oldest first, and only while the peer is `online`/`degraded` (an offline
 * peer's items wait without consuming attempts and drain when it comes back). An item never overtakes an earlier
 * pending item of its own task: a message or cancel must not reach the executor before the task itself.
 */
export class OutboxService implements OutboxApi {
	private unsubscribe: (() => void) | null = null;
	private timer: NodeJS.Timeout | null = null;
	private stopped = true;
	private abort = new AbortController();
	private readonly running = new Map<string, Promise<void>>();
	private readonly rerun = new Set<string>();
	private readonly handlers = new Map<string, OutboxHandler>();

	constructor(private readonly hub: TaskHub) {}

	/** Attach what happens to items of `kind` after delivery. A kind without a handler is delivered and only marked sent/dead. */
	register(kind: string, handler: OutboxHandler): void {
		this.handlers.set(kind, handler);
	}

	start(): void {
		this.stopped = false;
		this.abort = new AbortController();
		this.unsubscribe = this.hub.ctx.network.peers.onChange((change) => {
			if (change.type === "online" || change.type === "url_changed") this.kick(change.peerId);
		});
		this.timer = setInterval(() => this.kick(), this.hub.timings.outboxTickMs);
		this.timer.unref();
		this.kick();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.unsubscribe?.();
		this.unsubscribe = null;
		clearInterval(this.timer ?? undefined);
		this.timer = null;
		this.abort.abort();
		await Promise.all([...this.running.values()]);
	}

	kick(peerId?: string): void {
		if (this.stopped) return;
		for (const id of peerId ? [peerId] : this.peersWithWork()) void this.run(id);
	}

	async drain(peerId?: string): Promise<void> {
		if (this.stopped) return;
		await Promise.all((peerId ? [peerId] : this.peersWithWork()).map((id) => this.run(id)));
	}

	private peersWithWork(): string[] {
		return [...new Set(this.hub.store.pendingOutbox().map((item) => item.peerId))];
	}

	/** Single flight per peer; a request that arrives while a pass is running makes it look again once it is done. */
	private run(peerId: string): Promise<void> {
		const running = this.running.get(peerId);
		if (running) {
			this.rerun.add(peerId);
			return running;
		}
		const pass = (async () => {
			try {
				do {
					this.rerun.delete(peerId);
					await this.deliverDue(peerId);
				} while (this.rerun.has(peerId) && !this.stopped);
			} finally {
				this.running.delete(peerId);
			}
		})();
		this.running.set(peerId, pass);
		return pass;
	}

	/** Never throws. */
	private async deliverDue(peerId: string): Promise<void> {
		const { store, ctx, log } = this.hub;
		try {
			for (const due of store.dueOutbox(new Date().toISOString(), [peerId])) {
				if (this.stopped) return;
				const item = store.outboxRow(due.id);
				// Settled meanwhile: cascaded dead/cancelled, or reconciled by the mirror.
				if (!item || item.state !== "pending") continue;
				// Retargeted to another peer while this pass ran (`followExecutor`): that peer's pass delivers it.
				if (item.peerId !== peerId) continue;
				const peer = ctx.network.peers.row(peerId);
				if (!peer || (peer.status !== "online" && peer.status !== "degraded")) return;
				if (this.blockedByEarlier(item)) continue;
				// No answer from the peer: it is probably gone, so the rest of the queue waits for the next pass.
				if (!(await this.attempt(item, peer))) return;
			}
		} catch (error) {
			log.warn({ peerId, err: errorText(error) }, "outbox pass failed");
		}
	}

	private blockedByEarlier(item: OutboxRow): boolean {
		if (item.taskId === null) return false;
		return this.hub.store
			.outboxOfTask(item.taskId)
			.some((other) => other.id !== item.id && other.state === "pending" && (other.createdAt < item.createdAt || (other.createdAt === item.createdAt && other.id < item.id)));
	}

	/** One attempt. Resolves false when the peer gave no HTTP answer (the pass should stop). */
	private async attempt(item: OutboxRow, peer: PeerRow): Promise<boolean> {
		const attempts = item.attempts + 1;
		// Counted before the request: once it was on the wire the executor may have acted on it (see `TaskSender.cancel`).
		this.hub.store.updateOutbox(item.id, { attempts });
		let result: RequestResult<unknown>;
		try {
			result = await this.hub.ctx.network.client.request<unknown>(peer.url, {
				method: item.method,
				path: item.path,
				body: item.body,
				idempotencyKey: item.idempotencyKey,
				correlationId: item.correlationId,
				retry: false,
				signal: this.abort.signal,
			});
		} catch (error) {
			if (this.stopped) return false;
			return this.failed(item, attempts, error);
		}
		this.succeeded(item, result.status, result.body);
		return true;
	}

	private succeeded(item: OutboxRow, status: number, body: unknown): void {
		this.hub.store.updateOutbox(item.id, { state: "sent", sentAt: new Date().toISOString(), lastStatus: status, lastError: null });
		this.handlers.get(item.kind)?.sent(item, status, body);
	}

	/** Records the failure and decides pending vs dead. Resolves false for a transport failure. */
	private failed(item: OutboxRow, attempts: number, cause: unknown): boolean {
		const { hub } = this;
		const { store } = hub;
		const error = cause instanceof NetworkError ? cause : null;
		const lastError = errorText(cause);
		// The mirror may have seen the executor hold the task while this attempt was in flight.
		if (store.outboxRow(item.id)?.state !== "pending") return error?.status != null;

		// A peer that is gone is the heartbeat's business (it marks it offline and we stop attempting): never dead.
		if (error === null || error.status === null) {
			store.updateOutbox(item.id, { nextAttemptAt: new Date(Date.now() + outboxBackoffMs(attempts)).toISOString(), lastError, lastStatus: null });
			this.handlers.get(item.kind)?.retrying?.(item);
			return false;
		}

		const decision = decideAfterFailure({ attempts, retryable: error.retryable || error.code === "clock_skew", retryAfterMs: error.retryAfterMs });
		if (decision.state === "pending") {
			store.updateOutbox(item.id, { nextAttemptAt: new Date(Date.now() + decision.delayMs).toISOString(), lastError, lastStatus: error.status });
			this.handlers.get(item.kind)?.retrying?.(item);
			return true;
		}
		// The handlers see the settled row (`lastStatus` of THIS failure): the handoff kinds branch on 409 (stale epoch) and the like.
		const settled = store.updateOutbox(item.id, { state: "dead", lastError, lastStatus: error.status });
		this.died(settled ?? { ...item, state: "dead", lastError, lastStatus: error.status }, lastError);
		return true;
	}

	private died(item: OutboxRow, reason: string): void {
		this.hub.log.warn({ outboxId: item.id, kind: item.kind, taskId: item.taskId, err: reason }, "outbox item undeliverable");
		this.handlers.get(item.kind)?.dead(item, reason);
	}
}

/** The task kinds: `task.create` and `task.cancel` carry the executor's `TaskRecord`, `task.message` a thread message. */
export function taskOutboxHandlers(hub: TaskHub): Record<"task.create" | "task.message" | "task.cancel", OutboxHandler> {
	const { store } = hub;
	/** The message an item carries, fresh from the store, so a delivery change reaches the UI (`task:<id>` message frame). */
	const messagesOf = (item: OutboxRow): TaskMessageRow[] => {
		const row = item.kind === "task.message" && item.refId ? store.message(item.refId) : undefined;
		return row ? [row] : [];
	};
	const answerApplied = (item: OutboxRow, _status: number, body: unknown): void => {
		if (item.taskId === null) return;
		// The executor answers with its TaskRecord, applied exactly like a mirror poll.
		const record = wire.TaskRecord.safeParse(body);
		if (!record.success) {
			hub.log.warn({ taskId: item.taskId, kind: item.kind }, "the executor's answer is not a task record; polling instead");
			hub.changed(item.taskId);
			void hub.sender.syncTask(item.taskId);
			return;
		}
		const applied = applyRecord(hub, item.taskId, record.data);
		if (!applied.changed) hub.changed(item.taskId);
		if (!applied.settled) void hub.sender.syncTask(item.taskId);
	};
	return {
		"task.create": {
			sent: answerApplied,
			retrying(item) {
				if (item.taskId !== null) hub.changed(item.taskId);
			},
			dead(item, reason) {
				if (item.taskId === null) return;
				const failedMessages: TaskMessageRow[] = [];
				for (const dependent of store.outboxOfTask(item.taskId)) {
					if (dependent.id === item.id || dependent.state !== "pending") continue;
					store.updateOutbox(dependent.id, { state: "dead", lastError: "The task could not be delivered", lastErrorI18n: i18nMsg("The task could not be delivered").i18n });
					if (dependent.kind === "task.message" && dependent.refId) {
						store.setMessageDelivery(dependent.refId, "failed");
						failedMessages.push(...messagesOf(dependent));
					}
				}
				const peerName = hub.ctx.network.peers.row(item.peerId)?.name ?? "the peer";
				try {
					const { row, event } = store.transition(item.taskId, "failed", { from: ["offered"], reason: i18nMsg("Could not deliver the task to {peer}: {reason}", { peer: peerName, reason }) });
					hub.changed(item.taskId, { events: [event], messages: failedMessages, notifyPeer: false });
					void hub.injector.injectStatusNote(row);
				} catch (error) {
					// The task already left `offered` (the executor reported on it): nothing to fail.
					hub.log.warn({ taskId: item.taskId, err: errorText(error) }, "could not mark an undeliverable task failed");
					hub.changed(item.taskId);
				}
			},
		},
		"task.message": {
			sent(item) {
				if (item.taskId === null) return;
				if (item.refId) store.setMessageDelivery(item.refId, "delivered");
				hub.changed(item.taskId, { messages: messagesOf(item), notifyPeer: false });
			},
			dead(item) {
				if (item.taskId === null) return;
				if (item.refId) store.setMessageDelivery(item.refId, "failed");
				hub.changed(item.taskId, { messages: messagesOf(item), notifyPeer: false });
			},
		},
		// An undeliverable cancel leaves the task as it is; the mirror keeps reporting what the executor does.
		"task.cancel": { sent: answerApplied, dead() {} },
	};
}
