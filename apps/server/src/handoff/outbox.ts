import { wire } from "@clam/agent-network";
import type { HandoffState } from "@clam/contracts";
import { hasPassed } from "@clam/handoff-engine";
import { errorText } from "../network/util.ts";
import type { OutboxHandler } from "../tasks/outbox.ts";
import type { OutboxRow } from "../tasks/store.ts";
import type { HandoffHub } from "./hub.ts";

/** Outbox kinds of the handoff engine (delivered by the task engine's `OutboxService`, dispatched through `register`). */
export const HANDOFF_OUTBOX_KINDS = ["handoff.offer", "handoff.accept", "handoff.ack", "handoff.state", "task.executor"] as const;
export type HandoffOutboxKind = (typeof HANDOFF_OUTBOX_KINDS)[number];

/** `<handoffId>` of an item: `refId`, else the first segment of the ordering key. */
const handoffIdOf = (item: OutboxRow): string | null => item.refId ?? item.taskId?.split(":")[0] ?? null;

/**
 * What happens when a queued handoff call settles. Delivery itself (ordering per `<handoff>:<peer>`, backoff, peer reachability,
 * idempotency keys) is the task engine's outbox; these handlers keep the state machines honest:
 * - `handoff.offer` undeliverable (a permanent refusal) → the source records the offer as rejected;
 * - `handoff.accept` answered → the target adopts the source's restore deadline (or learns the offer is stale);
 * - `handoff.ack` answered → the target acquires ownership (step 9); `409 stale_epoch` → superseded; any other permanent failure is
 *   retried until the restore deadline (docs §4 step 8: "retried until deadline — safe because idempotent");
 * - `task.executor` (the notice to the task's sender) is retried until the sender took it.
 */
export function handoffOutboxHandlers(hub: HandoffHub): Record<HandoffOutboxKind, OutboxHandler> {
	const { store, log } = hub;

	/** Put a dead item back in the queue (the other node is reachable but refused for a reason that may pass). */
	const requeue = (item: OutboxRow, attemptsHint: number): void => {
		const delay = Math.min(30_000, hub.timings.ackRetryMs * 2 ** Math.min(attemptsHint, 6));
		hub.ctx.tasks.store.updateOutbox(item.id, { state: "pending", attempts: 0, nextAttemptAt: new Date(Date.now() + delay).toISOString() });
	};

	return {
		"handoff.offer": {
			sent() {},
			dead(item, reason) {
				const id = handoffIdOf(item);
				const row = id ? store.find(id) : undefined;
				if (!row || row.role !== "source" || row.state !== "offered") return;
				const stale = item.lastStatus === 409;
				try {
					hub.transition(row.id, "rejected", {
						summary: `${row.targetNodeName} refused the offer: ${reason}`,
						failure: { code: stale ? "superseded" : "manifest_invalid", detail: reason, step: null },
						notify: false,
					});
				} catch (error) {
					log.warn({ handoffId: row.id, err: errorText(error) }, "could not record an undeliverable offer");
				}
			},
		},
		"handoff.accept": {
			sent(item, _status, body) {
				const id = handoffIdOf(item);
				const row = id ? store.find(id) : undefined;
				if (!row || row.role !== "target") return;
				const parsed = wire.HandoffAcceptResponse.safeParse(body);
				if (!parsed.success) return;
				if (parsed.data.state === "accepted") {
					// The source's clock decides the restore window it will wait for.
					if (parsed.data.deadlineAt && parsed.data.deadlineAt !== row.deadlineAt) {
						store.update(row.id, { deadlineAt: parsed.data.deadlineAt });
						hub.changed(row.id);
					}
					return;
				}
				const detail = parsed.data.reason ?? "The source no longer wants this handoff";
				hub.target.receiveState(row.peerId, row.id, { epoch: row.toEpoch, state: "cancelled", summary: detail, at: new Date().toISOString() });
			},
			dead(item, reason) {
				const id = handoffIdOf(item);
				const row = id ? store.find(id) : undefined;
				if (!row || row.role !== "target") return;
				log.warn({ handoffId: row.id, err: reason }, "the accept could not be delivered");
				if (item.lastStatus === 409) {
					hub.target.receiveState(row.peerId, row.id, { epoch: row.toEpoch, state: "reclaimed", summary: reason, at: new Date().toISOString() });
				}
			},
		},
		"handoff.ack": {
			sent(item, _status, body) {
				const id = handoffIdOf(item);
				const response = wire.HandoffAckResponse.safeParse(body);
				if (id) void hub.target.ackConfirmed(id, response.success ? response.data : undefined).catch((error: unknown) => log.warn({ handoffId: id, err: errorText(error) }, "acquiring ownership after the ack failed"));
			},
			dead(item, reason) {
				const id = handoffIdOf(item);
				const row = id ? store.find(id) : undefined;
				if (!row || row.role !== "target") return;
				if (item.lastStatus === 409) {
					// stale_epoch / not accepting: the source reclaimed (docs §6.2) — never proceed to step 9.
					hub.target.receiveState(row.peerId, row.id, { epoch: row.toEpoch, state: "reclaimed", summary: `The source refused the ack: ${reason}`, at: new Date().toISOString() });
					return;
				}
				if (row.state === "acked" && !hasPassed(Date.now(), row.deadlineAt)) requeue(item, item.attempts);
			},
			retrying(item) {
				const id = handoffIdOf(item);
				if (id) hub.changed(id);
			},
		},
		"handoff.state": {
			sent() {},
			dead(item, reason) {
				log.debug({ outboxId: item.id, handoffId: handoffIdOf(item), err: reason }, "a handoff state notice was refused");
			},
		},
		"task.executor": {
			sent(item) {
				const id = handoffIdOf(item);
				const row = id ? store.find(id) : undefined;
				if (!row) return;
				store.patchMeta(row.id, { senderNotified: true });
				hub.note(row.id, "The task's sender knows the new executor");
			},
			dead(item, reason) {
				const id = handoffIdOf(item);
				const row = id ? store.find(id) : undefined;
				if (!row) return;
				// A 403/404/409 will not change by waiting (the sender revoked us, forgot the task, or follows another executor already).
				if (item.lastStatus !== null && [403, 404, 409].includes(item.lastStatus)) {
					hub.note(row.id, `The task's sender did not accept the executor change: ${reason}`);
					return;
				}
				requeue(item, item.attempts);
			},
		},
	};
}

export type { HandoffState };
