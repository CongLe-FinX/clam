/** Serializes async work per key (e.g. concurrent hellos for one invitation). */
export class KeyedLock {
	private readonly tails = new Map<string, Promise<unknown>>();

	async run<T>(key: string, task: () => Promise<T>): Promise<T> {
		const previous = this.tails.get(key) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(task);
		this.tails.set(key, next);
		try {
			return await next;
		} finally {
			if (this.tails.get(key) === next) this.tails.delete(key);
		}
	}
}

/** Lower-case hex without separators: `AB:CD ef-01` → `abcdef01`. */
export function normalizeFingerprint(input: string): string {
	return input.toLowerCase().replace(/[^0-9a-f]/g, "");
}

/** Short, single-line text of an unknown error for `lastError` columns and API messages. */
export function errorText(error: unknown, max = 300): string {
	const text = error instanceof Error ? error.message : String(error);
	return text.replace(/\s+/g, " ").slice(0, max);
}
