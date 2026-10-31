/** Per-key token bucket. `take` returns 0 when a token was available, else the seconds until one is. */
export class TokenBuckets {
	private readonly buckets = new Map<string, { tokens: number; at: number }>();

	constructor(
		private readonly capacity: number,
		private readonly refillPerSecond: number,
		private readonly now: () => number = Date.now,
	) {}

	take(key: string): number {
		const now = this.now();
		const bucket = this.buckets.get(key) ?? { tokens: this.capacity, at: now };
		bucket.tokens = Math.min(this.capacity, bucket.tokens + ((now - bucket.at) / 1000) * this.refillPerSecond);
		bucket.at = now;
		this.buckets.set(key, bucket);
		if (this.buckets.size > 4096) this.evictIdle(now);
		if (bucket.tokens >= 1) {
			bucket.tokens -= 1;
			return 0;
		}
		return Math.max(1, Math.ceil((1 - bucket.tokens) / this.refillPerSecond));
	}

	private evictIdle(now: number): void {
		for (const [key, bucket] of this.buckets) {
			if (now - bucket.at > 60_000) this.buckets.delete(key);
		}
	}
}
