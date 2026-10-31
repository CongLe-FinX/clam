import { createHmac, timingSafeEqual } from "node:crypto";

/** `__Host-` pins the cookie to this exact host over HTTPS: Secure is mandatory, no Domain, Path=/. */
export const SESSION_COOKIE = "__Host-clam_session";

/** What a signed session token carries. Times are epoch milliseconds. */
export interface SessionClaims {
	/** Random session id (revocation key). */
	sid: string;
	/** When the owner logged in; the absolute lifetime cap counts from here. */
	iat: number;
	/** When this token was last renewed (sliding expiry bookkeeping). */
	ren: number;
	/** Sliding expiry. */
	exp: number;
	/** `logout-all` / password change / disabling remote UI bump the node's epoch; a token from an older epoch is dead. */
	epoch: number;
}

const DOMAIN = "clam-session-v1.";

const mac = (key: Buffer, payload: string): Buffer => createHmac("sha256", key).update(DOMAIN).update(payload).digest();

/** `base64url(json).base64url(hmac-sha256)`. */
export function signToken(key: Buffer, claims: SessionClaims): string {
	const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
	return `${payload}.${mac(key, payload).toString("base64url")}`;
}

const isClaims = (value: unknown): value is SessionClaims => {
	if (typeof value !== "object" || value === null) return false;
	const c = value as Record<string, unknown>;
	return (
		typeof c.sid === "string" && /^[0-9a-f]{16,64}$/.test(c.sid) &&
		Number.isSafeInteger(c.iat) && Number.isSafeInteger(c.ren) && Number.isSafeInteger(c.exp) && Number.isSafeInteger(c.epoch)
	);
};

/** The claims of a token whose signature verifies (constant-time), else null. Expiry/epoch/revocation are the caller's checks. */
export function verifyToken(key: Buffer, token: string): SessionClaims | null {
	if (token.length > 1024) return null;
	const dot = token.indexOf(".");
	if (dot <= 0 || dot === token.length - 1 || token.indexOf(".", dot + 1) !== -1) return null;
	const payload = token.slice(0, dot);
	const supplied = Buffer.from(token.slice(dot + 1), "base64url");
	const expected = mac(key, payload);
	if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
	try {
		const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		return isClaims(claims) ? claims : null;
	} catch {
		return null;
	}
}

/** `Cookie` header → the value of the session cookie only (other cookies are never inspected). */
export function sessionCookieValue(header: string | undefined): string | null {
	if (!header) return null;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		if (part.slice(0, eq).trim() === SESSION_COOKIE) return part.slice(eq + 1).trim() || null;
	}
	return null;
}

const ATTRIBUTES = "Path=/; Secure; HttpOnly; SameSite=Strict";

export const sessionCookie = (token: string, maxAgeSeconds: number): string => `${SESSION_COOKIE}=${token}; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}; ${ATTRIBUTES}`;

export const clearedSessionCookie = (): string => `${SESSION_COOKIE}=; Max-Age=0; ${ATTRIBUTES}`;
