import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NodeInfo, SecurityInfo, TunnelState } from "@clam/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { NetworkOptions } from "../src/network/index.ts";
import { createFullHarness, api, createMemorySecrets, type FullHarness } from "./full-harness.ts";
import { FakeTunnelManager } from "./fake-tunnel.ts";
import { FAST, eventually, pair, peerOf } from "./net-helpers.ts";

const nodes: FullHarness[] = [];
afterEach(async () => {
	for (const n of nodes.splice(0)) await n.cleanup();
});

async function nodeWithTunnel(url: string | null, extra: { dataDir?: string; port?: number; secrets?: ReturnType<typeof createMemorySecrets>; options?: NetworkOptions } = {}) {
	const fake = new FakeTunnelManager();
	fake.url = url;
	const n = await createFullHarness({
		dataDir: extra.dataDir,
		secrets: extra.secrets,
		network: { port: extra.port, options: { ...FAST, createTunnelManager: () => fake, dnsWaitMs: 100, ...extra.options } },
	});
	nodes.push(n);
	return { n, fake };
}

const TOKEN = "eyJhIjoiY2xhbSIsInQiOiIxMjM0NTY3ODkwIiwicyI6InNlY3JldC1zZWNyZXQifQ==";

interface HostAnswer {
	status: number;
	body: { error?: { code?: string; message?: string; i18n?: { key: string; params?: Record<string, unknown> } } };
}

/** `GET /api/v1/node/info` on the network listener with an explicit Host header: status + parsed body. */
function hostRequest(n: FullHarness, host: string): Promise<HostAnswer> {
	const { promise, resolve, reject } = Promise.withResolvers<HostAnswer>();
	const req = request({ host: "127.0.0.1", port: n.netPort, path: "/api/v1/node/info", headers: { Host: host } }, (res) => {
		const chunks: Buffer[] = [];
		res.on("data", (c: Buffer) => chunks.push(c));
		res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as HostAnswer["body"] }));
	});
	req.on("error", reject);
	req.end();
	return promise;
}

/** A stand-in for the internet: what `https://<hostname>/api/v1/node/info` answers (nothing, this node, or some other node). */
class FakeInternet {
	answers: "none" | "us" | "stranger" = "none";
	readonly calls: string[] = [];
	/** Set once the node under test exists. */
	us: { nodeId: string; fingerprint: string } | null = null;

	readonly fetch = (async (input: string | URL | Request) => {
		this.calls.push(String(input));
		if (this.answers === "none" || !this.us) throw new Error("ENOTFOUND");
		return Response.json(this.answers === "us" ? { nodeId: this.us.nodeId, fingerprint: this.us.fingerprint } : { nodeId: "n_stranger", fingerprint: "0".repeat(64) });
	}) as typeof fetch;
}

describe("tunnel service", () => {
	it("starts from the persisted mode, publishes state on the `tunnel` topic and tells the rest of the node the truth", async () => {
		const { n, fake } = await nodeWithTunnel("https://quick-abc.trycloudflare.com");
		const http = api(n);
		const initial = (await http.get<TunnelState>("/tunnel")).body;
		expect(initial).toMatchObject({ config: { mode: "off", hostname: null, hasToken: false, autoStart: false }, state: "stopped", publicUrl: null, networkListener: { host: "127.0.0.1", port: n.netPort } });

		// Starting with the mode still off is a clear refusal, not a silent no-op.
		const refused = await http.post<{ error: { code: string } }>("/tunnel/start");
		expect(refused.status).toBe(409);
		expect(refused.body.error.code).toBe("tunnel_mode_off");

		const configured = await http.put<TunnelState>("/tunnel/config", { mode: "quick", autoStart: true });
		expect(configured.body.config).toMatchObject({ mode: "quick", autoStart: true });
		// Saving with "Start automatically" on starts the stopped tunnel right away; the response already says so.
		expect(configured.body).toMatchObject({ state: "running", publicUrl: "https://quick-abc.trycloudflare.com" });
		expect(fake.starts).toEqual([{ mode: "quick" }]);
		const started = await http.post<TunnelState>("/tunnel/start");
		expect(started.body).toMatchObject({ state: "running", publicUrl: "https://quick-abc.trycloudflare.com", connections: 4, pid: 4242 });
		expect(fake.starts).toEqual([{ mode: "quick" }, { mode: "quick" }]);
		expect(n.ctx.bus.latest("tunnel")?.event).toMatchObject({ type: "state", state: { state: "running", publicUrl: "https://quick-abc.trycloudflare.com" } });

		// NodeInfo, SecurityInfo and the public /node/info reflect the live tunnel.
		expect((await http.get<NodeInfo>("/node")).body.publicUrl).toBe("https://quick-abc.trycloudflare.com");
		expect((await http.get<SecurityInfo>("/security")).body.remoteApiEnabled).toBe(true);
		expect(n.ctx.db.$client.prepare("select public_url from node").get()).toEqual({ public_url: "https://quick-abc.trycloudflare.com" });
		const info = (await (await fetch(`${n.netUrl}/api/v1/node/info`)).json()) as { publicUrl: string };
		expect(info.publicUrl).toBe("https://quick-abc.trycloudflare.com");
		// Invitations point at the tunnel, not at the loopback listener.
		const ws = (await http.post<{ id: string }>("/workspaces", { name: "W" })).body;
		const invitation = (await http.post<{ url: string }>("/network/invitations", { workspaceId: ws.id })).body;
		expect(invitation.url).toBe("https://quick-abc.trycloudflare.com");

		// The network listener accepts the tunnel hostname as Host (and still nothing else).
		const hostStatus = async (host: string) => (await hostRequest(n, host)).status;
		expect(await hostStatus("quick-abc.trycloudflare.com")).toBe(200);
		expect(await hostStatus("other.trycloudflare.com")).toBe(403);

		const stopped = await http.post<TunnelState>("/tunnel/stop");
		expect(stopped.body).toMatchObject({ state: "stopped", publicUrl: null, pid: null });
		expect((await http.get<SecurityInfo>("/security")).body.remoteApiEnabled).toBe(false);
		expect(await hostStatus("quick-abc.trycloudflare.com")).toBe(403);
	});

	it("keeps the named-tunnel token in the secret store only and validates the configuration", async () => {
		const secrets = createMemorySecrets();
		const { n, fake } = await nodeWithTunnel("https://node-a.example.com", { secrets });
		const http = api(n);
		const token = "eyJhIjoiY2xhbSIsInQiOiIxMjM0NTY3ODkwIiwicyI6InNlY3JldC1zZWNyZXQifQ==";
		expect((await http.put("/tunnel/config", { mode: "named" })).status).toBe(400); // no hostname
		expect((await http.put("/tunnel/config", { mode: "named", hostname: "node-a.example.com" })).status).toBe(400); // no token
		expect((await http.put("/tunnel/config", { mode: "named", hostname: "https://node-a.example.com", token })).status).toBe(400); // not a hostname
		expect((await http.put("/tunnel/config", { mode: "named", hostname: "node-a.example.com", token: "short" })).status).toBe(400);

		const saved = await http.put<TunnelState>("/tunnel/config", { mode: "named", hostname: "Node-A.Example.com", token });
		expect(saved.status).toBe(200);
		expect(saved.body.config).toEqual({ mode: "named", hostname: "node-a.example.com", hasToken: true, autoStart: false });
		expect(JSON.stringify(saved.body)).not.toContain(token);
		expect(JSON.stringify((await http.get("/tunnel")).body)).not.toContain(token);
		expect(await secrets.get("tunnel.token")).toBe(token);
		const dump = JSON.stringify(n.ctx.db.$client.prepare("select * from settings").all());
		expect(dump).not.toContain(token);

		await http.post("/tunnel/start");
		expect(fake.starts).toEqual([{ mode: "named", token, hostname: "node-a.example.com" }]);
		// Updating the mode while running restarts onto the saved config; omitting the token keeps it.
		await http.put("/tunnel/config", { mode: "named", hostname: "node-b.example.com" });
		expect(fake.starts.at(-1)).toEqual({ mode: "named", token, hostname: "node-b.example.com" });
		// null deletes the token.
		await http.post("/tunnel/stop");
		const cleared = await http.put<TunnelState>("/tunnel/config", { mode: "quick", token: null });
		expect(cleared.body.config.hasToken).toBe(false);
		expect(await secrets.get("tunnel.token")).toBeNull();
	});

	it("starts the tunnel at boot when autoStart is set", async () => {
		const secrets = createMemorySecrets();
		const first = await nodeWithTunnel("https://boot-1.trycloudflare.com", { secrets });
		await api(first.n).put("/tunnel/config", { mode: "quick", autoStart: true });
		const dir = first.n.dataDir;
		const port = first.n.netPort;
		nodes.splice(nodes.indexOf(first.n), 1);
		await first.n.cleanup({ keepData: true });

		const second = await nodeWithTunnel("https://boot-2.trycloudflare.com", { dataDir: dir, port, secrets });
		const state = await eventually(async () => {
			const s = (await api(second.n).get<TunnelState>("/tunnel")).body;
			return s.state === "running" ? s : null;
		}, "tunnel auto-started");
		expect(state.publicUrl).toBe("https://boot-2.trycloudflare.com");
		expect(second.fake.starts).toEqual([{ mode: "quick" }]);
	});

	it("refuses to start when cloudflared is not installed", async () => {
		const n = await createFullHarness({ network: { options: { ...FAST, cloudflaredBinary: "/nonexistent/cloudflared" } } });
		nodes.push(n);
		await api(n).put("/tunnel/config", { mode: "quick" });
		const state = (await api(n).get<TunnelState>("/tunnel")).body;
		expect(state.cloudflared).toEqual({ installed: false, version: null, binaryPath: null });
		const start = await api(n).post<{ error: { code: string } }>("/tunnel/start");
		expect(start.status).toBe(409);
		expect(start.body.error.code).toBe("cloudflared_not_installed");
	});

	it("announces a new tunnel URL to every peer, which verifies it and keeps the peer online", async () => {
		const { n: a } = await nodeWithTunnel(null);
		const { n: b, fake: tunnelB } = await nodeWithTunnel(null);
		await pair(a, b);
		const moved = b.netUrl.replace("127.0.0.1", "localhost");
		tunnelB.url = moved;
		await api(b).put("/tunnel/config", { mode: "quick" });
		await api(b).post("/tunnel/start"); // B's tunnel came up with a new address: it announces itself
		await eventually(async () => (await peerOf(a, b.ctx.identity.nodeId))?.url === moved, "A stores B's announced URL", 15_000);
		expect((await peerOf(a, b.ctx.identity.nodeId))?.status).toBe("online");
		// B's tunnel restarts again with yet another spelling of the address.
		const again = b.netUrl.replace("127.0.0.1", "[::1]").replace("[::1]", "localhost");
		tunnelB.changeUrl(`${again}`);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect((await peerOf(a, b.ctx.identity.nodeId))?.status).toBe("online");
	});

	it("a named tunnel declares its hostname: the network listener answers for it while CLAM's own connector is stopped, and for nothing else", async () => {
		const { n, fake } = await nodeWithTunnel(null);
		const http = api(n);
		await http.put("/tunnel/config", { mode: "named", hostname: "Node-A.Example.com", token: TOKEN });
		expect((await http.get<TunnelState>("/tunnel")).body).toMatchObject({ state: "stopped", externalConnector: false, publicUrl: null });
		expect(fake.starts).toEqual([]);

		expect(n.ctx.network.tunnel.publicHostname()).toBe("node-a.example.com");
		expect(n.ctx.access.publicOrigins()).toContain("https://node-a.example.com");
		expect((await hostRequest(n, "node-a.example.com")).status).toBe(200);
		expect((await hostRequest(n, "Node-A.Example.com:443")).status).toBe(200);
		expect((await hostRequest(n, "other.example.com")).status).toBe(403);
		expect((await hostRequest(n, "node-a.example.com.evil.com")).status).toBe(403);

		// The refusal says which names this machine answers for and how to fix it, without echoing the Host sent or leaking secrets.
		const refused = await hostRequest(n, "evil.example.com");
		expect(refused.body.error?.code).toBe("forbidden_host");
		expect(refused.body.error?.message).toBe(
			"This machine only answers for localhost, 127.0.0.1, [::1], node-a.example.com. Set the hostname in Settings → Cloudflare Tunnel (named mode) or start the tunnel.",
		);
		expect(refused.body.error?.i18n).toMatchObject({ key: expect.stringContaining("This machine only answers for {hostnames}"), params: { hostnames: "localhost, 127.0.0.1, [::1], node-a.example.com" } });
		expect(JSON.stringify(refused.body)).not.toContain("evil.example.com");
		expect(JSON.stringify(refused.body)).not.toContain(TOKEN);

		// Quick mode stays runtime-only: a stopped quick tunnel (and the off mode) knows no hostname.
		await http.put("/tunnel/config", { mode: "quick" });
		expect(n.ctx.network.tunnel.publicHostname()).toBeNull();
		const quickRefused = await hostRequest(n, "node-a.example.com");
		expect(quickRefused.status).toBe(403);
		expect(quickRefused.body.error?.message).toContain("only answers for localhost, 127.0.0.1, [::1]. Set the hostname");
		expect(n.ctx.access.publicOrigins()).not.toContain("https://node-a.example.com");
	});

	it("verifies instead of assuming that another cloudflared serves a named hostname: only an answer carrying our own id and fingerprint counts", async () => {
		const internet = new FakeInternet();
		const { n } = await nodeWithTunnel("https://node-a.example.com", { options: { tunnelFetch: internet.fetch, externalProbeMs: 120 } });
		internet.us = { nodeId: n.ctx.identity.nodeId, fingerprint: n.ctx.identity.fingerprint };
		const http = api(n);
		const state = async () => (await http.get<TunnelState>("/tunnel")).body;
		const advertised = async () => (await http.get<NodeInfo>("/node")).body.publicUrl;

		// Nothing answers at the hostname: it is accepted as Host, but it is not an address peers can use.
		const saved = await http.put<TunnelState>("/tunnel/config", { mode: "named", hostname: "node-a.example.com", token: TOKEN });
		expect(saved.body).toMatchObject({ state: "stopped", externalConnector: false, publicUrl: null });
		await eventually(() => internet.calls.length > 0, "first probe");
		expect(internet.calls[0]).toBe("https://node-a.example.com/api/v1/node/info");
		expect(await advertised()).toBeNull();

		// Someone else's cloudflared now routes the hostname to this machine: the periodic probe notices on its own.
		internet.answers = "us";
		await eventually(async () => (await state()).externalConnector, "periodic probe sees our node");
		expect(await state()).toMatchObject({ state: "stopped", publicUrl: "https://node-a.example.com", pid: null });
		expect(await advertised()).toBe("https://node-a.example.com");
		expect(n.ctx.db.$client.prepare("select public_url from node").get()).toEqual({ public_url: "https://node-a.example.com" });
		expect((await http.get<SecurityInfo>("/security")).body.remoteApiEnabled).toBe(true);
		const ws = (await http.post<{ id: string }>("/workspaces", { name: "W" })).body;
		expect((await http.post<{ url: string }>("/network/invitations", { workspaceId: ws.id })).body.url).toBe("https://node-a.example.com");

		// The hostname now reaches a different node: the flag clears (checked on demand, as the Tunnel page's button does).
		internet.answers = "stranger";
		const cleared = await http.post<TunnelState>("/tunnel/probe");
		expect(cleared.body).toMatchObject({ externalConnector: false, publicUrl: null });
		expect(await advertised()).toBeNull();

		internet.answers = "us";
		expect((await http.post<TunnelState>("/tunnel/probe")).body).toMatchObject({ externalConnector: true, publicUrl: "https://node-a.example.com" });

		// CLAM's own connector takes over: it is the source of truth, the flag is off and probing stops.
		const started = await http.post<TunnelState>("/tunnel/start");
		expect(started.body).toMatchObject({ state: "running", externalConnector: false, publicUrl: "https://node-a.example.com" });
		await new Promise((resolve) => setTimeout(resolve, 200));
		const callsWhileRunning = internet.calls.length;
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(internet.calls.length).toBe(callsWhileRunning);

		// Stopped again: the evidence is re-collected straight away.
		await http.post("/tunnel/stop");
		await eventually(async () => (await state()).externalConnector, "probe after stop");

		// Leaving named mode drops the flag with the hostname.
		await http.put("/tunnel/config", { mode: "quick" });
		expect(await state()).toMatchObject({ externalConnector: false, publicUrl: null });
		expect(await advertised()).toBeNull();
	});

	it("saving with 'Start automatically' on starts a stopped tunnel at once and the response says so", async () => {
		const { n, fake } = await nodeWithTunnel("https://node-a.example.com");
		const http = api(n);
		const saved = await http.put<TunnelState>("/tunnel/config", { mode: "named", hostname: "node-a.example.com", token: TOKEN, autoStart: true });
		expect(saved.body).toMatchObject({ state: "running", publicUrl: "https://node-a.example.com", externalConnector: false, config: { autoStart: true } });
		expect(fake.starts).toEqual([{ mode: "named", token: TOKEN, hostname: "node-a.example.com" }]);

		// An unchanged save while it runs does not restart it.
		await http.put("/tunnel/config", { mode: "named", autoStart: true });
		expect(fake.starts).toHaveLength(1);

		// Switched off and stopped: saving leaves it stopped; switching it on starts it.
		await http.post("/tunnel/stop");
		expect((await http.put<TunnelState>("/tunnel/config", { mode: "named", autoStart: false })).body.state).toBe("stopped");
		expect(fake.starts).toHaveLength(1);
		expect((await http.put<TunnelState>("/tunnel/config", { mode: "named", autoStart: true })).body.state).toBe("running");
		expect(fake.starts).toHaveLength(2);
	});

	it("reports why a save-triggered start failed instead of failing the save", async () => {
		const n = await createFullHarness({ network: { options: { ...FAST, cloudflaredBinary: "/nonexistent/cloudflared" } } });
		nodes.push(n);
		const saved = await api(n).put<TunnelState>("/tunnel/config", { mode: "quick", autoStart: true });
		expect(saved.status).toBe(200);
		expect(saved.body).toMatchObject({
			config: { mode: "quick", autoStart: true },
			state: "stopped",
			lastError: expect.stringContaining("cloudflared is not installed"),
			lastErrorI18n: { key: expect.stringContaining("cloudflared is not installed") },
		});
	});

	it("starts the real connector process when the saved settings have 'Start automatically' on (fake cloudflared)", async () => {
		const fakeCloudflared = join(import.meta.dirname, "..", "..", "..", "packages", "cloudflare-tunnel", "test", "fixtures", "fake-cloudflared.mjs");
		chmodSync(fakeCloudflared, 0o755);
		const captureDir = mkdtempSync(join(tmpdir(), "clam-fake-cf-"));
		process.env.FAKE_CF_DIR = captureDir;
		try {
			const n = await createFullHarness({ network: { options: { ...FAST, cloudflaredBinary: fakeCloudflared } } });
			nodes.push(n);
			const saved = await api(n).put<TunnelState>("/tunnel/config", { mode: "named", hostname: "node-a.example.com", token: TOKEN, autoStart: true });
			expect(saved.status).toBe(200);
			expect(saved.body).toMatchObject({ state: "running", publicUrl: "https://node-a.example.com", connections: 4, externalConnector: false });
			expect(saved.body.pid).toBeGreaterThan(0);
			expect(readFileSync(join(captureDir, "count"), "utf8")).toBe("1");
			const capture = JSON.parse(readFileSync(join(captureDir, "capture-1.json"), "utf8")) as { argv: string[] };
			expect(capture.argv).toContain("--token-file");
			expect(JSON.stringify(saved.body)).not.toContain(TOKEN);
			await api(n).post("/tunnel/stop");
		} finally {
			delete process.env.FAKE_CF_DIR;
			rmSync(captureDir, { recursive: true, force: true });
		}
	});
});
