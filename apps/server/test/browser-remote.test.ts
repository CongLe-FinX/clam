import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { BROWSER_FRAME_HEADER_BYTES, routes, type AccessStatus, type BrowserServerMessage, type BrowserStatus, type BrowserTab } from "@clam/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBrowserExecutable, realDiscoveryEnv } from "../src/browser/executable.ts";
import { api } from "./full-harness.ts";
import { PASSWORD, PUBLIC_ORIGIN, cookiePair, raw, remoteNode, wsUpgrade, type RawWs, type RemoteNode } from "./remote-helpers.ts";

const SESSION = "__Host-clam_session";
const WS_PREFIX = "/ws/browser";
const API = "/api/local";

describe("Browser through the domain (public listener)", () => {
	let rn: RemoteNode;
	let site: Server;
	let siteUrl = "";
	let ipCounter = 0;
	const freshIp = (): string => `192.0.2.${++ipCounter}`;
	const http = () => api(rn.n);
	const hasBrowser = (): boolean => findBrowserExecutable(realDiscoveryEnv(rn.n.dataDir)) !== null;
	const call = <T = unknown>(method: string, path: string, o: { cookie?: string; body?: unknown } = {}) =>
		raw<T & { error?: { code: string } }>(rn.port, { method, path: `${API}${path}`, ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.body !== undefined ? { body: o.body } : {}), origin: PUBLIC_ORIGIN, ip: freshIp() });
	const signIn = async (): Promise<string> => {
		const res = await call("POST", "/access/login", { body: { password: PASSWORD } });
		expect(res.status, res.text).toBe(200);
		return cookiePair(res.cookies.find((c) => c.startsWith(`${SESSION}=`))!);
	};
	const upgrade = (tabId: string, o: { cookie?: string; origin?: string | null } = {}) => wsUpgrade(rn.port, { path: `${WS_PREFIX}/${tabId}`, origin: PUBLIC_ORIGIN, ...o });
	const closed = (ws: RawWs): boolean => ws.closeCode !== null || ws.ended;

	beforeAll(async () => {
		rn = await remoteNode();
		expect((await http().put("/access/password", { password: PASSWORD })).status).toBe(200);
		expect((await http().patch("/access", { remoteUiEnabled: true })).status).toBe(200);
		site = createServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/html" });
			res.end("<!doctype html><title>machine-local app</title><body style='background:#123'>hello from this machine</body>");
		});
		await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
		siteUrl = `localhost:${(site.address() as AddressInfo).port}`;
	});
	afterAll(async () => {
		site.close();
		await rn.cleanup();
	});

	it("is on for the loopback UI without any toggle", async () => {
		const status = await http().get<BrowserStatus>(routes.browser);
		expect(status.status).toBe(200);
		expect(status.body).toMatchObject({ state: "stopped", tabCount: 0 });
		expect((await http().get(routes.browserTabs)).body).toEqual([]);
		// the URL policy answers before any browser is started
		const blocked = await http().post<{ error: { code: string } }>(routes.browserTabs, { url: "chrome://settings" });
		expect(blocked.status).toBe(400);
		expect(blocked.body.error.code).toBe("url_blocked");
		expect((await http().get<BrowserStatus>(routes.browser)).body.state).toBe("stopped");
	});

	it("is off by default through the domain: every route and socket answers 403 tool_disabled", async () => {
		const cookie = await signIn();
		const status = (await call<AccessStatus>("GET", "/access", { cookie })).json!;
		expect(status).toMatchObject({ remoteBrowserEnabled: false, remoteTerminalEnabled: false });
		const requests: Array<[string, string, unknown?]> = [
			["GET", routes.browser],
			["POST", routes.browserInstall, {}],
			["GET", routes.browserTabs],
			["POST", routes.browserTabs, { url: siteUrl }],
			["DELETE", routes.browserTab("x")],
			["POST", routes.browserNavigate("x"), { url: siteUrl }],
			["GET", routes.browserPorts],
			["GET", routes.browserDownloads],
			["GET", routes.browserDownload("x.txt")],
		];
		for (const [method, path, body] of requests) {
			const res = await call(method, path, { cookie, ...(body !== undefined ? { body } : {}) });
			expect(res.status, `${method} ${path}`).toBe(403);
			expect(res.json?.error?.code, `${method} ${path}`).toBe("tool_disabled");
		}
		const put = await raw(rn.port, { method: "PUT", path: `${API}${routes.browserUpload("00000000-0000-0000-0000-000000000000")}?name=a.txt`, cookie, origin: PUBLIC_ORIGIN, ip: freshIp(), headers: { "content-type": "application/octet-stream" } });
		expect(put.status).toBe(403);
		expect((await upgrade("anything", { cookie })).status).toBe(403);
		// Signed out it is the sign-in wall, never a hint that the tool exists.
		expect((await upgrade("anything")).status).toBe(401);
		expect((await raw(rn.port, { path: `${API}${routes.browser}` })).status).toBe(401);
		expect(rn.n.ctx.browser.status().state).toBe("stopped");
	});

	it("a remote session can switch the Browser on only with the owner password", async () => {
		const cookie = await signIn();
		const patch = (body: unknown) => call<AccessStatus>("PATCH", "/access", { cookie, body });
		const missing = await patch({ remoteBrowserEnabled: true });
		expect(missing.status).toBe(400);
		const wrong = await patch({ remoteBrowserEnabled: true, password: "not the right password" });
		expect(wrong.status).toBe(401);
		expect((await http().get<AccessStatus>("/access")).body.remoteBrowserEnabled).toBe(false);
		const ok = await patch({ remoteBrowserEnabled: true, password: PASSWORD });
		expect(ok.status, ok.text).toBe(200);
		expect(ok.json).toMatchObject({ remoteBrowserEnabled: true, remoteTerminalEnabled: false });
		expect((await patch({ remoteBrowserEnabled: false })).json).toMatchObject({ remoteBrowserEnabled: false });
		const toggles = (rn.n.ctx.db.$client.prepare("select payload from node_events where type = 'access.remote_toggle'").all() as Array<{ payload: string }>).map((r) => JSON.parse(r.payload));
		expect(toggles).toContainEqual({ tool: "browser", enabled: true, via: "remote" });
		expect(toggles).toContainEqual({ tool: "browser", enabled: false, via: "remote" });
	});

	it("switched on (from the machine's own UI): the sockets refuse cross-origin and sessionless upgrades; an unknown tab closes 4404", async () => {
		expect((await http().patch<AccessStatus>("/access", { remoteBrowserEnabled: true })).body).toMatchObject({ remoteBrowserEnabled: true });
		const cookie = await signIn();
		expect((await call("GET", routes.browser, { cookie })).status).toBe(200);
		expect((await call("GET", routes.browserTabs, { cookie })).json).toEqual([]);
		expect((await upgrade("0123456789abcdef", { cookie, origin: "https://evil.example" })).status).toBe(403);
		expect((await upgrade("0123456789abcdef", { cookie, origin: null })).status).toBe(403);
		expect((await upgrade("0123456789abcdef")).status).toBe(401);
		expect((await upgrade("0123456789abcdef", { cookie: `${SESSION}=forged.sig` })).status).toBe(401);
		const { status, ws } = await upgrade("0123456789abcdef", { cookie });
		expect(status).toBe(101);
		await ws!.until(() => closed(ws!), "closed for an unknown tab");
		expect(ws!.closeCode).toBe(4404);
		ws!.destroy();
		// a blocked URL is refused over the domain too
		const blocked = await call("POST", routes.browserTabs, { cookie, body: { url: "file:///etc/passwd" } });
		expect(blocked.status).toBe(400);
		expect(blocked.json?.error?.code).toBe("url_blocked");
	});

	it.skipIf(!findBrowserExecutable(realDiscoveryEnv("/nonexistent")))("a signed-in remote session browses the machine's own localhost; toggling off or logging out closes the socket at once", async () => {
		expect((await http().patch("/access", { remoteBrowserEnabled: true })).status).toBe(200);
		const cookie = await signIn();
		const created = await call<BrowserTab>("POST", routes.browserTabs, { cookie, body: { url: siteUrl } });
		expect(created.status, created.text).toBe(201);
		const tabId = created.json!.id;

		const { status, ws } = await upgrade(tabId, { cookie });
		expect(status).toBe(101);
		const hello = await waitText(ws!, (m) => m.type === "hello");
		expect(hello.type === "hello" && hello.tab.id).toBe(tabId);
		ws!.send({ type: "viewer", width: 640, height: 480, dpr: 1, device: "fit" });
		await ws!.until(() => ws!.binaries.length > 0, "a screencast frame over the domain", 20_000);
		const jpeg = ws!.binaries[0]!.subarray(BROWSER_FRAME_HEADER_BYTES);
		expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]);
		await waitText(ws!, (m) => m.type === "tabs" && m.tabs.some((t) => t.id === tabId && t.title === "machine-local app"));

		// audit: the remote open is on record with how it arrived
		const audit = rn.n.ctx.db.$client.prepare("select type, payload from node_events where type like 'browser.%'").all() as Array<{ type: string; payload: string }>;
		expect(audit.some((r) => r.type === "browser.open" && JSON.parse(r.payload).via === "remote")).toBe(true);

		// Switching the toggle off ends the live socket immediately.
		expect((await http().patch("/access", { remoteBrowserEnabled: false })).status).toBe(200);
		await ws!.until(() => closed(ws!), "socket closed by the toggle");
		expect(ws!.closeCode).toBe(4401);
		ws!.destroy();
		expect((await upgrade(tabId, { cookie })).status).toBe(403);

		// Logging every session out closes a live one too.
		expect((await http().patch("/access", { remoteBrowserEnabled: true })).status).toBe(200);
		const again = await signIn();
		const second = await upgrade(tabId, { cookie: again });
		expect(second.status).toBe(101);
		await waitText(second.ws!, (m) => m.type === "hello");
		expect((await call("POST", "/access/logout-all", { cookie: again, body: {} })).status).toBe(204);
		await second.ws!.until(() => closed(second.ws!), "socket closed by logout-all");
		expect(second.ws!.closeCode).toBe(4401);
		second.ws!.destroy();
		const closeAudits = (): number => (rn.n.ctx.db.$client.prepare("select count(*) as n from node_events where type = 'browser.close'").get() as { n: number }).n;
		await waitFor(() => closeAudits() >= 2, "both closes to be audited");
	}, 90_000);
});

async function waitFor(done: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!done()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/** Wait for a JSON text frame matching `match` on a raw socket. */
async function waitText(ws: RawWs, match: (message: BrowserServerMessage) => boolean): Promise<BrowserServerMessage> {
	let found: BrowserServerMessage | undefined;
	await ws.until(() => {
		for (const text of ws.texts) {
			const message = JSON.parse(text) as BrowserServerMessage;
			if (match(message)) {
				found = message;
				return true;
			}
		}
		return false;
	}, "a matching message", 20_000);
	if (!found) throw new Error("no matching message");
	return found;
}
