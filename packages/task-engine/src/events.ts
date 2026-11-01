import { type I18nMessage, i18nMsg, type TaskStatus } from "@clam/contracts";

/** Timeline line of a status change; the English `text` is e.g. `accepted → running` or `blocked: waiting for answer`. */
export function statusChangeMessage(from: TaskStatus | null, to: TaskStatus, reason?: string | null): I18nMessage {
	const r = reason?.trim();
	if (to === "blocked" && r) return i18nMsg("blocked: {reason}", { reason: r });
	if (from === null || from === to) return r ? i18nMsg("{status}: {reason}", { status: to, reason: r }) : i18nMsg("{status}", { status: to });
	return r ? i18nMsg("{fromStatus} → {toStatus}: {reason}", { fromStatus: from, toStatus: to, reason: r }) : i18nMsg("{fromStatus} → {toStatus}", { fromStatus: from, toStatus: to });
}

/**
 * Filters a batch of mirrored executor events: sorted by seq, drops already-seen and
 * duplicate seqs. `gap` is true when the first accepted seq skips ahead of lastSeq+1
 * (the executor allocates gap-free seqs).
 */
export function applyMirroredEvents<T extends { seq: number }>(
	lastSeq: number,
	incoming: readonly T[],
): { accepted: T[]; lastSeq: number; gap: boolean } {
	const sorted = [...incoming].sort((a, b) => a.seq - b.seq);
	const accepted: T[] = [];
	let last = lastSeq;
	for (const e of sorted) {
		if (!(e.seq > last)) continue;
		accepted.push(e);
		last = e.seq;
	}
	const first = accepted[0];
	return { accepted, lastSeq: last, gap: first !== undefined && first.seq > lastSeq + 1 };
}
