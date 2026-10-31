import type { wire } from "@clam/agent-network";
import { verifyFencingToken } from "@clam/handoff-engine";
import { ApiError } from "../http/errors.ts";
import type { TaskHub } from "./hub.ts";
import type { TaskRow } from "./store.ts";

/** Outbox kinds whose body carries the task epoch (`wire.TaskMessageRequest`, `wire.CancelTaskRequest`) and that follow the task to its new executor. */
const FOLLOWING_KINDS: readonly string[] = ["task.message", "task.cancel"];

/**
 * Sender side of an executor change (docs/handoff-protocol.md §5, agent-network-protocol `POST /tasks/:id/executor`): the node that took over
 * a task this node delegated tells us, with the fencing token it signed for the new epoch. The row is OUTGOING (the executor is the source of
 * truth for status and events); the caller is not the row's current `peerId` but the NEW executor, so the usual "task of this peer" check does
 * not apply: the token (verified with the caller's pinned key) and the epoch rules are what authorize the change.
 *
 * Idempotent for the same `(caller, epoch)`. Never appends an event: the new executor owns the timeline from `eventSeqBase + 1`.
 */
export async function followExecutor(hub: TaskHub, input: { taskId: string; callerId: string; change: wire.TaskExecutorChange; syncOld: () => Promise<void> }): Promise<TaskRow> {
	const { taskId, callerId, change } = input;
	const { store } = hub;
	const first = store.find(taskId);
	if (!first || first.direction !== "outgoing") throw ApiError.notFound("Task");
	const peer = hub.ctx.network.peers.row(callerId);
	if (!peer || peer.status === "revoked") throw new ApiError(403, "forbidden", "The new executor is not a paired peer");

	// Already following this very change (a replayed notice): answer with the current row.
	if (first.peerId === callerId && first.epoch === change.epoch) return first;
	if (change.epoch <= first.epoch) throw new ApiError(409, "stale_epoch", `The task is at epoch ${first.epoch}; the notice carries epoch ${change.epoch}`, { currentEpoch: first.epoch });
	// The caller must have taken the task from the node we know as its executor, unless it skipped hops we never heard of.
	if (change.fromNodeId !== first.executorNodeId && change.epoch <= first.epoch + 1) {
		throw new ApiError(409, "executor_mismatch", `The notice says the task came from ${change.fromNodeId}; this node knows ${first.executorNodeId} as its executor`, { currentEpoch: first.epoch, executorNodeId: first.executorNodeId });
	}
	const verdict = verifyFencingToken(change.fencingToken, { publicKey: peer.publicKey, handoffId: change.handoffId, manifestSha256: change.manifestSha256, taskId, epoch: change.epoch });
	if (!verdict.ok) throw new ApiError(403, "invalid_fencing_token", `The fencing token does not verify (${verdict.reason})`, { reason: verdict.reason });

	// What the old executor still has (events up to the seal) is worth having; it may well be gone, and that is fine.
	await input.syncOld();

	const followed = hub.ctx.db.transaction(() => {
		const row = store.get(taskId);
		if (row.direction !== "outgoing") throw ApiError.notFound("Task");
		if (row.peerId === callerId && row.epoch === change.epoch) return row;
		// Another notice (or an answer from the old executor) moved the task meanwhile.
		if (change.epoch <= row.epoch) throw new ApiError(409, "stale_epoch", `The task is at epoch ${row.epoch}; the notice carries epoch ${change.epoch}`, { currentEpoch: row.epoch });
		const updated = store.update(taskId, {
			peerId: callerId,
			executorNodeId: callerId,
			executorNodeName: peer.name,
			executorAgentId: change.agentId ?? null,
			executorAgentName: change.agentName ?? null,
			executorSessionId: change.sessionId ?? null,
			epoch: change.epoch,
			highestSeenEpoch: Math.max(row.highestSeenEpoch, change.epoch),
			lastEventSeq: Math.max(row.lastEventSeq, change.eventSeqBase),
		});
		// Calls still waiting for the old executor (answers to its 503s) now go to the new one, at the new epoch, with their keys unchanged.
		const retryAt = new Date().toISOString();
		for (const item of store.outboxOfTask(taskId)) {
			if (item.state !== "pending" || !FOLLOWING_KINDS.includes(item.kind)) continue;
			store.updateOutbox(item.id, { peerId: callerId, body: { ...(item.body as Record<string, unknown>), epoch: change.epoch }, attempts: 0, nextAttemptAt: retryAt, lastError: null, lastStatus: null });
		}
		return updated;
	});

	hub.changed(taskId, { notifyPeer: false });
	hub.outbox.kick(callerId);
	void hub.sender.syncTask(taskId);
	return followed;
}
