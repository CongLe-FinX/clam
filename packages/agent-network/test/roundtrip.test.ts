import { request as httpRequest } from "node:http";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { contentDigest, MemoryNonceStore, NetworkClient, NetworkError, signRequest, wire } from "../src/index.ts";
import { cleanupIdentities, makeNode, registry, startVerifyServer, type VerifyServer } from "./helpers.ts";

afterAll(cleanupIdentities);

const alice = makeNode();
const bob = makeNode();
const servers: VerifyServer[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function server(deps: { peers?: Parameters<typeof registry>; now?: () => number; skewMs?: number } = {}): Promise<VerifyServer> {
	const s = await startVerifyServer({ lookupPeer: registry(...(deps.peers ?? [alice.peerKey()])), ...(deps.now ? { now: deps.now } : {}), ...(deps.skewMs ? { skewMs: deps.skewMs } : {}) });
	servers.push(s);
	return s;
}

function clientFor(node = alice, over: { now?: () => number } = {}): NetworkClient {
	return new NetworkClient({ signer: node.signer, allowLoopbackHttp: true, ...over });
}

/** Raw HTTP (so headers can be duplicated and `Host` forged), unlike fetch. */
function raw(origin: string, o: { method: string; path: string; headers: Record<string, string | string[]>; body?: Buffer }): Promise<{ status: number; error: wire.ApiErrorBody["error"] | null }> {
	const url = new URL(origin);
	return new Promise((resolve, reject) => {
		const req = httpRequest({ host: url.hostname, port: url.port, method: o.method, path: o.path, headers: o.headers }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("end", () => {
				const parsed = wire.ApiErrorBody.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
				resolve({ status: res.statusCode ?? 0, error: parsed.success ? parsed.data.error : null });
			});
		});
		req.on("error", reject);
		req.end(o.body);
	});
}

describe("sign → verify through a real HTTP server", () => {
	it("GET with a query string", async () => {
		const s = await server();
		const result = await clientFor().request<{ ok: boolean; peerId: string; path: string; idempotencyKey: string | null }>(s.origin, { method: "GET", path: "/agents?z=1&a=hello%20world&a=%7e" });
		expect(result.status).toBe(200);
		expect(result.body).toMatchObject({ ok: true, peerId: alice.identity.nodeId, path: "/api/v1/agents?z=1&a=hello%20world&a=%7e", idempotencyKey: null });
		expect(s.results).toHaveLength(1);
	});

	it("POST JSON with idempotency key, correlation id and request id attributed", async () => {
		const s = await server();
		const body = { title: "Build — ünïcode 🙂", nested: { n: [1, 2, 3] } };
		const result = await clientFor().request<{ ok: boolean; body: string; idempotencyKey: string; correlationId: string }>(s.origin, {
			method: "POST",
			path: "/tasks",
			body,
			idempotencyKey: "idem-roundtrip",
			correlationId: "corr-roundtrip",
		});
		expect(result.body).toMatchObject({ ok: true, idempotencyKey: "idem-roundtrip", correlationId: "corr-roundtrip" });
		expect(JSON.parse(result.body.body)).toEqual(body);
	});

	it("a large body round-trips (digest covers every byte)", async () => {
		const s = await server();
		const body = { blob: "x".repeat(1_500_000) };
		const result = await clientFor().request<{ ok: boolean; body: string }>(s.origin, { method: "POST", path: "/context/sync", body });
		expect(result.body.ok).toBe(true);
		expect(JSON.parse(result.body.body)).toEqual(body);
	});

	it("an empty POST body is signed with the digest of the empty string", async () => {
		const s = await server();
		const result = await clientFor().request<{ ok: boolean; body: string }>(s.origin, { method: "POST", path: "/tasks/tsk_1/cancel" });
		expect(result.body).toMatchObject({ ok: true, body: "" });
	});

	it("each peer is verified against its own pinned key", async () => {
		const s = await server({ peers: [alice.peerKey(), bob.peerKey()] });
		const fromBob = await clientFor(bob).request<{ peerId: string }>(s.origin, { method: "GET", path: "/node/health" });
		expect(fromBob.body.peerId).toBe(bob.identity.nodeId);
	});
});

describe("rejections on the wire", () => {
	function signedGet(origin: string, path: string, extra: Record<string, string> = {}) {
		const headers = signRequest(alice.signer, { method: "GET", url: `${origin}${path}`, bodyBytes: new Uint8Array() });
		return { headers: { ...headers, ...extra } };
	}

	it("a captured request replayed verbatim → 409 replayed_request", async () => {
		const s = await server();
		const { headers } = signedGet(s.origin, "/api/v1/agents");
		const first = await raw(s.origin, { method: "GET", path: "/api/v1/agents", headers });
		const second = await raw(s.origin, { method: "GET", path: "/api/v1/agents", headers });
		expect(first.status).toBe(200);
		expect(second.status).toBe(409);
		expect(second.error?.code).toBe("replayed_request");
	});

	it("body tampered in transit → 400 digest_mismatch; digest rewritten too → 401 bad_signature", async () => {
		const s = await server();
		const body = Buffer.from('{"epoch":0}');
		const headers = signRequest(alice.signer, { method: "POST", url: `${s.origin}/api/v1/tasks`, bodyBytes: body, idempotencyKey: "k1" });
		const tampered = await raw(s.origin, { method: "POST", path: "/api/v1/tasks", headers, body: Buffer.from('{"epoch":9}') });
		expect(tampered.status).toBe(400);
		expect(tampered.error?.code).toBe("digest_mismatch");
		const evil = Buffer.from('{"epoch":9}');
		const rewritten = signRequest(alice.signer, { method: "POST", url: `${s.origin}/api/v1/tasks`, bodyBytes: body, idempotencyKey: "k2" });
		rewritten["Content-Digest"] = contentDigest(evil);
		const forged = await raw(s.origin, { method: "POST", path: "/api/v1/tasks", headers: rewritten, body: evil });
		expect(forged.status).toBe(401);
		expect(forged.error?.code).toBe("bad_signature");
	});

	it("path, query and method changed in transit → 401 bad_signature", async () => {
		const s = await server();
		for (const [method, path] of [
			["GET", "/api/v1/other?a=1"],
			["GET", "/api/v1/agents?a=2"],
			["GET", "/api/v1/agents"],
		] as const) {
			const headers = signRequest(alice.signer, { method: "GET", url: `${s.origin}/api/v1/agents?a=1`, bodyBytes: new Uint8Array() });
			const res = await raw(s.origin, { method, path, headers });
			expect(res.error?.code).toBe("bad_signature");
		}
		const postHeaders = signRequest(alice.signer, { method: "POST", url: `${s.origin}/api/v1/tasks`, bodyBytes: new Uint8Array(), idempotencyKey: "k" });
		expect((await raw(s.origin, { method: "PUT", path: "/api/v1/tasks", headers: postHeaders })).error?.code).toBe("bad_signature");
	});

	it("a request relayed to another host (forged Host header) → 401 bad_signature", async () => {
		const s = await server();
		const { headers } = signedGet(s.origin, "/api/v1/agents");
		const relayed = await raw(s.origin, { method: "GET", path: "/api/v1/agents", headers: { ...headers, host: "relay.example.com" } });
		expect(relayed.status).toBe(401);
		expect(relayed.error?.code).toBe("bad_signature");
		const direct = await raw(s.origin, { method: "GET", path: "/api/v1/agents", headers: signedGet(s.origin, "/api/v1/agents").headers });
		expect(direct.status).toBe(200);
	});

	it("a security header sent twice → 400 invalid_request", async () => {
		const s = await server();
		const { headers } = signedGet(s.origin, "/api/v1/agents");
		const doubled = await raw(s.origin, { method: "GET", path: "/api/v1/agents", headers: { ...headers, "X-Clam-Nonce": [headers["X-Clam-Nonce"] as string, "AAAAAAAAAAAAAAAAAAAAAA"] } });
		expect(doubled.status).toBe(400);
		expect(doubled.error?.code).toBe("invalid_request");
		const sigTwice = await raw(s.origin, { method: "GET", path: "/api/v1/agents", headers: { ...signedGet(s.origin, "/api/v1/agents").headers, "X-Clam-Signature": [headers["X-Clam-Signature"] as string, headers["X-Clam-Signature"] as string] } });
		expect(sigTwice.error?.code).toBe("invalid_request");
	});

	it("an unsupported protocol version → 426 with the supported list", async () => {
		const s = await server();
		const { headers } = signedGet(s.origin, "/api/v1/agents", { "X-Clam-Version": "2" });
		const res = await raw(s.origin, { method: "GET", path: "/api/v1/agents", headers });
		expect(res.status).toBe(426);
		expect(res.error).toMatchObject({ code: "unsupported_version", details: { supportedVersions: [1] } });
	});

	it("clock skew in either direction → clock_skew with the receiver's time, never retried", async () => {
		const serverNow = 1_760_000_000_000;
		const s = await server({ now: () => serverNow });
		for (const offset of [-61_000, 61_000]) {
			const client = clientFor(alice, { now: () => serverNow + offset });
			const error = await client.request(s.origin, { method: "GET", path: "/agents" }).then(
				() => null,
				(e: unknown) => e,
			);
			expect(error).toBeInstanceOf(NetworkError);
			expect(error).toMatchObject({ status: 401, code: "clock_skew", retryable: false, attempts: 1, details: { serverTime: serverNow, maxSkewMs: 60_000 } });
		}
		expect((await clientFor(alice, { now: () => serverNow + 59_000 }).request(s.origin, { method: "GET", path: "/agents" })).status).toBe(200);
		expect(s.results.filter((r) => !r.ok)).toHaveLength(2);
	});

	it("revoked, unknown and re-keyed peers are refused with non-retryable codes the client surfaces", async () => {
		const s = await server({ peers: [alice.peerKey({ revoked: true }), bob.peerKey({ keyId: "ffffffffffffffff" })] });
		const mallory = makeNode();
		const expectations: Array<[NetworkClient, number, string]> = [
			[clientFor(alice), 403, "peer_revoked"],
			[clientFor(bob), 401, "key_mismatch"],
			[clientFor(mallory), 401, "unknown_peer"],
		];
		for (const [client, status, code] of expectations) {
			const error = await client.request(s.origin, { method: "GET", path: "/agents" }).then(
				() => null,
				(e: unknown) => e,
			);
			expect(error).toMatchObject({ status, code, retryable: false, attempts: 1 });
		}
	});

	it("a revoked peer is cut off at once while others keep working", async () => {
		const peers = [alice.peerKey(), bob.peerKey()];
		const store = new MemoryNonceStore();
		const s = await startVerifyServer({ lookupPeer: (id) => peers.find((p) => p.nodeId === id) ?? null, nonces: store });
		servers.push(s);
		const ca = clientFor(alice);
		expect((await ca.request(s.origin, { method: "GET", path: "/agents" })).status).toBe(200);
		peers[0] = alice.peerKey({ revoked: true });
		await expect(ca.request(s.origin, { method: "GET", path: "/agents" })).rejects.toMatchObject({ code: "peer_revoked" });
		expect((await clientFor(bob).request(s.origin, { method: "GET", path: "/agents" })).status).toBe(200);
	});
});
