import type { TaskStatus } from "@clam/contracts";

export function describeStatusChange(from: TaskStatus | null, to: TaskStatus, reason?: string | null): string {
	const r = reason?.trim();
	if (to === "blocked" && r) return `blocked: ${r}`;
	const base = from === null || from === to ? to : `${from} → ${to}`;
	return r ? `${base}: ${r}` : base;
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
