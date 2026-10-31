import { TERMINAL_CLOSE, TerminalClientMessage, type TerminalServerMessage } from "@clam/contracts";
import type { FastifyInstance } from "fastify";
import { refuse } from "../auth/gate.ts";
import type { ServerContext } from "../context.ts";
import { ApiError } from "../http/errors.ts";
import { recordAudit } from "../services/audit.ts";
import type { TerminalClient } from "../terminal/service.ts";

const HEARTBEAT_MS = 30_000;
/** Input frames (a paste) are capped by the socket's `maxPayload` (1 MiB, set where the hub registers @fastify/websocket); a bigger one closes the connection (1009). */
const ID_PATTERN = /^[\w-]{1,64}$/;

/**
 * `GET /ws/terminal/:id` — the byte stream of one terminal. BINARY frames carry terminal bytes in both directions
 * (keystrokes/paste in, PTY output out: first the scrollback replay, then live); small JSON TEXT frames carry control
 * (`resize`, `ping` in; `attached`, `live`, `exit`, `session`, `pong` out — see `TerminalServerMessage`).
 *
 * Same door as `/ws`: loopback Host/Origin policy, or on the public listener the owner session + Origin check (`auth/gate.ts`),
 * and then the Terminal's own gate (`assertTool`: switched on, and a recent step-up) before the upgrade. A remote socket ends
 * with its session or when the Terminal is switched off (close 4401). Registered in the same scope as the `/ws` hub (which loads @fastify/websocket).
 */
export function registerTerminalSocket(app: FastifyInstance, ctx: ServerContext): void {
	app.get<{ Params: { id: string } }>(
		"/ws/terminal/:id",
		{
			websocket: true,
			preHandler: async (request, reply) => {
				try {
					ctx.access.assertTool(request.access, "terminal", { stepUp: true });
					if (!ID_PATTERN.test(request.params.id) || !ctx.terminals.has(request.params.id)) throw ApiError.notFound("Terminal");
				} catch (error) {
					if (error instanceof ApiError) return refuse(request, reply, error.status, error.code, error.message);
					throw error;
				}
				return undefined;
			},
		},
		(socket, request) => {
			const via = request.access.via;
			const session = request.access.session;
			const id = request.params.id;
			const send = (text: string): void => {
				if (socket.readyState === socket.OPEN) socket.send(text);
			};
			const client: TerminalClient = {
				sendBinary: (data) => {
					if (socket.readyState === socket.OPEN) socket.send(data, { binary: true });
				},
				sendJson: (message: TerminalServerMessage) => send(JSON.stringify(message)),
				buffered: () => socket.bufferedAmount,
				close: (code, reason) => {
					if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) socket.close(code, reason);
				},
				terminate: () => socket.terminate(),
			};

			let attachment: ReturnType<typeof ctx.terminals.attach>;
			try {
				attachment = ctx.terminals.attach(id, client);
			} catch {
				socket.close(TERMINAL_CLOSE.removed, "terminal not found");
				return;
			}
			recordAudit(ctx, "terminal.attach", { via, terminal: id, sid: session?.sid.slice(0, 8) ?? null });

			socket.on("message", (raw: Buffer, isBinary: boolean) => {
				if (isBinary) {
					ctx.terminals.write(id, raw);
					return;
				}
				try {
					const message = TerminalClientMessage.parse(JSON.parse(raw.toString("utf8")));
					if (message.type === "resize") ctx.terminals.resize(id, message.cols, message.rows);
					else send(JSON.stringify({ type: "pong", t: message.t } satisfies TerminalServerMessage));
				} catch {
					send(JSON.stringify({ type: "error", message: "Invalid message" } satisfies TerminalServerMessage));
				}
			});

			let alive = true;
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

			// A remote terminal socket lives as long as its owner session and the Terminal's toggle (close 4401 otherwise).
			const untrack = session ? ctx.access.trackSocket(session, () => socket.close(TERMINAL_CLOSE.sessionEnded, "session ended"), "terminal") : null;
			let cleaned = false;
			const cleanup = (): void => {
				if (cleaned) return;
				cleaned = true;
				clearInterval(heartbeat);
				untrack?.();
				attachment.detach();
			};
			socket.on("close", cleanup);
			socket.on("error", (error: Error) => {
				ctx.log.debug({ err: error }, "terminal websocket error");
				cleanup();
			});
		},
	);
}
