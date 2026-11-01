import { createHash } from "node:crypto";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { routes, type AccessStatus, type PreviewStatus, type PreviewTicket } from "@clam/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PreviewService } from "../src/preview/service.ts";
import { api } from "./full-harness.ts";
import { PASSWORD, RawWs, cookiePair, raw, remoteNode, wsUpgrade, type RemoteNode } from "./remote-helpers.ts";

const TUNNEL_HOST = "clamp-work.conglt.io.vn";
const PREVIEW_HOST = "clamp-work-preview.conglt.io.vn";
const UI_ORIGIN = `https://${TUNNEL_HOST}`;
const SESSION = "__Host-clam_session";
const PREVIEW = "__Host-clam_preview";
const PORT_COOKIE = "__Host-clam_preview_port";
const API = "/api/local";
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** What the app under preview saw, per request. */
interface Seen {
	method: string;
	url: string;
	headers: IncomingMessage["headers"];
	body: string;
}

/** A tiny dev server: HTML, redirects, cookies, SSE, chunked bodies and a WebSocket echo (hand-rolled: no `ws` dependency in this package). */
async function startApp(): Promise<{ server: Server; port: number; seen: Seen[]; sseSecondSent: () => boolean; sockets: Socket[] }> {
	const seen: Seen[] = [];
	const sockets: Socket[] = [];
	let secondSent = false;
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
			const { port } = server.address() as AddressInfo;
			switch (req.url?.split("?")[0]) {
				case "/redirect":
					res.writeHead(302, { Location: `http://localhost:${port}/landing?x=1` });
					return void res.end();
				case "/cookie":
					res.writeHead(200, { "Set-Cookie": ["app=1; Path=/; Domain=localhost; HttpOnly", "other=2; Domain=.conglt.io.vn"], "Content-Type": "text/plain" });
					return void res.end("cookies");
				case "/headers":
					res.writeHead(200, { "Content-Type": "application/json" });
					return void res.end(JSON.stringify(req.headers));
				case "/sse":
					res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
					res.write("data: one\n\n");
					setTimeout(() => {
						secondSent = true;
						res.write("data: two\n\n");
						res.end();
					}, 700);
					return;
				case "/chunked":
					res.writeHead(200, { "Content-Type": "text/plain" });
					res.write("part-a;");
					setTimeout(() => res.end("part-b"), 50);
					return;
				default:
					res.writeHead(200, { "Content-Type": "text/html" });
					return void res.end(`<!doctype html><title>app</title>hello from the app ${req.method} ${req.url}`);
			}
		});
	});
	// WebSocket echo: replies "echo:<text>" to every text frame; the first frame it sends is the Origin/Host it saw.
	server.on("upgrade", (req, socket) => {
		sockets.push(socket as Socket);
		const key = String(req.headers["sec-websocket-key"]);
		socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${createHash("sha1").update(key + GUID).digest("base64")}\r\n\r\n`);
		const send = (text: string): void => {
			const payload = Buffer.from(text);
			socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
		};
		send(JSON.stringify({ origin: req.headers.origin ?? null, host: req.headers.host ?? null, cookie: req.headers.cookie ?? null }));
		socket.on("data", (data: Buffer) => {
			const length = data[1]! & 0x7f;
			const mask = data.subarray(2, 6);
			const text = Buffer.from(data.subarray(6, 6 + length).map((b, i) => b ^ mask[i % 4]!)).toString("utf8");
			send(`echo:${text}`);
		});
		socket.on("error", () => undefined);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, port: (server.address() as AddressInfo).port, seen, sseSecondSent: () => secondSent, sockets };
}

describe("Preview through the machine's own preview host (/port/<port>, port cookie)", () => {
	let rn: RemoteNode;
	let app: Awaited<ReturnType<typeof startApp>>;
	let ip = 0;
	const freshIp = (): string => `192.0.2.${++ip}`;
	const local = () => api(rn.n);
	/** A request to the UI host of the public listener (the owner's CLAM). */
	const ui = <T = unknown>(method: string, path: string, o: { cookie?: string; body?: unknown } = {}) =>
		raw<T & { error?: { code: string } }>(rn.port, { method, path: `${API}${path}`, host: TUNNEL_HOST, origin: UI_ORIGIN, ip: freshIp(), ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.body !== undefined ? { body: o.body } : {}) });
	const signIn = async (): Promise<string> => {
		const res = await ui("POST", "/access/login", { body: { password: PASSWORD } });
		expect(res.status, res.text).toBe(200);
		return cookiePair(res.cookies.find((c) => c.startsWith(`${SESSION}=`))!);
	};
	/** A request to the preview host. */
	const hit = (path: string, o: { method?: string; cookie?: string; headers?: Record<string, string>; origin?: string; body?: unknown; host?: string } = {}) =>
		raw<Record<string, string> & { error?: { code: string; message: string } }>(rn.port, { method: o.method ?? "GET", path, host: o.host ?? PREVIEW_HOST, ip: freshIp(), ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.origin ? { origin: o.origin } : {}), ...(o.headers ? { headers: o.headers } : {}), ...(o.body !== undefined ? { body: o.body } : {}) });
	const ticketUrl = async (cookie: string, port: number, path?: string): Promise<string> => {
		const res = await ui<PreviewTicket>("POST", routes.previewTicket, { cookie, body: { port, ...(path ? { path } : {}) } });
		expect(res.status, res.text).toBe(200);
		return res.json!.url;
	};
	const redeem = (url: string, host?: string) => {
		const u = new URL(url);
		return raw(rn.port, { path: `${u.pathname}${u.search}`, host: host ?? u.host, ip: freshIp() });
	};
	const pair = (res: { cookies: string[] }, name: string): string => cookiePair(res.cookies.find((c) => c.startsWith(`${name}=`))!);
	/** Sign in, mint a ticket, redeem it and follow `/port/<port>/…`: the preview session cookie alone, and with the selected port. */
	const previewCookie = async (port: number, path?: string): Promise<{ session: string; cookie: string; owner: string }> => {
		const owner = await signIn();
		const redeemed = await redeem(await ticketUrl(owner, port, path));
		expect(redeemed.status, redeemed.text).toBe(302);
		const session = pair(redeemed, PREVIEW);
		const selected = await hit(redeemed.headers.location!, { cookie: session });
		expect(selected.status, selected.text).toBe(302);
		return { session, cookie: `${session}; ${pair(selected, PORT_COOKIE)}`, owner };
	};
	const setPreview = async (enabled: boolean) => expect((await local().patch<AccessStatus>("/access", { remotePreviewEnabled: enabled })).status).toBe(200);
	const listing = (apps: Array<{ port: number; title: string | null }>) =>
		vi.spyOn(rn.n.ctx.browser, "ports").mockResolvedValue(apps.map((a) => ({ port: a.port, address: "127.0.0.1", pid: null, process: "node", hint: null, likelyHttp: true, title: a.title, startedAt: null, url: `http://localhost:${a.port}` })));

	beforeAll(async () => {
		rn = await remoteNode();
		app = await startApp();
		expect((await local().put("/access/password", { password: PASSWORD })).status).toBe(200);
		expect((await local().patch("/access", { remoteUiEnabled: true })).status).toBe(200);
		const named = await local().put("/tunnel/config", { mode: "named", hostname: TUNNEL_HOST, token: "t".repeat(24) });
		expect(named.status, JSON.stringify(named.body)).toBe(200);
	});
	afterAll(async () => {
		for (const socket of app.sockets) socket.destroy();
		app.server.closeAllConnections();
		app.server.close();
		await rn.cleanup();
	});

	it("derives the preview host from the named hostname", async () => {
		expect((await local().get<PreviewStatus>(routes.preview)).body).toEqual({
			available: true,
			unavailableReason: null,
			hostname: TUNNEL_HOST,
			host: PREVIEW_HOST,
			defaultHost: PREVIEW_HOST,
			customHost: false,
			universalSsl: true,
			remoteEnabled: false,
		});
	});

	it("answers /__clam_preview/health from this node whether or not Preview is on, and refuses everything else while it is off", async () => {
		const health = await hit("/__clam_preview/health");
		expect(health.status).toBe(200);
		expect(health.json).toEqual({ service: "clam-preview", nodeId: rn.n.ctx.identity.nodeId });
		const off = await hit("/", { headers: { accept: "application/json" } });
		expect(off.status).toBe(403);
		expect(off.json?.error?.code).toBe("preview_disabled");
		const page = await hit("/", { headers: { accept: "text/html" } });
		expect(page.status).toBe(403);
		expect(page.headers["content-type"]).toContain("text/html");
		expect(app.seen).toHaveLength(0);
		// the ticket route is shut remotely too
		const owner = await signIn();
		const refused = await ui("POST", routes.previewTicket, { cookie: owner, body: { port: app.port } });
		expect(refused.status).toBe(403);
		expect(refused.json?.error?.code).toBe("preview_disabled");
		expect((await ui("POST", routes.previewTicket, { body: { port: app.port } })).status).toBe(401); // signed out: the sign-in wall
		// a remote session needs the owner password to switch it on
		expect((await ui("PATCH", "/access", { cookie: owner, body: { remotePreviewEnabled: true } })).status).toBe(400);
		expect((await ui("PATCH", "/access", { cookie: owner, body: { remotePreviewEnabled: true, password: "wrong wrong wrong" } })).status).toBe(401);
		const on = await ui<AccessStatus>("PATCH", "/access", { cookie: owner, body: { remotePreviewEnabled: true, password: PASSWORD } });
		expect(on.status, on.text).toBe(200);
		expect(on.json).toMatchObject({ remotePreviewEnabled: true });
		await setPreview(false);
		const toggles = (rn.n.ctx.db.$client.prepare("select payload from node_events where type = 'access.remote_toggle'").all() as Array<{ payload: string }>).map((r) => JSON.parse(r.payload));
		expect(toggles).toContainEqual({ tool: "preview", enabled: true, via: "remote" });
		expect(toggles).toContainEqual({ tool: "preview", enabled: false, via: "loopback" });
	});

	it("is a sign-in wall without the preview cookie, and says nothing about what runs behind it", async () => {
		await setPreview(true);
		const res = await hit("/", { headers: { accept: "text/html" } });
		expect(res.status).toBe(401);
		expect(res.text).toContain("Open this preview from CLAM");
		expect(res.text).not.toContain("hello from the app");
		expect((await hit("/anything", { headers: { accept: "application/json" } })).json?.error?.code).toBe("auth_required");
		expect((await hit(`/port/${app.port}/`)).status).toBe(401); // selecting a port needs the session too
		// the owner's UI cookie is host-only on the UI host: even if a client sends it here it opens nothing
		const owner = await signIn();
		expect((await hit("/", { cookie: owner })).status).toBe(401);
		expect((await hit("/", { cookie: `${PREVIEW}=forged.sig; ${PORT_COOKIE}=${app.port}` })).status).toBe(401);
		expect((await hit("/__clam_preview/", { cookie: owner, headers: { accept: "text/html" } })).status).toBe(401);
		expect(app.seen).toHaveLength(0);
	});

	it("refuses CLAM's own ports and denied services when minting a ticket", async () => {
		const owner = await signIn();
		for (const port of [rn.n.ctx.config.port, rn.n.ctx.config.networkPort, 22, 5432, 6379, 9229]) {
			const res = await ui("POST", routes.previewTicket, { cookie: owner, body: { port } });
			expect(res.status, `port ${port}`).toBe(403);
			expect(res.json?.error?.code).toBe("port_not_allowed");
		}
		expect((await ui("POST", routes.previewTicket, { cookie: owner, body: { port: 0 } })).status).toBe(400);
		for (const path of ["//evil.example/", "https://evil.example/", "no-slash", "/a\\b"]) {
			expect((await ui("POST", routes.previewTicket, { cookie: owner, body: { port: app.port, path } })).status, path).toBe(400);
		}
	});

	it("a ticket is single-use, bound to its host, short-lived; it sets a host-only cookie and lands on /port/<port>/<path>", async () => {
		const owner = await signIn();
		const url = await ticketUrl(owner, app.port, "/deep/link?x=1");
		expect(url.startsWith(`https://${PREVIEW_HOST}/__clam_preview/auth?ticket=`)).toBe(true);
		// bound to the host it was minted for: another host cannot spend it, and the attempt burns it
		const token = new URL(url).searchParams.get("ticket")!;
		expect(await rn.n.ctx.access.redeemPreviewTicket(token, "evil.example.com")).toBeNull();
		expect((await redeem(url)).status).toBe(401);

		const fresh = await ticketUrl(owner, app.port, "/deep/link?x=1");
		const ok = await redeem(fresh);
		expect(ok.status).toBe(302);
		expect(ok.headers.location).toBe(`/port/${app.port}/deep/link?x=1`);
		expect(ok.headers["cache-control"]).toBe("no-store");
		expect(ok.headers["referrer-policy"]).toBe("no-referrer");
		const cookie = ok.cookies.find((c) => c.startsWith(`${PREVIEW}=`))!;
		expect(cookie).toMatch(/; Path=\/; Secure; HttpOnly; SameSite=Lax$/);
		expect(cookie.toLowerCase()).not.toContain("domain");
		expect(ok.cookies.some((c) => c.startsWith(`${SESSION}=`))).toBe(false);
		expect((await redeem(fresh)).status).toBe(401); // single use

		// a ticket expires (≤ 60 s)
		const stale = await ticketUrl(owner, app.port);
		const spy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
		try {
			expect((await redeem(stale)).status).toBe(401);
		} finally {
			spy.mockRestore();
		}
		// garbage, a missing ticket, and a method other than GET
		expect((await hit("/__clam_preview/auth?ticket=nonsense")).status).toBe(401);
		expect((await hit("/__clam_preview/auth")).status).toBe(401);
		const another = new URL(await ticketUrl(owner, app.port)).searchParams.get("ticket")!;
		expect((await hit(`/__clam_preview/auth?ticket=${another}`, { method: "POST" })).status).toBe(401);
		// the ticket is no cookie and the cookie is no ticket
		expect((await hit("/", { cookie: `${PREVIEW}=${another}; ${PORT_COOKIE}=${app.port}` })).status).toBe(401);
		const audit = (rn.n.ctx.db.$client.prepare("select type from node_events where type like 'preview.%'").all() as Array<{ type: string }>).map((r) => r.type);
		expect(audit).toContain("preview.open");
		expect(audit).toContain("preview.signin");
	});

	it("rate-limits minting tickets", async () => {
		const owner = await signIn();
		const statuses: number[] = [];
		for (let i = 0; i < 12; i++) statuses.push((await ui("POST", routes.previewTicket, { cookie: owner, body: { port: app.port } })).status);
		expect(statuses.slice(0, 8)).toEqual(Array(8).fill(200));
		expect(statuses).toContain(429);
	});

	it("/port/<port>/<rest> selects the app (port cookie) and redirects to /<rest> with the query kept", async () => {
		const { session } = await previewCookie(app.port);
		const selected = await hit(`/port/${app.port}/about/team?tab=2#x`, { cookie: session });
		expect(selected.status).toBe(302);
		expect(selected.headers.location).toBe("/about/team?tab=2");
		expect(selected.cookies.find((c) => c.startsWith(`${PORT_COOKIE}=`))).toBe(`${PORT_COOKIE}=${app.port}; Max-Age=604800; Path=/; Secure; HttpOnly; SameSite=Lax`);
		expect((await hit(`/port/${app.port}`, { cookie: session })).headers.location).toBe("/");
		expect((await hit(`/port/${app.port}/`, { cookie: session })).headers.location).toBe("/");
		// the policy applies to the selection: CLAM's own ports and denied services are refused (and set no cookie)
		for (const port of [rn.n.ctx.config.port, rn.n.ctx.config.networkPort, 5432, 22, 443]) {
			const res = await hit(`/port/${port}/`, { cookie: session, headers: { accept: "application/json" } });
			expect(res.status, `port ${port}`).toBe(403);
			expect(res.json?.error?.code).toBe("port_not_allowed");
			expect(res.cookies.find((c) => c.startsWith(`${PORT_COOKIE}=`))).toBeUndefined();
		}
		// a path that only looks like the prefix is the app's own
		const { cookie } = await previewCookie(app.port);
		app.seen.length = 0;
		for (const own of ["/port/abc", "/port/5173abc/x", "/ports/5173", "/port/"]) expect((await hit(own, { cookie })).text, own).toContain(`hello from the app GET ${own}`);
	});

	it("every other path follows the port cookie: absolute asset paths, API paths and the root reach the app at its natural paths", async () => {
		const { cookie } = await previewCookie(app.port);
		app.seen.length = 0;
		for (const path of ["/", "/about", "/assets/index-abc.js", "/@vite/client", "/api/v1/node/info", "/_next/static/x.js", "/api/local/access"]) {
			const res = await hit(path, { cookie });
			expect(res.status, path).toBe(200);
			expect(res.text, path).toContain(`hello from the app GET ${path}`);
		}
		expect(app.seen.map((r) => r.url)).toEqual(["/", "/about", "/assets/index-abc.js", "/@vite/client", "/api/v1/node/info", "/_next/static/x.js", "/api/local/access"]);
		// switching apps: select another port, the same absolute paths now reach it
		const second = await startApp();
		try {
			const switched = await hit(`/port/${second.port}/`, { cookie });
			expect(switched.status).toBe(302);
			const cookie2 = `${cookie.split("; ")[0]}; ${pair(switched, PORT_COOKIE)}`;
			expect((await hit("/about", { cookie: cookie2 })).text).toContain("hello from the app GET /about");
			expect(second.seen.map((r) => r.url)).toEqual(["/about"]);
			expect(app.seen).toHaveLength(7);
		} finally {
			second.server.closeAllConnections();
			second.server.close();
		}
	});

	it("without a selected port the picker lists the apps that may be previewed", async () => {
		const { session } = await previewCookie(app.port);
		app.seen.length = 0;
		const own = rn.n.ctx.config.port;
		const spy = listing([{ port: app.port, title: "My <app>" }, { port: own, title: "CLAM" }, { port: 5432, title: null }]);
		try {
			const page = await hit("/", { cookie: session, headers: { accept: "text/html" } });
			expect(page.status).toBe(200);
			expect(page.text).toContain(`href="/port/${app.port}/"`);
			expect(page.text).toContain("My &lt;app&gt;");
			expect(page.text).not.toContain(`href="/port/${own}/"`);
			expect(page.text).not.toContain('href="/port/5432/"');
			expect((await hit("/__clam_preview/", { cookie: session, headers: { accept: "text/html" } })).text).toContain(`href="/port/${app.port}/"`);
			expect((await hit("/__clam_preview/ports", { cookie: session, headers: { accept: "text/html" } })).status).toBe(200);
			// an API client gets the envelope, not a page
			const json = await hit("/api/data", { cookie: session, headers: { accept: "application/json" } });
			expect(json.status).toBe(409);
			expect(json.json?.error?.code).toBe("port_not_selected");
		} finally {
			spy.mockRestore();
		}
		expect(app.seen).toHaveLength(0);
	});

	it("proxies HTTP: Host/Origin/Referer rewritten, CLAM's cookies withheld, forwarding headers added", async () => {
		const { cookie } = await previewCookie(app.port);
		app.seen.length = 0;
		const res = await hit("/headers", {
			cookie: `${cookie}; theme=dark`,
			origin: `https://${PREVIEW_HOST}`,
			headers: { referer: `https://${PREVIEW_HOST}/page`, accept: "application/json" },
		});
		expect(res.status).toBe(200);
		const seen = res.json as Record<string, string>;
		expect(seen.host).toBe(`localhost:${app.port}`);
		expect(seen.origin).toBe(`http://localhost:${app.port}`);
		expect(seen.referer).toBe(`http://localhost:${app.port}/page`);
		expect(seen.cookie).toBe("theme=dark");
		expect(seen["x-forwarded-proto"]).toBe("https");
		expect(seen["x-forwarded-host"]).toBe(PREVIEW_HOST);
		expect(res.headers["x-robots-tag"]).toContain("noindex");
		const post = await hit("/submit", { method: "POST", cookie, body: { hello: "world" } });
		expect(post.status).toBe(200);
		expect(app.seen.at(-1)).toMatchObject({ method: "POST", url: "/submit", body: '{"hello":"world"}' });
		expect((await hit("/some/page?q=1", { cookie })).text).toContain("hello from the app GET /some/page?q=1");
	});

	it("rewrites redirects to the preview origin and keeps cookies host-only", async () => {
		const { cookie } = await previewCookie(app.port);
		const redirect = await hit("/redirect", { cookie });
		expect(redirect.status).toBe(302);
		expect(redirect.headers.location).toBe(`https://${PREVIEW_HOST}/landing?x=1`);
		expect((await hit("/cookie", { cookie })).cookies).toEqual(["app=1; Path=/; HttpOnly", "other=2"]);
	});

	it("never proxies the reserved prefix, however it is spelled", async () => {
		const { cookie } = await previewCookie(app.port);
		app.seen.length = 0;
		for (const path of ["/__clam_preview/secret", "/__CLAM_PREVIEW/x", "/%5F%5Fclam_preview/x", "/a/../__clam_preview/x"]) {
			const res = await hit(path, { cookie, headers: { accept: "application/json" } });
			expect(res.status, path).toBe(404);
		}
		expect(app.seen).toHaveLength(0);
	});

	it("answers 502 for a port nothing listens on", async () => {
		const spare = await startApp();
		const { session } = await previewCookie(spare.port);
		await new Promise((resolve) => spare.server.close(resolve));
		const gone = await hit("/", { cookie: `${session}; ${PORT_COOKIE}=${spare.port}`, headers: { accept: "application/json" } });
		expect(gone.status).toBe(502);
		expect(gone.json?.error?.code).toBe("nothing_listening");
	});

	it("refuses a forged port cookie for a port the policy denies (even with a valid session)", async () => {
		const { session } = await previewCookie(app.port);
		for (const port of [rn.n.ctx.config.port, rn.n.ctx.config.networkPort, 5432]) {
			const res = await hit("/", { cookie: `${session}; ${PORT_COOKIE}=${port}`, headers: { accept: "application/json" } });
			expect(res.status, `port ${port}`).toBe(403);
			expect(res.json?.error?.code).toBe("port_not_allowed");
		}
	});

	it("streams server-sent events and chunked bodies instead of buffering them", async () => {
		const { cookie } = await previewCookie(app.port);
		const arrivals: Array<{ text: string; secondSentBefore: boolean }> = [];
		await new Promise<void>((resolve, reject) => {
			const req = request({ host: "127.0.0.1", port: rn.port, path: "/sse", headers: { Host: PREVIEW_HOST, Cookie: cookie, Accept: "text/event-stream" }, agent: false }, (res) => {
				expect(res.headers["content-type"]).toContain("text/event-stream");
				res.on("data", (chunk: Buffer) => arrivals.push({ text: chunk.toString(), secondSentBefore: app.sseSecondSent() }));
				res.on("end", resolve);
			});
			req.on("error", reject);
			req.end();
		});
		expect(arrivals.map((a) => a.text).join("")).toBe("data: one\n\ndata: two\n\n");
		// the first event reached the client while the app had not yet produced the second one
		expect(arrivals[0]?.text).toBe("data: one\n\n");
		expect(arrivals[0]?.secondSentBefore).toBe(false);
		expect((await hit("/chunked", { cookie })).text).toBe("part-a;part-b");
	});

	it("proxies a WebSocket upgrade (HMR) by the port cookie, rewriting Origin and Host, withholding CLAM's cookies, refusing foreign origins", async () => {
		const { cookie, session } = await previewCookie(app.port);
		const origin = `https://${PREVIEW_HOST}`;
		const connect = (o: { cookie?: string; origin?: string | null }) => wsUpgrade(rn.port, { path: "/?token=abc", host: PREVIEW_HOST, ip: freshIp(), ...o });
		expect((await connect({ origin })).status).toBe(401); // no cookie
		expect((await connect({ cookie: `${PREVIEW}=forged.sig; ${PORT_COOKIE}=${app.port}`, origin })).status).toBe(401);
		expect((await connect({ cookie, origin: "https://evil.example" })).status).toBe(403);
		expect((await connect({ cookie: session, origin })).status).toBe(409); // session but no port selected
		const { status, ws } = await connect({ cookie: `${cookie}; theme=dark`, origin });
		expect(status).toBe(101);
		await ws!.until(() => ws!.texts.length >= 1, "the app's greeting");
		expect(JSON.parse(ws!.texts[0]!)).toEqual({ origin: `http://localhost:${app.port}`, host: `localhost:${app.port}`, cookie: "theme=dark" });
		ws!.send("ping-1");
		await ws!.until(() => ws!.texts.length >= 2, "the echo");
		expect(ws!.texts[1]).toBe('echo:"ping-1"');
		ws!.destroy();
		// a socket follows a forged denied port no better than a request
		expect((await connect({ cookie: `${session}; ${PORT_COOKIE}=5432`, origin })).status).toBe(403);
	});

	it("Preview off refuses the upgrade before any cookie check", async () => {
		const { cookie } = await previewCookie(app.port);
		await setPreview(false);
		expect((await wsUpgrade(rn.port, { path: "/", host: PREVIEW_HOST, cookie, origin: `https://${PREVIEW_HOST}` })).status).toBe(403);
		await setPreview(true);
	});

	it("logout ends the session's preview: the cookie dies and open sockets close", async () => {
		const { cookie, owner } = await previewCookie(app.port);
		const { ws } = await wsUpgrade(rn.port, { path: "/", host: PREVIEW_HOST, cookie, origin: `https://${PREVIEW_HOST}`, ip: freshIp() });
		await ws!.until(() => ws!.texts.length >= 1, "greeting");
		expect((await hit("/", { cookie })).status).toBe(200);
		expect((await ui("POST", "/access/logout", { cookie: owner })).status).toBe(204);
		expect((await hit("/", { cookie })).status).toBe(401);
		await ws!.until(() => ws!.ended, "the socket to close", 20_000);
	}, 30_000);

	it("logout-all, a password change, switching Preview off, and turning remote UI off each invalidate preview cookies", async () => {
		const results: Record<string, number> = {};
		for (const how of ["logout-all", "password", "preview-off", "remote-ui-off"] as const) {
			const { cookie, owner } = await previewCookie(app.port);
			expect((await hit("/", { cookie })).status, `${how} before`).toBe(200);
			if (how === "logout-all") expect((await ui("POST", "/access/logout-all", { cookie: owner })).status).toBe(204);
			if (how === "password") expect((await local().put("/access/password", { password: PASSWORD })).status).toBe(200);
			if (how === "preview-off") await setPreview(false);
			if (how === "remote-ui-off") expect((await local().patch("/access", { remoteUiEnabled: false })).status).toBe(200);
			// back on: the old cookie must not come back to life
			if (how === "preview-off") await setPreview(true);
			if (how === "remote-ui-off") expect((await local().patch("/access", { remoteUiEnabled: true })).status).toBe(200);
			results[how] = (await hit("/", { cookie })).status;
		}
		expect(results).toEqual({ "logout-all": 401, password: 401, "preview-off": 401, "remote-ui-off": 401 });
	}, 30_000);

	it("a ticket minted on the loopback UI works too (no owner session there)", async () => {
		const res = await local().post<PreviewTicket>(routes.previewTicket, { port: app.port });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const ok = await redeem(res.body.url);
		expect(ok.status).toBe(302);
		const session = pair(ok, PREVIEW);
		const selected = await hit(ok.headers.location!, { cookie: session });
		expect((await hit("/", { cookie: `${session}; ${pair(selected, PORT_COOKIE)}` })).status).toBe(200);
	});

	it("the UI host never proxies, and the preview host never serves CLAM's UI or wire API", async () => {
		const { cookie } = await previewCookie(app.port);
		app.seen.length = 0;
		// on the UI host /port/<n>/… and the reserved paths are nothing special, even with a (misplaced) preview cookie
		for (const path of [`/port/${app.port}/`, "/about", "/__clam_preview/health"]) {
			const res = await raw(rn.port, { path, host: TUNNEL_HOST, cookie, ip: freshIp() });
			expect(res.text, path).not.toContain("hello from the app");
			expect(res.json, path).not.toMatchObject({ service: "clam-preview" });
		}
		expect(app.seen).toHaveLength(0);
		// and the other way round: CLAM's own paths on the preview host are the app's
		app.seen.length = 0;
		expect((await hit("/api/v1/node/info", { cookie })).text).toContain("hello from the app GET /api/v1/node/info");
		expect((await hit("/api/local/access", { headers: { accept: "application/json" } })).status).toBe(401);
		expect(app.seen).toHaveLength(1);
		// the owner's UI session cookie never reaches the app
		app.seen.length = 0;
		await hit("/headers", { cookie });
		expect(app.seen.at(-1)?.headers.cookie).toBeUndefined();
	});

	it("only the exact preview host is a preview host; the host is validated and its edits are loopback-only", async () => {
		const owner = await signIn();
		const remote = await ui("PUT", routes.previewConfig, { cookie: owner, body: { host: "other-preview.conglt.io.vn" } });
		expect(remote.status).toBe(403);
		expect(remote.json?.error?.code).toBe("loopback_only");
		for (const bad of ["localhost", "https://x.conglt.io.vn", "x.conglt.io.vn/path", "*.conglt.io.vn", "{port}-x.conglt.io.vn", TUNNEL_HOST]) {
			expect((await local().put(routes.previewConfig, { host: bad })).status, bad).toBe(400);
		}
		const custom = await local().put<PreviewStatus>(routes.previewConfig, { host: "Dev-Box.conglt.io.vn" });
		expect(custom.status).toBe(200);
		expect(custom.body).toMatchObject({ host: "dev-box.conglt.io.vn", customHost: true, defaultHost: PREVIEW_HOST });
		expect((await raw(rn.port, { path: "/__clam_preview/health", host: "dev-box.conglt.io.vn" })).status).toBe(200);
		const old = await raw(rn.port, { path: "/__clam_preview/health", host: PREVIEW_HOST });
		expect(old.status).toBe(403);
		expect(old.json?.error?.code).toBe("forbidden_host");
		expect((await local().put<PreviewStatus>(routes.previewConfig, { host: null })).body).toMatchObject({ customHost: false, host: PREVIEW_HOST });
		expect((await raw(rn.port, { path: "/__clam_preview/health", host: PREVIEW_HOST })).status).toBe(200);
		// near misses are not preview hosts (and the Host guard says so)
		for (const stranger of ["evil.conglt.io.vn", `5173-${PREVIEW_HOST}`, `x${PREVIEW_HOST}`, `${PREVIEW_HOST}.evil.example`]) {
			const res = await raw(rn.port, { path: "/__clam_preview/health", host: stranger });
			expect(res.status, stranger).toBe(403);
			expect(res.json?.error?.code).toBe("forbidden_host");
		}
		// a quick tunnel (or none) has nothing to address; a two-label hostname gets preview.<hostname>
		expect((await local().put("/tunnel/config", { mode: "quick" })).status).toBe(200);
		expect((await local().get<PreviewStatus>(routes.preview)).body).toMatchObject({ available: false, unavailableReason: "no_named_tunnel", host: null });
		expect((await raw(rn.port, { path: "/__clam_preview/health", host: PREVIEW_HOST })).status).toBe(403);
		expect((await local().post(routes.previewTicket, { port: app.port })).status).toBe(409);
		expect((await local().put("/tunnel/config", { mode: "named", hostname: "example.com", token: "t".repeat(24) })).status).toBe(200);
		expect((await local().get<PreviewStatus>(routes.preview)).body).toMatchObject({ available: true, host: "preview.example.com" });
		expect((await local().put("/tunnel/config", { mode: "named", hostname: TUNNEL_HOST, token: "t".repeat(24) })).status).toBe(200);
	});

	it("the reachability check probes https://<preview host>/__clam_preview/health and wants THIS node's id", async () => {
		const asked: string[] = [];
		const answer = (body: unknown, status = 200) => (async (url: string | URL | Request) => {
			asked.push(String(url));
			return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
		}) as typeof fetch;
		const nodeId = rn.n.ctx.identity.nodeId;
		const check = (fetchImpl: typeof fetch) => new PreviewService(rn.n.ctx, { fetch: fetchImpl }).check();

		const ok = await check(answer({ service: "clam-preview", nodeId }));
		expect(asked[0]).toBe(`https://${PREVIEW_HOST}/__clam_preview/health`);
		expect(ok).toMatchObject({ ok: true, reason: "ok", host: PREVIEW_HOST });
		expect(await check(answer({ service: "clam-preview", nodeId: "another-node" }))).toMatchObject({ ok: false, reason: "not_this_node" });
		expect((await check(answer({ hello: "world" }))).reason).toBe("not_this_node");
		expect((await check(answer({ service: "clam-preview", nodeId }, 502))).reason).toBe("not_this_node");
		const down = await check((async () => {
			throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }) });
		}) as typeof fetch);
		expect(down).toMatchObject({ ok: false, reason: "unreachable" });
		expect(down.message).toContain("ENOTFOUND");
	});
});
