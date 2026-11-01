import { describe, expect, it } from "vitest";
import { clearedPreviewCookie, previewCookieValue, previewPortCookie, previewPortFromCookie, previewSessionCookie, signPreviewSession, signTicket, verifyPreviewSession, verifyTicket } from "../src/auth/preview-token.ts";
import { deriveDefaultHost, landingPath, matchPreviewHost, parsePortPath, parsePreviewHost } from "../src/preview/preview-host.ts";
import { DENIED_PORTS, refusePort } from "../src/preview/port-policy.ts";
import { rewriteLocation, rewriteRequestHeaders, rewriteResponseHeaders, rewriteSetCookie, stripClamCookies, type RewriteContext } from "../src/preview/rewrite.ts";

describe("preview host and URL scheme", () => {
	it("derives <first label>-preview.<rest> from the tunnel hostname", () => {
		expect(deriveDefaultHost("clamp-work.conglt.io.vn")).toBe("clamp-work-preview.conglt.io.vn");
		expect(deriveDefaultHost("Agent-A.Example.com")).toBe("agent-a-preview.example.com");
		expect(deriveDefaultHost("example.com")).toBe("preview.example.com");
		expect(deriveDefaultHost("localhost")).toBeNull();
		expect(deriveDefaultHost("a..b")).toBeNull();
	});

	it("accepts plain hostnames only, never the tunnel's own", () => {
		expect(parsePreviewHost(" Clamp-Work-Preview.conglt.io.vn ", "clamp-work.conglt.io.vn")).toEqual({ ok: true, host: "clamp-work-preview.conglt.io.vn" });
		for (const bad of ["", "localhost", "https://x.example.com", "x.example.com/path", "x.example.com:8080", "{port}-x.example.com", "*.example.com", "-x.example.com", "x_y.example.com", `${"a".repeat(64)}.example.com`]) {
			expect(parsePreviewHost(bad), bad).toEqual({ ok: false, error: "syntax" });
		}
		expect(parsePreviewHost("clamp-work.conglt.io.vn", "Clamp-Work.conglt.io.vn")).toEqual({ ok: false, error: "tunnel" });
	});

	it("matches exactly the preview host (any :port of the header ignored), nothing else", () => {
		const host = "clamp-work-preview.conglt.io.vn";
		expect(matchPreviewHost(host, "clamp-work-preview.conglt.io.vn")).toBe(host);
		expect(matchPreviewHost(host, "CLAMP-WORK-PREVIEW.conglt.io.vn:443")).toBe(host);
		for (const wrong of ["clamp-work.conglt.io.vn", "5173-clamp-work-preview.conglt.io.vn", "clamp-work-preview.conglt.io.vn.evil.example", "evil.clamp-work-preview.conglt.io.vn", "localhost", ""]) {
			expect(matchPreviewHost(host, wrong), wrong).toBeNull();
		}
		expect(matchPreviewHost(host, undefined)).toBeNull();
	});

	it("reads /port/<port>/<rest> and nothing that merely looks like it", () => {
		expect(parsePortPath("/port/5173/")).toEqual({ port: 5173, rest: "/" });
		expect(parsePortPath("/port/5173")).toEqual({ port: 5173, rest: "/" });
		expect(parsePortPath("/port/3000/a/b/c.js")).toEqual({ port: 3000, rest: "/a/b/c.js" });
		expect(parsePortPath("/port/65535/x")).toEqual({ port: 65535, rest: "/x" });
		for (const other of ["/port/", "/port/abc", "/port/0/x", "/port/05173/x", "/port/65536/x", "/port/5173abc", "/ports/5173", "/x/port/5173", "/Port/5173/", "/"]) {
			expect(parsePortPath(other), other).toBeNull();
		}
		expect(landingPath(5173, "/a?b=1")).toBe("/port/5173/a?b=1");
	});
});

describe("preview port policy", () => {
	it("refuses CLAM's own ports, the denylist, privileged and invalid ports", () => {
		expect(refusePort(5173, [4317, 4318])).toBeNull();
		expect(refusePort(3000, [4317, 4318])).toBeNull();
		expect(refusePort(80, [])).toBeNull();
		expect(refusePort(4317, [4317, 4318])).toBe("own");
		expect(refusePort(4318, [4317, 4318])).toBe("own");
		for (const denied of [22, 3306, 5432, 6379, 27017, 9229, 9222]) {
			expect(DENIED_PORTS.has(denied)).toBe(true);
			expect(refusePort(denied, [])).toBe("denied");
		}
		expect(refusePort(443, [])).toBe("privileged");
		expect(refusePort(1023, [])).toBe("privileged");
		expect(refusePort(0, [])).toBe("invalid");
		expect(refusePort(65536, [])).toBe("invalid");
		expect(refusePort(1.5, [])).toBe("invalid");
	});
});

const ctx: RewriteContext = { port: 5173, previewHost: "clamp-work-preview.conglt.io.vn", previewOrigin: "https://clamp-work-preview.conglt.io.vn", clientIp: "203.0.113.9" };

describe("preview header rewrites", () => {
	it("rewrites Host and a same-origin Origin/Referer to localhost:<port>, adds forwarding headers, drops the preview cookie and hop-by-hop headers", () => {
		const out = rewriteRequestHeaders(
			{
				host: "clamp-work-preview.conglt.io.vn",
				origin: "https://clamp-work-preview.conglt.io.vn",
				referer: "https://clamp-work-preview.conglt.io.vn/app?x=1",
				cookie: "a=1; __Host-clam_preview=SECRET; __Host-clam_preview_port=5173; b=2",
				connection: "keep-alive",
				"keep-alive": "timeout=5",
				"transfer-encoding": "chunked",
				"x-forwarded-for": "spoofed",
				accept: "text/html",
			},
			ctx,
			{ upgrade: false },
		);
		expect(out.host).toBe("localhost:5173");
		expect(out.origin).toBe("http://localhost:5173");
		expect(out.referer).toBe("http://localhost:5173/app?x=1");
		expect(out.cookie).toBe("a=1; b=2");
		expect(out["x-forwarded-proto"]).toBe("https");
		expect(out["x-forwarded-host"]).toBe("clamp-work-preview.conglt.io.vn");
		expect(out["x-forwarded-for"]).toBe("203.0.113.9");
		expect(out.accept).toBe("text/html");
		for (const hop of ["connection", "keep-alive", "transfer-encoding"]) expect(out[hop]).toBeUndefined();
	});

	it("leaves a foreign Origin alone and removes an empty Cookie header", () => {
		const out = rewriteRequestHeaders({ host: "x", origin: "https://evil.example", referer: "https://evil.example/x", cookie: "__Host-clam_preview=SECRET" }, ctx, { upgrade: false });
		expect(out.origin).toBe("https://evil.example");
		expect(out.referer).toBe("https://evil.example/x");
		expect("cookie" in out).toBe(false);
		expect(stripClamCookies("__Host-clam_preview=1")).toBeUndefined();
		expect(stripClamCookies("__Host-clam_preview_port=5173; a=1; __Host-clam_session=x")).toBe("a=1");
		expect(stripClamCookies("x=1;__Host-clam_preview=1;y=2")).toBe("x=1; y=2");
	});

	it("keeps Connection/Upgrade for a WebSocket handshake", () => {
		const out = rewriteRequestHeaders({ host: "x", connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": "k", origin: ctx.previewOrigin }, ctx, { upgrade: true });
		expect(out).toMatchObject({ connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": "k", origin: "http://localhost:5173" });
	});

	it("rewrites absolute redirects to this app's loopback name onto the preview origin, nothing else", () => {
		expect(rewriteLocation("http://localhost:5173/a/b?c=1#d", ctx)).toBe("https://clamp-work-preview.conglt.io.vn/a/b?c=1#d");
		expect(rewriteLocation("http://127.0.0.1:5173/", ctx)).toBe("https://clamp-work-preview.conglt.io.vn/");
		expect(rewriteLocation("http://[::1]:5173/x", ctx)).toBe("https://clamp-work-preview.conglt.io.vn/x");
		expect(rewriteLocation("//localhost:5173/x", ctx)).toBe("https://clamp-work-preview.conglt.io.vn/x");
		expect(rewriteLocation("http://localhost:3000/x", ctx)).toBe("http://localhost:3000/x"); // another app
		expect(rewriteLocation("https://example.com/x", ctx)).toBe("https://example.com/x");
		expect(rewriteLocation("/relative", ctx)).toBe("/relative");
		expect(rewriteLocation("mailto:a@b.c", ctx)).toBe("mailto:a@b.c");
	});

	it("keeps cookies host-only: Domain is stripped, the preview cookie cannot be set, SameSite=None gets Secure", () => {
		expect(rewriteSetCookie(["sid=1; Path=/; Domain=localhost; HttpOnly", "t=2; domain=.conglt.io.vn; Path=/"])).toEqual(["sid=1; Path=/; HttpOnly", "t=2; Path=/"]);
		expect(rewriteSetCookie(["__Host-clam_preview=evil; Path=/; Secure", "__Host-clam_session=x; Path=/", "ok=1"])).toEqual(["ok=1"]);
		expect(rewriteSetCookie(["x=1; SameSite=None"])).toEqual(["x=1; SameSite=None; Secure"]);
		expect(rewriteSetCookie(["x=1; SameSite=None; Secure"])).toEqual(["x=1; SameSite=None; Secure"]);
	});

	it("rewrites the response headers as a whole", () => {
		const out = rewriteResponseHeaders(
			{
				location: "http://localhost:5173/login",
				"set-cookie": ["a=1; Domain=localhost; Path=/", "b=2"],
				"access-control-allow-origin": "http://localhost:5173",
				connection: "keep-alive",
				"transfer-encoding": "chunked",
				"content-type": "text/html",
			},
			ctx,
		);
		expect(out.location).toBe("https://clamp-work-preview.conglt.io.vn/login");
		expect(out["set-cookie"]).toEqual(["a=1; Path=/", "b=2"]);
		expect(out["access-control-allow-origin"]).toBe("https://clamp-work-preview.conglt.io.vn");
		expect(out["content-type"]).toBe("text/html");
		expect(out.connection).toBeUndefined();
		expect(out["transfer-encoding"]).toBeUndefined();
	});
});

describe("preview tokens", () => {
	const key = Buffer.alloc(32, 7);
	const other = Buffer.alloc(32, 9);
	const ticket = { jti: "a".repeat(32), port: 5173, host: "5173-x.example.com", path: "/", sid: "b".repeat(32), sessionIat: 1, epoch: 0, pepoch: 0, exp: 2 };
	const session = { sid: "b".repeat(32), iat: 1, ren: 1, exp: 2, epoch: 0, pepoch: 0 };

	it("round-trips and rejects tampering, a wrong key and confusion between kinds", () => {
		const t = signTicket(key, ticket);
		expect(verifyTicket(key, t)).toEqual(ticket);
		expect(verifyTicket(other, t)).toBeNull();
		expect(verifyTicket(key, `${t.slice(0, -2)}xx`)).toBeNull();
		const s = signPreviewSession(key, session);
		expect(verifyPreviewSession(key, s)).toEqual(session);
		// a ticket is no session cookie and the other way round
		expect(verifyPreviewSession(key, t)).toBeNull();
		expect(verifyTicket(key, s)).toBeNull();
	});

	it("the cookie is __Host- prefixed, host-only, Secure, HttpOnly and SameSite=Lax", () => {
		const cookie = previewSessionCookie("tok", 3600);
		expect(cookie).toBe("__Host-clam_preview=tok; Max-Age=3600; Path=/; Secure; HttpOnly; SameSite=Lax");
		expect(cookie.toLowerCase()).not.toContain("domain");
		expect(clearedPreviewCookie()).toContain("Max-Age=0");
		expect(previewCookieValue("a=1; __Host-clam_preview=tok; b=2")).toBe("tok");
		expect(previewCookieValue("__Host-clam_session=x")).toBeNull();
		expect(previewPortCookie(5173)).toBe("__Host-clam_preview_port=5173; Max-Age=604800; Path=/; Secure; HttpOnly; SameSite=Lax");
		expect(previewPortFromCookie("a=1; __Host-clam_preview_port=5173")).toBe(5173);
		for (const bad of [undefined, "", "__Host-clam_preview_port=0", "__Host-clam_preview_port=70000", "__Host-clam_preview_port=abc", "__Host-clam_preview_port=0123", "x=1"]) expect(previewPortFromCookie(bad), String(bad)).toBeNull();
	});
});
