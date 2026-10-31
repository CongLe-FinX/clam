import { BrowserClientMessage, type BrowserServerMessage } from "@clam/contracts";
import type { FastifyInstance } from "fastify";
import { refuse } from "../auth/gate.ts";
import type { ServerContext } from "../context.ts";
import { ApiError } from "../http/errors.ts";
import { recordAudit } from "../services/audit.ts";
import type { ViewerPort } from "../browser/tab.ts";

const HEARTBEAT_MS = 30_000;
const ID_PATTERN = /^[\w-]{1,64}$/;
/** A viewer this far behind is shown no more frames until it catches up (the newest frame is what matters). */
const DROP_FRAMES_ABOVE = 2 * 1024 * 1024;
/** Close codes beyond the `/ws` ones: the viewed tab does not exist (any more). */
export const BROWSER_CLOSE_NO_TAB = 4404;
export const BROWSER_CLOSE_SESSION_ENDED = 4401;

/**
 * `GET /ws/browser/:tabId` — one viewer of one browser tab. BINARY frames server → client are screencast JPEGs
 * (`BROWSER_FRAME_HEADER_BYTES` header + JPEG); JSON TEXT frames carry everything else in both directions
 * (`BrowserClientMessage` in, `BrowserServerMessage` out — see `@clam/contracts` browser.ts).
 *
 * Same door as `/ws`: loopback Host/Origin policy, or on the public listener the owner session + Origin check (`auth/gate.ts`),
 * then the Browser's own gate (`assertTool`: switched on) before the upgrade. A remote socket ends with its session or when
 * the Browser is switched off (close 4401). Registered in the same scope as the `/ws` hub (which loads @fastify/websocket).
 */
export function registerBrowserSocket(app: FastifyInstance, ctx: ServerContext): void {
	app.get<{ Params: { tabId: string } }>(
		"/ws/browser/:tabId",
		{
			websocket: true,
			preHandler: async (request, reply) => {
				try {
					ctx.access.assertTool(request.access, "browser");
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
			const tabId = request.params.tabId;
			const send = (message: BrowserServerMessage): void => {
				if (socket.readyState !== socket.OPEN) return;
				socket.send(JSON.stringify(message));
				// The tab is gone: tell the viewer why, then end the socket with the "no such tab" code.
				if (message.type === "closed") socket.close(BROWSER_CLOSE_NO_TAB, message.reason.slice(0, 100));
			};
			const port: ViewerPort = {
				send,
				sendFrame: (frame) => {
					if (socket.readyState === socket.OPEN && socket.bufferedAmount < DROP_FRAMES_ABOVE) socket.send(frame, { binary: true });
				},
				buffered: () => socket.bufferedAmount,
			};

			const attached = ID_PATTERN.test(tabId) ? ctx.browser.attachViewer(tabId, port) : null;
			if (!attached) {
				socket.close(BROWSER_CLOSE_NO_TAB, "tab not found");
				return;
			}
			const { tab, handle } = attached;
			const openedAt = Date.now();
			recordAudit(ctx, "browser.open", { via, tab: tabId, sid: session?.sid.slice(0, 8) ?? null });
			send(tab.hello(ctx.browser.listTabs()));

			socket.on("message", (raw: Buffer, isBinary: boolean) => {
				if (isBinary) return;
				let message: BrowserClientMessage;
				try {
					message = BrowserClientMessage.parse(JSON.parse(raw.toString("utf8")));
				} catch {
					send({ type: "error", message: "Invalid message" });
					return;
				}
				handle.message(message);
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

			const untrack = session ? ctx.access.trackSocket(session, () => socket.close(BROWSER_CLOSE_SESSION_ENDED, "session ended"), "browser") : null;
			let cleaned = false;
			const cleanup = (): void => {
				if (cleaned) return;
				cleaned = true;
				clearInterval(heartbeat);
				untrack?.();
				handle.dispose();
				recordAudit(ctx, "browser.close", { via, tab: tabId, sid: session?.sid.slice(0, 8) ?? null, seconds: Math.round((Date.now() - openedAt) / 1000) });
			};
			socket.on("close", cleanup);
			socket.on("error", (error: Error) => {
				ctx.log.debug({ err: error }, "browser websocket error");
				cleanup();
			});
		},
	);
}
