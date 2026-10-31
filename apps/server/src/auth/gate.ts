import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { API_PREFIX } from "@clam/agent-network";
import { LOCAL_API_PREFIX } from "@clam/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ServerContext } from "../context.ts";
import { sendNotFound } from "../http/error-handler.ts";
import { isLocalHostHeader } from "../http/host-guard.ts";
import type { RequestAccess } from "./service.ts";
import { clearedSessionCookie, sessionCookie } from "./token.ts";

declare module "fastify" {
	interface FastifyRequest {
		/** Where a UI-surface request came from and its owner session. Set by the surface gate; null on routes outside the surface (`/api/v1`). */
		access: RequestAccess;
		/** True once the UI surface of the public listener took the request: that response's headers are the surface's, not the wire protocol's. */
		uiSurface?: boolean;
	}
}

/** Routes a remote caller may reach with no session: the status probe the login page needs, and the login itself. */
const PUBLIC_ROUTES = new Set([`GET ${LOCAL_API_PREFIX}/access`, `POST ${LOCAL_API_PREFIX}/access/login`]);
/** Routes that change how this node is exposed: only the person at the machine (the loopback UI port), never through the tunnel. */
const LOOPBACK_ONLY_ROUTES = new Set([`PUT ${LOCAL_API_PREFIX}/tunnel/config`]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const HSTS = "max-age=31536000";

const pathOf = (request: FastifyRequest): string => {
	const url = request.raw.url ?? request.url;
	const query = url.indexOf("?");
	return query === -1 ? url : url.slice(0, query);
};

/** The path as the router sees it (it percent-decodes before matching, so the gate must too). */
function decodedPath(request: FastifyRequest): string {
	const path = pathOf(request);
	try {
		return decodeURI(path);
	} catch {
		return path;
	}
}

const isWirePath = (path: string): boolean => path === API_PREFIX || path.startsWith(`${API_PREFIX}/`);
const isDataPath = (path: string): boolean => path === "/ws" || path.startsWith("/ws/") || path === LOCAL_API_PREFIX || path.startsWith(`${LOCAL_API_PREFIX}/`);

/** Refuse a request; a refused WebSocket handshake leaves the upgraded socket open, so end it once the answer is written. */
export function refuse(request: FastifyRequest, reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
	if (request.headers.upgrade !== undefined) {
		reply.header("connection", "close");
		reply.raw.once("finish", () => request.raw.socket.destroySoon());
	}
	return reply.status(status).send({ error: { code, message } });
}

/**
 * Content-Security-Policy of the public origin. The SPA's one inline script (the pre-paint theme switch) is allowed by hash,
 * computed from the built `index.html` itself so a rebuild never needs a policy edit; scripts are otherwise same-origin only.
 * Styles keep `'unsafe-inline'` because React and its UI libraries set inline `style` attributes at runtime.
 */
export function createPublicCsp(webDistDir: string | null): (host: string | undefined) => string {
	let cached: { mtimeMs: number; hashes: string[]; checkedAt: number } | null = null;
	const scriptHashes = (): string[] => {
		if (!webDistDir) return [];
		const file = join(webDistDir, "index.html");
		// A rebuild shows up within a couple of seconds; no need to stat the file for every response.
		if (cached && Date.now() - cached.checkedAt < 2_000) return cached.hashes;
		try {
			const { mtimeMs } = statSync(file);
			if (cached?.mtimeMs === mtimeMs) {
				cached.checkedAt = Date.now();
				return cached.hashes;
			}
			const html = readFileSync(file, "utf8");
			const hashes = [...html.matchAll(/<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => `'sha256-${createHash("sha256").update(m[1] ?? "", "utf8").digest("base64")}'`);
			cached = { mtimeMs, hashes, checkedAt: Date.now() };
			return hashes;
		} catch {
			return [];
		}
	};
	return (host) => {
		const socket = host ? `${isLocalHostHeader(host) ? "ws" : "wss"}://${host}` : "";
		return [
			"default-src 'none'",
			`script-src 'self' ${scriptHashes().join(" ")}`.trim(),
			"style-src 'self' 'unsafe-inline'",
			"img-src 'self' data: blob:",
			"media-src 'self' blob:",
			"frame-src 'self'",
			"font-src 'self' data:",
			`connect-src 'self' ${socket}`.trim(),
			"manifest-src 'self'",
			"base-uri 'none'",
			"object-src 'none'",
			"form-action 'self'",
			"frame-ancestors 'none'",
		].join("; ");
	};
}

/**
 * The UI surface on the loopback UI listener: no login (same trust as ever); requests just learn where they came from.
 * Host/Origin policy and the security headers there are the listener's own (`installHostGuard`, `buildApp`).
 */
export function installLoopbackGate(ui: FastifyInstance): void {
	ui.decorateRequest("access", null as unknown as RequestAccess);
	ui.decorateRequest("uiSurface", false);
	ui.addHook("onRequest", async (request) => {
		request.access = { via: "loopback", session: null };
	});
}

/**
 * The UI surface on the PUBLIC listener (the tunnel origin). Everything here is behind `remoteUiEnabled`; when it is off every
 * request answers the same plain 404 as any unknown path. When on:
 *  - a browser's `Origin` must be this node's public origin (always for writes and WebSocket upgrades: CSRF);
 *  - `/api/local/*` and `/ws` need a valid owner session (401 `auth_required`) except the status probe and the login;
 *  - the routes that change exposure answer 403 `loopback_only` even to a signed-in owner (`PATCH /access` is decided by its handler:
 *    a remote session may only switch things off);
 *  - machine tools (`/ws/terminal/*`, `/api/local/terminal/*`) are per-route gated on top of the session: their toggle, and for the Terminal a step-up;
 *  - the SPA's static files are public (they contain no data).
 * `/api/v1/*` is never touched here: its own signature auth stays the only door, cookies are never read for it.
 */
export function installRemoteGate(ui: FastifyInstance, ctx: ServerContext): void {
	const access = ctx.access;
	const csp = createPublicCsp(ctx.config.webDistDir);
	ui.decorateRequest("access", null as unknown as RequestAccess);
	ui.decorateRequest("uiSurface", false);

	ui.addHook("onRequest", async (request, reply) => {
		const path = decodedPath(request);
		// A request for a wire path only gets here as an unmatched GET falling into the static fallback: leave it to the wire listener's plain 404.
		if (isWirePath(path)) return;
		request.access = { via: "remote", session: null };
		// Off: indistinguishable from any unknown path — the listener's own plain 404, with its own headers.
		if (!access.config().remoteUiEnabled) return sendNotFound(request, reply);
		request.uiSurface = true;

		const upgrade = request.headers.upgrade !== undefined;
		const origin = request.headers.origin;
		if ((origin !== undefined || upgrade || !SAFE_METHODS.has(request.method)) && !access.originAllowed(origin)) {
			return refuse(request, reply, 403, "forbidden_origin", "Cross-origin requests are not allowed");
		}

		const cookie = request.headers.cookie;
		const auth = await access.authenticate(cookie);
		if (auth) {
			request.access.session = auth.claims;
			if (auth.renewed && !upgrade) reply.header("Set-Cookie", sessionCookie(auth.renewed.token, auth.renewed.maxAgeSeconds));
		} else if (cookie?.includes("clam_session")) {
			// A cookie we no longer honour (expired, logged out, from before a log-out-everywhere): have the browser drop it.
			reply.header("Set-Cookie", clearedSessionCookie());
		}

		const routeUrl = request.routeOptions?.url ?? "";
		const route = `${request.method} ${routeUrl}`;
		const gated = isDataPath(path) || isDataPath(routeUrl);
		if (gated && !PUBLIC_ROUTES.has(route) && !request.access.session) return refuse(request, reply, 401, "auth_required", "Sign in to continue");
		if (LOOPBACK_ONLY_ROUTES.has(route)) return refuse(request, reply, 403, "loopback_only", "This can only be changed from the machine this node runs on (the local UI)");
		return undefined;
	});

	ui.addHook("onSend", async (request, reply, payload) => {
		if (!request.uiSurface) return payload;
		// A JSON digest computed before compression would be wrong for the bytes that go out; browsers have no use for it.
		reply.removeHeader("content-digest");
		reply.header("X-Content-Type-Options", "nosniff");
		reply.header("Referrer-Policy", "no-referrer");
		// A file response (project/attachment bytes) carries its own policy: the page-level one would forbid framing a PDF preview.
		if (!reply.hasHeader("Content-Security-Policy")) reply.header("Content-Security-Policy", csp(request.headers.host));
		reply.header("Strict-Transport-Security", HSTS);
		reply.header("Cross-Origin-Opener-Policy", "same-origin");
		reply.header("Cross-Origin-Resource-Policy", "same-origin");
		reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
		if (isDataPath(decodedPath(request)) || isDataPath(request.routeOptions?.url ?? "")) reply.header("Cache-Control", "no-store");
		return payload;
	});
}
