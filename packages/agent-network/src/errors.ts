/**
 * Stable machine codes of the `/api/v1` error envelope (docs/agent-network-protocol.md §4) plus the
 * additive codes this implementation uses (protocol §13: new error codes are additive).
 */
export const ERROR_CODES = {
	invalidRequest: "invalid_request",
	unsupportedVersion: "unsupported_version",
	badSignature: "bad_signature",
	clockSkew: "clock_skew",
	replayedRequest: "replayed_request",
	keyMismatch: "key_mismatch",
	unknownPeer: "unknown_peer",
	peerRevoked: "peer_revoked",
	digestMismatch: "digest_mismatch",
	forbidden: "forbidden",
	notFound: "not_found",
	conflict: "conflict",
	idempotencyConflict: "idempotency_conflict",
	staleEpoch: "stale_epoch",
	rateLimited: "rate_limited",
	unavailable: "unavailable",
	internal: "internal",
} as const;

/** Codes raised on the client side only (never sent by a server). */
export const CLIENT_ERROR_CODES = {
	invalidPeerUrl: "invalid_peer_url",
	network: "network_error",
	timeout: "timeout",
	aborted: "aborted",
	invalidResponse: "invalid_response",
	responseTooLarge: "response_too_large",
	streamIdle: "stream_idle",
	streamError: "stream_error",
} as const;

export interface NetworkErrorInit {
	status?: number | null;
	code: string;
	retryable?: boolean;
	details?: unknown;
	/** Server-requested delay before the next attempt (`Retry-After`). */
	retryAfterMs?: number;
	/** Attempts made when the error was thrown by `NetworkClient.request`. */
	attempts?: number;
	cause?: unknown;
}

/**
 * A failed node-to-node call. `status` is the HTTP status or `null` when no response was received.
 * `code` is the server's `error.code` or one of {@link CLIENT_ERROR_CODES}; `retryable` follows the
 * protocol §7 table.
 */
export class NetworkError extends Error {
	readonly status: number | null;
	readonly code: string;
	readonly retryable: boolean;
	readonly details?: unknown;
	readonly retryAfterMs?: number;
	attempts?: number;

	constructor(message: string, init: NetworkErrorInit) {
		super(message, init.cause === undefined ? undefined : { cause: init.cause });
		this.name = "NetworkError";
		this.status = init.status ?? null;
		this.code = init.code;
		this.retryable = init.retryable ?? false;
		if (init.details !== undefined) this.details = init.details;
		if (init.retryAfterMs !== undefined) this.retryAfterMs = init.retryAfterMs;
		if (init.attempts !== undefined) this.attempts = init.attempts;
	}
}

/** The JSON error envelope: `{ error: { code, message, details? } }`. */
export function errorBody(code: string, message: string, details?: unknown): { error: { code: string; message: string; details?: unknown } } {
	return { error: details === undefined ? { code, message } : { code, message, details } };
}
