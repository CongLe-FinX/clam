import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

/** Every cookie CLAM itself sets on the preview host (`__Host-clam_preview`, `__Host-clam_preview_port`): never forwarded to the app, never settable by it. */
const CLAM_COOKIE_PREFIX = "__host-clam_";

/** Names the app may know the machine by; a redirect to any of them on the previewed port is a redirect to the preview origin. */
const LOOPBACK_NAMES: Record<string, true> = { localhost: true, "127.0.0.1": true, "[::1]": true, "0.0.0.0": true };

const HOP_BY_HOP = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"];

export interface RewriteContext {
	/** The previewed port. */
	port: number;
	/** `https://5173-agenta.example.com`: the origin the browser sees. */
	previewOrigin: string;
	/** The preview host (no scheme). */
	previewHost: string;
	/** The browser's address (Cloudflare's header, else the socket peer). */
	clientIp: string | undefined;
}

/** What the app believes its own origin is. */
export const upstreamOrigin = (port: number): string => `http://localhost:${port}`;

const originOf = (value: string): string | null => {
	try {
		return new URL(value).origin;
	} catch {
		return null;
	}
};

/** The Cookie header without CLAM's own cookies; undefined when nothing else is left. */
export function stripClamCookies(header: string | undefined): string | undefined {
	if (header === undefined) return undefined;
	const kept = header.split(";").map((p) => p.trim()).filter((p) => p !== "" && !p.toLowerCase().startsWith(CLAM_COOKIE_PREFIX));
	return kept.length > 0 ? kept.join("; ") : undefined;
}

/**
 * Headers for the upstream request. `Host` (and a same-origin `Origin`/`Referer`) become `localhost:<port>` so dev servers with host
 * checks (Vite `allowedHosts`, Next, webpack-dev-server) accept the request; CLAM's own cookies are removed; forwarding headers say
 * what the browser really used. `upgrade: true` keeps the WebSocket handshake's `Connection`/`Upgrade`.
 */
export function rewriteRequestHeaders(incoming: IncomingHttpHeaders, ctx: RewriteContext, options: { upgrade: boolean }): OutgoingHttpHeaders {
	const out: OutgoingHttpHeaders = {};
	for (const [name, value] of Object.entries(incoming)) {
		if (value === undefined) continue;
		if (HOP_BY_HOP.includes(name) && !(options.upgrade && (name === "connection" || name === "upgrade"))) continue;
		out[name] = value;
	}
	out.host = `localhost:${ctx.port}`;
	const origin = incoming.origin;
	if (typeof origin === "string" && origin === ctx.previewOrigin) out.origin = upstreamOrigin(ctx.port);
	const referer = incoming.referer;
	if (typeof referer === "string" && originOf(referer) === ctx.previewOrigin) out.referer = upstreamOrigin(ctx.port) + referer.slice(ctx.previewOrigin.length);
	const cookie = stripClamCookies(incoming.cookie);
	if (cookie === undefined) delete out.cookie;
	else out.cookie = cookie;
	out["x-forwarded-proto"] = "https";
	out["x-forwarded-host"] = ctx.previewHost;
	if (ctx.clientIp) out["x-forwarded-for"] = ctx.clientIp;
	else delete out["x-forwarded-for"];
	return out;
}

/** `Location: http://localhost:<port>/x` → `<previewOrigin>/x`. Other hosts, other ports and relative references are left alone. */
export function rewriteLocation(value: string, ctx: Pick<RewriteContext, "port" | "previewOrigin">): string {
	let url: URL;
	try {
		url = new URL(value.startsWith("//") ? `http:${value}` : value);
	} catch {
		return value;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return value;
	if (LOOPBACK_NAMES[url.hostname] !== true) return value;
	const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
	if (port !== ctx.port) return value;
	return `${ctx.previewOrigin}${url.pathname}${url.search}${url.hash}`;
}

/** Cookies stay host-only on the preview host: `Domain=` is dropped. A cookie named like one of ours (`__Host-clam_*`) is dropped; `SameSite=None` gets the `Secure` it needs over https. */
export function rewriteSetCookie(values: readonly string[]): string[] {
	const out: string[] = [];
	for (const raw of values) {
		const name = raw.slice(0, Math.max(0, raw.indexOf("="))).trim();
		if (name.toLowerCase().startsWith(CLAM_COOKIE_PREFIX)) continue;
		const [pair = "", ...attributes] = raw.split(";");
		const kept = attributes.map((a) => a.trim()).filter((a) => a !== "" && !/^domain\s*=/i.test(a));
		const sameSiteNone = kept.some((a) => /^samesite\s*=\s*none$/i.test(a));
		if (sameSiteNone && !kept.some((a) => a.toLowerCase() === "secure")) kept.push("Secure");
		out.push([pair.trim(), ...kept].join("; "));
	}
	return out;
}

/** Headers for the browser: hop-by-hop dropped, redirects and CORS allow-origin pointed at the preview origin, cookies host-only. */
export function rewriteResponseHeaders(upstream: IncomingHttpHeaders, ctx: RewriteContext): OutgoingHttpHeaders {
	const out: OutgoingHttpHeaders = {};
	for (const [name, value] of Object.entries(upstream)) {
		if (value === undefined || HOP_BY_HOP.includes(name)) continue;
		out[name] = value;
	}
	if (typeof out.location === "string") out.location = rewriteLocation(out.location, ctx);
	const allowOrigin = out["access-control-allow-origin"];
	if (allowOrigin === upstreamOrigin(ctx.port)) out["access-control-allow-origin"] = ctx.previewOrigin;
	const cookies = upstream["set-cookie"];
	if (cookies) {
		const rewritten = rewriteSetCookie(cookies);
		if (rewritten.length > 0) out["set-cookie"] = rewritten;
		else delete out["set-cookie"];
	}
	if (out["x-robots-tag"] === undefined) out["x-robots-tag"] = "noindex, nofollow";
	return out;
}
