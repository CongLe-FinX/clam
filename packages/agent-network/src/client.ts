import { constantTimeEqual, sha256 } from "./encoding.ts";
import { CLIENT_ERROR_CODES, ERROR_CODES, NetworkError } from "./errors.ts";
import { API_PREFIX, contentDigest, FORMAT, HEADER, isMutatingMethod, PROTOCOL_VERSION, signRequest, type Signer } from "./signing.ts";
import { SseParser } from "./sse.ts";
import { ulid } from "./ulid.ts";
import { normalizePeerUrl } from "./urls.ts";
import { ApiErrorBody } from "./wire.ts";

export interface RetryPolicy {
	/** Maximum TOTAL attempts (1 = no retry). */
	attempts: number;
	baseDelayMs: number;
	maxDelayMs: number;
}

/** Protocol §7 backoff: base 1 s, cap 60 s; one attempt plus up to three retries. */
export const DEFAULT_RETRY: RetryPolicy = { attempts: 4, baseDelayMs: 1000, maxDelayMs: 60_000 };
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** Consumers treat this much silence on an event stream (keepalives included) as a dead connection (§8). */
export const DEFAULT_STREAM_IDLE_MS = 45_000;

const NO_RETRY: RetryPolicy = { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 };
const EMPTY = new Uint8Array(0);
const MAX_ERROR_BODY_BYTES = 64 * 1024;

export interface NetworkClientOptions {
	signer: Signer;
	fetch?: typeof fetch;
	now?: () => number;
	/** Allow `http://127.0.0.1|localhost|[::1]` peers (`CLAM_ALLOW_LOOPBACK_PEERS=1`; insecure, development only). */
	allowLoopbackHttp?: boolean;
	/** Per-attempt timeout (default 30 s). */
	timeoutMs?: number;
	/** Largest accepted response body (default 8 MiB). */
	maxResponseBytes?: number;
	/** Test seams. */
	random?: () => number;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface RequestOptions {
	method: string;
	/** Relative to the API prefix (`/node/health`); `/api/v1/…` is accepted as is. May carry a query. */
	path: string;
	/** JSON-serialized exactly once; those bytes are digested and sent. */
	body?: unknown;
	/** Default true. Unsigned requests still carry ids, version and digest headers. */
	signed?: boolean;
	/** Generated for mutating requests when omitted; identical across retries. */
	idempotencyKey?: string;
	/** Generated when omitted; identical across retries. */
	correlationId?: string;
	/** Default: {@link DEFAULT_RETRY}. `false` = a single attempt. */
	retry?: RetryPolicy | false;
	signal?: AbortSignal;
}

export interface RequestResult<T> {
	status: number;
	/** Parsed JSON; `null` for an empty body. */
	body: T;
	latencyMs: number;
	/** The receiver answered from its idempotency store (`Idempotent-Replay: true`). */
	replayed: boolean;
	attempts: number;
}

export interface EventsOptions {
	lastEventId?: string;
	onEvent(e: { id: string; event: string; data: unknown }): void;
	onOpen?(): void;
	signal: AbortSignal;
	/** Abort after this much silence (default 45 s). */
	idleTimeoutMs?: number;
}

/** Full-jitter exponential backoff: `random(0, min(cap, base × 2^(retry-1)))`, `retry` counting from 1. */
export function backoffDelayMs(retry: number, policy: RetryPolicy, random: () => number = Math.random): number {
	const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (retry - 1));
	return Math.floor(random() * ceiling);
}

/** `Retry-After` as delay in ms (delta-seconds or HTTP-date); undefined when absent/invalid. */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
	if (value === null) return undefined;
	const text = value.trim();
	if (/^[0-9]+$/.test(text)) return Number(text) * 1000;
	const date = Date.parse(text);
	return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
}

/** Protocol §7: network errors, timeouts, 5xx, 429, 408, in-flight 409 `conflict`, and 409 `replayed_request` (re-signed). Everything else is permanent. */
function isRetryableResponse(status: number, code: string): boolean {
	if (status >= 500 || status === 429 || status === 408) return true;
	return status === 409 && (code === ERROR_CODES.replayedRequest || code === ERROR_CODES.conflict);
}

function abortedError(): NetworkError {
	return new NetworkError("request aborted", { code: CLIENT_ERROR_CODES.aborted });
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	if (signal?.aborted) {
		reject(abortedError());
		return promise;
	}
	const onAbort = () => {
		clearTimeout(timer);
		reject(abortedError());
	};
	const timer = setTimeout(() => {
		signal?.removeEventListener("abort", onAbort);
		resolve();
	}, ms);
	signal?.addEventListener("abort", onAbort, { once: true });
	return promise;
}

async function readBody(res: Response, limit: number): Promise<Uint8Array> {
	const tooLarge = () => new NetworkError(`response exceeds ${limit} bytes`, { status: res.status, code: CLIENT_ERROR_CODES.responseTooLarge });
	const declared = Number(res.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > limit) {
		await res.body?.cancel();
		throw tooLarge();
	}
	if (!res.body) return EMPTY;
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel();
			throw tooLarge();
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks);
}

function describeCause(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const cause = error.cause;
	const code = cause && typeof cause === "object" && "code" in cause ? String((cause as { code: unknown }).code) : null;
	return code ? `${error.message} (${code})` : error.message;
}

function parseJson(bytes: Uint8Array): { ok: true; value: unknown } | { ok: false } {
	try {
		return { ok: true, value: JSON.parse(Buffer.from(bytes).toString("utf8")) };
	} catch {
		return { ok: false };
	}
}

/**
 * HTTPS client for the node-to-node protocol: signs every request (unless told otherwise), digests
 * the exact bytes it sends, refuses disallowed peer URLs, and retries per protocol §7 with a fresh
 * nonce / request id / timestamp on every attempt but the same idempotency key and correlation id.
 */
export class NetworkClient {
	readonly #signer: Signer;
	readonly #fetch: typeof fetch;
	readonly #now: () => number;
	readonly #allowLoopbackHttp: boolean;
	readonly #timeoutMs: number;
	readonly #maxResponseBytes: number;
	readonly #random: () => number;
	readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

	constructor(options: NetworkClientOptions) {
		this.#signer = options.signer;
		this.#fetch = options.fetch ?? fetch;
		this.#now = options.now ?? Date.now;
		this.#allowLoopbackHttp = options.allowLoopbackHttp ?? false;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.#maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
		this.#random = options.random ?? Math.random;
		this.#sleep = options.sleep ?? defaultSleep;
	}

	async request<T>(baseUrl: string, r: RequestOptions): Promise<RequestResult<T>> {
		const method = r.method.toUpperCase();
		const url = this.#target(baseUrl, r.path);
		const hasBody = r.body !== undefined;
		let bodyBytes: Uint8Array = EMPTY;
		if (hasBody) {
			const json = JSON.stringify(r.body);
			if (typeof json !== "string") throw new NetworkError("request body is not JSON serializable", { code: ERROR_CODES.invalidRequest });
			bodyBytes = Buffer.from(json, "utf8");
		}
		const idempotencyKey = r.idempotencyKey ?? (isMutatingMethod(method) ? ulid() : undefined);
		const correlationId = r.correlationId ?? ulid();
		const policy = r.retry === false ? NO_RETRY : (r.retry ?? DEFAULT_RETRY);
		const maxAttempts = Math.max(1, Math.floor(policy.attempts));

		for (let attempt = 1; ; attempt++) {
			try {
				const result = await this.#attempt<T>({ method, url, bodyBytes, hasBody, idempotencyKey, correlationId, signed: r.signed ?? true, signal: r.signal });
				return { ...result, attempts: attempt };
			} catch (error) {
				const failure = error instanceof NetworkError ? error : new NetworkError(describeCause(error), { code: CLIENT_ERROR_CODES.network, retryable: true, cause: error });
				failure.attempts = attempt;
				if (!failure.retryable || attempt >= maxAttempts) throw failure;
				await this.#sleep(Math.max(backoffDelayMs(attempt, policy, this.#random), failure.retryAfterMs ?? 0), r.signal);
			}
		}
	}

	/**
	 * Open the signed SSE stream `GET /events` and deliver parsed events until it ends. Resolves when
	 * the stream closes cleanly or `signal` aborts; rejects with a {@link NetworkError} when the peer
	 * refuses (HTTP error), the connection fails, or 45 s pass without any bytes. One attempt only:
	 * reconnect/backoff is the caller's policy.
	 */
	async events(baseUrl: string, o: EventsOptions): Promise<void> {
		if (o.signal.aborted) return;
		const url = this.#target(baseUrl, "/events");
		if (o.lastEventId !== undefined && /[\r\n]/.test(o.lastEventId)) throw new NetworkError("invalid Last-Event-ID", { code: ERROR_CODES.invalidRequest });
		const headers = this.#headers({ method: "GET", url, bodyBytes: EMPTY, hasBody: false, correlationId: ulid(), signed: true, accept: "text/event-stream" });
		headers["Cache-Control"] = "no-store";
		if (o.lastEventId) headers["Last-Event-ID"] = o.lastEventId;

		const idleMs = o.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_MS;
		const controller = new AbortController();
		const failure: { own: NetworkError | null; callback: { error: unknown } | null } = { own: null, callback: null };
		const abortWith = (error: NetworkError) => {
			failure.own ??= error;
			controller.abort();
		};
		const onCallerAbort = () => controller.abort();
		o.signal.addEventListener("abort", onCallerAbort, { once: true });
		const connectTimer = setTimeout(() => abortWith(new NetworkError(`no response within ${this.#timeoutMs} ms`, { code: CLIENT_ERROR_CODES.timeout, retryable: true })), this.#timeoutMs);
		let idleTimer: NodeJS.Timeout | undefined;
		try {
			let res: Response;
			try {
				res = await this.#fetch(url, { method: "GET", headers, redirect: "manual", signal: controller.signal });
			} finally {
				clearTimeout(connectTimer);
			}
			if (res.status !== 200) throw this.#statusError(res, await readBody(res, MAX_ERROR_BODY_BYTES).catch(() => EMPTY));
			const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
			if (!contentType.startsWith("text/event-stream") || !res.body) {
				throw new NetworkError("peer did not answer with an event stream", { status: res.status, code: CLIENT_ERROR_CODES.invalidResponse });
			}
			const reader = res.body.getReader();
			const decoder = new TextDecoder("utf-8");
			const parser = new SseParser();
			let lastId = o.lastEventId ?? "";
			const armIdle = () => {
				clearTimeout(idleTimer);
				idleTimer = setTimeout(() => abortWith(new NetworkError(`no data for ${idleMs} ms`, { code: CLIENT_ERROR_CODES.streamIdle, retryable: true })), idleMs);
			};
			armIdle();
			try {
				o.onOpen?.();
			} catch (error) {
				failure.callback = { error };
				throw error;
			}
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				armIdle();
				for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
					if (frame.id !== undefined) lastId = frame.id;
					const parsed = parseJson(Buffer.from(frame.data, "utf8"));
					try {
						o.onEvent({ id: lastId, event: frame.event, data: parsed.ok ? parsed.value : frame.data });
					} catch (error) {
						failure.callback = { error };
						throw error;
					}
				}
			}
		} catch (error) {
			if (failure.callback) throw failure.callback.error;
			if (o.signal.aborted) return;
			if (failure.own) throw failure.own;
			if (error instanceof NetworkError) throw error;
			throw new NetworkError(`event stream failed: ${describeCause(error)}`, { code: CLIENT_ERROR_CODES.streamError, retryable: true, cause: error });
		} finally {
			clearTimeout(connectTimer);
			clearTimeout(idleTimer);
			o.signal.removeEventListener("abort", onCallerAbort);
			controller.abort();
		}
	}

	#target(baseUrl: string, path: string): URL {
		const origin = normalizePeerUrl(baseUrl, { allowLoopbackHttp: this.#allowLoopbackHttp });
		if (origin === null) {
			throw new NetworkError("peer URL must be https:// (http only for loopback with CLAM_ALLOW_LOOPBACK_PEERS=1), without credentials, query or fragment", {
				code: CLIENT_ERROR_CODES.invalidPeerUrl,
			});
		}
		if (!path.startsWith("/") || /[#\\\s]/.test(path)) throw new NetworkError("invalid request path", { code: ERROR_CODES.invalidRequest });
		const prefixed = path === API_PREFIX || path.startsWith(`${API_PREFIX}/`) || path.startsWith(`${API_PREFIX}?`) ? path : `${API_PREFIX}${path}`;
		return new URL(prefixed, origin);
	}

	/** Headers for ONE attempt: a fresh request id, nonce and timestamp each time. */
	#headers(input: {
		method: string;
		url: URL;
		bodyBytes: Uint8Array;
		hasBody: boolean;
		idempotencyKey?: string;
		correlationId: string;
		signed: boolean;
		accept: string;
	}): Record<string, string> {
		const requestId = ulid();
		let headers: Record<string, string>;
		if (input.signed) {
			headers = signRequest(this.#signer, {
				method: input.method,
				url: input.url.href,
				bodyBytes: input.bodyBytes,
				correlationId: input.correlationId,
				requestId,
				now: this.#now(),
				...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
			});
		} else {
			headers = {
				[HEADER.version]: String(PROTOCOL_VERSION),
				[HEADER.requestId]: requestId,
				[HEADER.correlationId]: input.correlationId,
				[HEADER.contentDigest]: contentDigest(input.bodyBytes),
			};
			if (input.idempotencyKey !== undefined) headers[HEADER.idempotencyKey] = input.idempotencyKey;
		}
		headers.Accept = input.accept;
		if (input.hasBody) headers["Content-Type"] = "application/json; charset=utf-8";
		return headers;
	}

	async #attempt<T>(a: {
		method: string;
		url: URL;
		bodyBytes: Uint8Array;
		hasBody: boolean;
		idempotencyKey: string | undefined;
		correlationId: string;
		signed: boolean;
		signal: AbortSignal | undefined;
	}): Promise<Omit<RequestResult<T>, "attempts">> {
		const headers = this.#headers({ ...a, accept: "application/json" });
		const timeout = AbortSignal.timeout(this.#timeoutMs);
		const signal = a.signal ? AbortSignal.any([a.signal, timeout]) : timeout;
		const started = performance.now();
		let res: Response;
		let bytes: Uint8Array;
		try {
			res = await this.#fetch(a.url, { method: a.method, headers, body: a.hasBody ? a.bodyBytes : undefined, redirect: "manual", signal });
			bytes = await readBody(res, this.#maxResponseBytes);
		} catch (error) {
			if (error instanceof NetworkError) throw error;
			if (a.signal?.aborted) throw abortedError();
			if (timeout.aborted) throw new NetworkError(`no response within ${this.#timeoutMs} ms`, { code: CLIENT_ERROR_CODES.timeout, retryable: true, cause: error });
			throw new NetworkError(`request failed: ${describeCause(error)}`, { code: CLIENT_ERROR_CODES.network, retryable: true, cause: error });
		}
		const latencyMs = Math.round(performance.now() - started);
		if (res.status < 200 || res.status >= 300) throw this.#statusError(res, bytes);

		const digest = res.headers.get("content-digest");
		const match = digest === null ? null : FORMAT.contentDigest.exec(digest);
		if (match && !constantTimeEqual(Buffer.from(match[1] as string, "base64"), sha256(bytes))) {
			throw new NetworkError("response Content-Digest does not match the body", { status: res.status, code: ERROR_CODES.digestMismatch, retryable: true });
		}
		let body: unknown = null;
		if (bytes.length > 0) {
			const parsed = parseJson(bytes);
			if (!parsed.ok) throw new NetworkError("response is not valid JSON", { status: res.status, code: CLIENT_ERROR_CODES.invalidResponse });
			body = parsed.value;
		}
		return { status: res.status, body: body as T, latencyMs, replayed: res.headers.get("idempotent-replay") === "true" };
	}

	#statusError(res: Response, bytes: Uint8Array): NetworkError {
		let code = `http_${res.status}`;
		let message = `HTTP ${res.status}`;
		let details: unknown;
		const json = bytes.length > 0 ? parseJson(bytes) : null;
		if (json?.ok) {
			const envelope = ApiErrorBody.safeParse(json.value);
			if (envelope.success) {
				code = envelope.data.error.code;
				message = envelope.data.error.message;
				details = envelope.data.error.details;
			}
		}
		const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), this.#now());
		return new NetworkError(message, {
			status: res.status,
			code,
			retryable: isRetryableResponse(res.status, code),
			...(details !== undefined ? { details } : {}),
			...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
		});
	}
}
