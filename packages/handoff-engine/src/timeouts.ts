/** Timers of docs/handoff-protocol.md §7. All wall-clock, enforced against each node's own clock. */

const MINUTE = 60_000;

export const OFFER_EXPIRY_MS = 30 * MINUTE;
/** Accept → ack. Extendable by the user. */
export const RESTORE_DEADLINE_MS = 30 * MINUTE;
/** Per step with its own timeout (dependency setup, validation). */
export const STEP_TIMEOUT_MS = 10 * MINUTE;
/** After `completed`, records are archived. */
export const COMPLETED_GRACE_MS = 24 * 60 * MINUTE;

export interface DeadlineOptions {
	offerExpiryMs?: number;
	restoreDeadlineMs?: number;
	stepTimeoutMs?: number;
	completedGraceMs?: number;
}

export interface Deadlines {
	createdAt: string;
	/** Offer lifetime: `offered → expired` when passed with no response. */
	expiresAt: string;
	/**
	 * Absolute restore deadline for a freshly built offer: the latest the target could still be inside its
	 * restore window if it accepted at the very end of the offer (`expiresAt + restoreDeadlineMs`). Re-base it with
	 * {@link restoreDeadlineFrom} when the target actually accepts.
	 */
	deadlineAt: string;
	stepTimeoutMs: number;
	completedGraceMs: number;
}

export type TimeInput = number | string | Date;

export function toMs(time: TimeInput): number {
	if (typeof time === "number") return time;
	return time instanceof Date ? time.getTime() : Date.parse(time);
}

export function computeDeadlines(now: TimeInput, opts: DeadlineOptions = {}): Deadlines {
	const t = toMs(now);
	const expiresAt = t + (opts.offerExpiryMs ?? OFFER_EXPIRY_MS);
	return {
		createdAt: new Date(t).toISOString(),
		expiresAt: new Date(expiresAt).toISOString(),
		deadlineAt: new Date(expiresAt + (opts.restoreDeadlineMs ?? RESTORE_DEADLINE_MS)).toISOString(),
		stepTimeoutMs: opts.stepTimeoutMs ?? STEP_TIMEOUT_MS,
		completedGraceMs: opts.completedGraceMs ?? COMPLETED_GRACE_MS,
	};
}

/** Restore deadline counted from acceptance (accept → ack). */
export function restoreDeadlineFrom(acceptedAt: TimeInput, restoreDeadlineMs: number = RESTORE_DEADLINE_MS): string {
	return new Date(toMs(acceptedAt) + restoreDeadlineMs).toISOString();
}

/** User extends the restore deadline from the later of the current deadline and `now`. */
export function extendDeadline(deadlineAt: TimeInput, minutes: number, now: TimeInput = Date.now()): string {
	return new Date(Math.max(toMs(deadlineAt), toMs(now)) + minutes * MINUTE).toISOString();
}

/** True once `now` reached `at`; a missing/unparseable `at` never expires. */
export function hasPassed(now: TimeInput, at: TimeInput | null | undefined): boolean {
	if (at === null || at === undefined) return false;
	const limit = toMs(at);
	return !Number.isNaN(limit) && toMs(now) >= limit;
}
