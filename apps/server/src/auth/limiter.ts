/**
 * Brute-force protection of the owner login.
 *
 * - Per client: after `clientThreshold` consecutive failures the client is locked out for `baseLockMs · 2^(n − threshold)`
 *   (capped at `maxLockMs`); a success clears it; failures older than `decayMs` are forgotten.
 * - Global: more than `globalThreshold` failures within `globalWindowMs` (a botnet spreading guesses over many addresses)
 *   locks EVERY client out, again exponentially while it keeps happening. A real login or 30 quiet minutes resets it.
 * - While locked, even the right password is refused: that is what makes the lockout worth anything.
 *
 * Clients are identified by the caller (the real address behind the tunnel). Pure and clock-injectable.
 */
export interface LimiterOptions {
	now?: () => number;
	clientThreshold?: number;
	baseLockMs?: number;
	maxLockMs?: number;
	decayMs?: number;
	globalThreshold?: number;
	globalWindowMs?: number;
	globalBaseLockMs?: number;
	/** Cap on tracked clients (oldest evicted) so a flood of spoofed identities cannot grow memory. */
	maxClients?: number;
}

export type LimiterVerdict = { allowed: true } | { allowed: false; retryAfterSeconds: number };

interface ClientState {
	failures: number;
	lockedUntil: number;
	lastFailureAt: number;
}

export class LoginLimiter {
	private readonly now: () => number;
	private readonly clientThreshold: number;
	private readonly baseLockMs: number;
	private readonly maxLockMs: number;
	private readonly decayMs: number;
	private readonly globalThreshold: number;
	private readonly globalWindowMs: number;
	private readonly globalBaseLockMs: number;
	private readonly maxClients: number;
	private readonly clients = new Map<string, ClientState>();
	private recentFailures: number[] = [];
	private globalLockedUntil = 0;
	private globalLocks = 0;
	private lastGlobalLockAt = 0;

	constructor(options: LimiterOptions = {}) {
		this.now = options.now ?? Date.now;
		this.clientThreshold = options.clientThreshold ?? 5;
		this.baseLockMs = options.baseLockMs ?? 30_000;
		this.maxLockMs = options.maxLockMs ?? 15 * 60_000;
		this.decayMs = options.decayMs ?? 60 * 60_000;
		this.globalThreshold = options.globalThreshold ?? 20;
		this.globalWindowMs = options.globalWindowMs ?? 60_000;
		this.globalBaseLockMs = options.globalBaseLockMs ?? 30_000;
		this.maxClients = options.maxClients ?? 10_000;
	}

	/** Call before verifying a password. */
	check(client: string): LimiterVerdict {
		const now = this.now();
		const waits = [this.globalLockedUntil - now, (this.clients.get(client)?.lockedUntil ?? 0) - now];
		const wait = Math.max(...waits);
		return wait > 0 ? { allowed: false, retryAfterSeconds: Math.ceil(wait / 1000) } : { allowed: true };
	}

	failure(client: string): void {
		const now = this.now();
		let state = this.clients.get(client);
		if (state && now - state.lastFailureAt > this.decayMs) state = undefined;
		state ??= { failures: 0, lockedUntil: 0, lastFailureAt: now };
		state.failures += 1;
		state.lastFailureAt = now;
		if (state.failures >= this.clientThreshold) {
			state.lockedUntil = now + Math.min(this.baseLockMs * 2 ** (state.failures - this.clientThreshold), this.maxLockMs);
		}
		this.clients.delete(client); // re-insert: Map order = recency, so eviction drops the stalest
		this.clients.set(client, state);
		if (this.clients.size > this.maxClients) {
			const oldest = this.clients.keys().next().value;
			if (oldest !== undefined) this.clients.delete(oldest);
		}

		this.recentFailures = this.recentFailures.filter((at) => now - at < this.globalWindowMs);
		this.recentFailures.push(now);
		if (this.recentFailures.length > this.globalThreshold) {
			if (now - this.lastGlobalLockAt > 30 * 60_000) this.globalLocks = 0;
			this.globalLockedUntil = now + Math.min(this.globalBaseLockMs * 2 ** this.globalLocks, this.maxLockMs);
			this.globalLocks += 1;
			this.lastGlobalLockAt = now;
			this.recentFailures = [];
		}
	}

	success(client: string): void {
		this.clients.delete(client);
		this.globalLocks = 0;
	}
}
