import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccessStatus, NodeInfo, Workspace } from "@clam/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signToken, verifyToken, type SessionClaims } from "../src/auth/token.ts";
import { api, createMemorySecrets, type FullHarness } from "./full-harness.ts";
import { INLINE_SCRIPT, PASSWORD, PUBLIC_HOST, PUBLIC_ORIGIN, cookiePair, raw, remoteNode, wsUpgrade, type Raw, type RawOptions, type RemoteNode } from "./remote-helpers.ts";

const SESSION = "__Host-clam_session";
let ipCounter = 0;
/** A distinct client address per test so one test's failed logins never lock another test out. */
const freshIp = (): string => `203.0.113.${++ipCounter}`;

const epochOf = (n: FullHarness): number => Number((n.ctx.db.$client.prepare("select value from settings where key = 'access.epoch'").get() as { value: string } | undefined)?.value ?? 0);
const keyOf = async (n: FullHarness): Promise<Buffer> => Buffer.from((await n.ctx.secrets.get("access.session-key")) ?? "", "base64url");
const sessionCookieOf = (res: Raw<unknown>): string => {
	const line = res.cookies.find((c) => c.startsWith(`${SESSION}=`));
	if (!line) throw new Error(`no ${SESSION} cookie in ${JSON.stringify(res.cookies)}`);
	return cookiePair(line);
};

/** Sign in from a fresh client address; resolves the `name=value` cookie to send back. */
async function signIn(rn: RemoteNode, options: { ip?: string; password?: string } = {}): Promise<string> {
	const res = await raw<AccessStatus>(rn.port, { method: "POST", path: "/api/local/access/login", origin: PUBLIC_ORIGIN, ip: options.ip ?? freshIp(), body: { password: options.password ?? PASSWORD } });
	expect(res.status, res.text).toBe(200);
	return sessionCookieOf(res);
}

/** Password set from the loopback UI port, then remote UI switched on — exactly as the owner does at the machine. */
async function enableRemoteUi(rn: RemoteNode, password = PASSWORD): Promise<void> {
	const http = api(rn.n);
	expect((await http.put("/access/password", { password })).status).toBe(200);
	expect((await http.patch<AccessStatus>("/access", { remoteUiEnabled: true })).status).toBe(200);
}

type Caller = Pick<RawOptions, "cookie" | "origin" | "ip" | "host">;
const get = (rn: RemoteNode, path: string, o: Caller = {}) => raw(rn.port, { path, ...o });
const send = (rn: RemoteNode, method: string, path: string, body: unknown, o: Caller = { origin: PUBLIC_ORIGIN }) => raw(rn.port, { method, path, body, ...o });

describe("remote UI disabled (the default)", () => {
	let rn: RemoteNode;
	beforeAll(async () => {
		rn = await remoteNode();
	});
	afterAll(async () => rn.cleanup());

	it("answers the plain 404 for the UI, the API, the status probe, login and WebSocket upgrades — the public listener is /api/v1 only", async () => {
		const unknown = await get(rn, "/definitely-not-a-route");
		expect(unknown.status).toBe(404);
		for (const path of ["/", "/index.html", "/assets/app.js", "/some/spa/route", "/api/local/node", "/api/local/access", "/api/local/nope", "/ws"]) {
			const res = await get(rn, path);
			expect(res.status, path).toBe(404);
			expect(res.json?.error?.code, path).toBe("not_found");
			expect(res.headers["strict-transport-security"], path).toBeUndefined();
		}
		for (const [method, path] of [["POST", "/api/local/access/login"], ["PATCH", "/api/local/access"], ["PUT", "/api/local/access/password"], ["POST", "/api/local/workspaces"]] as const) {
			const res = await send(rn, method, path, { password: PASSWORD, name: "x" });
			expect(res.status, `${method} ${path}`).toBe(404);
		}
		expect((await wsUpgrade(rn.port, { origin: PUBLIC_ORIGIN })).status).toBe(404);
		// /api/v1 is untouched.
		expect((await get(rn, "/api/v1/node/info")).status).toBe(200);
	});

	it("cannot be turned on without a password, and a password never turns it on by itself", async () => {
		const http = api(rn.n);
		const before = (await http.get<AccessStatus>("/access")).body;
		expect(before).toMatchObject({ passwordSet: false, remoteUiEnabled: false, publicUiUrl: null, via: "loopback", signedIn: true, sessionExpiresAt: null, sessionTtlHours: 12 });
		expect(before.nodeName.length).toBeGreaterThan(0);
		expect(before.fingerprint).toBe(rn.n.ctx.identity.fingerprint);
		const refused = await http.patch<{ error: { code: string } }>("/access", { remoteUiEnabled: true });
		expect(refused.status).toBe(409);
		expect(refused.body.error.code).toBe("password_required");

		expect((await http.put<AccessStatus>("/access/password", { password: PASSWORD })).body).toMatchObject({ passwordSet: true, remoteUiEnabled: false });
		expect((await get(rn, "/api/local/access")).status).toBe(404);
		// Short passwords are refused by the contract.
		expect((await http.put("/access/password", { password: "short" })).status).toBe(400);
	});
});

describe("remote UI enabled", () => {
	let rn: RemoteNode;
	beforeAll(async () => {
		rn = await remoteNode();
		await enableRemoteUi(rn);
	});
	afterAll(async () => rn.cleanup());

	it("serves the SPA publicly with HSTS and a strict CSP that allows exactly the inline theme script by hash", async () => {
		const index = await get(rn, "/");
		expect(index.status).toBe(200);
		expect(index.headers["content-type"]).toContain("text/html");
		const hash = createHash("sha256").update(INLINE_SCRIPT).digest("base64");
		const csp = String(index.headers["content-security-policy"]);
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain(`script-src 'self' 'sha256-${hash}'`);
		expect(csp).toContain(`connect-src 'self' wss://${PUBLIC_HOST}`);
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).toContain("object-src 'none'");
		expect(csp).not.toContain("unsafe-eval");
		expect(index.headers["strict-transport-security"]).toBe("max-age=31536000");
		expect(index.headers["x-content-type-options"]).toBe("nosniff");
		expect(index.headers["referrer-policy"]).toBe("no-referrer");
		expect(index.headers["content-digest"]).toBeUndefined();

		const asset = await get(rn, "/assets/app.js");
		expect(asset.status).toBe(200);
		expect(asset.text).toBe("console.log('spa')");
		expect(asset.headers["cache-control"]).toContain("immutable");
		// Client-side routes fall back to index.html.
		const route = await get(rn, "/workspaces/abc");
		expect(route.status).toBe(200);
		expect(route.text).toContain('<div id="root">');
		// Other methods on a static path do not exist.
		expect((await send(rn, "POST", "/whatever", {})).status).toBe(404);
	});

	it("answers 401 auth_required for every /api/local route and /ws without a session — including unknown ones and path tricks", async () => {
		for (const [method, path] of [
			["GET", "/api/local/node"],
			["GET", "/api/local/nope"],
			["GET", "/api/local/node/"],
			["GET", "/%61pi/local/node"],
			["GET", "/api/local/%6eode"],
			["POST", "/api/local/workspaces"],
			["DELETE", "/api/local/workspaces/abc"],
			["PUT", "/api/local/tunnel/config"],
			["PATCH", "/api/local/access"],
			["GET", "/ws"],
			["POST", "/api/local/access/logout"],
			["POST", "/api/local/access/logout-all"],
			["PUT", "/api/local/access/password"],
		] as const) {
			const res = await raw(rn.port, { method, path, origin: PUBLIC_ORIGIN, body: method === "GET" ? undefined : {} });
			expect(res.status, `${method} ${path}`).toBe(401);
			expect(res.json?.error?.code, `${method} ${path}`).toBe("auth_required");
			expect(res.headers["cache-control"]).toBe("no-store");
		}
		expect((await wsUpgrade(rn.port, { origin: PUBLIC_ORIGIN })).status).toBe(401);
		// Nothing leaks in the body.
		expect((await get(rn, "/api/local/node")).text).not.toContain(rn.n.ctx.identity.nodeId);
	});

	it("reports the truth on GET /access without a session, and reaches the login", async () => {
		const res = await get(rn, "/api/local/access");
		expect(res.status).toBe(200);
		expect(res.json).toMatchObject({ passwordSet: true, remoteUiEnabled: true, publicUiUrl: PUBLIC_ORIGIN, via: "remote", signedIn: false, sessionExpiresAt: null, sessionTtlHours: 12, fingerprint: rn.n.ctx.identity.fingerprint });
		expect(res.headers["cache-control"]).toBe("no-store");
	});

	it("logs in: wrong passwords get one uniform error; the cookie is __Host-, HttpOnly, Secure, SameSite=Strict, Path=/", async () => {
		const ip = freshIp();
		const wrong = await send(rn, "POST", "/api/local/access/login", { password: "not the password at all" }, { origin: PUBLIC_ORIGIN, ip });
		expect(wrong.status).toBe(401);
		expect(wrong.json?.error).toMatchObject({ code: "invalid_credentials", message: "Invalid password" });
		expect(wrong.cookies).toEqual([]);

		const ok = await send(rn, "POST", "/api/local/access/login", { password: PASSWORD }, { origin: PUBLIC_ORIGIN, ip });
		expect(ok.status).toBe(200);
		expect(ok.cookies).toHaveLength(1);
		const [name, ...attributes] = (ok.cookies[0] ?? "").split(";").map((part) => part.trim());
		expect(name?.startsWith("__Host-clam_session=")).toBe(true);
		expect(attributes.filter((a) => !a.startsWith("Max-Age="))).toEqual(["Path=/", "Secure", "HttpOnly", "SameSite=Strict"]);
		expect(attributes.some((a) => a.toLowerCase().startsWith("domain"))).toBe(false);
		const maxAge = Number(attributes.find((a) => a.startsWith("Max-Age="))?.slice("Max-Age=".length));
		expect(maxAge).toBeGreaterThan(12 * 3600 - 30);
		expect(maxAge).toBeLessThanOrEqual(12 * 3600);
		expect(ok.json).toMatchObject({ via: "remote", signedIn: true });
		expect(Date.parse((ok.json as AccessStatus).sessionExpiresAt ?? "")).toBeGreaterThan(Date.now() + 11 * 3_600_000);
		expect(ok.headers["strict-transport-security"]).toBe("max-age=31536000");
		expect(ok.headers["cache-control"]).toBe("no-store");
	});

	it("serves the authenticated API, and the status probe then says signedIn", async () => {
		const cookie = await signIn(rn);
		const node = await get(rn, "/api/local/node", { cookie });
		expect(node.status).toBe(200);
		expect((node.json as unknown as NodeInfo).id).toBe(rn.n.ctx.identity.nodeId);
		expect(node.headers["content-security-policy"]).toContain("default-src 'none'");
		const status = await get(rn, "/api/local/access", { cookie });
		expect(status.json).toMatchObject({ via: "remote", signedIn: true });
		expect(Date.parse((status.json as AccessStatus).sessionExpiresAt ?? "")).toBeGreaterThan(Date.now());
		// Unknown API routes behind a session are a plain 404.
		expect((await get(rn, "/api/local/nope", { cookie })).status).toBe(404);
		// Other cookies riding along do not matter.
		expect((await get(rn, "/api/local/node", { cookie: `foo=bar; ${cookie}; baz=1` })).status).toBe(200);
	});

	it("throttles guesses per client with a lockout that even the right password cannot beat, without locking other clients out", async () => {
		const ip = freshIp();
		for (let i = 0; i < 5; i++) {
			const res = await send(rn, "POST", "/api/local/access/login", { password: `guess number ${i} of many` }, { origin: PUBLIC_ORIGIN, ip });
			expect(res.status, `guess ${i}`).toBe(401);
		}
		const locked = await send(rn, "POST", "/api/local/access/login", { password: PASSWORD }, { origin: PUBLIC_ORIGIN, ip });
		expect(locked.status).toBe(429);
		expect(locked.json?.error?.code).toBe("rate_limited");
		const retry = Number(locked.headers["retry-after"]);
		expect(retry).toBeGreaterThan(0);
		expect(locked.json?.error?.details?.retryAfterSeconds).toBe(retry);
		expect(locked.cookies).toEqual([]);
		// Another client is unaffected.
		expect((await send(rn, "POST", "/api/local/access/login", { password: PASSWORD }, { origin: PUBLIC_ORIGIN, ip: freshIp() })).status).toBe(200);
	});

	it("applies the strict Origin check to login, writes and reads alike (CSRF)", async () => {
		const ip = freshIp();
		for (const origin of ["https://evil.example", "null", `http://${PUBLIC_HOST}`, `https://${PUBLIC_HOST}.evil.example`, null]) {
			const res = await send(rn, "POST", "/api/local/access/login", { password: PASSWORD }, { origin, ip });
			expect(res.status, String(origin)).toBe(403);
			expect(res.json?.error?.code).toBe("forbidden_origin");
			expect(res.cookies).toEqual([]);
		}
		const cookie = await signIn(rn);
		const workspacesBefore = ((await api(rn.n).get<Workspace[]>("/workspaces")).body ?? []).length;
		for (const origin of ["https://evil.example", "null", null]) {
			const res = await send(rn, "POST", "/api/local/workspaces", { name: "forged" }, { cookie, origin });
			expect(res.status, String(origin)).toBe(403);
			expect(res.json?.error?.code).toBe("forbidden_origin");
		}
		// A read with a foreign Origin is refused too; a read with no Origin (plain navigation) is fine.
		expect((await get(rn, "/api/local/node", { cookie, origin: "https://evil.example" })).status).toBe(403);
		expect((await get(rn, "/api/local/node", { cookie, origin: null })).status).toBe(200);
		expect(((await api(rn.n).get<Workspace[]>("/workspaces")).body ?? []).length).toBe(workspacesBefore);
		// The right origin writes.
		const created = await send(rn, "POST", "/api/local/workspaces", { name: "from the tunnel" }, { cookie, origin: PUBLIC_ORIGIN });
		expect(created.status, created.text).toBeLessThan(300);
		// Development mode (CLAM_ALLOW_LOOPBACK_PEERS) also treats the listener's own loopback origin as its own.
		const loopbackOrigin = await send(rn, "POST", "/api/local/workspaces", { name: "dev origin" }, { cookie, origin: `http://127.0.0.1:${rn.port}`, host: `127.0.0.1:${rn.port}` });
		expect(loopbackOrigin.status).toBeLessThan(300);
	});

	it("rejects tampered, forged, expired and out-of-epoch cookies and tells the browser to drop them", async () => {
		const cookie = await signIn(rn);
		const token = cookie.slice(SESSION.length + 1);
		const [payload, signature] = token.split(".") as [string, string];
		const flip = (s: string): string => s.slice(0, -2) + (s.endsWith("A") ? "B" : "A") + s.slice(-1);
		const claims = verifyToken(await keyOf(rn.n), token) as SessionClaims;
		const now = Date.now();
		const key = await keyOf(rn.n);
		const forged = (c: Partial<SessionClaims>, withKey = key): string => `${SESSION}=${signToken(withKey, { ...claims, ...c })}`;
		const cases: Record<string, string> = {
			"bad signature": `${SESSION}=${payload}.${flip(signature)}`,
			"edited payload": `${SESSION}=${Buffer.from(JSON.stringify({ ...claims, exp: now + 99 * 3_600_000 })).toString("base64url")}.${signature}`,
			"not a token": `${SESSION}=garbage`,
			"empty": `${SESSION}=`,
			"signed with another key": forged({}, Buffer.alloc(32, 7)),
			expired: forged({ iat: now - 3 * 3_600_000, ren: now - 2 * 3_600_000, exp: now - 60_000 }),
			"older than the 7-day cap": forged({ iat: now - 8 * 24 * 3_600_000, ren: now - 60_000, exp: now + 3_600_000 }),
			"previous epoch": forged({ epoch: epochOf(rn.n) - 1 }),
			"future epoch": forged({ epoch: epochOf(rn.n) + 1 }),
		};
		for (const [what, header] of Object.entries(cases)) {
			const res = await get(rn, "/api/local/node", { cookie: header });
			expect(res.status, what).toBe(401);
			expect(res.json?.error?.code, what).toBe("auth_required");
			if (header !== `${SESSION}=`) expect(res.cookies.join(), what).toContain("Max-Age=0");
		}
		// The genuine one still works.
		expect((await get(rn, "/api/local/node", { cookie })).status).toBe(200);
	});

	it("renews an active session's cookie (sliding expiry) without ever extending past the 7-day cap", async () => {
		const key = await keyOf(rn.n);
		const now = Date.now();
		const base: SessionClaims = { sid: "ab".repeat(16), iat: now - 3 * 3_600_000, ren: now - 10 * 60_000, exp: now + 3_600_000, epoch: epochOf(rn.n) };
		const stale = `${SESSION}=${signToken(key, base)}`;
		const res = await get(rn, "/api/local/node", { cookie: stale });
		expect(res.status).toBe(200);
		const renewed = verifyToken(key, sessionCookieOf(res).slice(SESSION.length + 1)) as SessionClaims;
		expect(renewed.sid).toBe(base.sid);
		expect(renewed.iat).toBe(base.iat);
		expect(renewed.ren).toBeGreaterThanOrEqual(now);
		expect(renewed.exp).toBeGreaterThan(now + 11 * 3_600_000);
		// Fresh cookies are not re-issued on every request.
		const fresh = `${SESSION}=${signToken(key, { ...base, ren: Date.now() })}`;
		expect((await get(rn, "/api/local/node", { cookie: fresh })).cookies).toEqual([]);
		// Near the cap the renewal is clamped to it.
		const nearCap = `${SESSION}=${signToken(key, { ...base, iat: now - 7 * 24 * 3_600_000 + 5 * 60_000, ren: now - 10 * 60_000, exp: now + 60_000 })}`;
		const capped = await get(rn, "/api/local/node", { cookie: nearCap });
		expect(capped.status).toBe(200);
		const clamped = verifyToken(key, sessionCookieOf(capped).slice(SESSION.length + 1)) as SessionClaims;
		expect(clamped.exp).toBe(clamped.iat + 7 * 24 * 3_600_000);
	});

	it("logout ends that session only, even for a copied cookie; logout-all ends every session", async () => {
		const first = await signIn(rn);
		const second = await signIn(rn);
		const noOrigin = await send(rn, "POST", "/api/local/access/logout", {}, { cookie: first, origin: null });
		expect(noOrigin.status).toBe(403);
		const out = await send(rn, "POST", "/api/local/access/logout", {}, { cookie: first, origin: PUBLIC_ORIGIN });
		expect(out.status).toBe(204);
		expect(out.cookies.join()).toContain(`${SESSION}=;`);
		expect(out.cookies.join()).toContain("Max-Age=0");
		expect((await get(rn, "/api/local/node", { cookie: first })).status).toBe(401);
		expect((await get(rn, "/api/local/node", { cookie: second })).status).toBe(200);

		const epochBefore = epochOf(rn.n);
		const all = await send(rn, "POST", "/api/local/access/logout-all", {}, { cookie: second, origin: PUBLIC_ORIGIN });
		expect(all.status).toBe(204);
		expect(epochOf(rn.n)).toBe(epochBefore + 1);
		const third = await signIn(rn);
		expect((await get(rn, "/api/local/node", { cookie: first })).status).toBe(401);
		expect((await get(rn, "/api/local/node", { cookie: second })).status).toBe(401);
		expect((await get(rn, "/api/local/node", { cookie: third })).status).toBe(200);
	});

	it("keeps exposure settings loopback-only even for a signed-in owner", async () => {
		const cookie = await signIn(rn);
		const http = api(rn.n);
		const patch = await send(rn, "PATCH", "/api/local/access", { remoteUiEnabled: false }, { cookie, origin: PUBLIC_ORIGIN });
		expect(patch.status).toBe(403);
		expect(patch.json?.error?.code).toBe("loopback_only");
		const tunnel = await send(rn, "PUT", "/api/local/tunnel/config", { mode: "off" }, { cookie, origin: PUBLIC_ORIGIN });
		expect(tunnel.status).toBe(403);
		expect(tunnel.json?.error?.code).toBe("loopback_only");
		expect((await http.get<AccessStatus>("/access")).body.remoteUiEnabled).toBe(true);
		expect(((await http.get<{ config: { mode: string } }>("/tunnel")).body).config.mode).toBe("quick");
		// A ttl change is an exposure change as well; at the machine it works and applies to new sessions.
		expect((await http.patch<AccessStatus>("/access", { sessionTtlHours: 1 })).body.sessionTtlHours).toBe(1);
		const short = await send(rn, "POST", "/api/local/access/login", { password: PASSWORD }, { origin: PUBLIC_ORIGIN, ip: freshIp() });
		expect(Date.parse((short.json as AccessStatus).sessionExpiresAt ?? "")).toBeLessThan(Date.now() + 3_700_000);
		expect((await http.patch<AccessStatus>("/access", { sessionTtlHours: 12 })).body.sessionTtlHours).toBe(12);
		expect((await http.patch("/access", { sessionTtlHours: 0 })).status).toBe(400);
	});

	it("reports publicUiUrl only while the tunnel is up", async () => {
		const http = api(rn.n);
		expect((await http.post("/tunnel/stop")).status).toBe(200);
		expect((await http.get<AccessStatus>("/access")).body).toMatchObject({ remoteUiEnabled: true, publicUiUrl: null });
		expect((await http.post("/tunnel/start")).status).toBe(200);
		expect((await http.get<AccessStatus>("/access")).body.publicUiUrl).toBe(PUBLIC_ORIGIN);
	});

	it("leaves the loopback UI listener exactly as it was: no login, no cookie, same security headers", async () => {
		const status = await fetch(`${rn.n.url}/api/local/access`);
		expect(await status.json()).toMatchObject({ via: "loopback", signedIn: true, sessionExpiresAt: null });
		expect(status.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
		expect(status.headers.get("strict-transport-security")).toBeNull();
		expect((await fetch(`${rn.n.url}/api/local/node`)).status).toBe(200);
		// A stray cookie header changes nothing; login is meaningless there.
		expect((await fetch(`${rn.n.url}/api/local/node`, { headers: { cookie: `${SESSION}=garbage` } })).status).toBe(200);
		const login = await fetch(`${rn.n.url}/api/local/access/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) });
		expect(login.status).toBe(409);
		expect(login.headers.get("set-cookie")).toBeNull();
		expect(((await login.json()) as { error: { code: string } }).error.code).toBe("login_not_required");
		expect((await fetch(`${rn.n.url}/api/v1/node/info`)).status).toBe(404);
	});

	it("lets the owner at the machine end every remote session", async () => {
		const cookie = await signIn(rn);
		expect((await get(rn, "/api/local/node", { cookie })).status).toBe(200);
		const res = await fetch(`${rn.n.url}/api/local/access/logout-all`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
		expect(res.status).toBe(204);
		expect((await get(rn, "/api/local/node", { cookie })).status).toBe(401);
	});
});

describe("remote UI password changes", () => {
	let rn: RemoteNode;
	beforeAll(async () => {
		rn = await remoteNode();
		await enableRemoteUi(rn);
	});
	afterAll(async () => rn.cleanup());

	it("needs the current password remotely, then ends every session and continues as a fresh one", async () => {
		const cookie = await signIn(rn);
		const other = await signIn(rn);
		const next = "a brand new passphrase!";
		const change = (body: unknown, c: string = cookie, ip = freshIp()) => send(rn, "PUT", "/api/local/access/password", body, { cookie: c, origin: PUBLIC_ORIGIN, ip });

		expect((await change({ password: next }, "")).status).toBe(401);
		expect((await change({ password: next })).status).toBe(400);
		const wrong = await change({ password: next, currentPassword: "not my password!!" });
		expect(wrong.status).toBe(403);
		expect(wrong.json?.error?.code).toBe("invalid_current_password");
		expect((await change({ password: "short", currentPassword: PASSWORD })).status).toBe(400);
		expect((await get(rn, "/api/local/node", { cookie })).status).toBe(200);

		const changed = await change({ password: next, currentPassword: PASSWORD });
		expect(changed.status, changed.text).toBe(200);
		expect(changed.json).toMatchObject({ via: "remote", signedIn: true });
		const fresh = sessionCookieOf(changed);
		expect((await get(rn, "/api/local/node", { cookie })).status).toBe(401);
		expect((await get(rn, "/api/local/node", { cookie: other })).status).toBe(401);
		expect((await get(rn, "/api/local/node", { cookie: fresh })).status).toBe(200);
		expect((await send(rn, "POST", "/api/local/access/login", { password: PASSWORD }, { origin: PUBLIC_ORIGIN, ip: freshIp() })).status).toBe(401);
		await signIn(rn, { password: next });
	});

	it("throttles current-password guesses like login guesses", async () => {
		const cookie = await signIn(rn, { password: "a brand new passphrase!" });
		const ip = freshIp();
		for (let i = 0; i < 5; i++) {
			const res = await send(rn, "PUT", "/api/local/access/password", { password: "yet another passphrase", currentPassword: `wrong guess ${i} here` }, { cookie, origin: PUBLIC_ORIGIN, ip });
			expect(res.status, `guess ${i}`).toBe(403);
		}
		const locked = await send(rn, "PUT", "/api/local/access/password", { password: "yet another passphrase", currentPassword: "a brand new passphrase!" }, { cookie, origin: PUBLIC_ORIGIN, ip });
		expect(locked.status).toBe(429);
		expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
	});

	it("at the machine, a new password needs no old one and cuts off remote sessions", async () => {
		const cookie = await signIn(rn, { password: "a brand new passphrase!" });
		const res = await api(rn.n).put<AccessStatus>("/access/password", { password: PASSWORD });
		expect(res.status).toBe(200);
		expect((await get(rn, "/api/local/node", { cookie })).status).toBe(401);
		await signIn(rn);
	});
});

describe("remote UI WebSocket", () => {
	let rn: RemoteNode;
	beforeAll(async () => {
		rn = await remoteNode();
		await enableRemoteUi(rn);
	});
	afterAll(async () => rn.cleanup());

	it("requires the owner session AND the public origin on the upgrade, and a known Host", async () => {
		const cookie = await signIn(rn);
		expect((await wsUpgrade(rn.port, { origin: PUBLIC_ORIGIN })).status).toBe(401);
		expect((await wsUpgrade(rn.port, { origin: PUBLIC_ORIGIN, cookie: `${SESSION}=forged.sig` })).status).toBe(401);
		expect((await wsUpgrade(rn.port, { origin: "https://evil.example", cookie })).status).toBe(403);
		expect((await wsUpgrade(rn.port, { cookie })).status).toBe(403);
		expect((await wsUpgrade(rn.port, { origin: PUBLIC_ORIGIN, cookie, host: "evil.example" })).status).toBe(403);
	});

	it("accepts the upgrade with the cookie, serves subscriptions, and closes with 4401 when the session ends", async () => {
		const cookie = await signIn(rn);
		const { status, ws } = await wsUpgrade(rn.port, { origin: PUBLIC_ORIGIN, cookie });
		expect(status).toBe(101);
		ws!.send({ type: "ping", t: 7 });
		await ws!.until(() => ws!.texts.some((t) => t.includes('"pong"')), "pong");
		expect(JSON.parse(ws!.texts.find((t) => t.includes('"pong"'))!)).toEqual({ type: "pong", t: 7 });
		ws!.send({ type: "subscribe", topics: ["node"] });
		await ws!.until(() => ws!.texts.some((t) => t.includes('"subscribed"')), "subscribed");

		const out = await send(rn, "POST", "/api/local/access/logout", {}, { cookie, origin: PUBLIC_ORIGIN });
		expect(out.status).toBe(204);
		await ws!.until(() => ws!.closeCode !== null || ws!.ended, "close after logout");
		expect(ws!.closeCode).toBe(4401);
		ws!.destroy();
	});

	it("closes remote sockets on logout-all, on disabling remote UI, and keeps a loopback socket", async () => {
		const first = await signIn(rn);
		const a = await wsUpgrade(rn.port, { origin: PUBLIC_ORIGIN, cookie: first });
		expect(a.status).toBe(101);
		expect((await send(rn, "POST", "/api/local/access/logout-all", {}, { cookie: first, origin: PUBLIC_ORIGIN })).status).toBe(204);
		await a.ws!.until(() => a.ws!.closeCode !== null || a.ws!.ended, "close after logout-all");
		expect(a.ws!.closeCode).toBe(4401);
		a.ws!.destroy();

		const second = await signIn(rn);
		const b = await wsUpgrade(rn.port, { origin: PUBLIC_ORIGIN, cookie: second });
		expect(b.status).toBe(101);
		expect((await api(rn.n).patch("/access", { remoteUiEnabled: false })).status).toBe(200);
		await b.ws!.until(() => b.ws!.closeCode !== null || b.ws!.ended, "close after disabling");
		expect(b.ws!.closeCode).toBe(4401);
		b.ws!.destroy();
		expect((await wsUpgrade(rn.port, { origin: PUBLIC_ORIGIN, cookie: second })).status).toBe(404);

		// Re-enabling starts clean: the old cookie stays dead.
		expect((await api(rn.n).patch("/access", { remoteUiEnabled: true })).status).toBe(200);
		expect((await get(rn, "/api/local/node", { cookie: second })).status).toBe(401);
		await signIn(rn);
	});
});

describe("/api/v1 next to the remote UI", () => {
	let rn: RemoteNode;
	beforeAll(async () => {
		rn = await remoteNode();
	});
	afterAll(async () => rn.cleanup());

	const WIRE_PATHS = ["/api/v1/node/info", "/api/v1/agents", "/api/v1/zzz-unknown", "/api/v1/"];
	const snapshot = async (cookie?: string) =>
		Promise.all(
			WIRE_PATHS.map(async (path) => {
				const res = await get(rn, path, { cookie });
				const { date: _date, "x-request-id": _id, ...headers } = res.headers;
				return { path, status: res.status, headers, text: path === "/api/v1/node/info" ? res.text.replace(/"startedAt":"[^"]+"/, "") : res.text };
			}),
		);

	it("answers byte-for-byte the same with remote UI off and on, and never reads cookies", async () => {
		const off = await snapshot();
		await enableRemoteUi(rn);
		const cookie = await signIn(rn);
		const on = await snapshot();
		const onWithCookie = await snapshot(cookie);
		expect(on).toEqual(off);
		expect(onWithCookie).toEqual(off);
		const byPath = Object.fromEntries(off.map((s) => [s.path, s]));
		expect(byPath["/api/v1/node/info"]?.status).toBe(200);
		expect(byPath["/api/v1/node/info"]?.headers["cache-control"]).toBe("no-store");
		expect(byPath["/api/v1/node/info"]?.headers["content-digest"]).toBeDefined();
		expect(byPath["/api/v1/node/info"]?.headers["content-security-policy"]).toBeUndefined();
		expect(byPath["/api/v1/node/info"]?.headers["strict-transport-security"]).toBeUndefined();
		// Signed routes still demand a node signature (an unsigned call is refused for its missing protocol version): a valid owner cookie is not one.
		expect(byPath["/api/v1/agents"]?.status).toBe(426);
		expect(byPath["/api/v1/zzz-unknown"]?.status).toBe(404);
		expect(byPath["/api/v1/zzz-unknown"]?.headers["content-digest"]).toBeDefined();
	});

	it("never upgrades an /api/v1 connection to a WebSocket", async () => {
		expect((await wsUpgrade(rn.port, { path: "/api/v1/events", origin: PUBLIC_ORIGIN })).status).toBe(0);
		expect((await wsUpgrade(rn.port, { path: "/api/v1/node/info", origin: PUBLIC_ORIGIN, cookie: await signIn(rn) })).status).toBe(0);
	});
});

describe("remote UI robustness", () => {
	it("keeps sessions across a node restart, and a logged-out or logged-out-everywhere cookie stays dead", async () => {
		const secrets = createMemorySecrets();
		const dataDir = mkdtempSync(join(tmpdir(), "clam-remote-restart-"));
		let rn = await remoteNode({ dataDir, secrets });
		try {
			await enableRemoteUi(rn);
			const kept = await signIn(rn);
			const loggedOut = await signIn(rn);
			expect((await send(rn, "POST", "/api/local/access/logout", {}, { cookie: loggedOut, origin: PUBLIC_ORIGIN })).status).toBe(204);
			await rn.cleanup({ keepData: true });

			rn = await remoteNode({ dataDir, secrets });
			expect((await api(rn.n).get<AccessStatus>("/access")).body).toMatchObject({ passwordSet: true, remoteUiEnabled: true });
			expect((await get(rn, "/api/local/node", { cookie: kept })).status).toBe(200);
			expect((await get(rn, "/api/local/node", { cookie: loggedOut })).status).toBe(401);
			expect((await send(rn, "POST", "/api/local/access/login", { password: PASSWORD }, { origin: PUBLIC_ORIGIN, ip: freshIp() })).status).toBe(200);

			expect((await send(rn, "POST", "/api/local/access/logout-all", {}, { cookie: kept, origin: PUBLIC_ORIGIN })).status).toBe(204);
			await rn.cleanup({ keepData: true });
			rn = await remoteNode({ dataDir, secrets });
			expect((await get(rn, "/api/local/node", { cookie: kept })).status).toBe(401);
		} finally {
			await rn.cleanup();
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("a restarted node whose secret store lost the signing key rejects the old cookies and mints a new key", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "clam-remote-key-"));
		let rn = await remoteNode({ dataDir, secrets: createMemorySecrets() });
		try {
			await enableRemoteUi(rn);
			const cookie = await signIn(rn);
			await rn.cleanup({ keepData: true });
			rn = await remoteNode({ dataDir, secrets: createMemorySecrets() });
			expect((await get(rn, "/api/local/node", { cookie })).status).toBe(401);
			const fresh = await signIn(rn);
			expect((await get(rn, "/api/local/node", { cookie: fresh })).status).toBe(200);
		} finally {
			await rn.cleanup();
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("never stores the password or the signing key in SQLite, and the stored hash is scrypt", async () => {
		const rn = await remoteNode();
		try {
			await enableRemoteUi(rn);
			const rows = rn.n.ctx.db.$client.prepare("select key, value from settings where key like 'access.%'").all() as Array<{ key: string; value: string }>;
			const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
			expect(byKey["access.password"]).toMatch(/^scrypt\$32768\$8\$1\$/);
			expect(JSON.stringify(rows)).not.toContain(PASSWORD);
			await signIn(rn);
			const key = await rn.n.ctx.secrets.get("access.session-key");
			expect(key).toBeTruthy();
			const after = rn.n.ctx.db.$client.prepare("select value from settings").all() as Array<{ value: string }>;
			expect(after.every((r) => !(key && r.value.includes(key)))).toBe(true);
		} finally {
			await rn.cleanup();
		}
	});

	it("answers false, at the cost of a real check, when no password is set", async () => {
		const rn = await remoteNode();
		try {
			expect(rn.n.ctx.access.passwordSet()).toBe(false);
			expect(await rn.n.ctx.access.verifyOwnerPassword("x", "whatever it is, whatever")).toBe(false);
			expect(await rn.n.ctx.access.verifyOwnerPassword("x", "")).toBe(false);
		} finally {
			await rn.cleanup();
		}
	});

	it("refuses a flood of concurrent password checks instead of queueing scrypt without bound", async () => {
		const rn = await remoteNode();
		try {
			await enableRemoteUi(rn);
			const results = await Promise.all(Array.from({ length: 14 }, () => send(rn, "POST", "/api/local/access/login", { password: "not it, not it, not it" }, { origin: PUBLIC_ORIGIN, ip: freshIp() })));
			const statuses = results.map((r) => r.status);
			expect(statuses.every((s) => s === 401 || s === 429)).toBe(true);
			expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
			expect(statuses.filter((s) => s === 401).length).toBeGreaterThanOrEqual(1);
			// The node is still fine afterwards.
			await signIn(rn);
		} finally {
			await rn.cleanup();
		}
	});
});
