import { NetworkError, decodeCursor, wire, type NetworkClient } from "@clam/agent-network";
import { CAPABILITIES, type Capability, type PeerStatus } from "@clam/contracts";
import type { DirectoryService } from "./directory.ts";
import type { PeerService } from "./peers.ts";
import { errorText } from "./util.ts";

export interface MonitorOptions {
	/** Heartbeat period per peer (docs/agent-network-protocol.md §12: 30 s, jittered ±20 %). */
	intervalMs: number;
	jitter: number;
	/** Consecutive failures that make a peer `offline`. */
	missesForOffline: number;
	/** A peer whose agents are refreshed at least this often even when no change was signalled. */
	agentsRefreshMs: number;
	/** The event stream counts as live only if it opens within this time (quick tunnels buffer SSE, so it never does there). */
	sseOpenTimeoutMs: number;
	/** After an event stream failed to open, do not try again for this long. */
	sseRetryAfterFailedOpenMs: number;
}

export const DEFAULT_MONITOR_OPTIONS: MonitorOptions = {
	intervalMs: 30_000,
	jitter: 0.2,
	missesForOffline: 3,
	agentsRefreshMs: 5 * 60_000,
	sseOpenTimeoutMs: 5_000,
	sseRetryAfterFailedOpenMs: 10 * 60_000,
};

interface Loop {
	peerId: string;
	timer: NodeJS.Timeout | null;
	misses: number;
	inFlight: Promise<void> | null;
	stopped: boolean;
	agentsRevision: string | null;
	lastAgentsRefresh: number;
	sse: { abort: AbortController | null; retryAt: number; backoffMs: number; reconnect: NodeJS.Timeout | null };
	lastSeq: number;
	/** The next heartbeat should come after `RETRY_SOON_MS`, not a full interval. */
	retrySoon: boolean;
}

/** A peer paired less than this long ago may simply not have finished pinning us yet. */
const JUST_PAIRED_MS = 60_000;
const RETRY_SOON_MS = 1_000;

const CAPABILITY_SET = new Set<string>(CAPABILITIES);

/**
 * Keeps every non-revoked peer's liveness honest: a signed `GET /node/health` per peer on a jittered timer is the
 * authority (status `online` / `degraded` / `offline` after 3 misses; a 403 `peer_revoked` marks the peer revoked by
 * remote). On top of that an SSE connection to the peer's `/events` delivers `agents_changed`, `peer_updated` and
 * `peer_revoked` immediately while it can be held; the health answer carries enough (agent revision, the capabilities
 * the peer grants us) that nothing depends on the stream.
 */
export class PeerMonitor {
	private readonly loops = new Map<string, Loop>();
	private offPeers: (() => void) | null = null;
	private running = false;

	constructor(
		private readonly deps: {
			/** Used for the event stream (long-lived). */
			client: NetworkClient;
			/** Short-timeout client for heartbeats. */
			probeClient: NetworkClient;
			/** This node's id: audience-scoped events (`peer_updated`, `peer_revoked`) are acted on only when addressed to it. */
			nodeId: string;
			peers: PeerService;
			directory: DirectoryService;
			log: { info(o: object, m?: string): void; warn(o: object, m?: string): void };
			options?: Partial<MonitorOptions>;
			/** A `task.updated` frame from the peer arrived (a hint only; the consumer polls the task). */
			onTaskUpdated?: (taskId: string | undefined, peerId: string) => void;
		},
	) {
		this.options = { ...DEFAULT_MONITOR_OPTIONS, ...deps.options };
	}

	private readonly options: MonitorOptions;

	start(): void {
		this.running = true;
		this.offPeers = this.deps.peers.onChange((change) => {
			if (change.type === "revoked") this.unwatch(change.peerId);
			else if (change.type === "added") this.watch(change.peerId);
			else if (change.type === "url_changed") this.restartSse(change.peerId);
		});
		for (const peer of this.deps.peers.activeRows()) this.watch(peer.id);
	}

	async stop(): Promise<void> {
		this.running = false;
		this.offPeers?.();
		this.offPeers = null;
		const pending: Promise<void>[] = [];
		for (const loop of this.loops.values()) {
			this.halt(loop);
			if (loop.inFlight) pending.push(loop.inFlight);
		}
		this.loops.clear();
		await Promise.allSettled(pending);
	}

	/** Start monitoring a peer; the first heartbeat runs immediately. */
	watch(peerId: string): void {
		if (!this.running || this.loops.has(peerId)) return;
		const loop: Loop = {
			peerId,
			timer: null,
			misses: 0,
			inFlight: null,
			stopped: false,
			agentsRevision: null,
			lastAgentsRefresh: 0,
			sse: { abort: null, retryAt: 0, backoffMs: 2_000, reconnect: null },
			lastSeq: 0,
			retrySoon: false,
		};
		this.loops.set(peerId, loop);
		void this.beat(loop);
	}

	unwatch(peerId: string): void {
		const loop = this.loops.get(peerId);
		if (!loop) return;
		this.halt(loop);
		this.loops.delete(peerId);
	}

	/** Run one heartbeat now (and wait for it). Used after pairing and by tests. */
	async probeNow(peerId: string): Promise<void> {
		const loop = this.loops.get(peerId);
		if (loop) await this.beat(loop);
	}

	private halt(loop: Loop): void {
		loop.stopped = true;
		if (loop.timer) clearTimeout(loop.timer);
		loop.timer = null;
		this.closeSse(loop);
	}

	private schedule(loop: Loop): void {
		if (loop.stopped) return;
		const { intervalMs, jitter } = this.options;
		const soon = loop.retrySoon;
		loop.retrySoon = false;
		const delay = soon ? Math.min(RETRY_SOON_MS, intervalMs) : Math.max(1, Math.round(intervalMs * (1 + (Math.random() * 2 - 1) * jitter)));
		loop.timer = setTimeout(() => void this.beat(loop), delay);
		loop.timer.unref();
	}

	/** Retry a heartbeat shortly (the regular timer is re-armed when it runs). */
	private scheduleSoon(loop: Loop): void {
		loop.retrySoon = true;
	}

	private beat(loop: Loop): Promise<void> {
		if (loop.inFlight) return loop.inFlight;
		if (loop.timer) clearTimeout(loop.timer);
		loop.timer = null;
		loop.inFlight = this.heartbeat(loop)
			.catch((error) => this.deps.log.warn({ err: errorText(error), peerId: loop.peerId }, "heartbeat failed unexpectedly"))
			.finally(() => {
				loop.inFlight = null;
				this.schedule(loop);
			});
		return loop.inFlight;
	}

	private async heartbeat(loop: Loop): Promise<void> {
		const { peers, probeClient } = this.deps;
		const peer = peers.row(loop.peerId);
		if (!peer || peer.status === "revoked") return this.unwatch(loop.peerId);
		const wasUp = peer.status === "online" || peer.status === "degraded";
		try {
			const result = await probeClient.request<unknown>(peer.url, { method: "GET", path: "/node/health", retry: false });
			if (loop.stopped) return;
			loop.misses = 0;
			const body = (typeof result.body === "object" && result.body !== null ? result.body : {}) as Record<string, unknown>;
			const parsed = wire.NodeHealth.safeParse(result.body);
			const reported = parsed.success ? parsed.data.status : "degraded";
			const status: PeerStatus = reported === "ok" ? "online" : "degraded";
			peers.setLiveness(peer.id, { status, latencyMs: result.latencyMs, seen: true, error: status === "degraded" ? `The peer reports its health as ${reported}` : null });
			this.absorbHealthHints(loop, body);
			if (!wasUp || Date.now() - loop.lastAgentsRefresh >= this.options.agentsRefreshMs) void this.refreshAgents(loop);
			this.ensureSse(loop);
		} catch (error) {
			if (loop.stopped) return;
			if (error instanceof NetworkError && error.code === "peer_revoked") {
				peers.revoke(peer.id, "remote");
				return;
			}
			let message = error instanceof NetworkError ? this.describe(error) : errorText(error);
			if (error instanceof NetworkError && error.status !== null && (error.code === "unknown_peer" || error.code === "key_mismatch")) {
				// The peer answers but does not recognise this node: not usable until it does.
				loop.misses = this.options.missesForOffline;
				if (Date.now() - Date.parse(peer.pairedAt) < JUST_PAIRED_MS) {
					// The other side pins us a few milliseconds after we pinned it: look again shortly instead of a full interval.
					message = "Waiting for the other node to finish pairing";
					this.scheduleSoon(loop);
				}
			} else {
				loop.misses += 1;
			}
			const status: PeerStatus = loop.misses >= this.options.missesForOffline ? "offline" : wasUp ? "degraded" : "offline";
			peers.setLiveness(peer.id, { status, latencyMs: null, error: message });
			if (status === "offline") this.closeSse(loop);
		}
	}

	private describe(error: NetworkError): string {
		if (error.code === "clock_skew") return "Clock out of sync with this peer (requests are rejected for a timestamp more than a minute apart)";
		if (error.code === "unknown_peer") return "The peer does not recognise this node (it may have been reset); pair again";
		if (error.code === "key_mismatch") return "The peer presents a different key than the one pinned at pairing";
		return errorText(error.message);
	}

	/** Additive fields of our signed health answer: the capabilities the peer grants us and its agent-list revision. */
	private absorbHealthHints(loop: Loop, body: Record<string, unknown>): void {
		const granted = body.grantedCapabilities;
		if (Array.isArray(granted) && granted.every((c) => typeof c === "string")) {
			const next = (granted as string[]).filter((c): c is Capability => CAPABILITY_SET.has(c));
			const row = this.deps.peers.row(loop.peerId);
			if (row && JSON.stringify([...next].sort()) !== JSON.stringify([...(row.receivedCapabilities as string[])].sort())) {
				this.deps.peers.setReceivedCapabilities(loop.peerId, next);
				void this.refreshAgents(loop);
			}
		}
		const revision = body.agentsRevision;
		if (typeof revision === "string") {
			if (loop.agentsRevision !== null && loop.agentsRevision !== revision) void this.refreshAgents(loop);
			loop.agentsRevision = revision;
		}
	}

	private async refreshAgents(loop: Loop): Promise<void> {
		loop.lastAgentsRefresh = Date.now();
		await this.deps.directory.refresh(loop.peerId);
	}

	// ------------------------------------------------------------------------------------------ SSE

	private ensureSse(loop: Loop): void {
		if (loop.stopped || loop.sse.abort || loop.sse.reconnect || Date.now() < loop.sse.retryAt) return;
		void this.runSse(loop);
	}

	private closeSse(loop: Loop): void {
		loop.sse.abort?.abort();
		loop.sse.abort = null;
		if (loop.sse.reconnect) clearTimeout(loop.sse.reconnect);
		loop.sse.reconnect = null;
	}

	/** The peer's address changed: drop the old connection and let the next heartbeat open a new one. */
	private restartSse(peerId: string): void {
		const loop = this.loops.get(peerId);
		if (!loop) return;
		this.closeSse(loop);
		loop.sse.retryAt = 0;
		loop.sse.backoffMs = 2_000;
		void this.beat(loop);
	}

	private async runSse(loop: Loop): Promise<void> {
		const peer = this.deps.peers.row(loop.peerId);
		if (!peer || peer.status === "revoked") return;
		const abort = new AbortController();
		loop.sse.abort = abort;
		let opened = false;
		let openedAt = 0;
		const openTimer = setTimeout(() => {
			if (!opened) abort.abort();
		}, this.options.sseOpenTimeoutMs);
		try {
			await this.deps.client.events(peer.url, {
				lastEventId: peer.lastEventCursor ?? undefined,
				signal: abort.signal,
				onOpen: () => {
					opened = true;
					openedAt = Date.now();
					clearTimeout(openTimer);
				},
				onEvent: (event) => this.onEvent(loop, event),
			});
		} catch (error) {
			if (error instanceof NetworkError && error.code === "peer_revoked") this.deps.peers.revoke(loop.peerId, "remote");
		} finally {
			clearTimeout(openTimer);
		}
		if (loop.sse.abort === abort) loop.sse.abort = null;
		if (loop.stopped) return;
		if (!opened) {
			// Never became live (a proxy that buffers streams, or the peer does not serve events): polling carries on alone.
			loop.sse.retryAt = Date.now() + this.options.sseRetryAfterFailedOpenMs;
			return;
		}
		const lived = Date.now() - openedAt;
		loop.sse.backoffMs = lived > 30_000 ? 2_000 : Math.min(60_000, loop.sse.backoffMs * 2);
		const current = this.deps.peers.row(loop.peerId);
		if (!current || current.status === "revoked" || current.status === "offline") return;
		loop.sse.reconnect = setTimeout(() => {
			loop.sse.reconnect = null;
			this.ensureSse(loop);
		}, loop.sse.backoffMs);
		loop.sse.reconnect.unref();
	}

	private onEvent(loop: Loop, event: { id: string; event: string; data: unknown }): void {
		const parsed = wire.NodeEvent.safeParse(event.data);
		if (!parsed.success) return;
		const node = parsed.data;
		// At-least-once delivery: consumers dedupe by (stream, seq) and ignore what they already processed.
		const positions = decodeCursor(event.id);
		if (node.stream === "node") {
			if (node.seq <= loop.lastSeq && positions !== null) return;
			loop.lastSeq = Math.max(loop.lastSeq, node.seq);
		}
		if (event.id) this.deps.peers.setCursor(loop.peerId, event.id);
		const payload = (typeof node.payload === "object" && node.payload !== null ? node.payload : {}) as Record<string, unknown>;
		switch (node.type) {
			case "agents_changed":
			case "stream.reset":
				void this.refreshAgents(loop);
				break;
			case "peer_updated":
				if (payload.peerId === this.deps.nodeId && Array.isArray(payload.capabilities)) {
					this.deps.peers.setReceivedCapabilities(
						loop.peerId,
						(payload.capabilities as unknown[]).filter((c): c is Capability => typeof c === "string" && CAPABILITY_SET.has(c)),
					);
					void this.refreshAgents(loop);
				}
				break;
			case "peer_revoked":
				// Other peers receive the same frame with an empty payload; only the revoked node sees its own id here.
				if (payload.peerId === this.deps.nodeId) this.deps.peers.revoke(loop.peerId, "remote");
				break;
			case "task.updated":
				// Audience-scoped like `peer_updated`: other peers' frames carry an empty payload and are ignored.
				if (typeof payload.taskId === "string") this.deps.onTaskUpdated?.(payload.taskId, loop.peerId);
				break;
			default:
				break; // health and unknown types: heartbeat is the authority; unknown types are skipped (§13).
		}
	}
}
