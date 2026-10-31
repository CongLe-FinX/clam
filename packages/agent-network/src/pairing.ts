import { createHmac, hkdfSync, randomBytes } from "node:crypto";
import { verifySignature } from "@clam/node-identity";
import { constantTimeEqual, fromBase64Url, frame, publicKeyToWire, sha256, toBase64Url } from "./encoding.ts";
import { ERROR_CODES, NetworkError } from "./errors.ts";
import type { Signer } from "./signing.ts";
import { CROCKFORD_ALPHABET } from "./ulid.ts";

/**
 * Pairing cryptography (docs/agent-network-protocol.md §11). The invitation code is 8 Crockford
 * base32 symbols = exactly 40 bits, displayed `XXXX-XXXX`. It is never sent: both sides derive
 * `codeKey = HKDF-SHA256(code, salt = invitationId, info = "clam-pair-v1")` and exchange HMAC proofs.
 */

export const INVITATION_CODE_LENGTH = 8;
const HKDF_INFO = "clam-pair-v1";
const CODE_PATTERN = new RegExp(`^[${CROCKFORD_ALPHABET}]{${INVITATION_CODE_LENGTH}}$`);

/** A fresh invitation code in display form `ABCD-EFGH` (40 bits from the OS CSPRNG). */
export function generateInvitationCode(): string {
	const bits = randomBytes(5);
	let value = (BigInt(bits[0] as number) << 32n) | (BigInt(bits[1] as number) << 24n) | (BigInt(bits[2] as number) << 16n) | (BigInt(bits[3] as number) << 8n) | BigInt(bits[4] as number);
	let compact = "";
	for (let i = 0; i < INVITATION_CODE_LENGTH; i++) {
		compact = CROCKFORD_ALPHABET[Number(value & 31n)] + compact;
		value >>= 5n;
	}
	return formatInvitationCode(compact);
}

/** `ABCD1234` → `ABCD-1234`. */
export function formatInvitationCode(compact: string): string {
	return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

/**
 * Canonical (compact, upper-case) form of what a user typed: case-insensitive, separators
 * (dashes, spaces, underscores, dots) ignored, Crockford confusables folded (`O`→`0`, `I`/`L`→`1`).
 * Throws `NetworkError(invalid_request)` unless the result is exactly 8 valid symbols.
 */
export function normalizeInvitationCode(input: string): string {
	const folded = input
		.toUpperCase()
		.replace(/[\s\-_.]/g, "")
		.replace(/O/g, "0")
		.replace(/[IL]/g, "1");
	if (!CODE_PATTERN.test(folded)) throw new NetworkError("invalid invitation code", { code: ERROR_CODES.invalidRequest });
	return folded;
}

/** Deterministic invitation id both sides can derive from the code alone (the joiner only knows URL + code). */
export function invitationIdFromCode(code: string): string {
	return `inv_${sha256(`clam-invitation-id-v1\0${normalizeInvitationCode(code)}`).toString("hex").slice(0, 24)}`;
}

/** What the inviter may persist instead of the code (hex SHA-256, domain separated, bound to the invitation). */
export function hashInvitationCode(code: string, invitationId: string): string {
	return sha256(`clam-invitation-code-v1\0${invitationId}\0${normalizeInvitationCode(code)}`).toString("hex");
}

export function deriveCodeKey(code: string, invitationId: string): Uint8Array {
	const key = hkdfSync("sha256", Buffer.from(normalizeInvitationCode(code), "utf8"), Buffer.from(invitationId, "utf8"), Buffer.from(HKDF_INFO, "utf8"), 32);
	return new Uint8Array(key);
}

export type ProofRole = "hello" | "reply";

function proofMac(codeKey: Uint8Array, role: ProofRole, parts: readonly string[]): Buffer {
	return createHmac("sha256", codeKey)
		.update(frame(["clam-pair-proof-v1", role, ...parts]))
		.digest();
}

/** HMAC-SHA256 proof of code possession over `role` and `parts`, base64url. */
export function pairingProof(codeKey: Uint8Array, role: ProofRole, parts: string[]): string {
	return toBase64Url(proofMac(codeKey, role, parts));
}

/** Constant-time check of a proof; malformed proofs are simply false. */
export function verifyPairingProof(codeKey: Uint8Array, role: ProofRole, parts: string[], proof: string): boolean {
	const received = fromBase64Url(proof);
	if (received === null || received.length !== 32) return false;
	return constantTimeEqual(received, proofMac(codeKey, role, parts));
}

/** Parts of the joiner's `hello` proof: binds both ids, the joiner's key and its nonce. */
export function helloProofParts(t: { invitationId: string; inviterId: string; joinerId: string; joinerPub: string; nonceJoiner: string }): string[] {
	return [t.invitationId, t.inviterId, t.joinerId, publicKeyToWire(t.joinerPub), t.nonceJoiner];
}

/** Parts of the inviter's `reply` proof: binds the whole hello plus the inviter's key and nonce. */
export function replyProofParts(t: {
	invitationId: string;
	inviterId: string;
	inviterPub: string;
	joinerId: string;
	joinerPub: string;
	nonceJoiner: string;
	nonceInviter: string;
}): string[] {
	return [t.invitationId, t.inviterId, publicKeyToWire(t.inviterPub), t.joinerId, publicKeyToWire(t.joinerPub), t.nonceJoiner, t.nonceInviter];
}

export interface PairingTranscript {
	inviterId: string;
	inviterPub: string;
	joinerId: string;
	joinerPub: string;
	nonceInviter: string;
	nonceJoiner: string;
	invitationId: string;
	/** Capabilities the inviter grants (order and duplicates do not matter). */
	capabilities: string[];
}

/** SHA-256 over every transcript field (length-prefixed, keys in their canonical wire encoding, capabilities sorted and de-duplicated). */
export function transcriptHash(t: PairingTranscript): Uint8Array {
	const capabilities = [...new Set(t.capabilities)].sort();
	return new Uint8Array(
		sha256(
			frame([
				"clam-pair-transcript-v1",
				t.inviterId,
				publicKeyToWire(t.inviterPub),
				t.joinerId,
				publicKeyToWire(t.joinerPub),
				t.nonceInviter,
				t.nonceJoiner,
				t.invitationId,
				JSON.stringify(capabilities),
			]),
		),
	);
}

const TRANSCRIPT_SIGNATURE_DOMAIN = Buffer.from("CLAM-PAIR-SIG-V1\0", "utf8");

function transcriptMessage(hash: Uint8Array): Buffer {
	return Buffer.concat([TRANSCRIPT_SIGNATURE_DOMAIN, hash]);
}

/** Ed25519 signature (base64url) by the node key over the transcript hash. */
export function signTranscript(signer: Signer, hash: Uint8Array): string {
	return toBase64Url(signer.sign(transcriptMessage(hash)));
}

export function verifyTranscript(publicKey: string, hash: Uint8Array, signature: string): boolean {
	const sig = fromBase64Url(signature);
	if (sig === null) return false;
	try {
		return verifySignature({ publicKey: Buffer.from(publicKeyToWire(publicKey), "base64url").toString("base64"), message: transcriptMessage(hash), signature: Buffer.from(sig).toString("base64") });
	} catch {
		return false;
	}
}

/** 128-bit random handshake nonce, base64url. */
export function generatePairingNonce(): string {
	return toBase64Url(randomBytes(16));
}
