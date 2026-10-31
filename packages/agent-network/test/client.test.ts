import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
	backoffDelayMs,
	contentDigest,
	errorBody,
	MemoryNonceStore,
	NetworkClient,
	NetworkError,
	parseRetryAfter,
	SSE_KEEPALIVE,
	encodeSseEvent,
	verifyRequest,
	type RetryPolicy,
	type VerifyResult,
} from "../src/index.ts";
import { cleanupIdentities, closeServer, listen, makeNode, registry } from "./helpers.ts";

afterAll(cleanupIdentities);

const alice = makeNode();
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

interface Seen {
	method: string;
	url: string;
	headers: IncomingHttpHeaders;
	body: Buffer;
}

const servers: Server[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map(closeServer));
});

async function readAll(req: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks);
}

type Respond = (seen: Seen, index: number, res: ServerResponse) => void | Promise<void>;

async function scripted(respond: Respond): Promise<{ origin: string; seen: Seen[] }> {
	const seen: Seen[] = [];
	const server = createServer((req, res) => {
		void (async () => {
			const entry: Seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: await readAll(req) };
			seen.push(entry);
			await respond(entry, seen.length - 1, res);
		})();
	});
	servers.push(server);
	const { origin } = await listen(server);
	return { origin, seen };
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
	res.writeHead(status, { "content-type": "application/json", ...headers });
	res.end(JSON.stringify(body));
}

/** Respond with `statuses[i]` for the i-th request (the last repeats); 2xx bodies are `{ ok: true }`. */
function statusScript(statuses: Array<number | { status: number; code?: string; headers?: Record<string, string> }>): Respond {
	return (_seen, index, res) => {
		const step = statuses[Math.min(index, statuses.length - 1)] as (typeof statuses)[number];
		const { status, code, headers } = typeof step === "number" ? { status: step, code: undefined, headers: undefined } : step;
		if (status >= 200 && status < 300) sendJson(res, status, { ok: true });
		else sendJson(res, status, errorBody(code ?? "internal", `scripted ${status}`), headers ?? {});
	};
}

const FAST: RetryPolicy = { attempts: 4, baseDelayMs: 1000, maxDelayMs: 60_000 };

function recordingClient(over: { random?: () => number; now?: () => number; timeoutMs?: number } = {}) {
	const sleeps: number[] = [];
	const client = new NetworkClient({
		signer: alice.signer,
		allowLoopbackHttp: true,
		random: over.random ?? (() => 0.5),
		sleep: async (ms) => {
			sleeps.push(ms);
		},
		...(over.now ? { now: over.now } : {}),
		...(over.timeoutMs ? { timeoutMs: over.timeoutMs } : {}),
	});
	return { client, sleeps };
}

async function failureOf(promise: Promise<unknown>): Promise<NetworkError> {
	const outcome = await promise.then(
		() => null,
		(error: unknown) => error,
	);
	expect(outcome).toBeInstanceOf(NetworkError);
	return outcome as NetworkError;
}

describe("retry: fresh attempt, stable operation", () => {
	it("every attempt has a new nonce, request id and timestamp; idempotency key and correlation id stay", async () => {
		const { origin, seen } = await scripted(statusScript([503, 502, 200]));
		let tick = 0;
		const { client, sleeps } = recordingClient({ now: () => 1_760_000_000_000 + tick++ * 1000 });
		const result = await client.request<{ ok: boolean }>(origin, { method: "POST", path: "/tasks", body: { title: "t" }, retry: FAST });
		expect(result).toMatchObject({ status: 200, body: { ok: true }, attempts: 3, replayed: false });
		expect(seen).toHaveLength(3);
		const h = (name: string) => seen.map((s) => s.headers[name.toLowerCase()]);
		expect(new Set(h("X-Clam-Nonce")).size).toBe(3);
		expect(new Set(h("X-Request-Id")).size).toBe(3);
		expect(new Set(h("X-Clam-Timestamp")).size).toBe(3);
		expect(new Set(h("X-Clam-Signature")).size).toBe(3);
		expect(new Set(h("Idempotency-Key")).size).toBe(1);
		expect(new Set(h("X-Correlation-Id")).size).toBe(1);
		expect(new Set(h("Content-Digest")).size).toBe(1);
		expect(h("Idempotency-Key")[0]).toMatch(ULID);
		expect(h("X-Correlation-Id")[0]).toMatch(ULID);
		for (const id of h("X-Request-Id")) expect(id).toMatch(ULID);
		expect(sleeps).toHaveLength(2);
	});

	it("honors a caller-supplied idempotency key and correlation id across retries", async () => {
		const { origin, seen } = await scripted(statusScript([500, 200]));
		const { client } = recordingClient();
		await client.request(origin, { method: "POST", path: "/tasks", body: {}, idempotencyKey: "idem-fixed", correlationId: "corr-fixed", retry: FAST });
		expect(seen.map((s) => [s.headers["idempotency-key"], s.headers["x-correlation-id"]])).toEqual([
			["idem-fixed", "corr-fixed"],
			["idem-fixed", "corr-fixed"],
		]);
	});

	it("GET requests carry no idempotency key; mutating ones always do", async () => {
		const { origin, seen } = await scripted(statusScript([200]));
		const { client } = recordingClient();
		await client.request(origin, { method: "GET", path: "/agents" });
		for (const method of ["POST", "PUT", "PATCH", "DELETE"]) await client.request(origin, { method, path: "/x" });
		expect(seen[0]?.headers["idempotency-key"]).toBeUndefined();
		for (const s of seen.slice(1)) expect(s.headers["idempotency-key"]).toMatch(ULID);
	});

	it("serializes the JSON body once and sends/digests identical bytes on every attempt", async () => {
		const { origin, seen } = await scripted(statusScript([503, 503, 200]));
		let serialized = 0;
		const body = {
			title: "once",
			toJSON() {
				serialized++;
				return { title: "once", at: serialized };
			},
		};
		const { client } = recordingClient();
		await client.request(origin, { method: "POST", path: "/tasks", body, retry: FAST });
		expect(serialized).toBe(1);
		expect(new Set(seen.map((s) => s.body.toString("utf8"))).size).toBe(1);
		for (const s of seen) expect(s.headers["content-digest"]).toBe(contentDigest(s.body));
		expect(seen[0]?.headers["content-type"]).toBe("application/json; charset=utf-8");
	});

	it("rejects bodies that cannot be serialized", async () => {
		const { client } = recordingClient();
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		await expect(client.request("http://127.0.0.1:1", { method: "POST", path: "/x", body: circular })).rejects.toThrow();
		await expect(client.request("http://127.0.0.1:1", { method: "POST", path: "/x", body: () => 1 })).rejects.toMatchObject({ code: "invalid_request" });
	});
});

describe("retry: what is and is not retried (protocol §7)", () => {
	const retried: Array<[number, string | undefined]> = [
		[500, undefined],
		[502, undefined],
		[503, "unavailable"],
		[504, undefined],
		[429, "rate_limited"],
		[408, undefined],
		[409, "conflict"],
		[409, "replayed_request"],
	];
	for (const [status, code] of retried) {
		it(`retries ${status}${code ? ` ${code}` : ""} with a re-signed request`, async () => {
			const { origin, seen } = await scripted(statusScript([{ status, ...(code ? { code } : {}) }, 200]));
			const { client, sleeps } = recordingClient();
			const result = await client.request(origin, { method: "POST", path: "/tasks", body: {}, retry: FAST });
			expect(result.attempts).toBe(2);
			expect(seen).toHaveLength(2);
			expect(seen[0]?.headers["x-clam-nonce"]).not.toBe(seen[1]?.headers["x-clam-nonce"]);
			expect(sleeps).toHaveLength(1);
		});
	}

	const permanent: Array<[number, string]> = [
		[400, "invalid_request"],
		[400, "digest_mismatch"],
		[401, "bad_signature"],
		[401, "key_mismatch"],
		[401, "clock_skew"],
		[401, "unknown_peer"],
		[403, "forbidden"],
		[403, "peer_revoked"],
		[404, "not_found"],
		[409, "stale_epoch"],
		[409, "idempotency_conflict"],
		[422, "unprocessable"],
		[426, "unsupported_version"],
	];
	for (const [status, code] of permanent) {
		it(`never retries ${status} ${code}`, async () => {
			const { origin, seen } = await scripted(statusScript([{ status, code }, 200]));
			const { client, sleeps } = recordingClient();
			const error = await failureOf(client.request(origin, { method: "POST", path: "/tasks", body: {}, retry: FAST }));
			expect(error).toMatchObject({ status, code, retryable: false, attempts: 1 });
			expect(seen).toHaveLength(1);
			expect(sleeps).toEqual([]);
		});
	}

	it("gives up after the configured attempts and reports the last failure", async () => {
		const { origin, seen } = await scripted(statusScript([503]));
		const { client, sleeps } = recordingClient();
		const error = await failureOf(client.request(origin, { method: "GET", path: "/agents", retry: { attempts: 3, baseDelayMs: 10, maxDelayMs: 100 } }));
		expect(error).toMatchObject({ status: 503, retryable: true, attempts: 3 });
		expect(seen).toHaveLength(3);
		expect(sleeps).toHaveLength(2);
	});

	it("retry: false makes exactly one attempt; the default policy is 1 + 3 retries", async () => {
		const once = await scripted(statusScript([503]));
		const { client } = recordingClient();
		await failureOf(client.request(once.origin, { method: "GET", path: "/agents", retry: false }));
		expect(once.seen).toHaveLength(1);
		const dflt = await scripted(statusScript([503]));
		const error = await failureOf(client.request(dflt.origin, { method: "GET", path: "/agents" }));
		expect(dflt.seen).toHaveLength(4);
		expect(error.attempts).toBe(4);
	});

	it("uses full-jitter exponential backoff capped at maxDelayMs", async () => {
		const { origin } = await scripted(statusScript([503]));
		const { client, sleeps } = recordingClient({ random: () => 0.999 });
		await failureOf(client.request(origin, { method: "GET", path: "/x", retry: { attempts: 6, baseDelayMs: 1000, maxDelayMs: 3000 } }));
		expect(sleeps).toEqual([999, 1998, 2997, 2997, 2997]);
		const low = recordingClient({ random: () => 0 });
		await failureOf(low.client.request(origin, { method: "GET", path: "/x", retry: { attempts: 3, baseDelayMs: 1000, maxDelayMs: 3000 } }));
		expect(low.sleeps).toEqual([0, 0]);
	});

	it("honors Retry-After when it exceeds the jittered delay, and ignores it when smaller", async () => {
		const big = await scripted(statusScript([{ status: 429, code: "rate_limited", headers: { "retry-after": "7" } }, 200]));
		const a = recordingClient({ random: () => 0 });
		await a.client.request(big.origin, { method: "POST", path: "/x", retry: FAST });
		expect(a.sleeps).toEqual([7000]);
		const small = await scripted(statusScript([{ status: 429, code: "rate_limited", headers: { "retry-after": "0" } }, 200]));
		const b = recordingClient({ random: () => 0.5 });
		await b.client.request(small.origin, { method: "POST", path: "/x", retry: FAST });
		expect(b.sleeps).toEqual([500]);
		const withDate = await scripted(statusScript([{ status: 503, headers: { "retry-after": new Date(1_760_000_030_000).toUTCString() } }, 200]));
		const c = recordingClient({ random: () => 0, now: () => 1_760_000_000_000 });
		await c.client.request(withDate.origin, { method: "GET", path: "/x", retry: FAST });
		expect(c.sleeps).toEqual([30_000]);
	});

	it("really waits for Retry-After before the next attempt (wall clock)", async () => {
		const { origin, seen } = await scripted(statusScript([{ status: 429, code: "rate_limited", headers: { "retry-after": "1" } }, 200]));
		const client = new NetworkClient({ signer: alice.signer, allowLoopbackHttp: true, random: () => 0 });
		const started = Date.now();
		const result = await client.request(origin, { method: "POST", path: "/x", retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 1 } });
		expect(result.attempts).toBe(2);
		expect(Date.now() - started).toBeGreaterThanOrEqual(950);
		expect(seen).toHaveLength(2);
	});

	it("retries transport failures (connection refused) and reports network_error", async () => {
		const { origin } = await scripted(statusScript([200]));
		await Promise.all(servers.splice(0).map(closeServer));
		const { client, sleeps } = recordingClient();
		const error = await failureOf(client.request(origin, { method: "GET", path: "/agents", retry: { attempts: 3, baseDelayMs: 5, maxDelayMs: 5 } }));
		expect(error).toMatchObject({ code: "network_error", status: null, retryable: true, attempts: 3 });
		expect(sleeps).toHaveLength(2);
	});

	// Integration test of the real per-attempt timer: no deterministic substitute for AbortSignal.timeout.
	it("times out a silent peer (per-attempt timeout) as a retryable timeout", async () => {
		const { origin, seen } = await scripted(() => new Promise<void>(() => {}));
		const { client, sleeps } = recordingClient({ timeoutMs: 100 });
		const error = await failureOf(client.request(origin, { method: "GET", path: "/agents", retry: { attempts: 2, baseDelayMs: 5, maxDelayMs: 5 } }));
		expect(error).toMatchObject({ code: "timeout", status: null, retryable: true, attempts: 2 });
		expect(seen).toHaveLength(2);
		expect(sleeps).toHaveLength(1);
	});

	it("an abort during a request is final: code aborted, not retried", async () => {
		const received = Promise.withResolvers<void>();
		const { origin, seen } = await scripted(() => {
			received.resolve();
			return new Promise<void>(() => {});
		});
		const { client } = recordingClient();
		const controller = new AbortController();
		const pending = failureOf(client.request(origin, { method: "GET", path: "/agents", signal: controller.signal, retry: FAST }));
		await received.promise;
		controller.abort();
		expect(await pending).toMatchObject({ code: "aborted", retryable: false });
		expect(seen).toHaveLength(1);
	});

	it("an abort while waiting between attempts cancels the wait", async () => {
		const { origin, seen } = await scripted(statusScript([{ status: 503, headers: { "retry-after": "30" } }, 200]));
		const client = new NetworkClient({ signer: alice.signer, allowLoopbackHttp: true });
		const controller = new AbortController();
		const started = Date.now();
		const pending = failureOf(client.request(origin, { method: "GET", path: "/x", signal: controller.signal, retry: FAST }));
		await vi.waitFor(() => expect(seen).toHaveLength(1));
		controller.abort();
		expect(await pending).toMatchObject({ code: "aborted" });
		expect(Date.now() - started).toBeLessThan(5000);
		expect(seen).toHaveLength(1);
	});

	it("an already-aborted signal never reaches the network", async () => {
		const { origin, seen } = await scripted(statusScript([200]));
		const { client } = recordingClient();
		const controller = new AbortController();
		controller.abort();
		expect(await failureOf(client.request(origin, { method: "GET", path: "/x", signal: controller.signal }))).toMatchObject({ code: "aborted" });
		expect(seen).toHaveLength(0);
	});
});

describe("backoff helpers", () => {
	it("backoffDelayMs is random(0, min(cap, base × 2^(retry-1)))", () => {
		const policy = { attempts: 9, baseDelayMs: 1000, maxDelayMs: 60_000 };
		expect(backoffDelayMs(1, policy, () => 0.5)).toBe(500);
		expect(backoffDelayMs(2, policy, () => 0.5)).toBe(1000);
		expect(backoffDelayMs(7, policy, () => 0.5)).toBe(30_000);
		expect(backoffDelayMs(20, policy, () => 0.999)).toBe(59_940);
		for (let i = 0; i < 100; i++) {
			const delay = backoffDelayMs(3, policy);
			expect(delay).toBeGreaterThanOrEqual(0);
			expect(delay).toBeLessThan(4000);
		}
	});

	it("parseRetryAfter reads delta-seconds and HTTP dates", () => {
		expect(parseRetryAfter("5", 0)).toBe(5000);
		expect(parseRetryAfter(" 0 ", 0)).toBe(0);
		expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
		expect(parseRetryAfter(new Date(1_000).toUTCString(), 4_000)).toBe(0);
		expect(parseRetryAfter("soon", 0)).toBeUndefined();
		expect(parseRetryAfter(null, 0)).toBeUndefined();
	});
});

describe("responses", () => {
	it("surfaces the server's error envelope as NetworkError status/code/message/details", async () => {
		const { origin } = await scripted((_s, _i, res) => sendJson(res, 409, errorBody("stale_epoch", "task moved on", { currentEpoch: 3 })));
		const { client } = recordingClient();
		const error = await failureOf(client.request(origin, { method: "POST", path: "/tasks/x/cancel", body: { epoch: 1 } }));
		expect(error).toMatchObject({ name: "NetworkError", status: 409, code: "stale_epoch", message: "task moved on", details: { currentEpoch: 3 }, retryable: false });
	});

	it("falls back to http_<status> for non-envelope error bodies", async () => {
		const { origin } = await scripted((_s, _i, res) => {
			res.writeHead(500, { "content-type": "text/html" });
			res.end("<h1>oops</h1>");
		});
		const { client } = recordingClient();
		const error = await failureOf(client.request(origin, { method: "GET", path: "/x", retry: false }));
		expect(error).toMatchObject({ status: 500, code: "http_500", retryable: true });
	});

	it("exposes Retry-After on the error and the idempotent-replay marker on success", async () => {
		const a = await scripted(statusScript([{ status: 429, code: "rate_limited", headers: { "retry-after": "3" } }]));
		const { client } = recordingClient();
		expect(await failureOf(client.request(a.origin, { method: "GET", path: "/x", retry: false }))).toMatchObject({ retryAfterMs: 3000 });
		const b = await scripted((_s, _i, res) => sendJson(res, 200, { ok: true }, { "idempotent-replay": "true" }));
		expect((await client.request(b.origin, { method: "POST", path: "/x" })).replayed).toBe(true);
	});

	it("returns null for an empty body and rejects invalid JSON", async () => {
		const empty = await scripted((_s, _i, res) => {
			res.writeHead(204);
			res.end();
		});
		const { client } = recordingClient();
		expect(await client.request(empty.origin, { method: "POST", path: "/x" })).toMatchObject({ status: 204, body: null });
		const bad = await scripted((_s, _i, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end("{nope");
		});
		expect(await failureOf(client.request(bad.origin, { method: "GET", path: "/x" }))).toMatchObject({ code: "invalid_response", retryable: false });
	});

	it("refuses oversized responses", async () => {
		const { origin } = await scripted((_s, _i, res) => sendJson(res, 200, { blob: "x".repeat(10_000) }));
		const client = new NetworkClient({ signer: alice.signer, allowLoopbackHttp: true, maxResponseBytes: 1000 });
		expect(await failureOf(client.request(origin, { method: "GET", path: "/x" }))).toMatchObject({ code: "response_too_large", retryable: false });
	});

	it("verifies a response Content-Digest when present", async () => {
		const payload = JSON.stringify({ ok: true });
		const good = await scripted((_s, _i, res) => {
			res.writeHead(200, { "content-type": "application/json", "content-digest": contentDigest(Buffer.from(payload)) });
			res.end(payload);
		});
		const { client } = recordingClient();
		expect((await client.request(good.origin, { method: "GET", path: "/x" })).body).toEqual({ ok: true });
		const bad = await scripted((_s, _i, res) => {
			res.writeHead(200, { "content-type": "application/json", "content-digest": contentDigest(Buffer.from("other")) });
			res.end(payload);
		});
		expect(await failureOf(client.request(bad.origin, { method: "GET", path: "/x", retry: false }))).toMatchObject({ code: "digest_mismatch", retryable: true });
	});

	it("does not follow redirects (the signature binds the host)", async () => {
		const target = await scripted(statusScript([200]));
		const { origin, seen } = await scripted((_s, _i, res) => {
			res.writeHead(302, { location: `${target.origin}/api/v1/agents` });
			res.end();
		});
		const { client } = recordingClient();
		expect(await failureOf(client.request(origin, { method: "GET", path: "/agents" }))).toMatchObject({ status: 302, code: "http_302", retryable: false });
		expect(seen).toHaveLength(1);
		expect(target.seen).toHaveLength(0);
	});
});

describe("unsigned requests", () => {
	it("carry ids, version, digest and (when mutating) an idempotency key, but no identity or signature", async () => {
		const { origin, seen } = await scripted(statusScript([200]));
		const { client } = recordingClient();
		await client.request(origin, { method: "POST", path: "/node/pair", body: { step: "hello" }, signed: false });
		await client.request(origin, { method: "GET", path: "/node/info", signed: false });
		const [post, get] = seen as [Seen, Seen];
		for (const name of ["x-clam-signature", "x-clam-node-id", "x-clam-key-id", "x-clam-nonce", "x-clam-timestamp"]) {
			expect(post.headers[name]).toBeUndefined();
			expect(get.headers[name]).toBeUndefined();
		}
		expect(post.headers["x-clam-version"]).toBe("1");
		expect(post.headers["x-request-id"]).toMatch(ULID);
		expect(post.headers["x-correlation-id"]).toMatch(ULID);
		expect(post.headers["idempotency-key"]).toMatch(ULID);
		expect(post.headers["content-digest"]).toBe(contentDigest(post.body));
		expect(get.headers["content-digest"]).toBe(contentDigest(new Uint8Array()));
		expect(get.headers["idempotency-key"]).toBeUndefined();
	});
});

describe("target resolution and URL policy", () => {
	it("prefixes /api/v1 unless the path already has it and tolerates a base URL ending in /api/v1", async () => {
		const { origin, seen } = await scripted(statusScript([200]));
		const { client } = recordingClient();
		await client.request(origin, { method: "GET", path: "/node/info" });
		await client.request(origin, { method: "GET", path: "/api/v1/node/info" });
		await client.request(`${origin}/api/v1`, { method: "GET", path: "/node/info" });
		await client.request(`${origin}/`, { method: "GET", path: "/node/info?x=1" });
		expect(seen.map((s) => s.url)).toEqual(["/api/v1/node/info", "/api/v1/node/info", "/api/v1/node/info", "/api/v1/node/info?x=1"]);
	});

	it("rejects malformed paths", async () => {
		const { client } = recordingClient();
		for (const path of ["node/info", "/a#b", "/a\\b", "/a b", ""]) {
			await expect(client.request("http://127.0.0.1:1", { method: "GET", path })).rejects.toMatchObject({ code: "invalid_request" });
		}
	});

	it("refuses http peers unless loopback is explicitly allowed, without touching the network", async () => {
		const { origin, seen } = await scripted(statusScript([200]));
		const strict = new NetworkClient({ signer: alice.signer });
		const error = await failureOf(strict.request(origin, { method: "GET", path: "/node/info" }));
		expect(error).toMatchObject({ code: "invalid_peer_url", status: null, retryable: false });
		expect(seen).toHaveLength(0);
		await expect(strict.events(origin, { onEvent() {}, signal: new AbortController().signal })).rejects.toMatchObject({ code: "invalid_peer_url" });
		const dev = new NetworkClient({ signer: alice.signer, allowLoopbackHttp: true });
		expect((await dev.request(origin, { method: "GET", path: "/node/info" })).status).toBe(200);
	});

	it("never allows non-loopback http, other schemes, or credentials even in dev mode", async () => {
		const dev = new NetworkClient({ signer: alice.signer, allowLoopbackHttp: true });
		for (const url of ["http://example.com", "http://192.168.1.5:4318", "ftp://127.0.0.1", "https://user:secret@example.com", "https://example.com?x=1", "not a url"]) {
			const error = await failureOf(dev.request(url, { method: "GET", path: "/node/info" }));
			expect(error.code).toBe("invalid_peer_url");
			expect(error.message).not.toContain("secret");
		}
	});

	it("accepts an https peer URL (policy only; nothing listens there)", async () => {
		const client = new NetworkClient({
			signer: alice.signer,
			fetch: async (input) => new Response(JSON.stringify({ url: String(input) }), { status: 200, headers: { "content-type": "application/json" } }),
		});
		const result = await client.request<{ url: string }>("https://agent-b.example.com", { method: "GET", path: "/node/info", signed: false });
		expect(result.body.url).toBe("https://agent-b.example.com/api/v1/node/info");
	});
});

describe("events (SSE)", () => {
	const bob = makeNode();

	/** SSE server that verifies the signed request like a protocol endpoint, then streams `stream(res)`. */
	async function sseServer(stream: (res: ServerResponse, seen: Seen) => void | Promise<void>) {
		const verdicts: VerifyResult[] = [];
		const nonces = new MemoryNonceStore();
		const seen: Seen[] = [];
		const server = createServer((req, res) => {
			void (async () => {
				const url = new URL(req.url ?? "/", "http://placeholder");
				const entry: Seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: await readAll(req) };
				seen.push(entry);
				const verdict = await verifyRequest(
					{ method: entry.method, path: url.pathname, rawQuery: url.search, host: req.headers.host ?? "", headers: req.headers, bodyBytes: entry.body },
					{ lookupPeer: registry(alice.peerKey()), nonces },
				);
				verdicts.push(verdict);
				if (!verdict.ok) {
					sendJson(res, verdict.status, errorBody(verdict.code, verdict.message, verdict.details));
					return;
				}
				await stream(res, entry);
			})();
		});
		servers.push(server);
		const { origin } = await listen(server);
		return { origin, verdicts, seen };
	}

	function open(res: ServerResponse): void {
		res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
	}

	const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
	// The idle-timer tests below exercise the client's real timer; nothing deterministic can drive socket reads.
	const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

	it("delivers parsed events in order across arbitrary chunk splits, ignoring keepalives, and resolves when the stream ends", async () => {
		const frames = [1, 2, 3].map((n) => encodeSseEvent({ id: `cur-${n}`, event: "node.event", data: { stream: "node", seq: n, type: "health", payload: { status: "ok" } } }));
		const { origin, verdicts, seen } = await sseServer(async (res) => {
			open(res);
			const wire = SSE_KEEPALIVE + frames.join(SSE_KEEPALIVE) + SSE_KEEPALIVE;
			for (let i = 0; i < wire.length; i += 7) {
				res.write(wire.slice(i, i + 7));
				await turn();
			}
			res.end();
		});
		const client = new NetworkClient({ signer: alice.signer, allowLoopbackHttp: true });
		const events: Array<{ id: string; event: string; data: unknown }> = [];
		let opened = 0;
		await client.events(origin, {
			lastEventId: "cur-0",
			onOpen: () => {
				opened++;
				expect(events).toHaveLength(0);
			},
			onEvent: (e) => events.push(e),
			signal: new AbortController().signal,
		});
		expect(opened).toBe(1);
		expect(events.map((e) => [e.id, e.event, (e.data as { seq: number }).seq])).toEqual([
			["cur-1", "node.event", 1],
			["cur-2", "node.event", 2],
			["cur-3", "node.event", 3],
		]);
		expect(verdicts).toEqual([expect.objectContaining({ ok: true, peerId: alice.identity.nodeId })]);
		expect(seen[0]).toMatchObject({ method: "GET", url: "/api/v1/events" });
		expect(seen[0]?.headers["last-event-id"]).toBe("cur-0");
		expect(seen[0]?.headers.accept).toBe("text/event-stream");
	});

	it("signs every connection with a fresh nonce (a reconnect is not a replay)", async () => {
		const { origin, verdicts } = await sseServer((res) => {
			open(res);
			res.end();
		});
		const client = new NetworkClient({ signer: alice.signer, allowLoopbackHttp: true });
		for (let i = 0; i < 3; i++) await client.events(origin, { onEvent() {}, signal: new AbortController().signal });
		expect(verdicts.map((v) => v.ok)).toEqual([true, true, true]);
	});

	it("resolves (does not reject) when the caller aborts, promptly", async () => {
		const { origin } = await sseServer(async (res) => {
			open(res);
			res.write(encodeSseEvent({ id: "1", event: "e", data: { n: 1 } }));
		});
		const client = new NetworkClient({ signer: alice.signer, allowLoopbackHttp: true });
		const controller = new AbortController();
		const events: unknown[] = [];
		const started = Date.now();
		await client.events(origin, {
			onEvent: (e) => {
				events.push(e.data);
				controller.abort();
			},
			signal: controller.signal,
		});
		expect(events).toEqual([{ n: 1 }]);
		expect(Date.now() - started).toBeLessThan(3000);
	});

	it("an already-aborted signal resolves without connecting", async () => {
		const { origin, seen } = await sseServer((res) => {
			open(res);
			res.end();
		});
		const client = new NetworkClient({ signer: alice.signer, allowLoopbackHttp: true });
		const controller = new AbortController();
		controller.abort();
		await client.events(origin, { onEvent() {}, signal: controller.signal });
		expect(seen).toHaveLength(0);
	});

	it("rejects with the server's error (revoked, unknown, forbidden) without opening", async () => {
		const stranger = new NetworkClient({ signer: bob.signer, allowLoopbackHttp: true });
		const { origin } = await sseServer(() => {});
		let opened = false;
		const error = await failureOf(stranger.events(origin, { onOpen: () => (opened = true), onEvent() {}, signal: new AbortController().signal }));
		expect(error).toMatchObject({ status: 401, code: "unknown_peer", retryable: false });
		expect(opened).toBe(false);

		const refuse = await scripted((_s, _i, res) => sendJson(res, 403, errorBody("forbidden", "missing events.read", { capability: "events.read" })));
		const client = new NetworkClient({ signer: alice.signer, allowLoopbackHttp: true });
		expect(await failureOf(client.events(refuse.origin, { onEvent() {}, signal: new AbortController().signal }))).toMatchObject({ status: 403, code: "forbidden", details: { capability: "events.read" } });
	});

	it("rejects a 200 that is not an event stream", async () => {
		const { origin } = await scripted((_s, _i, res) => sendJson(res, 200, { ok: true }));
		const client = new NetworkClient({ signer: alice.signer, allowLoopbackHttp: true });
		expect(await failureOf(client.events(origin, { onEvent() {}, signal: new AbortController().signal }))).toMatchObject({ code: "invalid_response" });
	});

	it("treats silence (not even keepalives) as a dead connection", async () => {
		const { origin } = await sseServer(async (res) => {
			open(res);
			res.write(": ping\n\n");
		});
		const client = new NetworkClient({ signer: alice.signer, allowLoopbackHttp: true });
		const started = Date.now();
		const error = await failureOf(client.events(origin, { onEvent() {}, signal: new AbortController().signal, idleTimeoutMs: 250 }));
		expect(error).toMatchObject({ code: "stream_idle", retryable: true });
		expect(Date.now() - started).toBeGreaterThanOrEqual(200);
	});

	it("keepalives keep a stream alive past the idle timeout", async () => {
		const { origin } = await sseServer(async (res) => {
			open(res);
			for (let i = 0; i < 8; i++) {
				res.write(SSE_KEEPALIVE);
				await pause(40);
			}
			res.write(encodeSseEvent({ id: "1", event: "e", data: { done: true } }));
			res.end();
		});
		const client = new NetworkClient({ signer: alice.signer, allowLoopbackHttp: true });
		const events: unknown[] = [];
		await client.events(origin, { onEvent: (e) => events.push(e.data), signal: new AbortController().signal, idleTimeoutMs: 150 });
		expect(events).toEqual([{ done: true }]);
	});

	it("rejects with a retryable stream_error when the connection dies mid-stream", async () => {
		const { origin } = await sseServer(async (res) => {
			open(res);
			await new Promise<void>((resolve) => res.write(encodeSseEvent({ id: "1", event: "e", data: { n: 1 } }), () => resolve()));
			await turn();
			res.socket?.destroy();
		});
		const client = new NetworkClient({ signer: alice.signer, allowLoopbackHttp: true });
		const events: unknown[] = [];
		const error = await failureOf(client.events(origin, { onEvent: (e) => events.push(e.data), signal: new AbortController().signal }));
		expect(events).toEqual([{ n: 1 }]);
		expect(error).toMatchObject({ code: "stream_error", retryable: true });
	});

	it("rethrows an error thrown by the consumer unchanged and stops reading", async () => {
		const { origin } = await sseServer(async (res) => {
			open(res);
			res.write(encodeSseEvent({ id: "1", event: "e", data: 1 }) + encodeSseEvent({ id: "2", event: "e", data: 2 }));
		});
		const client = new NetworkClient({ signer: alice.signer, allowLoopbackHttp: true });
		const boom = new Error("consumer failed");
		const seenData: unknown[] = [];
		const outcome = await client
			.events(origin, {
				onEvent: (e) => {
					seenData.push(e.data);
					throw boom;
				},
				signal: new AbortController().signal,
			})
			.then(
				() => null,
				(error: unknown) => error,
			);
		expect(outcome).toBe(boom);
		expect(seenData).toEqual([1]);
	});

	it("passes data that is not JSON through as the raw string, and defaults the event name to message", async () => {
		const { origin } = await sseServer(async (res) => {
			open(res);
			res.write("id: 9\ndata: plain text\n\n");
			res.end();
		});
		const client = new NetworkClient({ signer: alice.signer, allowLoopbackHttp: true });
		const events: Array<{ id: string; event: string; data: unknown }> = [];
		await client.events(origin, { onEvent: (e) => events.push(e), signal: new AbortController().signal });
		expect(events).toEqual([{ id: "9", event: "message", data: "plain text" }]);
	});

	it("a refused connection is a retryable stream_error", async () => {
		const { origin } = await sseServer(() => {});
		await Promise.all(servers.splice(0).map(closeServer));
		const client = new NetworkClient({ signer: alice.signer, allowLoopbackHttp: true });
		expect(await failureOf(client.events(origin, { onEvent() {}, signal: new AbortController().signal }))).toMatchObject({ code: "stream_error", retryable: true });
	});

	it("rejects a Last-Event-ID that could split headers", async () => {
		const client = new NetworkClient({ signer: alice.signer, allowLoopbackHttp: true });
		await expect(client.events("http://127.0.0.1:1", { lastEventId: "a\r\nX: y", onEvent() {}, signal: new AbortController().signal })).rejects.toMatchObject({ code: "invalid_request" });
	});
});
