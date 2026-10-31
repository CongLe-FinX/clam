import { verifySignature } from "@clam/node-identity";
import { constantTimeEqual, fromBase64Url, publicKeyToBase64, sha256 } from "./encoding.ts";
import { ERROR_CODES } from "./errors.ts";
import { canonicalString, FORMAT, HEADER, isMutatingMethod, PROTOCOL_VERSION, type CanonicalFields } from "./signing.ts";

export const DEFAULT_SKEW_MS = 60_000;

/** The pinned key of a paired peer. `revoked` peers are refused before anything else is checked. */
export interface PeerKey {
	nodeId: string;
	/** First 16 hex chars of the pinned key's fingerprint. */
	keyId: string;
	/** Raw 32-byte Ed25519 public key, base64 or base64url. */
	publicKey: string;
	revoked: boolean;
}

/**
 * Replay window store. `checkAndRemember` atomically records `(peerId, nonce)` until `expiresAtMs`
 * and returns false when it was already recorded (and not yet expired).
 */
export interface NonceStore {
	checkAndRemember(peerId: string, nonce: string, expiresAtMs: number): boolean | Promise<boolean>;
}

export interface VerifyInput {
	method: string;
	/** Request path as received, without the query, e.g. `/api/v1/agents`. */
	path: string;
	/** Raw query string as received (with or without the leading `?`). */
	rawQuery: string;
	/** Host the request was addressed to (the `Host` header). */
	host: string;
	headers: Record<string, string | string[] | undefined>;
	/** Exact body bytes as received. */
	bodyBytes: Uint8Array;
}

export type VerifyResult =
	| { ok: true; peerId: string; requestId: string; correlationId: string; idempotencyKey: string | null }
	| { ok: false; status: number; code: string; message: string; details?: unknown };

export interface VerifyDeps {
	lookupPeer(nodeId: string): PeerKey | null | Promise<PeerKey | null>;
	nonces: NonceStore;
	now?: () => number;
	/** Allowed clock difference in ms (default 60 000; protocol allows 30 000–300 000). */
	skewMs?: number;
	supportedVersions?: number[];
}

const SECURITY_HEADERS = [
	HEADER.version,
	HEADER.nodeId,
	HEADER.keyId,
	HEADER.timestamp,
	HEADER.nonce,
	HEADER.requestId,
	HEADER.correlationId,
	HEADER.idempotencyKey,
	HEADER.contentDigest,
	HEADER.signature,
] as const;

function fail(status: number, code: string, message: string, details?: unknown): VerifyResult {
	return details === undefined ? { ok: false, status, code, message } : { ok: false, status, code, message, details };
}

type Collected = { ok: true; values: Map<string, string> } | { ok: false; header: string };

/** Case-insensitive collection of the security headers; any header present twice is a failure. */
function collectSecurityHeaders(headers: VerifyInput["headers"]): Collected {
	const values = new Map<string, string>();
	for (const [rawName, rawValue] of Object.entries(headers)) {
		const lower = rawName.toLowerCase();
		const name = SECURITY_HEADERS.find((candidate) => candidate.toLowerCase() === lower);
		if (name === undefined || rawValue === undefined) continue;
		let value: string;
		if (Array.isArray(rawValue)) {
			if (rawValue.length > 1) return { ok: false, header: name };
			if (rawValue.length === 0) continue;
			value = rawValue[0] as string;
		} else {
			value = rawValue;
		}
		if (values.has(name)) return { ok: false, header: name };
		values.set(name, value);
	}
	return { ok: true, values };
}

/**
 * Verify one inbound request against protocol §3, in the specified order:
 * duplicated headers → version → header syntax → peer / key id → clock skew → replay → digest →
 * signature → idempotency key. Steps 7–8 (authorization, rate limiting) belong to the caller, which
 * receives `peerId` on success.
 */
export async function verifyRequest(input: VerifyInput, deps: VerifyDeps): Promise<VerifyResult> {
	const now = deps.now ?? Date.now;
	const skewMs = deps.skewMs ?? DEFAULT_SKEW_MS;
	const supportedVersions = deps.supportedVersions ?? [PROTOCOL_VERSION];

	const collected = collectSecurityHeaders(input.headers);
	if (!collected.ok) return fail(400, ERROR_CODES.invalidRequest, `duplicated header ${collected.header}`);
	const h = collected.values;

	// 1. Protocol version.
	const versionText = h.get(HEADER.version);
	if (versionText === undefined || !FORMAT.version.test(versionText) || !supportedVersions.includes(Number(versionText))) {
		return fail(426, ERROR_CODES.unsupportedVersion, "unsupported protocol version", { supportedVersions });
	}

	// Syntax of everything else (cheap, stateless).
	const need = (name: string, pattern: RegExp): string | null => {
		const value = h.get(name);
		return value !== undefined && pattern.test(value) ? value : null;
	};
	const nodeId = need(HEADER.nodeId, FORMAT.nodeId);
	const keyId = need(HEADER.keyId, FORMAT.keyId);
	const timestampText = need(HEADER.timestamp, FORMAT.timestamp);
	const nonce = need(HEADER.nonce, FORMAT.nonce);
	const requestId = need(HEADER.requestId, FORMAT.id);
	const correlationId = need(HEADER.correlationId, FORMAT.id);
	const digestHeader = need(HEADER.contentDigest, FORMAT.contentDigest);
	const signatureText = need(HEADER.signature, FORMAT.signature);
	const idempotencyKeyText = h.get(HEADER.idempotencyKey);
	const required: Array<[string, string | null]> = [
		[HEADER.nodeId, nodeId],
		[HEADER.keyId, keyId],
		[HEADER.timestamp, timestampText],
		[HEADER.nonce, nonce],
		[HEADER.requestId, requestId],
		[HEADER.correlationId, correlationId],
		[HEADER.contentDigest, digestHeader],
		[HEADER.signature, signatureText],
	];
	for (const [name, value] of required) {
		if (value === null) return fail(400, ERROR_CODES.invalidRequest, `missing or malformed header ${name}`);
	}
	if (idempotencyKeyText !== undefined && !FORMAT.idempotencyKey.test(idempotencyKeyText)) {
		return fail(400, ERROR_CODES.invalidRequest, `malformed header ${HEADER.idempotencyKey}`);
	}
	if (!input.path.startsWith("/") || input.host.trim() === "") {
		return fail(400, ERROR_CODES.invalidRequest, "malformed request target");
	}
	// Non-null: checked by the loop above.
	const nodeIdV = nodeId as string;
	const keyIdV = keyId as string;
	const nonceV = nonce as string;
	const timestamp = Number(timestampText);

	// 2. Paired, non-revoked peer; pinned key id.
	const peer = await deps.lookupPeer(nodeIdV);
	if (!peer) return fail(401, ERROR_CODES.unknownPeer, "sender is not a paired peer");
	if (peer.revoked) return fail(403, ERROR_CODES.peerRevoked, "peer has been revoked");
	if (peer.keyId !== keyIdV) return fail(401, ERROR_CODES.keyMismatch, "key id does not match the pinned key");

	// 3. Clock skew.
	const serverTime = now();
	if (Math.abs(serverTime - timestamp) > skewMs) {
		return fail(401, ERROR_CODES.clockSkew, "request timestamp is outside the allowed clock skew", { serverTime, maxSkewMs: skewMs });
	}

	// 4. Replay window (skew × 2): a request accepted at the edge of the skew window must stay rejected until its timestamp is stale.
	const fresh = await deps.nonces.checkAndRemember(peer.nodeId, nonceV, serverTime + skewMs * 2);
	if (!fresh) return fail(409, ERROR_CODES.replayedRequest, "nonce already used");

	// 5. Body digest.
	const received = Buffer.from((digestHeader as string).slice("sha-256=:".length, -1), "base64");
	if (!constantTimeEqual(received, sha256(input.bodyBytes))) {
		return fail(400, ERROR_CODES.digestMismatch, "Content-Digest does not match the request body");
	}

	// 6. Signature over the canonical string (constant-time; never says which field differed).
	const fields: CanonicalFields = {
		method: input.method,
		path: input.path,
		rawQuery: input.rawQuery,
		host: input.host,
		nodeId: nodeIdV,
		keyId: keyIdV,
		timestamp: timestampText as string,
		nonce: nonceV,
		requestId: requestId as string,
		correlationId: correlationId as string,
		idempotencyKey: idempotencyKeyText ?? null,
		contentDigest: digestHeader as string,
	};
	const signature = fromBase64Url(signatureText as string);
	let publicKey: string | null = null;
	try {
		publicKey = publicKeyToBase64(peer.publicKey);
	} catch {
		publicKey = null;
	}
	const valid =
		signature !== null &&
		publicKey !== null &&
		verifySignature({ publicKey, message: Buffer.from(canonicalString(fields), "utf8"), signature: Buffer.from(signature).toString("base64") });
	if (!valid) return fail(401, ERROR_CODES.badSignature, "signature verification failed");

	// Authenticated: the idempotency key is mandatory on mutating requests (protocol §6).
	if (isMutatingMethod(input.method) && idempotencyKeyText === undefined) {
		return fail(400, ERROR_CODES.invalidRequest, `${HEADER.idempotencyKey} is required on mutating requests`);
	}

	return {
		ok: true,
		peerId: peer.nodeId,
		requestId: requestId as string,
		correlationId: correlationId as string,
		idempotencyKey: idempotencyKeyText ?? null,
	};
}

/**
 * In-memory replay window with expiry pruning. ServerNet backs the same interface with SQLite
 * (`nonce_log`) so a restart cannot reopen the window; this one is for tests and single-process use.
 */
export class MemoryNonceStore implements NonceStore {
	readonly #seen = new Map<string, number>();
	readonly #now: () => number;
	#lastSweep = 0;

	constructor(options: { now?: () => number } = {}) {
		this.#now = options.now ?? Date.now;
	}

	checkAndRemember(peerId: string, nonce: string, expiresAtMs: number): boolean {
		const now = this.#now();
		this.#prune(now);
		const key = `${peerId}\n${nonce}`;
		const existing = this.#seen.get(key);
		if (existing !== undefined && existing > now) return false;
		// Re-insert so Map iteration order approximates expiry order for the cheap front-pruning above.
		this.#seen.delete(key);
		this.#seen.set(key, expiresAtMs);
		return true;
	}

	/** Entries currently remembered (after pruning). */
	get size(): number {
		this.#prune(this.#now());
		return this.#seen.size;
	}

	#prune(now: number): void {
		for (const [key, expiresAt] of this.#seen) {
			if (expiresAt > now) break;
			this.#seen.delete(key);
		}
		// Entries behind a longer-lived one are only reachable by a full sweep.
		if (now - this.#lastSweep >= 30_000) {
			this.#lastSweep = now;
			for (const [key, expiresAt] of this.#seen) if (expiresAt <= now) this.#seen.delete(key);
		}
	}
}
