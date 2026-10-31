import { describe, expect, it } from "vitest";
import { LoginLimiter } from "../src/auth/limiter.ts";
import { dummyHash, hashPassword, verifyPassword } from "../src/auth/password.ts";
import { SESSION_COOKIE, clearedSessionCookie, sessionCookie, sessionCookieValue, signToken, verifyToken, type SessionClaims } from "../src/auth/token.ts";

describe("password hashing", () => {
	it("hashes with scrypt N=2^15, a random salt, and verifies in constant time", async () => {
		const first = await hashPassword("correct horse battery staple");
		const second = await hashPassword("correct horse battery staple");
		expect(first).not.toBe(second);
		expect(first.split("$").slice(0, 4)).toEqual(["scrypt", String(2 ** 15), "8", "1"]);
		expect(await verifyPassword("correct horse battery staple", first)).toBe(true);
		expect(await verifyPassword("correct horse battery stapl", first)).toBe(false);
		expect(await verifyPassword("", first)).toBe(false);
		// Composed and decomposed forms of the same text are the same password.
		const composed = await hashPassword("pässwörd-ünïcode-123");
		expect(await verifyPassword("pa\u0308sswo\u0308rd-u\u0308ni\u0308code-123", composed)).toBe(true);
	});

	it("never matches an unreadable or out-of-bounds stored value, and never allocates for one", async () => {
		for (const stored of ["", "plain", "scrypt$1$8$1$AAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAA", `scrypt$${2 ** 30}$8$1$AAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAA`, "scrypt$32768$8$1$$", "scrypt$32768$8$1$AAAAAAAAAAAA$AAAA", "bcrypt$32768$8$1$AAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAA"]) {
			expect(await verifyPassword("anything", stored), stored).toBe(false);
		}
		expect(await verifyPassword("anything", await dummyHash())).toBe(false);
	});
});

describe("session token", () => {
	const key = Buffer.alloc(32, 1);
	const claims: SessionClaims = { sid: "0123456789abcdef0123456789abcdef", iat: 1_000, ren: 2_000, exp: 3_000, epoch: 4 };

	it("round-trips claims and refuses anything that is not exactly what was signed", () => {
		const token = signToken(key, claims);
		expect(verifyToken(key, token)).toEqual(claims);
		expect(verifyToken(Buffer.alloc(32, 2), token)).toBeNull();
		const [payload, mac] = token.split(".") as [string, string];
		expect(verifyToken(key, `${payload}.${mac.slice(0, -2)}AA`)).toBeNull();
		expect(verifyToken(key, `${payload}x.${mac}`)).toBeNull();
		for (const bad of ["", ".", "a.", ".b", "a.b.c", "x".repeat(2000), `${payload}.`, `.${mac}`]) expect(verifyToken(key, bad), bad).toBeNull();
		// A correctly signed payload of the wrong shape is no session.
		for (const shape of [{ ...claims, sid: "short" }, { ...claims, exp: "soon" }, { ...claims, epoch: 1.5 }, { sid: claims.sid }, null, 5]) {
			expect(verifyToken(key, signToken(key, shape as unknown as SessionClaims)), JSON.stringify(shape)).toBeNull();
		}
	});

	it("serializes the cookie with exactly the attributes the design demands", () => {
		expect(SESSION_COOKIE).toBe("__Host-clam_session");
		expect(sessionCookie("tok", 3600.9)).toBe("__Host-clam_session=tok; Max-Age=3600; Path=/; Secure; HttpOnly; SameSite=Strict");
		expect(sessionCookie("tok", -5)).toContain("Max-Age=0");
		expect(clearedSessionCookie()).toBe("__Host-clam_session=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict");
	});

	it("reads only its own cookie out of a Cookie header", () => {
		expect(sessionCookieValue(undefined)).toBeNull();
		expect(sessionCookieValue("a=b")).toBeNull();
		expect(sessionCookieValue("a=b; __Host-clam_session=tok.sig; c=d")).toBe("tok.sig");
		expect(sessionCookieValue("__Host-clam_session=")).toBeNull();
		expect(sessionCookieValue("clam_session=nope; x__Host-clam_session=nope")).toBeNull();
	});
});

describe("login limiter", () => {
	const clock = () => {
		let now = 1_000_000;
		return { now: () => now, advance: (ms: number) => void (now += ms) };
	};

	it("locks a client out after 5 consecutive failures, exponentially, and a success clears it", () => {
		const t = clock();
		const limiter = new LoginLimiter({ now: t.now });
		for (let i = 0; i < 4; i++) {
			expect(limiter.check("a").allowed).toBe(true);
			limiter.failure("a");
		}
		expect(limiter.check("a").allowed).toBe(true);
		limiter.failure("a"); // 5th
		expect(limiter.check("a")).toEqual({ allowed: false, retryAfterSeconds: 30 });
		expect(limiter.check("b").allowed).toBe(true);
		t.advance(29_000);
		expect(limiter.check("a")).toEqual({ allowed: false, retryAfterSeconds: 1 });
		t.advance(1_000);
		expect(limiter.check("a").allowed).toBe(true);
		limiter.failure("a"); // 6th → 60 s
		expect(limiter.check("a")).toEqual({ allowed: false, retryAfterSeconds: 60 });
		t.advance(60_000);
		limiter.failure("a"); // 7th → 120 s
		expect(limiter.check("a")).toEqual({ allowed: false, retryAfterSeconds: 120 });
		t.advance(120_000);
		limiter.success("a");
		for (let i = 0; i < 4; i++) limiter.failure("a");
		expect(limiter.check("a").allowed).toBe(true);
	});

	it("caps the lockout and forgets old failures", () => {
		const t = clock();
		const limiter = new LoginLimiter({ now: t.now, maxLockMs: 5 * 60_000 });
		for (let i = 0; i < 20; i++) {
			t.advance(10 * 60_000);
			limiter.failure("a");
			limiter.failure("a");
		}
		const verdict = limiter.check("a");
		expect(verdict.allowed).toBe(false);
		if (!verdict.allowed) expect(verdict.retryAfterSeconds).toBeLessThanOrEqual(300);
		// An hour without a failure resets the count.
		t.advance(2 * 60 * 60_000);
		limiter.failure("a");
		expect(limiter.check("a").allowed).toBe(true);
	});

	it("locks everyone out when guesses are spread over many clients, and escalates while it continues", () => {
		const t = clock();
		const limiter = new LoginLimiter({ now: t.now });
		for (let i = 0; i < 20; i++) limiter.failure(`client-${i}`); // 20 failures in the window: at the threshold, not over it
		expect(limiter.check("innocent").allowed).toBe(true);
		limiter.failure("client-20"); // 21st
		expect(limiter.check("innocent")).toEqual({ allowed: false, retryAfterSeconds: 30 });
		t.advance(30_000);
		expect(limiter.check("innocent").allowed).toBe(true);
		for (let i = 0; i < 21; i++) limiter.failure(`second-wave-${i}`);
		expect(limiter.check("innocent")).toEqual({ allowed: false, retryAfterSeconds: 60 });
		t.advance(60_000);
		// A real login resets the escalation.
		limiter.success("innocent");
		for (let i = 0; i < 21; i++) limiter.failure(`third-wave-${i}`);
		expect(limiter.check("innocent")).toEqual({ allowed: false, retryAfterSeconds: 30 });
	});

	it("bounds the number of tracked clients", () => {
		const limiter = new LoginLimiter({ maxClients: 3, globalThreshold: 10_000 });
		for (let i = 0; i < 5; i++) for (let k = 0; k < 5; k++) limiter.failure(`c${i}`);
		expect(limiter.check("c0").allowed).toBe(true); // evicted, so forgotten
		expect(limiter.check("c4").allowed).toBe(false);
	});
});
