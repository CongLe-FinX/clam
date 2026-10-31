import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "./helpers.ts";
import workspaceRoutes from "../src/api/workspaces.ts";
import { hostnameOf, isLocalHostHeader, isLocalOrigin } from "../src/http/host-guard.ts";
import { createFullHarness, type FullHarness } from "./full-harness.ts";

let harness: TestHarness | undefined;
let full: FullHarness | undefined;
afterEach(async () => {
	await harness?.cleanup();
	await full?.cleanup();
	harness = undefined;
	full = undefined;
});

describe("Host guard", () => {
	it("serves localhost, 127.0.0.1 and [::1] hosts (with or without port)", async () => {
		harness = await createTestHarness({ plugins: [workspaceRoutes] });
		for (const host of ["localhost", "localhost:4317", "127.0.0.1", "127.0.0.1:5173", "[::1]", "[::1]:4317", "LOCALHOST:4317"]) {
			const res = await harness.app.inject({ method: "GET", url: "/api/local/workspaces", headers: { host } });
			expect(res.statusCode, host).toBe(200);
		}
	});

	it("rejects foreign, spoofed and missing hosts with 403 forbidden_host", async () => {
		harness = await createTestHarness({ plugins: [workspaceRoutes] });
		for (const host of ["evil.com", "evil.com:4317", "localhost.evil.com", "127.0.0.1.evil.com", "evil.localhost", "192.168.1.5:4317", "[::2]", "0.0.0.0:4317", "localhost@evil.com"]) {
			const res = await harness.app.inject({ method: "GET", url: "/api/local/workspaces", headers: { host } });
			expect(res.statusCode, host).toBe(403);
			expect(res.json()).toMatchObject({ error: { code: "forbidden_host" } });
		}
	});

	it("rejects a foreign Origin on any request and allows local origins on any port", async () => {
		harness = await createTestHarness({ plugins: [workspaceRoutes] });
		const foreign = await harness.app.inject({ method: "GET", url: "/api/local/workspaces", headers: { host: "localhost", origin: "https://evil.example" } });
		expect(foreign.statusCode).toBe(403);
		expect(foreign.json()).toMatchObject({ error: { code: "forbidden_origin" } });
		const nullOrigin = await harness.app.inject({ method: "POST", url: "/api/local/workspaces", headers: { host: "localhost", origin: "null", "content-type": "application/json" }, payload: { name: "x" } });
		expect(nullOrigin.statusCode).toBe(403);
		for (const origin of ["http://localhost:5337", "http://127.0.0.1:4317", "http://[::1]:5173"]) {
			const ok = await harness.app.inject({ method: "GET", url: "/api/local/workspaces", headers: { host: "localhost", origin } });
			expect(ok.statusCode, origin).toBe(200);
		}
	});

	it("parses hosts and origins strictly", () => {
		expect(hostnameOf("[::1]:80")).toBe("[::1]");
		expect(hostnameOf("Example.COM:80")).toBe("example.com");
		expect(hostnameOf("")).toBeNull();
		expect(hostnameOf("[::1")).toBeNull();
		expect(isLocalHostHeader(undefined)).toBe(false);
		expect(isLocalOrigin("file:///etc/passwd")).toBe(false);
		expect(isLocalOrigin("not a url")).toBe(false);
		expect(isLocalOrigin("http://localhost:1")).toBe(true);
	});
});

describe("WebSocket upgrade guard", () => {
	function upgrade(port: number, headers: Record<string, string>): Promise<{ status: number | "upgraded" }> {
		const { promise, resolve, reject } = Promise.withResolvers<{ status: number | "upgraded" }>();
		const req = request({
			host: "127.0.0.1",
			port,
			path: "/ws",
			// A pooled keep-alive socket cannot be reused for an Upgrade request.
			agent: false,
			headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers },
		});
		req.on("upgrade", (_res, socket) => {
			socket.destroy();
			resolve({ status: "upgraded" });
		});
		req.on("response", (res) => {
			res.resume();
			resolve({ status: res.statusCode ?? 0 });
		});
		req.on("error", reject);
		req.end();
		return promise;
	}

	it("refuses upgrades with a foreign Origin or Host and accepts local ones", async () => {
		full = await createFullHarness();
		expect(await upgrade(full.port, { Origin: "https://evil.example" })).toEqual({ status: 403 });
		expect(await upgrade(full.port, { Host: "evil.com" })).toEqual({ status: 403 });
		expect(await upgrade(full.port, { Origin: `http://localhost:${full.port}` })).toEqual({ status: "upgraded" });
		expect(await upgrade(full.port, {})).toEqual({ status: "upgraded" });
	});
});
