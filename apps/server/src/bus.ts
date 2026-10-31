import type { EventBus } from "./context.ts";

type Listener = (event: unknown, seq: number) => void;

const MAX_RETAINED = 256;

/** Topics whose latest event is replayed to late subscribers. */
export function isRetainedTopic(topic: string): boolean {
	return topic === "node" || topic === "tunnel" || topic.startsWith("login:") || topic.startsWith("github-device:") || topic.startsWith("git-op:");
}

/** In-process topic bus. `seq` is per topic, starts at 1 and increases by one for every published event. */
export function createEventBus(): EventBus {
	const listeners = new Map<string, Set<Listener>>();
	const seqs = new Map<string, number>();
	const retained = new Map<string, { event: unknown; seq: number }>();
	const demandWatchers = new Set<{ prefix: string; listener: (topic: string, active: boolean) => void }>();
	const notifyDemand = (topic: string, active: boolean): void => {
		for (const w of [...demandWatchers]) {
			if (!topic.startsWith(w.prefix)) continue;
			try {
				w.listener(topic, active);
			} catch {
				// A failing demand watcher must never break subscribers.
			}
		}
	};
	return {
		publish(topic, event) {
			const seq = (seqs.get(topic) ?? 0) + 1;
			seqs.set(topic, seq);
			if (isRetainedTopic(topic)) {
				retained.delete(topic);
				retained.set(topic, { event, seq });
				if (retained.size > MAX_RETAINED) {
					const oldest = retained.keys().next().value;
					if (oldest !== undefined) {
						retained.delete(oldest);
						seqs.delete(oldest);
					}
				}
			}
			const set = listeners.get(topic);
			if (!set) return;
			for (const listener of [...set]) {
				try {
					listener(event, seq);
				} catch {
					// A failing subscriber (e.g. a closed socket) must never break publishers.
				}
			}
		},
		subscribe(topic, listener) {
			let set = listeners.get(topic);
			if (!set) {
				set = new Set();
				listeners.set(topic, set);
			}
			set.add(listener);
			if (set.size === 1) notifyDemand(topic, true);
			return () => {
				if (!set.delete(listener)) return;
				if (set.size === 0) {
					if (listeners.get(topic) === set) listeners.delete(topic);
					notifyDemand(topic, false);
				}
			};
		},
		hasSubscribers: (topic) => (listeners.get(topic)?.size ?? 0) > 0,
		watchDemand(prefix, listener) {
			const watcher = { prefix, listener };
			demandWatchers.add(watcher);
			for (const [topic, set] of listeners) if (topic.startsWith(prefix) && set.size > 0) listener(topic, true);
			return () => {
				demandWatchers.delete(watcher);
			};
		},
		latest: (topic) => retained.get(topic),
	};
}
