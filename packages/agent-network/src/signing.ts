import { randomBytes } from "node:crypto";
import { toBase64Url, sha256 } from "./encoding.ts";
import { ERROR_CODES, NetworkError } from "./errors.ts";
import { ulid } from "./ulid.ts";

/** Protocol version this implementation speaks (docs/agent-network-protocol.md §13). */
export const PROTOCOL_VERSION = 1;
/** URL prefix of the resource model; every signed path starts with it. */
export const API_PREFIX = "/api/v1";
/** First line of the canonical string; versioned independently of the resource model. */
export const SIGNATURE_SCHEME = "CLAM-SIG-V1";

export const HEADER = {
	version: "X-Clam-Version",
	nodeId: "X-Clam-Node-Id",
	keyId: "X-Clam-Key-Id",
	timestamp: "X-Clam-Timestamp",
	nonce: "X-Clam-Nonce",
	requestId: "X-Request-Id",
	correlationId: "X-Correlation-Id",
	idempotencyKey: "Idempotency-Key",
	contentDigest: "Content-Digest",
	signature: "X-Clam-Signature",
} as const;

/** Syntax of each security header value. None may contain a comma, so a comma-joined duplicate is detectable. */
export const FORMAT = {
	version: /^[0-9]{1,4}$/,
	nodeId: /^[A-Za-z0-9_-]{1,64}$/,
	keyId: /^[0-9a-f]{16}$/,
	timestamp: /^[0-9]{1,15}$/,
	nonce: /^[A-Za-z0-9_-]{16,64}$/,
	id: /^[A-Za-z0-9_.:-]{1,128}$/,
	idempotencyKey: /^[A-Za-z0-9._:~@/+=-]{1,128}$/,
	contentDigest: /^sha-256=:([A-Za-z0-9+/]{43}=):$/,
	signature: /^[A-Za-z0-9_-]{86}$/,
} as const;

/** Signs on behalf of one node: its id, the id of the signing key and the raw Ed25519 signing primitive. */
export interface Signer {
	nodeId: string;
	/** First 16 hex chars of the key fingerprint. */
	keyId: string;
	/** Raw 32-byte public key, base64 (as in `@clam/node-identity`). */
	publicKey: string;
	sign(data: Uint8Array): Uint8Array;
}

export const KEY_ID_LENGTH = 16;

export function keyIdOfFingerprint(fingerprint: string): string {
	return fingerprint.slice(0, KEY_ID_LENGTH);
}

export function signerFromIdentity(identity: {
	nodeId: string;
	fingerprint: string;
	publicKey: string;
	sign(message: Uint8Array): string;
}): Signer {
	return {
		nodeId: identity.nodeId,
		keyId: keyIdOfFingerprint(identity.fingerprint),
		publicKey: identity.publicKey,
		sign: (data) => Buffer.from(identity.sign(data), "base64"),
	};
}

export function isMutatingMethod(method: string): boolean {
	const m = method.toUpperCase();
	return m !== "GET" && m !== "HEAD" && m !== "OPTIONS";
}

/** `sha-256=:<base64>:` of the exact bytes (RFC 9530 style). Empty bodies digest the empty string. */
export function contentDigest(bytes: Uint8Array): string {
	return `sha-256=:${sha256(bytes).toString("base64")}:`;
}

/**
 * Host as bound into the signature: lower-case with the default ports (`:443`, `:80`) dropped, so
 * `Example.COM:443` and `example.com` sign identically. Both sides apply this to what they see.
 */
export function normalizeHost(host: string): string {
	return host.trim().toLowerCase().replace(/:(443|80)$/, "");
}

/** The exact host string {@link signRequest} binds for a URL (lower-case, default ports omitted). */
export function hostOf(url: string | URL): string {
	return normalizeHost(new URL(url).host);
}

const HEX = /^[0-9A-Fa-f]{2}$/;

/** Percent-decode what is decodable (invalid escapes stay literal `%`), then RFC 3986-encode every byte outside the unreserved set. `+` is NOT a space. */
function normalizeQueryComponent(component: string): string {
	const bytes = Buffer.from(component, "utf8");
	let out = "";
	for (let i = 0; i < bytes.length; i++) {
		let byte = bytes[i] as number;
		if (byte === 0x25 && i + 2 < bytes.length) {
			const escape = String.fromCharCode(bytes[i + 1] as number, bytes[i + 2] as number);
			if (HEX.test(escape)) {
				byte = Number.parseInt(escape, 16);
				i += 2;
			}
		}
		const isUnreserved =
			(byte >= 0x30 && byte <= 0x39) ||
			(byte >= 0x41 && byte <= 0x5a) ||
			(byte >= 0x61 && byte <= 0x7a) ||
			byte === 0x2d ||
			byte === 0x2e ||
			byte === 0x5f ||
			byte === 0x7e;
		out += isUnreserved ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
	}
	return out;
}

/**
 * Query string as signed: `key=value` pairs, each percent-normalized (RFC 3986), sorted by key then
 * value (byte order of the encoded form), joined with `&`. Duplicated keys are kept. A leading `?` is
 * ignored; the empty query is the empty string.
 */
export function canonicalQuery(rawQuery: string): string {
	const query = rawQuery.startsWith("?") ? rawQuery.slice(1) : rawQuery;
	if (query === "") return "";
	const pairs: Array<[string, string]> = [];
	for (const part of query.split("&")) {
		if (part === "") continue;
		const eq = part.indexOf("=");
		const key = eq === -1 ? part : part.slice(0, eq);
		const value = eq === -1 ? "" : part.slice(eq + 1);
		pairs.push([normalizeQueryComponent(key), normalizeQueryComponent(value)]);
	}
	pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
	return pairs.map(([key, value]) => `${key}=${value}`).join("&");
}

export interface CanonicalFields {
	method: string;
	path: string;
	/** Raw query (as received/sent); canonicalized here. */
	rawQuery: string;
	host: string;
	nodeId: string;
	keyId: string;
	timestamp: string;
	nonce: string;
	requestId: string;
	correlationId: string;
	idempotencyKey: string | null;
	contentDigest: string;
}

/** The exact bytes covered by `X-Clam-Signature` (protocol §3). */
export function canonicalString(f: CanonicalFields): string {
	return [
		SIGNATURE_SCHEME,
		f.method.toUpperCase(),
		f.path,
		canonicalQuery(f.rawQuery),
		normalizeHost(f.host),
		f.nodeId,
		f.keyId,
		f.timestamp,
		f.nonce,
		f.requestId,
		f.correlationId,
		f.idempotencyKey ?? "",
		f.contentDigest,
	].join("\n");
}

export interface SignRequestInput {
	method: string;
	/** Absolute URL of the request, including the `/api/v1` prefix and any query. */
	url: string;
	bodyBytes: Uint8Array;
	/** Required for mutating methods (protocol §6). */
	idempotencyKey?: string;
	correlationId?: string;
	requestId?: string;
	/** Sender clock in ms; defaults to `Date.now()`. */
	now?: number;
}

function requireFormat(name: string, value: string, pattern: RegExp): void {
	if (!pattern.test(value)) throw new NetworkError(`invalid ${name}`, { code: ERROR_CODES.invalidRequest });
}

/**
 * Headers for one request ATTEMPT: fresh nonce, request id and timestamp every call. The caller must
 * send exactly `bodyBytes` as the body and `new URL(url).host` as the host.
 */
export function signRequest(signer: Signer, req: SignRequestInput): Record<string, string> {
	const url = new URL(req.url);
	const method = req.method.toUpperCase();
	if (isMutatingMethod(method) && !req.idempotencyKey) {
		throw new NetworkError("Idempotency-Key is required on mutating requests", { code: ERROR_CODES.invalidRequest });
	}
	if (req.idempotencyKey !== undefined) requireFormat(HEADER.idempotencyKey, req.idempotencyKey, FORMAT.idempotencyKey);
	const requestId = req.requestId ?? ulid();
	const correlationId = req.correlationId ?? ulid();
	requireFormat(HEADER.requestId, requestId, FORMAT.id);
	requireFormat(HEADER.correlationId, correlationId, FORMAT.id);
	requireFormat(HEADER.nodeId, signer.nodeId, FORMAT.nodeId);
	requireFormat(HEADER.keyId, signer.keyId, FORMAT.keyId);

	const timestamp = String(Math.trunc(req.now ?? Date.now()));
	const nonce = toBase64Url(randomBytes(16));
	const digest = contentDigest(req.bodyBytes);
	const canonical = canonicalString({
		method,
		path: url.pathname,
		rawQuery: url.search,
		host: url.host,
		nodeId: signer.nodeId,
		keyId: signer.keyId,
		timestamp,
		nonce,
		requestId,
		correlationId,
		idempotencyKey: req.idempotencyKey ?? null,
		contentDigest: digest,
	});
	const signature = toBase64Url(signer.sign(Buffer.from(canonical, "utf8")));

	const headers: Record<string, string> = {
		[HEADER.version]: String(PROTOCOL_VERSION),
		[HEADER.nodeId]: signer.nodeId,
		[HEADER.keyId]: signer.keyId,
		[HEADER.timestamp]: timestamp,
		[HEADER.nonce]: nonce,
		[HEADER.requestId]: requestId,
		[HEADER.correlationId]: correlationId,
		[HEADER.contentDigest]: digest,
		[HEADER.signature]: signature,
	};
	if (req.idempotencyKey !== undefined) headers[HEADER.idempotencyKey] = req.idempotencyKey;
	return headers;
}
