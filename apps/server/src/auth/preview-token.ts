import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed values of Preview (`preview/`): the one-time ticket that starts a preview session on a preview host, and the
 * host-only cookie that carries it. Same HMAC key as the owner session, but a different domain-separation prefix per kind:
 * a ticket is no cookie, a cookie is no ticket, and neither is an owner session token.
 */

/** `__Host-` pins the cookie to this exact preview host over HTTPS: Secure is mandatory, no Domain, Path=/. */
export const PREVIEW_SESSION_COOKIE = "__Host-clam_preview";
/** Which local port this browser is previewing on the preview host (set by `/port/<port>/…`). A selection, not a credential: the port policy applies on every request. */
export const PREVIEW_PORT_COOKIE = "__Host-clam_preview_port";

export interface PreviewTicketClaims {
	/** Random id; the server remembers which ids it issued and forgets one when it is redeemed (single use). */
	jti: string;
	port: number;
	/** The preview host the ticket was minted for; redeemable only there. */
	host: string;
	/** Where to land after sign-in: a path (+query) on that host. */
	path: string;
	/** Owner session id behind the ticket (or a random id when minted on the loopback UI): logging that session out kills what it started. */
	sid: string;
	/** `iat` of the owner session: the preview session's absolute lifetime counts from it. */
	sessionIat: number;
	epoch: number;
	pepoch: number;
	exp: number;
}

export interface PreviewClaims {
	sid: string;
	iat: number;
	/** Last renewal (sliding expiry bookkeeping). */
	ren: number;
	exp: number;
	/** The node's access epoch (logout-all, password change, remote UI off) and preview epoch (Preview switched off) at issue time. */
	epoch: number;
	pepoch: number;
}

type Kind = "ticket" | "session";

const mac = (key: Buffer, kind: Kind, payload: string): Buffer => createHmac("sha256", key).update(`clam-preview-${kind}-v1.`).update(payload).digest();

function sign(key: Buffer, kind: Kind, value: object): string {
	const payload = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
	return `${payload}.${mac(key, kind, payload).toString("base64url")}`;
}

function open(key: Buffer, kind: Kind, token: string): unknown {
	if (token.length > 2048) return null;
	const dot = token.indexOf(".");
	if (dot <= 0 || dot === token.length - 1 || token.indexOf(".", dot + 1) !== -1) return null;
	const payload = token.slice(0, dot);
	const supplied = Buffer.from(token.slice(dot + 1), "base64url");
	const expected = mac(key, kind, payload);
	if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
	try {
		return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
	} catch {
		return null;
	}
}

const int = (v: unknown): v is number => Number.isSafeInteger(v);
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

export const signTicket = (key: Buffer, claims: PreviewTicketClaims): string => sign(key, "ticket", claims);
export const signPreviewSession = (key: Buffer, claims: PreviewClaims): string => sign(key, "session", claims);

export function verifyTicket(key: Buffer, token: string): PreviewTicketClaims | null {
	const c = open(key, "ticket", token) as Partial<Record<keyof PreviewTicketClaims, unknown>> | null;
	if (typeof c !== "object" || c === null) return null;
	if (!str(c.jti, 64) || !int(c.port) || !str(c.host, 253) || !str(c.path, 2048) || !str(c.sid, 64) || !int(c.sessionIat) || !int(c.epoch) || !int(c.pepoch) || !int(c.exp)) return null;
	return { jti: c.jti, port: c.port, host: c.host, path: c.path, sid: c.sid, sessionIat: c.sessionIat, epoch: c.epoch, pepoch: c.pepoch, exp: c.exp };
}

export function verifyPreviewSession(key: Buffer, token: string): PreviewClaims | null {
	const c = open(key, "session", token) as Partial<Record<keyof PreviewClaims, unknown>> | null;
	if (typeof c !== "object" || c === null) return null;
	if (!str(c.sid, 64) || !int(c.iat) || !int(c.ren) || !int(c.exp) || !int(c.epoch) || !int(c.pepoch)) return null;
	return { sid: c.sid, iat: c.iat, ren: c.ren, exp: c.exp, epoch: c.epoch, pepoch: c.pepoch };
}

/** `Cookie` header → the value of the cookie called `name` (other cookies are never inspected). */
function cookieValue(header: string | undefined, name: string): string | null {
	if (!header) return null;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
	}
	return null;
}

export const previewCookieValue = (header: string | undefined): string | null => cookieValue(header, PREVIEW_SESSION_COOKIE);

/** The previewed port in the `Cookie` header, or null (absent or not a port). */
export function previewPortFromCookie(header: string | undefined): number | null {
	const raw = cookieValue(header, PREVIEW_PORT_COOKIE);
	if (raw === null || !/^[1-9][0-9]{0,4}$/.test(raw)) return null;
	const port = Number(raw);
	return port <= 65535 ? port : null;
}

const ATTRIBUTES = "Path=/; Secure; HttpOnly; SameSite=Lax";

export const previewSessionCookie = (token: string, maxAgeSeconds: number): string => `${PREVIEW_SESSION_COOKIE}=${token}; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}; ${ATTRIBUTES}`;
const PORT_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 3600;
export const previewPortCookie = (port: number): string => `${PREVIEW_PORT_COOKIE}=${port}; Max-Age=${PORT_COOKIE_MAX_AGE_SECONDS}; ${ATTRIBUTES}`;
export const clearedPreviewCookie = (): string => `${PREVIEW_SESSION_COOKIE}=; Max-Age=0; ${ATTRIBUTES}`;
