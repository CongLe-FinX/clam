import type { FastifyInstance } from "fastify";

/**
 * DNS-rebinding / cross-site defense for a loopback-only server (security baseline, M1):
 * - reject any request whose `Host` is not localhost / 127.0.0.1 / [::1] (403 `forbidden_host`);
 * - reject WebSocket upgrades (and state-changing requests) whose `Origin` is a foreign site (403 `forbidden_origin`).
 */

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Hostnames accepted in `Host`/`Origin`; exposed for the security info route. */
export const ALLOWED_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];

/** Extract the hostname from a `Host` header value (`host[:port]`, IPv6 in brackets). */
export function hostnameOf(hostHeader: string): string | null {
	const value = hostHeader.trim().toLowerCase();
	if (!value) return null;
	if (value.startsWith("[")) {
		const end = value.indexOf("]");
		return end === -1 ? null : value.slice(0, end + 1);
	}
	const colon = value.lastIndexOf(":");
	return colon === -1 ? value : value.slice(0, colon);
}

export function isLocalHostHeader(hostHeader: string | undefined): boolean {
	if (!hostHeader) return false;
	const hostname = hostnameOf(hostHeader);
	return hostname !== null && LOCAL_HOSTNAMES.has(hostname);
}

/** `Origin` is `scheme://host[:port]`; "null" and unparsable origins are foreign. */
export function isLocalOrigin(origin: string): boolean {
	try {
		const url = new URL(origin);
		if (url.protocol !== "http:" && url.protocol !== "https:") return false;
		return LOCAL_HOSTNAMES.has(url.hostname.toLowerCase());
	} catch {
		return false;
	}
}

export function installHostGuard(app: FastifyInstance): void {
	app.addHook("onRequest", async (request, reply) => {
		const rejection = !isLocalHostHeader(request.headers.host)
			? { code: "forbidden_host", message: "Requests must target localhost, 127.0.0.1 or [::1]" }
			: request.headers.origin !== undefined && !isLocalOrigin(request.headers.origin)
				? { code: "forbidden_origin", message: "Cross-origin requests are not allowed" }
				: null;
		if (!rejection) return;
		if (request.headers.upgrade !== undefined) {
			// A refused WebSocket handshake leaves the upgraded socket open; end it once the 403 is written.
			reply.header("connection", "close");
			reply.raw.once("finish", () => request.raw.socket.destroySoon());
		}
		return reply.status(403).send({ error: rejection });
	});
}
