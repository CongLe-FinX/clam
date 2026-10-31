import type { ClientWsMessage, ServerWsMessage, TopicPayload } from "@clam/contracts";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { authGate } from "@/features/auth/gate.ts";
import { api } from "./api.ts";

export type WsStatus = "connecting" | "open" | "closed";
type AnyEvent = TopicPayload["event"];
export type TopicHandler = (event: AnyEvent) => void;

/** Event payload type for a concrete topic string. */
export type EventFor<T extends string> = T extends `session:${string}`
	? Extract<TopicPayload, { topic: `session:${string}` }>["event"]
	: T extends `login:${string}`
		? Extract<TopicPayload, { topic: `login:${string}` }>["event"]
		: T extends `github-device:${string}`
			? Extract<TopicPayload, { topic: `github-device:${string}` }>["event"]
			: T extends `git:${string}`
				? Extract<TopicPayload, { topic: `git:${string}` }>["event"]
				: T extends `git-op:${string}`
					? Extract<TopicPayload, { topic: `git-op:${string}` }>["event"]
					: T extends `task:${string}`
						? Extract<TopicPayload, { topic: `task:${string}` }>["event"]
						: T extends "sessions" | "runtime" | "node" | "network" | "tunnel" | "tasks"
							? Extract<TopicPayload, { topic: T }>["event"]
							: AnyEvent;

interface Entry {
	handler: TopicHandler;
	onResync?: () => void;
}
interface TopicState {
	entries: Set<Entry>;
	lastSeq: number | null;
}

const PING_MS = 20_000;
const DEAD_MS = 50_000;

class WsClient {
	private socket: WebSocket | null = null;
	private topics = new Map<string, TopicState>();
	private status: WsStatus = "closed";
	private statusListeners = new Set<() => void>();
	private attempts = 0;
	private everOpened = false;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private pingTimer: ReturnType<typeof setInterval> | null = null;
	private lastRx = 0;
	private pendingSub = new Set<string>();
	private pendingUnsub = new Set<string>();
	private flushQueued = false;
	private started = false;
	/** Signed out on the public origin: no sockets, no reconnect loop until the gate clears. */
	private paused = false;
	private lastProbe = 0;
	private stableTimer: ReturnType<typeof setTimeout> | null = null;

	getStatus = (): WsStatus => this.status;
	onStatus = (cb: () => void): (() => void) => {
		this.statusListeners.add(cb);
		return () => this.statusListeners.delete(cb);
	};

	private setStatus(s: WsStatus): void {
		if (this.status === s) return;
		this.status = s;
		for (const l of this.statusListeners) l();
	}

	/** Open the socket (idempotent). Called on first subscribe and from app boot. */
	start(): void {
		if (this.started) return;
		this.started = true;
		authGate.subscribe(() => (authGate.isRequired() ? this.pause() : this.resume()));
		this.paused = authGate.isRequired();
		if (typeof document !== "undefined") {
			document.addEventListener("visibilitychange", () => {
				if (document.visibilityState === "visible" && this.status === "closed") this.connect(true);
			});
			addEventListener("online", () => this.status === "closed" && this.connect(true));
		}
		this.connect(false);
	}

	private pause(): void {
		this.paused = true;
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = null;
		this.socket?.close();
	}

	private resume(): void {
		this.paused = false;
		this.attempts = 0;
		if (this.started) this.connect(true);
	}

	/**
	 * A refused handshake looks like any other close to the browser. Ask the (unauthenticated) status route whether the
	 * owner session is gone, so an expired session stops the reconnect loop instead of hammering the server.
	 */
	private probeAuth(): void {
		const now = Date.now();
		if (now - this.lastProbe < 5_000) return;
		this.lastProbe = now;
		void api
			.get<{ via: string; signedIn: boolean }>("/access")
			.then((a) => {
				if (a.via === "remote" && !a.signedIn) authGate.require();
			})
			.catch(() => undefined);
	}

	subscribe<T extends string>(topic: T, handler: (event: EventFor<T>) => void, onResync?: () => void): () => void {
		this.start();
		const entry: Entry = { handler: handler as TopicHandler, onResync };
		let st = this.topics.get(topic);
		if (!st) {
			st = { entries: new Set(), lastSeq: null };
			this.topics.set(topic, st);
		}
		st.entries.add(entry);
		if (st.entries.size === 1) {
			this.pendingUnsub.delete(topic);
			this.pendingSub.add(topic);
			this.queueFlush();
		}
		return () => {
			const cur = this.topics.get(topic);
			if (!cur) return;
			cur.entries.delete(entry);
			if (cur.entries.size === 0) {
				this.topics.delete(topic);
				this.pendingSub.delete(topic);
				this.pendingUnsub.add(topic);
				this.queueFlush();
			}
		};
	}

	private queueFlush(): void {
		if (this.flushQueued) return;
		this.flushQueued = true;
		queueMicrotask(() => {
			this.flushQueued = false;
			if (this.socket?.readyState !== WebSocket.OPEN) {
				this.pendingSub.clear();
				this.pendingUnsub.clear();
				return;
			}
			if (this.pendingSub.size) this.send({ type: "subscribe", topics: [...this.pendingSub] });
			if (this.pendingUnsub.size) this.send({ type: "unsubscribe", topics: [...this.pendingUnsub] });
			this.pendingSub.clear();
			this.pendingUnsub.clear();
		});
	}

	private send(msg: ClientWsMessage): void {
		if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg));
	}

	private connect(immediate: boolean): void {
		if (this.retryTimer) {
			clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
		if (this.paused || (this.socket && this.socket.readyState <= WebSocket.OPEN)) return;
		this.setStatus("connecting");
		const proto = location.protocol === "https:" ? "wss" : "ws";
		const ws = new WebSocket(`${proto}://${location.host}/ws`);
		this.socket = ws;
		void immediate;
		ws.onopen = () => {
			this.lastRx = Date.now();
			const reconnect = this.everOpened;
			this.everOpened = true;
			// Back-off only resets once the connection proved stable (a server that accepts then drops must not cause a tight loop).
			this.stableTimer = setTimeout(() => (this.attempts = 0), 5_000);
			this.setStatus("open");
			this.pendingSub.clear();
			this.pendingUnsub.clear();
			const names = [...this.topics.keys()];
			for (const st of this.topics.values()) st.lastSeq = null;
			if (names.length) this.send({ type: "subscribe", topics: names });
			if (reconnect) for (const st of this.topics.values()) for (const e of st.entries) e.onResync?.();
			this.pingTimer = setInterval(() => {
				if (Date.now() - this.lastRx > DEAD_MS) ws.close();
				else this.send({ type: "ping", t: Date.now() });
			}, PING_MS);
		};
		ws.onmessage = (ev) => {
			this.lastRx = Date.now();
			let msg: ServerWsMessage;
			try {
				msg = JSON.parse(ev.data as string) as ServerWsMessage;
			} catch {
				return;
			}
			if (msg.type !== "event") return;
			const st = this.topics.get(msg.topic);
			if (!st) return;
			const gap = st.lastSeq !== null && msg.seq !== st.lastSeq + 1;
			st.lastSeq = msg.seq;
			if (gap) for (const e of [...st.entries]) e.onResync?.();
			for (const e of [...st.entries]) {
				try {
					e.handler(msg.event);
				} catch (err) {
					console.error("ws handler failed", msg.topic, err);
				}
			}
		};
		ws.onclose = () => {
			if (this.pingTimer) clearInterval(this.pingTimer);
			this.pingTimer = null;
			if (this.stableTimer) clearTimeout(this.stableTimer);
			this.stableTimer = null;
			if (this.socket === ws) this.socket = null;
			this.setStatus("closed");
			if (this.paused) return;
			// The browser cannot tell a refused upgrade or the server's 4401 (a tunnel reports both as 1006) from a network drop: ask.
			this.probeAuth();
			const delay = Math.min(4_000, 300 * 2 ** this.attempts) * (0.75 + Math.random() * 0.5);
			this.attempts++;
			this.retryTimer = setTimeout(() => this.connect(false), delay);
		};
		ws.onerror = () => ws.close();
	}
}

export const ws = new WsClient();

/** Subscribe to a topic for the lifetime of the component. `topic = null` disables. */
export function useTopic<T extends string>(topic: T | null, handler: (event: EventFor<T>) => void, opts?: { onResync?: () => void }): void {
	const h = useRef(handler);
	const r = useRef(opts?.onResync);
	h.current = handler;
	r.current = opts?.onResync;
	useEffect(() => {
		if (!topic) return;
		return ws.subscribe(
			topic,
			(e) => h.current(e),
			() => r.current?.(),
		);
	}, [topic]);
}

export function useWsStatus(): WsStatus {
	return useSyncExternalStore(ws.onStatus, ws.getStatus, () => "closed" as WsStatus);
}
