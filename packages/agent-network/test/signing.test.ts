import { verifySignature } from "@clam/node-identity";
import { afterAll, describe, expect, it } from "vitest";
import {
	API_PREFIX,
	canonicalQuery,
	canonicalString,
	contentDigest,
	FORMAT,
	fromBase64Url,
	hostOf,
	normalizeHost,
	signRequest,
	signerFromIdentity,
	ulid,
} from "../src/index.ts";
import { cleanupIdentities, makeNode } from "./helpers.ts";

afterAll(cleanupIdentities);

describe("canonicalQuery", () => {
	it("sorts by key then value and keeps duplicate keys", () => {
		expect(canonicalQuery("b=2&a=2&a=1&c=")).toBe("a=1&a=2&b=2&c=");
		expect(canonicalQuery("z=1&z=0&z=3")).toBe("z=0&z=1&z=3");
	});

	it("is independent of the original pair order and a leading ?", () => {
		expect(canonicalQuery("?x=1&y=2")).toBe(canonicalQuery("y=2&x=1"));
	});

	it("percent-encodes per RFC 3986 with upper-case hex and decodes unreserved escapes", () => {
		expect(canonicalQuery("q=a b")).toBe("q=a%20b");
		expect(canonicalQuery("q=a%20b")).toBe("q=a%20b");
		expect(canonicalQuery("q=%7e%41%2d")).toBe("q=~A-");
		expect(canonicalQuery("q=%2f%3a")).toBe("q=%2F%3A");
		expect(canonicalQuery("q=é")).toBe("q=%C3%A9");
		expect(canonicalQuery("q=%c3%a9")).toBe("q=%C3%A9");
	});

	it("treats + as a literal plus (never as a space) and keeps invalid escapes literal", () => {
		expect(canonicalQuery("q=a+b")).toBe("q=a%2Bb");
		expect(canonicalQuery("q=a+b")).not.toBe(canonicalQuery("q=a%20b"));
		expect(canonicalQuery("q=100%")).toBe("q=100%25");
		expect(canonicalQuery("q=%zz")).toBe("q=%25zz");
	});

	it("decodes exactly once", () => {
		expect(canonicalQuery("q=%2541")).toBe("q=%2541");
	});

	it("normalizes keys, bare keys and empty segments", () => {
		expect(canonicalQuery("a&&b=1&")).toBe("a=&b=1");
		expect(canonicalQuery("k%20ey=v")).toBe("k%20ey=v");
		expect(canonicalQuery("")).toBe("");
		expect(canonicalQuery("?")).toBe("");
	});
});

describe("host normalization", () => {
	it("lower-cases and drops default ports", () => {
		expect(normalizeHost("Example.COM")).toBe("example.com");
		expect(normalizeHost("Example.COM:443")).toBe("example.com");
		expect(normalizeHost("example.com:80")).toBe("example.com");
		expect(normalizeHost("127.0.0.1:4318")).toBe("127.0.0.1:4318");
		expect(normalizeHost("[::1]:4318")).toBe("[::1]:4318");
	});

	it("hostOf is exactly the host signRequest binds", () => {
		expect(hostOf("https://Agent-A.Example.com:443/api/v1/x")).toBe("agent-a.example.com");
		expect(hostOf("https://agent-a.example.com/api/v1/x")).toBe("agent-a.example.com");
		expect(hostOf("http://127.0.0.1:4318/api/v1/x")).toBe("127.0.0.1:4318");
		expect(hostOf(new URL("https://x.trycloudflare.com/a"))).toBe("x.trycloudflare.com");
	});
});

describe("content digest", () => {
	it("is sha-256 in RFC 9530 form, and the empty body has the digest of the empty string", () => {
		expect(contentDigest(new Uint8Array())).toBe("sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:");
		expect(contentDigest(Buffer.from("abc"))).toBe("sha-256=:ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=:");
		expect(contentDigest(Buffer.from("abc"))).toMatch(FORMAT.contentDigest);
	});
});

describe("ulid", () => {
	it("is 26 Crockford chars, unique, and strictly increasing within a millisecond", () => {
		const ids = Array.from({ length: 500 }, () => ulid(1_700_000_000_000));
		for (const id of ids) expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
		expect(new Set(ids).size).toBe(500);
		expect([...ids].sort()).toEqual(ids);
	});

	it("encodes the time in the first 10 chars so ids sort by creation time", () => {
		const earlier = ulid(1_000_000_000_000);
		const later = ulid(1_000_000_000_001);
		expect(earlier.slice(0, 10) < later.slice(0, 10)).toBe(true);
		expect(ulid(0).slice(0, 10)).toBe("0000000000");
	});
});

describe("signRequest", () => {
	const node = makeNode();
	const url = "https://Agent-B.Example.com/api/v1/tasks/tsk_1/cancel?b=2&a=1";

	it("emits every protocol header and a signature over the canonical string", () => {
		const body = Buffer.from('{"epoch":0}');
		const headers = signRequest(node.signer, { method: "post", url, bodyBytes: body, idempotencyKey: "idem-1", correlationId: "corr-1", requestId: "req-1", now: 1_760_000_000_123 });
		expect(headers).toMatchObject({
			"X-Clam-Version": "1",
			"X-Clam-Node-Id": node.identity.nodeId,
			"X-Clam-Key-Id": node.identity.fingerprint.slice(0, 16),
			"X-Clam-Timestamp": "1760000000123",
			"X-Request-Id": "req-1",
			"X-Correlation-Id": "corr-1",
			"Idempotency-Key": "idem-1",
			"Content-Digest": contentDigest(body),
		});
		expect(headers["X-Clam-Nonce"]).toMatch(FORMAT.nonce);
		expect(fromBase64Url(headers["X-Clam-Nonce"] as string)?.length).toBe(16);
		const signature = fromBase64Url(headers["X-Clam-Signature"] as string);
		expect(signature?.length).toBe(64);

		const canonical = canonicalString({
			method: "POST",
			path: "/api/v1/tasks/tsk_1/cancel",
			rawQuery: "b=2&a=1",
			host: "agent-b.example.com",
			nodeId: node.identity.nodeId,
			keyId: node.signer.keyId,
			timestamp: "1760000000123",
			nonce: headers["X-Clam-Nonce"] as string,
			requestId: "req-1",
			correlationId: "corr-1",
			idempotencyKey: "idem-1",
			contentDigest: contentDigest(body),
		});
		expect(canonical.split("\n")).toEqual([
			"CLAM-SIG-V1",
			"POST",
			"/api/v1/tasks/tsk_1/cancel",
			"a=1&b=2",
			"agent-b.example.com",
			node.identity.nodeId,
			node.signer.keyId,
			"1760000000123",
			headers["X-Clam-Nonce"],
			"req-1",
			"corr-1",
			"idem-1",
			contentDigest(body),
		]);
		expect(verifySignature({ publicKey: node.identity.publicKey, message: canonical, signature: Buffer.from(signature as Uint8Array).toString("base64") })).toBe(true);
	});

	it("uses a fresh nonce and request id for every attempt", () => {
		const attempts = Array.from({ length: 50 }, () => signRequest(node.signer, { method: "GET", url: `https://x.example${API_PREFIX}/a`, bodyBytes: new Uint8Array() }));
		expect(new Set(attempts.map((h) => h["X-Clam-Nonce"])).size).toBe(50);
		expect(new Set(attempts.map((h) => h["X-Request-Id"])).size).toBe(50);
		expect(new Set(attempts.map((h) => h["X-Clam-Signature"])).size).toBe(50);
	});

	it("omits Idempotency-Key when none is given and demands one for mutating methods", () => {
		const get = signRequest(node.signer, { method: "GET", url, bodyBytes: new Uint8Array() });
		expect(get["Idempotency-Key"]).toBeUndefined();
		for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
			expect(() => signRequest(node.signer, { method, url, bodyBytes: new Uint8Array() })).toThrow(/Idempotency-Key/);
		}
	});

	it("rejects header values the receiver would refuse", () => {
		expect(() => signRequest(node.signer, { method: "POST", url, bodyBytes: new Uint8Array(), idempotencyKey: "has space" })).toThrow();
		expect(() => signRequest(node.signer, { method: "POST", url, bodyBytes: new Uint8Array(), idempotencyKey: "x".repeat(129) })).toThrow();
		expect(() => signRequest(node.signer, { method: "GET", url, bodyBytes: new Uint8Array(), correlationId: "a\nb" })).toThrow();
	});

	it("signerFromIdentity derives the key id from the fingerprint", () => {
		const signer = signerFromIdentity(node.identity);
		expect(signer.nodeId).toBe(node.identity.nodeId);
		expect(signer.keyId).toBe(node.identity.fingerprint.slice(0, 16));
		expect(signer.publicKey).toBe(node.identity.publicKey);
		const signature = signer.sign(Buffer.from("m"));
		expect(signature.length).toBe(64);
		expect(verifySignature({ publicKey: signer.publicKey, message: "m", signature: Buffer.from(signature).toString("base64") })).toBe(true);
	});
});
