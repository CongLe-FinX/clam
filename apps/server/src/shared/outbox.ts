import { i18nMsg } from "@clam/contracts";
import type { OutboxHandler } from "../tasks/outbox.ts";
import type { OutboxRow } from "../tasks/store.ts";
import type { SharedHub } from "./hub.ts";

/** Outbox kinds of shared sessions (delivered by the task engine's `OutboxService`, dispatched through `register`). */
export const SHARED_OUTBOX_KINDS = ["shared.invite", "shared.decision", "shared.message", "shared.checkpoint", "shared.snapshot_ack", "shared.driver", "shared.membership"] as const;
export type SharedOutboxKind = (typeof SHARED_OUTBOX_KINDS)[number];

/**
 * What happens when a queued shared-session call settles. Delivery itself (ordering per `<shared>:<peer>`, backoff,
 * peer reachability, idempotency keys) is the task engine's outbox; these handlers only keep the user-visible state honest:
 * the delivery of thread messages and the fate of an invitation that could not be delivered.
 */
export function sharedOutboxHandlers(hub: SharedHub): Record<SharedOutboxKind, OutboxHandler> {
	const { store, log } = hub;
	const sharedIdOf = (item: OutboxRow): string | null => {
		const body = item.body;
		if (typeof body === "object" && body !== null && "sharedSessionId" in body && typeof body.sharedSessionId === "string") return body.sharedSessionId;
		return item.taskId?.split(":")[0] ?? null;
	};
	/** A message goes to several nodes: delivered when every copy arrived, failed as soon as one is undeliverable. */
	const settleMessage = (item: OutboxRow): void => {
		if (!item.refId) return;
		const message = store.message(item.refId);
		if (!message) return;
		const copies = store.outboxOfRef("shared.message", item.refId);
		const delivery = copies.some((c) => c.state === "dead") ? "failed" : copies.every((c) => c.state === "sent" || c.state === "cancelled") ? "delivered" : "pending";
		if (delivery === message.delivery) return;
		store.setMessageDelivery(message.id, delivery);
		const fresh = store.message(message.id);
		hub.changed(message.sharedSessionId, fresh ? { messages: [fresh] } : {});
	};
	const justLog = (what: string): OutboxHandler => ({
		sent() {},
		dead(item, reason) {
			log.warn({ outboxId: item.id, kind: item.kind, peerId: item.peerId, err: reason }, `${what} could not be delivered`);
		},
	});
	return {
		"shared.invite": {
			sent() {},
			dead(item, reason) {
				const sharedId = sharedIdOf(item);
				if (!sharedId) return;
				const participant = store.participant(sharedId, item.peerId);
				if (!participant || participant.state !== "invited") return;
				store.updateParticipant(sharedId, item.peerId, { state: "declined" });
				hub.discussion.note(sharedId, i18nMsg("The invitation to {name} could not be delivered: {reason}", { name: participant.nodeName, reason }));
				hub.changed(sharedId);
			},
		},
		"shared.decision": justLog("an answer to a shared session invitation"),
		"shared.message": {
			sent: settleMessage,
			dead: settleMessage,
		},
		"shared.checkpoint": justLog("a checkpoint notice"),
		"shared.snapshot_ack": justLog("a snapshot acknowledgement"),
		"shared.driver": justLog("a driver change notice"),
		"shared.membership": justLog("a membership notice"),
	};
}
