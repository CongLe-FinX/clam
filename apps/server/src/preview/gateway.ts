import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { PREVIEW_RESERVED_PREFIX } from "@clam/contracts";
import { clearedPreviewCookie, previewPortCookie, previewPortFromCookie, previewSessionCookie, PREVIEW_SESSION_COOKIE, type PreviewClaims } from "../auth/preview-token.ts";
import type { IssuedPreviewSession } from "../auth/service.ts";
import type { ServerContext } from "../context.ts";
import { recordAudit } from "../services/audit.ts";
import { REFUSALS, sendPicker, sendRefusal, type Refusal, type RefusalRequest } from "./page.ts";
import { parsePortPath } from "./preview-host.ts";
import { proxyHttp, proxyUpgrade, rejectUpgrade, type ProxyTarget } from "./proxy.ts";
import type { PreviewRoute } from "./service.ts";
import { findUpstream } from "./upstream.ts";

type Deps = Pick<ServerContext, "access" | "preview" | "identity" | "log" | "db">;

/** The raw upgrade requests this gateway has taken over: the network app's own upgrade handling must leave their sockets alone. */
const TAKEN_OVER = new WeakSet<IncomingMessage>();
export const takenOver = (req: IncomingMessage): boolean => TAKEN_OVER.has(req);

/** The path of `rawUrl` the way an HTTP client/server would resolve it (dot segments), and whether it points into the reserved prefix in any spelling (case, one level of percent-encoding). */
function reservedPath(rawUrl: string): { path: string; query: string; reserved: boolean } {
	let url: URL;
	try {
		url = new URL(rawUrl, "http://preview.invalid");
	} catch {
		return { path: rawUrl, query: "", reserved: false };
	}
	const path = url.pathname;
	let decoded = path;
	try {
		decoded = decodeURIComponent(path);
	} catch {
		// keep the undecoded path
	}
	const reserved = `${decoded.toLowerCase()}/`.startsWith(PREVIEW_RESERVED_PREFIX) || path.toLowerCase().startsWith(PREVIEW_RESERVED_PREFIX);
	return { path, query: url.search, reserved };
}

/**
 * The preview host of the network listener: everything that arrives with the preview `Host` is answered here and never reaches the
 * wire protocol or the UI surface. Order, for every request:
 *   `/__clam_preview/health|auth` → Preview switched on? → preview session cookie → `/__clam_preview/` (port picker) →
 *   `/port/<port>/<rest>` (select the app, 302 to `/<rest>`) → port from the `__Host-clam_preview_port` cookie (none: the picker) →
 *   port policy → reverse proxy to `127.0.0.1:<port>`.
 */
export class PreviewGateway {
	constructor(private readonly ctx: Deps) {}

	/** The preview route of a request, or null when it is not a preview request (see `PreviewService.resolve`). */
	resolve(req: IncomingMessage): PreviewRoute | null {
		return this.ctx.preview.resolve(req);
	}

	private enabled(): boolean {
		const config = this.ctx.access.config();
		return config.remoteUiEnabled && config.remotePreviewEnabled;
	}

	private target(req: IncomingMessage, route: PreviewRoute, port: number, address: ProxyTarget["address"], claims: PreviewClaims, renewed: IssuedPreviewSession | null): ProxyTarget {
		const forwarded = req.headers["cf-connecting-ip"];
		return {
			address,
			path: route.url,
			context: { port, previewHost: route.host, previewOrigin: route.origin, clientIp: (typeof forwarded === "string" && forwarded) || req.socket.remoteAddress },
			setCookie: renewed ? previewSessionCookie(renewed.token, renewed.maxAgeSeconds) : undefined,
			// An owner session that ends (logout, logout-all, password change, Preview off) takes its open exchanges with it.
			track: (close) => this.ctx.access.trackSocket(claims, close, "preview"),
		};
	}

	/** Answer or proxy one plain HTTP request that `resolve` routed to the preview host. */
	async handle(req: IncomingMessage, res: ServerResponse, route: PreviewRoute): Promise<void> {
		const ask: RefusalRequest = { accept: req.headers.accept, acceptLanguage: req.headers["accept-language"] };
		const refuse = (refusal: Refusal, headers?: Record<string, string | string[]>): void => sendRefusal(res, ask, refusal, headers);
		try {
			const { path, query, reserved } = reservedPath(route.url);
			if (reserved) {
				if (path === `${PREVIEW_RESERVED_PREFIX}health`) return this.health(req, res);
				if (path === `${PREVIEW_RESERVED_PREFIX}auth`) return await this.auth(req, res, route, ask);
			}
			if (!this.enabled()) return refuse(REFUSALS.disabled);
			const session = await this.ctx.access.authenticatePreview(req.headers.cookie);
			if (!session) return refuse(REFUSALS.signIn, req.headers.cookie?.includes(PREVIEW_SESSION_COOKIE) ? { "Set-Cookie": clearedPreviewCookie() } : undefined);
			if (reserved) {
				// CLAM's own pages on the preview host: the port picker. Anything else under the prefix is not a page.
				if (path === PREVIEW_RESERVED_PREFIX || path === PREVIEW_RESERVED_PREFIX.slice(0, -1) || path === `${PREVIEW_RESERVED_PREFIX}ports`) return sendPicker(res, ask, await this.ctx.preview.apps());
				return refuse(REFUSALS.notFound);
			}
			const selected = parsePortPath(path);
			if (selected) {
				if (this.ctx.preview.refusal(selected.port)) return refuse(REFUSALS.port);
				// The app runs at the natural root of this host from here on: select it, then forget the prefix.
				res.writeHead(302, { Location: `${selected.rest}${query}`, "Set-Cookie": previewPortCookie(selected.port), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow", "Content-Length": "0" });
				return void res.end();
			}
			const port = previewPortFromCookie(req.headers.cookie);
			if (port === null) return sendPicker(res, ask, await this.ctx.preview.apps());
			if (this.ctx.preview.refusal(port)) return refuse(REFUSALS.port);
			const address = await findUpstream(port);
			if (!address) return refuse(REFUSALS.nothing);
			proxyHttp(req, res, this.target(req, route, port, address, session.claims, session.renewed), () => (res.headersSent ? res.destroy() : refuse(REFUSALS.nothing)));
		} catch (error) {
			this.ctx.log.warn({ err: error }, "preview request failed");
			if (res.headersSent) res.destroy();
			else sendRefusal(res, ask, { ...REFUSALS.nothing, status: 500, code: "internal_error", title: "Internal server error", detail: "", vi: { title: "Lỗi máy chủ nội bộ", detail: "" } });
		}
	}

	/** `GET /__clam_preview/health`: which node answers for this preview host. Public; says nothing the node's `/api/v1/node/info` does not. */
	private health(req: IncomingMessage, res: ServerResponse): void {
		if (req.method !== "GET" && req.method !== "HEAD") return sendRefusal(res, { accept: undefined, acceptLanguage: undefined }, { ...REFUSALS.notFound, status: 405, code: "method_not_allowed", title: "Method not allowed" });
		const body = JSON.stringify({ service: "clam-preview", nodeId: this.ctx.identity.nodeId });
		res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
		res.end(req.method === "HEAD" ? undefined : body);
	}

	/** `GET /__clam_preview/auth?ticket=…`: spend the ticket, set this host's own cookie, land on the ticket's `/port/<port>/<path>`. */
	private async auth(req: IncomingMessage, res: ServerResponse, route: PreviewRoute, ask: RefusalRequest): Promise<void> {
		if (!this.enabled()) return sendRefusal(res, ask, REFUSALS.disabled);
		const ticket = new URL(route.url, "http://preview.invalid").searchParams.get("ticket");
		const redeemed = req.method === "GET" && ticket ? await this.ctx.access.redeemPreviewTicket(ticket, route.host) : null;
		if (!redeemed) return sendRefusal(res, ask, REFUSALS.signIn);
		recordAudit(this.ctx, "preview.signin", { host: route.host, sid: redeemed.session.claims.sid.slice(0, 8) });
		res.writeHead(302, {
			Location: redeemed.path,
			"Set-Cookie": previewSessionCookie(redeemed.session.token, redeemed.session.maxAgeSeconds),
			// The ticket was in the URL: keep it out of Referer and caches.
			"Cache-Control": "no-store",
			"Referrer-Policy": "no-referrer",
			"X-Robots-Tag": "noindex, nofollow",
			"Content-Length": "0",
		});
		res.end();
	}

	/**
	 * A WebSocket upgrade. Returns true when `Host` is the preview host (the gateway answered or proxied it and took the socket), false
	 * when it is not and the caller carries on. Only same-origin handshakes are proxied: a page of another site cannot open a socket to
	 * the app with the cookie.
	 */
	upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
		const route = this.resolve(req);
		if (route === null) return false;
		TAKEN_OVER.add(req);
		void this.proxyUpgrade(req, socket, head, route).catch((error) => {
			this.ctx.log.warn({ err: error }, "preview upgrade failed");
			rejectUpgrade(socket, 500, "Internal Server Error");
		});
		return true;
	}

	private async proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, route: PreviewRoute): Promise<void> {
		socket.on("error", () => socket.destroy());
		if (reservedPath(route.url).reserved) return rejectUpgrade(socket, 404, "Not Found");
		if (!this.enabled()) return rejectUpgrade(socket, 403, "Preview is switched off");
		const origin = req.headers.origin;
		if (origin !== undefined && origin !== route.origin) return rejectUpgrade(socket, 403, "Cross-origin WebSocket refused");
		const session = await this.ctx.access.authenticatePreview(req.headers.cookie);
		if (!session) return rejectUpgrade(socket, 401, "Open this preview from CLAM");
		const port = previewPortFromCookie(req.headers.cookie);
		if (port === null) return rejectUpgrade(socket, 409, "Choose an app to preview");
		if (this.ctx.preview.refusal(port)) return rejectUpgrade(socket, 403, "This port cannot be previewed");
		const address = await findUpstream(port);
		if (!address) return rejectUpgrade(socket, 502, "Nothing is answering on this port");
		proxyUpgrade(req, socket, head, this.target(req, route, port, address, session.claims, null));
	}
}
