import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface SnapshotCacheOptions<T extends { fetchedAt: string; stale: boolean }> {
	ttlMs: number;
	/** Produces a fresh snapshot (spawns the child process). Called at most once at a time. */
	fetch: () => Promise<T>;
	/** Disk location of the last good snapshot. */
	file: string;
	/** Validates a snapshot read from disk; returns null when it no longer matches the schema. */
	parse: (raw: unknown) => T | null;
	/** After a failed background refresh, wait this long before trying again. */
	failureCooldownMs?: number;
	onError?: (err: unknown) => void;
	now?: () => number;
}

/**
 * Stale-while-revalidate cache with single-flight refresh.
 * - fresh (age < ttl): served as-is.
 * - expired: last good snapshot is served with `stale: true` and one refresh runs in the background.
 * - nothing cached: callers wait on the single in-flight fetch.
 * The last good snapshot is persisted so the first request after a restart is instant.
 */
export class SnapshotCache<T extends { fetchedAt: string; stale: boolean }> {
	private value: T | null = null;
	private valueAtMs = 0;
	private inflight: Promise<T> | null = null;
	private diskLoaded: Promise<void> | null = null;
	private lastFailureAtMs = 0;
	private readonly now: () => number;

	constructor(private readonly opts: SnapshotCacheOptions<T>) {
		this.now = opts.now ?? Date.now;
	}

	async get(refresh = false): Promise<T> {
		await (this.diskLoaded ??= this.loadDisk());
		const age = this.now() - this.valueAtMs;

		if (this.value && !refresh) {
			if (age < this.opts.ttlMs) return { ...this.value, stale: false };
			if (this.now() - this.lastFailureAtMs >= (this.opts.failureCooldownMs ?? 15_000)) {
				this.refresh().catch(() => {});
			}
			return { ...this.value, stale: true };
		}

		try {
			return { ...(await this.refresh()), stale: false };
		} catch (err) {
			if (this.value) return { ...this.value, stale: true };
			throw err;
		}
	}

	/** Starts (or joins) the one refresh; failures are recorded and rethrown to awaiters. */
	private refresh(): Promise<T> {
		this.inflight ??= this.opts
			.fetch()
			.then(async (snapshot) => {
				this.value = snapshot;
				this.valueAtMs = this.now();
				this.lastFailureAtMs = 0;
				await this.persist(snapshot).catch((err) => this.opts.onError?.(err));
				return snapshot;
			})
			.catch((err) => {
				this.lastFailureAtMs = this.now();
				this.opts.onError?.(err);
				throw err;
			})
			.finally(() => {
				this.inflight = null;
			});
		return this.inflight;
	}

	private async loadDisk(): Promise<void> {
		try {
			const parsed = this.opts.parse(JSON.parse(await readFile(this.opts.file, "utf8")));
			if (parsed) {
				this.value = parsed;
				// Age is measured from when OMP produced the snapshot; a restart never makes old data look fresh.
				const at = Date.parse(parsed.fetchedAt);
				this.valueAtMs = Number.isFinite(at) ? at : 0;
			}
		} catch {
			// Missing or unreadable cache file: start cold.
		}
	}

	private async persist(snapshot: T): Promise<void> {
		await mkdir(dirname(this.opts.file), { recursive: true });
		const tmp = `${this.opts.file}.${process.pid}.tmp`;
		await writeFile(tmp, JSON.stringify(snapshot), { mode: 0o600 });
		await rename(tmp, this.opts.file);
	}
}
