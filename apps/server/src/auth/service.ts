import { randomBytes } from "node:crypto";
import type { AccessStatus, UpdateAccessBody } from "@clam/contracts";
import { settings } from "@clam/database";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import type { ServerContext } from "../context.ts";
import { ApiError } from "../http/errors.ts";
import { readNodeSettings } from "../services/settings.ts";
import { LoginLimiter, type LimiterOptions } from "./limiter.ts";
import { dummyHash, hashPassword, verifyPassword } from "./password.ts";
import { sessionCookieValue, signToken, verifyToken, type SessionClaims } from "./token.ts";

const KEY_PASSWORD = "access.password";
const KEY_CONFIG = "access.config";
const KEY_EPOCH = "access.epoch";
const KEY_REVOKED = "access.revoked";
const SECRET_SIGNING_KEY = "access.session-key";

/** A session lives at most this long after the login, however active it is. */
export const MAX_SESSION_MS = 7 * 24 * 3_600_000;
/** An active session's cookie is re-issued (sliding expiry) at most this often. */
const RENEW_AFTER_MS = 60_000;
/** Password checks (scrypt, ~100 ms and 32 MiB each) run one at a time; more than this waiting are refused. */
const MAX_PENDING_VERIFICATIONS = 6;
const SOCKET_SWEEP_MS = 15_000;
const DEFAULT_TTL_HOURS = 12;
/** Loopback names the public listener also accepts as its own origin, only with `CLAM_ALLOW_LOOPBACK_PEERS=1` (development/tests). */
const LOOPBACK_ORIGIN_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

/** Where a request came from and which owner session (if any) it carries. Set by the surface gate on every UI-surface request. */
export interface RequestAccess {
	via: "loopback" | "remote";
	/** The verified session of a remote request; always null on the loopback listener (no login there). */
	session: SessionClaims | null;
}

export interface AccessConfig {
	remoteUiEnabled: boolean;
	sessionTtlHours: number;
}

export interface IssuedSession {
	claims: SessionClaims;
	token: string;
	maxAgeSeconds: number;
}

interface TrackedSocket {
	claims: SessionClaims;
	close: () => void;
}

const rateLimited = (retryAfterSeconds: number): ApiError => new ApiError(429, "rate_limited", "Too many sign-in attempts. Try again later.", { retryAfterSeconds });

/**
 * Owner access to this node's web UI through its own domain: the password (scrypt, `settings`), the stateless
 * signed session cookie (HMAC key in the secret store), epoch-based "log out everywhere", single-session
 * revocation, login throttling, and the WebSockets that live as long as their session.
 */
export class AccessService {
	readonly limiter: LoginLimiter;
	private keyPromise: Promise<Buffer> | null = null;
	/** sid → hard end of that session; consulted on every request, persisted so a restart does not resurrect a logged-out cookie. */
	private readonly revoked: Map<string, number>;
	/** sid → the latest expiry this process has seen for it (renewals happen in the browser's cookie, not here). */
	private readonly liveExp = new Map<string, number>();
	private readonly sockets = new Set<TrackedSocket>();
	private sweeper: NodeJS.Timeout | null = null;
	private pending = 0;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly ctx: Pick<ServerContext, "db" | "secrets" | "network" | "config" | "identity">,
		options: { limiter?: LimiterOptions } = {},
	) {
		this.limiter = new LoginLimiter(options.limiter);
		this.revoked = new Map(Object.entries(this.readJson<Record<string, number>>(KEY_REVOKED) ?? {}).filter(([, until]) => typeof until === "number"));
	}

	// ---------------------------------------------------------------------------------------------- stored state

	private readRow(key: string): string | null {
		return this.ctx.db.select().from(settings).where(eq(settings.key, key)).get()?.value ?? null;
	}

	private writeRow(key: string, value: string): void {
		const updatedAt = new Date().toISOString();
		this.ctx.db.insert(settings).values({ key, value, updatedAt }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt } }).run();
	}

	private readJson<T>(key: string): T | null {
		const raw = this.readRow(key);
		if (raw === null) return null;
		try {
			return JSON.parse(raw) as T;
		} catch {
			return null;
		}
	}

	passwordSet(): boolean {
		return this.readRow(KEY_PASSWORD) !== null;
	}

	config(): AccessConfig {
		const stored = this.readJson<Partial<AccessConfig>>(KEY_CONFIG) ?? {};
		const ttl = stored.sessionTtlHours;
		return {
			remoteUiEnabled: stored.remoteUiEnabled === true,
			sessionTtlHours: typeof ttl === "number" && Number.isInteger(ttl) && ttl >= 1 && ttl <= 24 * 7 ? ttl : DEFAULT_TTL_HOURS,
		};
	}

	private epoch(): number {
		const value = Number(this.readRow(KEY_EPOCH) ?? 0);
		return Number.isSafeInteger(value) && value >= 0 ? value : 0;
	}

	private bumpEpoch(): void {
		this.writeRow(KEY_EPOCH, String(this.epoch() + 1));
		this.liveExp.clear();
	}

	private signingKey(): Promise<Buffer> {
		this.keyPromise ??= (async () => {
			const stored = await this.ctx.secrets.get(SECRET_SIGNING_KEY);
			if (stored) {
				const key = Buffer.from(stored, "base64url");
				if (key.length >= 32) return key;
			}
			const fresh = randomBytes(32);
			await this.ctx.secrets.set(SECRET_SIGNING_KEY, fresh.toString("base64url"));
			return fresh;
		})().catch((error) => {
			this.keyPromise = null;
			throw error;
		});
		return this.keyPromise;
	}

	// ---------------------------------------------------------------------------------------------- origins

	/** The origins a browser may legitimately have when it talks to the public listener (CSRF / WS-upgrade check). */
	publicOrigins(): string[] {
		const origins: string[] = [];
		const host = this.ctx.network.tunnel.publicHostname();
		if (host) origins.push(`https://${host}`);
		if (this.ctx.config.allowLoopbackPeers && this.ctx.config.networkPort > 0) {
			for (const name of LOOPBACK_ORIGIN_HOSTS) origins.push(`http://${name}:${this.ctx.config.networkPort}`);
		}
		return origins;
	}

	originAllowed(origin: string | undefined): boolean {
		if (origin === undefined) return false;
		let normalized: string;
		try {
			normalized = new URL(origin).origin;
		} catch {
			return false;
		}
		return this.publicOrigins().includes(normalized);
	}

	// ---------------------------------------------------------------------------------------------- password

	/**
	 * Check `password` for `client`, throttled. Resolves whether it matched (failures are recorded); rejects with 429 when the
	 * client or the whole node is locked out or too many checks are already waiting. Costs the same whether or not a password exists.
	 */
	async verifyOwnerPassword(client: string, password: string): Promise<boolean> {
		const verdict = this.limiter.check(client);
		if (!verdict.allowed) throw rateLimited(verdict.retryAfterSeconds);
		if (this.pending >= MAX_PENDING_VERIFICATIONS) throw rateLimited(1);
		this.pending += 1;
		try {
			const stored = this.readRow(KEY_PASSWORD);
			const run = this.queue.then(async () => {
				const matched = await verifyPassword(password, stored ?? (await dummyHash()));
				return stored !== null && matched;
			});
			this.queue = run.catch(() => undefined);
			const ok = await run;
			if (ok) this.limiter.success(client);
			else this.limiter.failure(client);
			return ok;
		} finally {
			this.pending -= 1;
		}
	}

	/** Store a new owner password and end every remote session (the epoch moves). */
	async setPassword(password: string): Promise<void> {
		this.writeRow(KEY_PASSWORD, await hashPassword(password));
		this.bumpEpoch();
		this.closeSockets(() => true);
	}

	updateConfig(body: z.infer<typeof UpdateAccessBody>): void {
		const current = this.config();
		const next: AccessConfig = { remoteUiEnabled: body.remoteUiEnabled ?? current.remoteUiEnabled, sessionTtlHours: body.sessionTtlHours ?? current.sessionTtlHours };
		if (next.remoteUiEnabled && !this.passwordSet()) {
			throw new ApiError(409, "password_required", "Set an owner password before enabling remote access to the UI");
		}
		this.writeRow(KEY_CONFIG, JSON.stringify(next));
		if (current.remoteUiEnabled && !next.remoteUiEnabled) {
			// Turning the door off also ends every session behind it: re-enabling later starts from a clean slate.
			this.bumpEpoch();
			this.closeSockets(() => true);
		}
	}

	// ---------------------------------------------------------------------------------------------- sessions

	private mint(claims: SessionClaims, key: Buffer, now: number): IssuedSession {
		return { claims, token: signToken(key, claims), maxAgeSeconds: Math.max(0, Math.floor((claims.exp - now) / 1000)) };
	}

	/** A fresh session (login, or after a password change by the signed-in owner). */
	async startSession(): Promise<IssuedSession> {
		const key = await this.signingKey();
		const now = Date.now();
		const exp = Math.min(now + this.config().sessionTtlHours * 3_600_000, now + MAX_SESSION_MS);
		const claims: SessionClaims = { sid: randomBytes(16).toString("hex"), iat: now, ren: now, exp, epoch: this.epoch() };
		this.noteExpiry(claims.sid, exp);
		return this.mint(claims, key, now);
	}

	/** Remember the latest expiry seen for a session; forget the ones already over so this never grows without bound. */
	private noteExpiry(sid: string, exp: number): void {
		this.liveExp.set(sid, Math.max(this.liveExp.get(sid) ?? 0, exp));
		if (this.liveExp.size <= 512) return;
		const now = Date.now();
		for (const [other, until] of this.liveExp) if (until <= now) this.liveExp.delete(other);
	}

	private valid(claims: SessionClaims, now: number): boolean {
		return claims.exp > now && claims.iat <= now + 60_000 && claims.iat + MAX_SESSION_MS > now && claims.epoch === this.epoch() && !this.revoked.has(claims.sid);
	}

	/**
	 * The session behind a `Cookie` header, or null (absent, tampered, expired, from before a `logout-all`, logged out).
	 * `renewed` carries the re-issued cookie when the sliding expiry moved; the caller sends it.
	 */
	async authenticate(cookieHeader: string | undefined): Promise<{ claims: SessionClaims; renewed: IssuedSession | null } | null> {
		const raw = sessionCookieValue(cookieHeader);
		if (!raw || !this.passwordSet()) return null;
		const key = await this.signingKey();
		const claims = verifyToken(key, raw);
		const now = Date.now();
		if (!claims || !this.valid(claims, now)) return null;
		if (now - claims.ren < RENEW_AFTER_MS) {
			this.noteExpiry(claims.sid, claims.exp);
			return { claims, renewed: null };
		}
		const exp = Math.min(now + this.config().sessionTtlHours * 3_600_000, claims.iat + MAX_SESSION_MS);
		const renewed = this.mint({ ...claims, ren: now, exp }, key, now);
		this.noteExpiry(claims.sid, exp);
		return { claims: renewed.claims, renewed };
	}

	/** End one session: its cookie is dead from now on (even if copied) and its WebSockets close. */
	logout(claims: SessionClaims): void {
		const now = Date.now();
		for (const [sid, until] of this.revoked) if (until <= now) this.revoked.delete(sid);
		this.revoked.set(claims.sid, claims.iat + MAX_SESSION_MS);
		this.writeRow(KEY_REVOKED, JSON.stringify(Object.fromEntries(this.revoked)));
		this.liveExp.delete(claims.sid);
		this.closeSockets((tracked) => tracked.claims.sid === claims.sid);
	}

	/** End every remote session. */
	logoutAll(): void {
		this.bumpEpoch();
		this.closeSockets(() => true);
	}

	// ---------------------------------------------------------------------------------------------- live sockets

	/** Register a remote WebSocket so it ends with its session. Returns the unregister function. */
	trackSocket(claims: SessionClaims, close: () => void): () => void {
		const tracked: TrackedSocket = { claims, close };
		this.sockets.add(tracked);
		this.sweeper ??= setInterval(() => this.sweepSockets(), SOCKET_SWEEP_MS).unref();
		return () => {
			this.sockets.delete(tracked);
			this.stopSweeperWhenIdle();
		};
	}

	private closeSockets(which: (tracked: TrackedSocket) => boolean): void {
		for (const tracked of [...this.sockets]) {
			if (!which(tracked)) continue;
			this.sockets.delete(tracked);
			tracked.close();
		}
		this.stopSweeperWhenIdle();
	}

	private sweepSockets(): void {
		const now = Date.now();
		const enabled = this.config().remoteUiEnabled;
		this.closeSockets((tracked) => !enabled || !this.valid({ ...tracked.claims, exp: Math.max(tracked.claims.exp, this.liveExp.get(tracked.claims.sid) ?? 0) }, now));
		for (const [sid, exp] of this.liveExp) if (exp <= now) this.liveExp.delete(sid);
	}

	private stopSweeperWhenIdle(): void {
		if (this.sockets.size > 0 || !this.sweeper) return;
		clearInterval(this.sweeper);
		this.sweeper = null;
	}

	// ---------------------------------------------------------------------------------------------- status

	status(access: RequestAccess): AccessStatus {
		const config = this.config();
		const remote = access.via === "remote";
		return {
			nodeName: readNodeSettings(this.ctx.db).nodeName,
			fingerprint: this.ctx.identity.fingerprint,
			passwordSet: this.passwordSet(),
			remoteUiEnabled: config.remoteUiEnabled,
			publicUiUrl: config.remoteUiEnabled ? this.ctx.network.tunnel.publicUrl() : null,
			via: access.via,
			signedIn: remote ? access.session !== null : true,
			sessionExpiresAt: remote && access.session ? new Date(access.session.exp).toISOString() : null,
			sessionTtlHours: config.sessionTtlHours,
		};
	}
}
