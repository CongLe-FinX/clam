import { describe, expect, it } from "vitest";
import { hasCapabilities, isAllowedPeerUrl, normalizePeerUrl } from "../src/index.ts";

const strict = { allowLoopbackHttp: false };
const dev = { allowLoopbackHttp: true };

describe("peer URL policy", () => {
	it("always accepts https origins (tunnel hostnames, LAN names, ports)", () => {
		for (const url of ["https://agent-a.example.com", "https://abc-def.trycloudflare.com/", "https://node.lan:8443", "https://[2001:db8::1]:8443", "https://localhost", "https://127.0.0.1:9"]) {
			expect(isAllowedPeerUrl(url, strict)).toBe(true);
			expect(isAllowedPeerUrl(url, dev)).toBe(true);
		}
	});

	it("rejects plain http unless it is loopback AND loopback peers are enabled", () => {
		for (const url of ["http://127.0.0.1:4318", "http://localhost:4318", "http://[::1]:4318", "http://127.0.0.1", "http://LOCALHOST:1"]) {
			expect(isAllowedPeerUrl(url, strict)).toBe(false);
			expect(isAllowedPeerUrl(url, dev)).toBe(true);
		}
		for (const url of ["http://example.com", "http://192.168.1.10:4318", "http://10.0.0.1", "http://127.0.0.2:4318", "http://localhost.evil.com", "http://127.0.0.1.evil.com", "http://0.0.0.0:80", "http://agent.trycloudflare.com"]) {
			expect(isAllowedPeerUrl(url, strict)).toBe(false);
			expect(isAllowedPeerUrl(url, dev)).toBe(false);
		}
	});

	it("rejects other schemes, garbage, credentials, queries and fragments", () => {
		for (const url of ["ftp://example.com", "ws://127.0.0.1", "file:///etc/passwd", "javascript:alert(1)", "", "not a url", "example.com", "//example.com", "https://user:pw@example.com", "https://user@example.com", "https://example.com?x=1", "https://example.com/#frag", "https://example.com/other", "https://example.com/api/v2"]) {
			expect(isAllowedPeerUrl(url, dev)).toBe(false);
		}
	});

	it("normalizes to the origin and tolerates a trailing /api/v1", () => {
		expect(normalizePeerUrl("https://Agent-A.Example.com:443/", strict)).toBe("https://agent-a.example.com");
		expect(normalizePeerUrl("https://agent-a.example.com/api/v1", strict)).toBe("https://agent-a.example.com");
		expect(normalizePeerUrl("https://agent-a.example.com/api/v1/", strict)).toBe("https://agent-a.example.com");
		expect(normalizePeerUrl("http://127.0.0.1:4318/", dev)).toBe("http://127.0.0.1:4318");
		expect(normalizePeerUrl("http://127.0.0.1:4318", strict)).toBeNull();
	});
});

describe("hasCapabilities", () => {
	it("requires every needed capability", () => {
		expect(hasCapabilities(["agents.read", "tasks.send"], ["agents.read"])).toBe(true);
		expect(hasCapabilities(["agents.read", "tasks.send"], ["agents.read", "tasks.send"])).toBe(true);
		expect(hasCapabilities(["agents.read"], ["agents.read", "tasks.send"])).toBe(false);
		expect(hasCapabilities([], ["events.read"])).toBe(false);
		expect(hasCapabilities(["agents.read"], [])).toBe(true);
		expect(hasCapabilities([], [])).toBe(true);
	});
});
