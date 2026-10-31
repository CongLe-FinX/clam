export type EpochCheck =
	| { ok: true }
	| { ok: false; reason: "stale" | "future"; currentEpoch: number; suppliedEpoch: number };

export function checkEpoch(current: number, supplied: number): EpochCheck {
	if (supplied === current) return { ok: true };
	return {
		ok: false,
		reason: supplied < current ? "stale" : "future",
		currentEpoch: current,
		suppliedEpoch: supplied,
	};
}
