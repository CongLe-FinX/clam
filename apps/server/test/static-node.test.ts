import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, NodeHealth, NodeInfo, NodeSettings, SecurityInfo, TunnelState } from "@clam/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { api, createFullHarness, type FullHarness } from "./full-harness.ts";

let full: FullHarness | undefined;
let dist: string | undefined;
afterEach(async () => {
	await full?.cleanup();
	if (dist) rmSync(dist, { recursive: true, force: true });
	full = undefined;
	dist = undefined;
});

function makeDist(): string {
	const dir = mkdtempSync(join(tmpdir(), "clam-dist-"));
	mkdirSync(join(dir, "assets"));
	writeFileSync(join(dir, "index.html"), '<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/app.abc123.js"></script></body></html>');
	writeFileSync(join(dir, "assets", "app.abc123.js"), `console.log("${"x".repeat(5000)}");`);
	writeFileSync(join(dir, "favicon.svg"), "<svg/>");
	return dir;
}

describe("static web serving", () => {
	it("serves the SPA with immutable hashed assets, revalidating index and router fallback", async () => {
		dist = makeDist();
		full = await createFullHarness({ webDistDir: dist });

		const index = await fetch(`${full.url}/`);
		expect(index.status).toBe(200);
		expect(index.headers.get("cache-control")).toBe("no-cache");
		expect(index.headers.get("content-type")).toContain("text/html");
		expect(index.headers.get("x-content-type-options")).toBe("nosniff");
		expect(index.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");

		const asset = await fetch(`${full.url}/assets/app.abc123.js`, { headers: { "accept-encoding": "gzip" } });
		expect(asset.status).toBe(200);
		expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
		expect(asset.headers.get("content-encoding")).toBe("gzip");
		expect(await asset.text()).toContain("console.log");

		const fav = await fetch(`${full.url}/favicon.svg`);
		expect(fav.status).toBe(200);
		expect(fav.headers.get("cache-control")).toBe("no-cache");

		const route = await fetch(`${full.url}/workspaces/abc/projects`);
		expect(route.status).toBe(200);
		expect(await route.text()).toContain('<div id="root">');
		expect(route.headers.get("cache-control")).toBe("no-cache");

		expect((await fetch(`${full.url}/assets/missing.js`)).status).toBe(404);
		const unknownApi = await fetch(`${full.url}/api/local/nope`);
		expect(unknownApi.status).toBe(404);
		expect(await unknownApi.json()).toMatchObject({ error: { code: "not_found" } });
		expect((await fetch(`${full.url}/api/local/node`)).headers.get("content-type")).toContain("application/json");
	});

	it("does not escape the dist root", async () => {
		dist = makeDist();
		full = await createFullHarness({ webDistDir: dist });
		const res = await fetch(`${full.url}/%2e%2e/%2e%2e/etc/passwd`);
		expect(await res.text()).not.toContain("root:");
	});

	it("serves only the API when no web build exists", async () => {
		full = await createFullHarness();
		expect((await fetch(`${full.url}/`)).status).toBe(404);
		expect((await fetch(`${full.url}/api/local/health`)).status).toBe(200);
	});
});

describe("request parsing", () => {
	it("treats an empty JSON body as no body and rejects malformed JSON with 400", async () => {
		full = await createFullHarness();
		const empty = await fetch(`${full.url}/api/local/sessions/ses_none/abort`, { method: "POST", headers: { "content-type": "application/json" } });
		expect(empty.status).toBe(404); // reached the handler (unknown session) instead of FST_ERR_CTP_EMPTY_JSON_BODY
		const bad = await fetch(`${full.url}/api/local/workspaces`, { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" });
		expect(bad.status).toBe(400);
		expect(await bad.json()).toMatchObject({ error: { code: expect.any(String) } });
		const missing = await fetch(`${full.url}/api/local/workspaces`, { method: "POST", headers: { "content-type": "application/json" } });
		expect(missing.status).toBe(400);
	});
});

describe("node routes", () => {
	it("reports identity, health, security and tunnel detection", async () => {
		full = await createFullHarness();
		const http = api(full);
		const node = (await http.get<NodeInfo>("/node")).body;
		expect(node).toMatchObject({ id: full.ctx.identity.nodeId, fingerprint: full.ctx.identity.fingerprint, bindAddress: "127.0.0.1", port: full.port, dataDir: full.dataDir, version: "0.0.0-test" });
		expect(node.fingerprint).toMatch(/^[0-9a-f]{64}$/);

		const health = (await http.get<NodeHealth>("/health")).body;
		expect(health.status).toBe("ok");
		expect(health.checks.map((c) => c.name)).toEqual(["database", "omp", "runtime"]);
		expect(health.checks.find((c) => c.name === "omp")?.message).toContain("fake");

		const security = (await http.get<SecurityInfo>("/security")).body;
		expect(security).toMatchObject({ remoteApiEnabled: false, allowedHosts: ["localhost", "127.0.0.1", "[::1]"], secretStore: { backend: "encrypted-file" } });

		const tunnel = (await http.get<TunnelState>("/tunnel")).body;
		expect(typeof tunnel.cloudflared.installed).toBe("boolean");
		expect(tunnel.cloudflared.binaryPath === null).toBe(!tunnel.cloudflared.installed);
		expect(tunnel).toMatchObject({ config: { mode: "off", hostname: null, hasToken: false, autoStart: false }, state: "stopped", publicUrl: null, pid: null, connections: 0 });
	});

	it("persists node settings, validates them and applies supervisor limits live", async () => {
		full = await createFullHarness();
		const http = api(full);
		const defaults = (await http.get<NodeSettings>("/settings")).body;
		expect(defaults).toMatchObject({ runtimeIdleTimeoutMin: 30, maxConcurrentRuntimes: 4, approvalMode: "yolo", autoStart: false });

		const patched = await http.patch<NodeSettings>("/settings", { nodeName: "Studio", maxConcurrentRuntimes: 1, approvalMode: "write" });
		expect(patched.body).toMatchObject({ nodeName: "Studio", maxConcurrentRuntimes: 1, approvalMode: "write" });
		expect((await http.get<NodeSettings>("/settings")).body.nodeName).toBe("Studio");
		expect((await http.get<NodeInfo>("/node")).body.name).toBe("Studio");

		expect(full.ctx.db.$client.prepare("select payload from node_events where type = 'settings.updated'").get()).toEqual({
			payload: JSON.stringify({ changed: ["nodeName", "maxConcurrentRuntimes", "approvalMode"] }),
		});

		expect((await http.patch("/settings", { maxConcurrentRuntimes: 0 })).status).toBe(400);
		expect((await http.patch("/settings", { approvalMode: "reckless" })).status).toBe(400);
		expect((await http.patch("/settings", { nodeName: "" })).status).toBe(400);
		expect((await http.get<NodeSettings>("/settings")).body.maxConcurrentRuntimes).toBe(1);

		// The cap of 1 is now enforced: with the first runtime busy a second session cannot start.
		const ws = (await http.post<{ id: string }>("/workspaces", { name: "W" })).body;
		const project = (await http.post<{ id: string }>("/projects", { workspaceId: ws.id, name: "P", path: full.projectDir })).body;
		const a = (await http.post<{ id: string }>("/sessions", { projectId: project.id })).body;
		const b = (await http.post<{ id: string }>("/sessions", { projectId: project.id })).body;
		await http.post(`/sessions/${a.id}/prompt`, { message: "__slow__", clientId: "x" });
		const blocked = await http.get<{ error: { code: string } }>(`/sessions/${b.id}/state`);
		expect(blocked.status).toBe(503);
		expect(blocked.body.error.code).toBe("runtime_capacity");
		await http.post(`/sessions/${a.id}/abort`);
	});

	it("registers the default OMP agent and lets it be edited; status follows OMP availability and runtime activity", async () => {
		full = await createFullHarness();
		const http = api(full);
		const [agent] = (await http.get<Agent[]>("/agents")).body;
		expect(agent).toMatchObject({ name: "OMP Agent", runtime: "omp", status: "online", activeSessions: 0, nodeId: full.ctx.identity.nodeId });
		const edited = await http.patch<Agent>(`/agents/${agent?.id}`, { name: "Backend", role: "API", capabilities: ["go"] });
		expect(edited.body).toMatchObject({ name: "Backend", role: "API", capabilities: ["go"] });
		expect((await http.patch(`/agents/nope`, { name: "x" })).status).toBe(404);
		expect((await http.patch(`/agents/${agent?.id}`, { name: "" })).status).toBe(400);

		const ws = (await http.post<{ id: string }>("/workspaces", { name: "W" })).body;
		const project = (await http.post<{ id: string }>("/projects", { workspaceId: ws.id, name: "P", path: full.projectDir })).body;
		const session = (await http.post<{ id: string }>("/sessions", { projectId: project.id })).body;
		await http.post(`/sessions/${session.id}/prompt`, { message: "__slow__", clientId: "x" });
		const deadline = Date.now() + 5000;
		let busy: Agent | undefined;
		while (Date.now() < deadline) {
			busy = (await http.get<Agent[]>("/agents")).body[0];
			if (busy?.status === "busy") break;
			await new Promise((r) => setTimeout(r, 25));
		}
		expect(busy).toMatchObject({ status: "busy", activeSessions: 1 });
		await http.post(`/sessions/${session.id}/abort`);
	});
});
