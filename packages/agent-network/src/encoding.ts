import { createHash, timingSafeEqual } from "node:crypto";

const BASE64URL_ALPHABET = /^[A-Za-z0-9_-]*$/;
const ANY_BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

export function toBase64Url(bytes: Uint8Array): string {
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64url");
}

/**
 * Strict base64url (no padding, canonical): returns null unless `text` is exactly what
 * {@link toBase64Url} would produce, so one byte string has one wire spelling.
 */
export function fromBase64Url(text: string): Uint8Array | null {
	if (!BASE64URL_ALPHABET.test(text)) return null;
	const bytes = Buffer.from(text, "base64url");
	return bytes.toString("base64url") === text ? bytes : null;
}

/**
 * Raw Ed25519 public key from either base64 (what `@clam/node-identity` stores) or base64url (the
 * wire form, protocol §2). Returns null unless the canonical encoding of exactly 32 bytes.
 */
export function decodePublicKey(input: string): Uint8Array | null {
	if (!ANY_BASE64.test(input)) return null;
	const raw = Buffer.from(input, "base64");
	if (raw.length !== 32) return null;
	const spelled = input.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
	return raw.toString("base64url") === spelled ? raw : null;
}

export function isValidPublicKey(input: string): boolean {
	return decodePublicKey(input) !== null;
}

/** Wire form (base64url, no padding) of a public key given as base64 or base64url. */
export function publicKeyToWire(publicKey: string): string {
	const raw = decodePublicKey(publicKey);
	if (!raw) throw new TypeError("not a canonical base64/base64url Ed25519 public key");
	return toBase64Url(raw);
}

/** Standard base64 form (as `@clam/node-identity` exchanges keys) of a public key in either encoding. */
export function publicKeyToBase64(publicKey: string): string {
	const raw = decodePublicKey(publicKey);
	if (!raw) throw new TypeError("not a canonical base64/base64url Ed25519 public key");
	return Buffer.from(raw).toString("base64");
}

export function sha256(data: Uint8Array | string): Buffer {
	return createHash("sha256").update(data).digest();
}

/** Constant-time equality; unequal lengths are simply unequal. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) return false;
	return timingSafeEqual(a, b);
}

/**
 * Unambiguous concatenation: each part is prefixed by its 32-bit big-endian byte length, so no
 * choice of part contents can shift a boundary (the HMAC/transcript analogue of `a|b|c`).
 */
export function frame(parts: ReadonlyArray<string | Uint8Array>): Buffer {
	const chunks: Buffer[] = [];
	for (const part of parts) {
		const bytes = typeof part === "string" ? Buffer.from(part, "utf8") : Buffer.from(part.buffer, part.byteOffset, part.byteLength);
		const length = Buffer.alloc(4);
		length.writeUInt32BE(bytes.length);
		chunks.push(length, bytes);
	}
	return Buffer.concat(chunks);
}
