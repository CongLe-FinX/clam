export const OUTBOX_MAX_ATTEMPTS = 10;
export const OUTBOX_BACKOFF = { baseMs: 1000, capMs: 60000 } as const;

/** Full jitter: random in [0, min(cap, base*2^(attempt-1))], but never below `retryAfterMs`. */
export function outboxBackoffMs(attempt: number, random: () => number = Math.random, retryAfterMs = 0): number {
	const exp = Math.min(OUTBOX_BACKOFF.capMs, OUTBOX_BACKOFF.baseMs * 2 ** Math.max(0, attempt - 1));
	return Math.max(Math.floor(random() * exp), retryAfterMs);
}

/**
 * `attempts` includes the attempt that just failed. Time a peer spends offline does NOT
 * consume attempts: the server only attempts delivery while the peer is reachable.
 */
export function decideAfterFailure(i: {
	attempts: number;
	retryable: boolean;
	retryAfterMs?: number;
	random?: () => number;
}): { state: "pending"; delayMs: number } | { state: "dead" } {
	if (!i.retryable || i.attempts >= OUTBOX_MAX_ATTEMPTS) return { state: "dead" };
	return { state: "pending", delayMs: outboxBackoffMs(i.attempts, i.random, i.retryAfterMs ?? 0) };
}
