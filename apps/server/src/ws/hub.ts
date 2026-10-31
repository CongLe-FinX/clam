import { ClientWsMessage, type ServerWsMessage } from "@clam/contracts";
import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { ServerContext } from "../context.ts";

const MAX_PAYLOAD_BYTES = 1 << 20;
const MAX_TOPICS_PER_SOCKET = 256;
/** A client that lets this much pile up unread is dropped instead of ballooning server memory. */
const MAX_BUFFERED_BYTES = 16 << 20;
const HEARTBEAT_MS = 30_000;
const TOPIC_PATTERN = /^(sessions|runtime|node|network|tunnel|tasks|shared|contexts|handoffs|session:[\w.-]{1,128}|task:[\w.-]{1,128}|shared:[\w.-]{1,128}|handoff:[\w.-]{1,128}|login:[\w.-]{1,128}|github-device:[\w.-]{1,128}|git:[\w.-]{1,128}|git-op:[\w.-]{1,128})$/;

/**
 * The single multiplexed `/ws` endpoint: subscribe/unsubscribe to bus topics, per-topic `seq` stamped by the
 * bus (gaps tell the client to refetch), latest-state replay for retained topics, ping/pong, and protocol-level
 * heartbeats that drop dead peers. Host/Origin (loopback listener) or Host/Origin + owner session (public
 * listener, `auth/gate.ts`) are enforced before the upgrade; a remote socket ends with its session (close code 4401).
 */
export async function registerWebSocketHub(app: FastifyInstance, ctx: ServerContext): Promise<void> {
	await app.register(websocket, { options: { maxPayload: MAX_PAYLOAD_BYTES } });
	// Never let a client that ignores the close handshake hold up shutdown.
	app.addHook("preClose", async () => {
		for (const client of app.websocketServer.clients) {
			client.close(1001, "server shutting down");
			setTimeout(() => client.terminate(), 500).unref();
		}
	});

	app.get("/ws", { websocket: true }, (socket, request) => {
		const subscriptions = new Map<string, () => void>();
		let alive = true;

		const send = (message: ServerWsMessage): void => {
			if (socket.readyState !== socket.OPEN) return;
			if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
				socket.terminate();
				return;
			}
			socket.send(JSON.stringify(message));
		};

		const subscribe = (topic: string): void => {
			if (subscriptions.has(topic)) return;
			subscriptions.set(
				topic,
				ctx.bus.subscribe(topic, (event, seq) => send({ type: "event", seq, topic, event } as ServerWsMessage)),
			);
			// Same tick as the subscribe above, so nothing can slip between the listener and the snapshot.
			const latest = ctx.bus.latest(topic);
			if (latest) send({ type: "event", seq: latest.seq, topic, event: latest.event } as ServerWsMessage);
		};

		socket.on("message", (raw: Buffer) => {
			let parsed: ClientWsMessage;
			try {
				parsed = ClientWsMessage.parse(JSON.parse(raw.toString("utf8")));
			} catch {
				send({ type: "error", message: "Invalid message" });
				return;
			}
			switch (parsed.type) {
				case "ping":
					send({ type: "pong", t: parsed.t });
					break;
				case "subscribe": {
					const accepted: string[] = [];
					for (const topic of parsed.topics) {
						if (!TOPIC_PATTERN.test(topic)) {
							send({ type: "error", message: `Unknown topic "${topic.slice(0, 80)}"` });
							continue;
						}
						if (!subscriptions.has(topic) && subscriptions.size >= MAX_TOPICS_PER_SOCKET) {
							send({ type: "error", message: "Too many subscriptions" });
							break;
						}
						accepted.push(topic);
					}
					// Acknowledge first so the client has the topic registered before replayed events arrive.
					send({ type: "subscribed", topics: accepted });
					for (const topic of accepted) subscribe(topic);
					break;
				}
				case "unsubscribe":
					for (const topic of parsed.topics) {
						subscriptions.get(topic)?.();
						subscriptions.delete(topic);
					}
					break;
			}
		});

		socket.on("pong", () => {
			alive = true;
		});
		const heartbeat = setInterval(() => {
			if (!alive) {
				socket.terminate();
				return;
			}
			alive = false;
			socket.ping();
		}, HEARTBEAT_MS);
		heartbeat.unref();

		// A remote socket lives exactly as long as its owner session: logout, log-out-everywhere, expiry or disabling remote UI close it (4401).
		const session = request.access?.session ?? null;
		const untrack = session ? ctx.access.trackSocket(session, () => socket.close(4401, "session ended")) : null;
		const cleanup = (): void => {
			clearInterval(heartbeat);
			untrack?.();
			for (const unsubscribe of subscriptions.values()) unsubscribe();
			subscriptions.clear();
		};
		socket.on("close", cleanup);
		socket.on("error", (error: Error) => {
			ctx.log.debug({ err: error }, "websocket error");
			cleanup();
		});
	});
}
