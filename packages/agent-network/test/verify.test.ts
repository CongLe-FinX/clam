import { afterAll, describe, expect, it } from "vitest";
import {
	contentDigest,
	MemoryNonceStore,
	toBase64Url,
	verifyRequest,
	type NonceStore,
	type PeerKey,
	type VerifyInput,
	type VerifyResult,
} from "../src/index.ts";
import { cleanupIdentities, forgeSigned, makeNode, registry } from "./helpers.ts";

afterAll(cleanupIdentities);

const NOW = 1_760_000_000_000;
const HOST = "agent-b.example.com";
const alice = makeNode();
const mallory = makeNode();

function original(over: Partial<Parameters<typeof forgeSigned>[1]> = {}): VerifyInput {
	return forgeSigned(alice.signer, {
		method: "POST",
		path: "/api/v1/tasks",
		rawQuery: "a=1&b=2",
		host: HOST,
		timestamp: NOW,
		idempotencyKey: "idem-1",
		body: Buffer.from('{"title":"build"}'),
		...over,
	});
}

function verify(
	input: VerifyInput,
	deps: { lookupPeer?: (nodeId: string) => PeerKey | null; nonces?: NonceStore; now?: number; skewMs?: number; supportedVersions?: number[] } = {},
): Promise<VerifyResult> {
	return verifyRequest(input, {
		lookupPeer: deps.lookupPeer ?? registry(alice.peerKey()),
		nonces: deps.nonces ?? new MemoryNonceStore({ now: () => NOW }),
		now: () => deps.now ?? NOW,
		...(deps.skewMs !== undefined ? { skewMs: deps.skewMs } : {}),
		...(deps.supportedVersions ? { supportedVersions: deps.supportedVersions } : {}),
	});
}

function withHeaders(input: VerifyInput, change: Record<string, string | string[] | undefined>): VerifyInput {
	const headers: VerifyInput["headers"] = { ...input.headers };
	for (const [name, value] of Object.entries(change)) {
		if (value === undefined) delete headers[name];
		else headers[name] = value;
	}
	return { ...input, headers };
}

function expectFail(result: VerifyResult, status: number, code: string) {
	expect(result.ok).toBe(false);
	if (result.ok) throw new Error("expected failure");
	expect({ status: result.status, code: result.code }).toEqual({ status, code });
	return result;
}

describe("verifyRequest: acceptance", () => {
	it("accepts a valid signed request and returns the attribution ids", async () => {
		const result = await verify(original({ requestId: "req-42", correlationId: "corr-42" }));
		expect(result).toEqual({ ok: true, peerId: alice.identity.nodeId, requestId: "req-42", correlationId: "corr-42", idempotencyKey: "idem-1" });
	});

	it("accepts a GET without Idempotency-Key and reports null", async () => {
		const result = await verify(original({ method: "GET", idempotencyKey: null, body: new Uint8Array(), rawQuery: "" }));
		expect(result).toMatchObject({ ok: true, idempotencyKey: null });
	});

	it("treats header names case-insensitively", async () => {
		const input = original();
		const headers = Object.fromEntries(Object.entries(input.headers).map(([k, v]) => [k.replace(/(^|-)([a-z])/g, (_, d: string, c: string) => d + c.toUpperCase()), v]));
		expect(await verify({ ...input, headers })).toMatchObject({ ok: true });
	});

	it("binds the host case-insensitively and ignores default ports and query order/escaping", async () => {
		const input = original();
		expect(await verify({ ...input, host: "Agent-B.Example.COM:443" })).toMatchObject({ ok: true });
		expect(await verify({ ...input, rawQuery: "?b=2&a=1" })).toMatchObject({ ok: true });
		const escaped = original({ rawQuery: "q=a%20b&r=%7e" });
		expect(await verify({ ...escaped, rawQuery: "r=~&q=a%20b" })).toMatchObject({ ok: true });
	});

	it("supports async lookup and async nonce stores", async () => {
		const nonces: NonceStore = { checkAndRemember: async () => true };
		const result = await verifyRequest(original(), { lookupPeer: async () => alice.peerKey(), nonces, now: () => NOW });
		expect(result.ok).toBe(true);
	});
});

describe("verifyRequest: tampering with every signed field is rejected", () => {
	const cases: Array<{ field: string; tamper: (i: VerifyInput) => VerifyInput; lookup?: (nodeId: string) => PeerKey | null }> = [
		{ field: "method", tamper: (i) => ({ ...i, method: "PUT" }) },
		{ field: "path", tamper: (i) => ({ ...i, path: "/api/v1/tasks/other" }) },
		{ field: "query", tamper: (i) => ({ ...i, rawQuery: "a=1&b=3" }) },
		{ field: "extra query pair", tamper: (i) => ({ ...i, rawQuery: "a=1&b=2&c=3" }) },
		{ field: "host", tamper: (i) => ({ ...i, host: "agent-c.example.com" }) },
		{
			field: "node id",
			tamper: (i) => withHeaders(i, { "x-clam-node-id": "node_0123456789abcdef" }),
			lookup: (id) => (id === "node_0123456789abcdef" ? alice.peerKey({ nodeId: id }) : null),
		},
		{
			field: "key id",
			tamper: (i) => withHeaders(i, { "x-clam-key-id": "0123456789abcdef" }),
			lookup: () => alice.peerKey({ keyId: "0123456789abcdef" }),
		},
		{ field: "timestamp", tamper: (i) => withHeaders(i, { "x-clam-timestamp": String(NOW + 1000) }) },
		{ field: "nonce", tamper: (i) => withHeaders(i, { "x-clam-nonce": toBase64Url(Buffer.alloc(16, 9)) }) },
		{ field: "request id", tamper: (i) => withHeaders(i, { "x-request-id": "req-other" }) },
		{ field: "correlation id", tamper: (i) => withHeaders(i, { "x-correlation-id": "corr-other" }) },
		{ field: "idempotency key", tamper: (i) => withHeaders(i, { "idempotency-key": "idem-other" }) },
		{ field: "body (digest recomputed by the attacker)", tamper: (i) => withHeaders({ ...i, bodyBytes: Buffer.from('{"title":"steal"}') }, { "content-digest": contentDigest(Buffer.from('{"title":"steal"}')) }) },
		{ field: "signature bytes", tamper: (i) => withHeaders(i, { "x-clam-signature": toBase64Url(Buffer.alloc(64, 1)) }) },
		{
			field: "signature (signed by another key)",
			tamper: (i) => withHeaders(i, { "x-clam-signature": forgeSigned(mallory.signer, { method: "POST", path: "/api/v1/tasks", rawQuery: "a=1&b=2", host: HOST, timestamp: NOW, idempotencyKey: "idem-1", body: i.bodyBytes }).headers["x-clam-signature"] }),
		},
	];

	for (const c of cases) {
		it(`${c.field} → 401 bad_signature`, async () => {
			const result = await verify(c.tamper(original()), c.lookup ? { lookupPeer: c.lookup } : {});
			const failure = expectFail(result, 401, "bad_signature");
			expect(failure.message).not.toMatch(/field|method|path|host|nonce|timestamp/i);
			expect(failure.details).toBeUndefined();
		});
	}

	it("body bytes changed but header kept → 400 digest_mismatch", async () => {
		expectFail(await verify({ ...original(), bodyBytes: Buffer.from('{"title":"steal"}') }), 400, "digest_mismatch");
		expectFail(await verify({ ...original(), bodyBytes: new Uint8Array() }), 400, "digest_mismatch");
	});

	it("Content-Digest header swapped for another body's digest → 400 digest_mismatch", async () => {
		expectFail(await verify(withHeaders(original(), { "content-digest": contentDigest(Buffer.from("other")) })), 400, "digest_mismatch");
	});

	it("a valid signature from an unpinned key under a paired node id is rejected", async () => {
		const forged = forgeSigned({ ...mallory.signer, nodeId: alice.identity.nodeId, keyId: alice.signer.keyId }, { method: "POST", path: "/api/v1/tasks", host: HOST, timestamp: NOW, idempotencyKey: "idem-1" });
		expectFail(await verify(forged), 401, "bad_signature");
	});
});

describe("verifyRequest: peer and key checks", () => {
	it("unknown sender → 401 unknown_peer", async () => {
		expectFail(await verify(original(), { lookupPeer: registry() }), 401, "unknown_peer");
	});

	it("revoked peer → 403 peer_revoked, even with a perfect signature", async () => {
		expectFail(await verify(original(), { lookupPeer: registry(alice.peerKey({ revoked: true })) }), 403, "peer_revoked");
	});

	it("key id other than the pinned one → 401 key_mismatch", async () => {
		expectFail(await verify(original(), { lookupPeer: registry(alice.peerKey({ keyId: "ffffffffffffffff" })) }), 401, "key_mismatch");
	});

	it("a different key under the same node id (key swap) is key_mismatch when it claims its own key id", async () => {
		const swapped = forgeSigned({ ...mallory.signer, nodeId: alice.identity.nodeId }, { method: "GET", path: "/api/v1/agents", host: HOST, timestamp: NOW });
		expectFail(await verify(swapped), 401, "key_mismatch");
	});
});

describe("verifyRequest: clock skew", () => {
	it("allows exactly the skew window in both directions", async () => {
		expect((await verify(original({ timestamp: NOW - 60_000 }))).ok).toBe(true);
		expect((await verify(original({ timestamp: NOW + 60_000 }))).ok).toBe(true);
	});

	it("rejects a timestamp too far in the past or the future with serverTime", async () => {
		const past = expectFail(await verify(original({ timestamp: NOW - 60_001 })), 401, "clock_skew");
		expect(past.details).toEqual({ serverTime: NOW, maxSkewMs: 60_000 });
		const future = expectFail(await verify(original({ timestamp: NOW + 60_001 })), 401, "clock_skew");
		expect(future.details).toEqual({ serverTime: NOW, maxSkewMs: 60_000 });
	});

	it("honors a configured skew", async () => {
		expect((await verify(original({ timestamp: NOW - 200_000 }), { skewMs: 300_000 })).ok).toBe(true);
		expectFail(await verify(original({ timestamp: NOW - 31_000 }), { skewMs: 30_000 }), 401, "clock_skew");
	});
});

describe("verifyRequest: replay window", () => {
	it("rejects the same nonce twice with 409 replayed_request", async () => {
		const nonces = new MemoryNonceStore({ now: () => NOW });
		const input = original();
		expect((await verify(input, { nonces })).ok).toBe(true);
		expectFail(await verify(input, { nonces }), 409, "replayed_request");
	});

	it("records (peer, nonce) until skew × 2 from now", async () => {
		const calls: Array<[string, string, number]> = [];
		const nonces: NonceStore = { checkAndRemember: (peerId, nonce, expiresAtMs) => (calls.push([peerId, nonce, expiresAtMs]), true) };
		await verify(original({ nonce: toBase64Url(Buffer.alloc(16, 3)) }), { nonces });
		await verify(original({ nonce: toBase64Url(Buffer.alloc(16, 4)) }), { nonces, skewMs: 30_000 });
		expect(calls).toEqual([
			[alice.identity.nodeId, toBase64Url(Buffer.alloc(16, 3)), NOW + 120_000],
			[alice.identity.nodeId, toBase64Url(Buffer.alloc(16, 4)), NOW + 60_000],
		]);
	});

	it("a replayed request is rejected before its body is examined", async () => {
		const nonces = new MemoryNonceStore({ now: () => NOW });
		const input = original();
		await verify(input, { nonces });
		expectFail(await verify({ ...input, bodyBytes: Buffer.from("tampered") }, { nonces }), 409, "replayed_request");
	});

	it("is checked after the peer lookup and skew checks (no state recorded for those failures)", async () => {
		const calls: string[] = [];
		const nonces: NonceStore = { checkAndRemember: (_p, n) => (calls.push(n), true) };
		await verify(original(), { nonces, lookupPeer: registry() });
		await verify(original({ timestamp: NOW - 120_000 }), { nonces });
		await verify(withHeaders(original(), { "x-clam-version": "9" }), { nonces });
		expect(calls).toEqual([]);
	});
});

describe("MemoryNonceStore", () => {
	it("forgets a nonce once it expires and prunes old entries", () => {
		let now = 1_000;
		const store = new MemoryNonceStore({ now: () => now });
		expect(store.checkAndRemember("p", "n1", 1_100)).toBe(true);
		expect(store.checkAndRemember("p", "n1", 1_100)).toBe(false);
		expect(store.checkAndRemember("p", "n2", 5_000)).toBe(true);
		expect(store.size).toBe(2);
		now = 1_100;
		expect(store.size).toBe(1);
		expect(store.checkAndRemember("p", "n1", 9_000)).toBe(true);
		expect(store.checkAndRemember("p", "n1", 9_000)).toBe(false);
	});

	it("scopes nonces per peer", () => {
		const store = new MemoryNonceStore({ now: () => 0 });
		expect(store.checkAndRemember("a", "n", 10)).toBe(true);
		expect(store.checkAndRemember("b", "n", 10)).toBe(true);
		expect(store.checkAndRemember("a", "n", 10)).toBe(false);
	});

	it("prunes entries hidden behind a longer-lived one on the periodic sweep", () => {
		let now = 0;
		const store = new MemoryNonceStore({ now: () => now });
		store.checkAndRemember("p", "long", 1_000_000);
		for (let i = 0; i < 100; i++) store.checkAndRemember("p", `short-${i}`, 10);
		now = 31_000;
		expect(store.size).toBe(1);
	});
});

describe("verifyRequest: protocol version", () => {
	it("missing or unsupported version → 426 unsupported_version listing the supported ones", async () => {
		for (const version of [undefined, "2", "0", "abc", "1.0", "01x"]) {
			const failure = expectFail(await verify(withHeaders(original(), { "x-clam-version": version })), 426, "unsupported_version");
			expect(failure.details).toEqual({ supportedVersions: [1] });
		}
	});

	it("accepts any configured version", async () => {
		expect((await verify(withHeaders(original(), { "x-clam-version": "2" }), { supportedVersions: [1, 2] })).ok).toBe(true);
	});
});

describe("verifyRequest: header syntax and duplicates", () => {
	const required = ["x-clam-node-id", "x-clam-key-id", "x-clam-timestamp", "x-clam-nonce", "x-request-id", "x-correlation-id", "content-digest", "x-clam-signature"];
	for (const name of required) {
		it(`missing ${name} → 400 invalid_request`, async () => {
			expectFail(await verify(withHeaders(original(), { [name]: undefined })), 400, "invalid_request");
		});
	}

	it("malformed values → 400 invalid_request", async () => {
		const bad: Array<Record<string, string>> = [
			{ "x-clam-nonce": "short" },
			{ "x-clam-timestamp": "yesterday" },
			{ "x-clam-timestamp": "-5" },
			{ "x-clam-key-id": "NOTHEX" },
			{ "x-clam-node-id": "node with space" },
			{ "content-digest": `sha-512=:${Buffer.alloc(64).toString("base64")}:` },
			{ "x-clam-signature": toBase64Url(Buffer.alloc(63)) },
			{ "x-correlation-id": "has space" },
			{ "x-request-id": "" },
			{ "idempotency-key": "a,b" },
			{ "idempotency-key": "k".repeat(129) },
		];
		for (const change of bad) expectFail(await verify(withHeaders(original(), change)), 400, "invalid_request");
	});

	it("a header delivered twice (array form) → 400 invalid_request", async () => {
		for (const name of ["x-clam-nonce", "x-clam-signature", "x-clam-node-id", "idempotency-key", "content-digest", "x-clam-version", "x-clam-timestamp"]) {
			const input = original();
			const value = input.headers[name] as string;
			expectFail(await verify(withHeaders(input, { [name]: [value, value] })), 400, "invalid_request");
		}
	});

	it("a header that differs only in case from another copy → 400 invalid_request", async () => {
		const input = original();
		const dup = { ...input, headers: { ...input.headers, "X-Clam-Nonce": toBase64Url(Buffer.alloc(16, 5)) } };
		expectFail(await verify(dup), 400, "invalid_request");
	});

	it("a comma-joined duplicate (how node:http folds repeated headers) → 400 invalid_request", async () => {
		const input = original();
		const joined = `${input.headers["x-clam-nonce"]}, ${toBase64Url(Buffer.alloc(16, 5))}`;
		expectFail(await verify(withHeaders(input, { "x-clam-nonce": joined })), 400, "invalid_request");
	});

	it("a single-element array is the same as a string", async () => {
		const input = original();
		expect((await verify(withHeaders(input, { "x-clam-nonce": [input.headers["x-clam-nonce"] as string] }))).ok).toBe(true);
	});

	it("rejects a malformed request target", async () => {
		expectFail(await verify({ ...original(), host: "" }), 400, "invalid_request");
		expectFail(await verify({ ...original(), path: "api/v1/tasks" }), 400, "invalid_request");
	});

	it("requires Idempotency-Key on a mutating request, but only after the signature is proven", async () => {
		const noKey = forgeSigned(alice.signer, { method: "POST", path: "/api/v1/tasks", host: HOST, timestamp: NOW });
		expectFail(await verify(noKey), 400, "invalid_request");
		const tampered = withHeaders(noKey, { "x-clam-signature": toBase64Url(Buffer.alloc(64, 2)) });
		expectFail(await verify(tampered), 401, "bad_signature");
	});
});

describe("verifyRequest: verification order (protocol §3)", () => {
	const badSignature = (i: VerifyInput) => withHeaders(i, { "x-clam-signature": toBase64Url(Buffer.alloc(64, 1)) });

	it("skewed AND bad signature → clock_skew", async () => {
		expectFail(await verify(badSignature(original({ timestamp: NOW - 10 * 60_000 }))), 401, "clock_skew");
	});

	it("skewed AND bad digest → clock_skew", async () => {
		expectFail(await verify({ ...original({ timestamp: NOW + 10 * 60_000 }), bodyBytes: Buffer.from("x") }), 401, "clock_skew");
	});

	it("unsupported version beats everything below it", async () => {
		const input = badSignature(withHeaders(original({ timestamp: NOW - 10 * 60_000 }), { "x-clam-version": "7" }));
		expectFail(await verify(input, { lookupPeer: registry() }), 426, "unsupported_version");
	});

	it("unknown peer beats skew and signature problems", async () => {
		expectFail(await verify(badSignature(original({ timestamp: NOW - 10 * 60_000 })), { lookupPeer: registry() }), 401, "unknown_peer");
	});

	it("revoked beats key mismatch and skew", async () => {
		const peer = alice.peerKey({ revoked: true, keyId: "ffffffffffffffff" });
		expectFail(await verify(original({ timestamp: NOW - 10 * 60_000 }), { lookupPeer: registry(peer) }), 403, "peer_revoked");
	});

	it("key mismatch beats skew", async () => {
		expectFail(await verify(original({ timestamp: NOW - 10 * 60_000 }), { lookupPeer: registry(alice.peerKey({ keyId: "ffffffffffffffff" })) }), 401, "key_mismatch");
	});

	it("replay beats digest and signature problems", async () => {
		const nonces = new MemoryNonceStore({ now: () => NOW });
		const input = original();
		await verify(input, { nonces });
		expectFail(await verify(badSignature({ ...input, bodyBytes: Buffer.from("x") }), { nonces }), 409, "replayed_request");
	});

	it("digest mismatch beats a bad signature", async () => {
		expectFail(await verify(badSignature({ ...original(), bodyBytes: Buffer.from("x") })), 400, "digest_mismatch");
	});
});
