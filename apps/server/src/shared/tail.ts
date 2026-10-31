import { buildPostCheckpointDigest } from "@clam/task-engine";
import type { FastifyBaseLogger } from "fastify";
import { errorText } from "../network/util.ts";
import type { CheckpointRow, SharedStore } from "./store.ts";

/**
 * What the former driver did after the checkpoint a takeover continues from, read from this node's stored mirror of the
 * driving session (it survives the driver going offline and a restart). The snapshot holds the first
 * `held.snapshotMessages` messages of the driver's transcript (`takeSnapshot` stores the driving session's message total) and
 * the mirror stores the same ordered messages, so the tail is the mirror's messages from that position on. Null when there is
 * no mirror, no recorded count or nothing newer. Never throws: the takeover must not depend on it.
 */
export function postCheckpointTail(store: SharedStore, log: FastifyBaseLogger, mirrorSessionId: string | null, held: CheckpointRow): string | null {
	if (!mirrorSessionId) return null;
	try {
		return buildPostCheckpointDigest(store.mirrorMessages(mirrorSessionId), { snapshotMessages: held.snapshotMessages });
	} catch (error) {
		log.warn({ err: errorText(error), mirrorSessionId, seq: held.seq }, "could not read what the driver did after the checkpoint");
		return null;
	}
}
