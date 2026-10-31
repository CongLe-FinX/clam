import { request } from "node:http";
import type { NodeInfo, SecurityInfo, TunnelState } from "@clam/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createFullHarness, api, createMemorySecrets, type FullHarness } from "./full-harness.ts";
import { FakeTunnelManager } from "./fake-tunnel.ts";
import { FAST, eventually, pair, peerOf } from "./net-helpers.ts";

const nodes: FullHarness[] = [];
afterEach(async () => {
	for (const n of nodes.splice(0)) await n.cleanup();
});

async function nodeWithTunnel(url: string | null, extra: { dataDir?: string; port?: number; secrets?: ReturnType<typeof createMemorySecrets> } = {}) {
	const fake = new FakeTunnelManager();
	fake.url = url;
	const n = await createFullHarness({
		dataDir: extra.dataDir,
		secrets: extra.secrets,
		network: { port: extra.port, options: { ...FAST, createTunnelManager: () => fake, dnsWaitMs: 100 } },
	});
	nodes.push(n);
	return { n, fake };
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
		const started = await http.post<TunnelState>("/tunnel/start");
		expect(started.body).toMatchObject({ state: "running", publicUrl: "https://quick-abc.trycloudflare.com", connections: 4, pid: 4242 });
		expect(fake.starts).toEqual([{ mode: "quick" }]);
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
		const hostStatus = (host: string) =>
			new Promise<number>((resolve, reject) => {
				const req = request({ host: "127.0.0.1", port: n.netPort, path: "/api/v1/node/info", headers: { Host: host } }, (res) => {
					res.resume();
					resolve(res.statusCode ?? 0);
				});
				req.on("error", reject);
				req.end();
			});
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
});
