/**
 * `@clam/agent-network`: the node-to-node protocol (`/api/v1`) of CL Agent Mesh — request signing and
 * verification, pairing cryptography, SSE framing, the HTTPS client and the wire schemas.
 * Specification: docs/agent-network-protocol.md.
 */
export { NetworkClient, backoffDelayMs, parseRetryAfter, DEFAULT_RETRY, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_RESPONSE_BYTES, DEFAULT_STREAM_IDLE_MS } from "./client.ts";
export type { EventsOptions, NetworkClientOptions, RequestOptions, RequestResult, RetryPolicy } from "./client.ts";
export {
	constantTimeEqual,
	decodePublicKey,
	fromBase64Url,
	isValidPublicKey,
	publicKeyToBase64,
	publicKeyToWire,
	toBase64Url,
} from "./encoding.ts";
export { CLIENT_ERROR_CODES, ERROR_CODES, NetworkError, errorBody } from "./errors.ts";
export type { NetworkErrorInit } from "./errors.ts";
export {
	INVITATION_CODE_LENGTH,
	deriveCodeKey,
	formatInvitationCode,
	generateInvitationCode,
	generatePairingNonce,
	hashInvitationCode,
	helloProofParts,
	invitationIdFromCode,
	normalizeInvitationCode,
	pairingProof,
	replyProofParts,
	signTranscript,
	transcriptHash,
	verifyPairingProof,
	verifyTranscript,
} from "./pairing.ts";
export type { PairingTranscript, ProofRole } from "./pairing.ts";
export { SSE_KEEPALIVE, SseParser, decodeCursor, encodeCursor, encodeSseComment, encodeSseEvent } from "./sse.ts";
export type { SseFrame } from "./sse.ts";
export {
	API_PREFIX,
	FORMAT,
	HEADER,
	KEY_ID_LENGTH,
	PROTOCOL_VERSION,
	SIGNATURE_SCHEME,
	canonicalQuery,
	canonicalString,
	contentDigest,
	hostOf,
	isMutatingMethod,
	keyIdOfFingerprint,
	normalizeHost,
	signRequest,
	signerFromIdentity,
} from "./signing.ts";
export type { CanonicalFields, SignRequestInput, Signer } from "./signing.ts";
export { ulid } from "./ulid.ts";
export { hasCapabilities, isAllowedPeerUrl, normalizePeerUrl } from "./urls.ts";
export { DEFAULT_SKEW_MS, MemoryNonceStore, verifyRequest } from "./verify.ts";
export type { NonceStore, PeerKey, VerifyDeps, VerifyInput, VerifyResult } from "./verify.ts";
export * as wire from "./wire.ts";
