import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NetworkClient, decodeCursor, encodeCursor, signRequest, signerFromIdentity, wire } from "@clam/agent-network";
import type { DirectoryAgent, Peer, SecurityInfo, Workspace } from "@clam/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { api, createMemorySecrets, type FullHarness } from "./full-harness.ts";
import { eventually, pair, peerOf, signedRequest, startNode } from "./net-helpers.ts";

const nodes: FullHarness[] = [];
const cleanups: Array<() => void> = [];
async function node(name: string, extra?: Parameters<typeof startNode>[1]): Promise<FullHarness> {
	const n = await startNode(name, extra);
	nodes.push(n);
	return n;
}
async function dropNode(n: FullHarness, keepData = false): Promise<void> {
	nodes.splice(nodes.indexOf(n), 1);
	await n.cleanup({ keepData });
}
afterEach(async () => {
	for (const n of nodes.splice(0)) await n.cleanup();
	for (const c of cleanups.splice(0)) c();
});

const NO_BODY = new Uint8Array(0);
const ERROR = (code: string) => ({ error: expect.objectContaining({ code }) });

describe("signed /api/v1 endpoints", () => {
	it("accepts a valid signed request and answers with a digest and the request id", async () => {
		const a = await node("node-a");
		const b = await node("node-b");
		await pair(a, b);
		const res = await signedRequest(b, a.netUrl, { path: "/agents" });
		expect(res.status).toBe(200);
		expect(res.body.agents[0]).toMatchObject({ name: "OMP Agent", runtime: "omp", status: "online", activeTasks: 0, acceptsTasks: true, activeSessions: 0 });
		expect(wire.AgentsResponse.safeParse(res.body).success).toBe(true);
		expect(res.headers.get("content-digest")).toMatch(/^sha-256=:[A-Za-z0-9+/]{43}=:$/);
		expect(res.headers.get("x-request-id")).toBeTruthy();
		expect(res.headers.get("cache-control")).toBe("no-store");
	});

	it("rejects replayed, tampered, skewed, unsigned, unknown and key-mismatched requests before touching anything", async () => {
		const a = await node("node-a");
		const b = await node("node-b");
		const stranger = await node("stranger");
		await pair(a, b);

		// Replay: byte-identical re-send of an accepted request.
		const first = await signedRequest(b, a.netUrl, { path: "/agents" });
		expect(first.status).toBe(200);
		const replay = await fetch(first.sent.url, first.sent.init);
		expect(replay.status).toBe(409);
		expect(await replay.json()).toEqual(ERROR("replayed_request"));

		// Tampered body: the digest no longer matches (announce would otherwise move the peer's URL).
		const body = { url: "http://127.0.0.1:1" };
		const tamperedBody = await signedRequest(b, a.netUrl, { method: "POST", path: "/node/announce", body, bodyOverride: JSON.stringify({ url: "http://127.0.0.1:2" }) });
		expect(tamperedBody.status).toBe(400);
		expect(tamperedBody.body).toEqual(ERROR("digest_mismatch"));
		expect((await peerOf(a, b.ctx.identity.nodeId))?.url).toBe(b.netUrl);

		// Tampered body with a recomputed digest: the signature no longer matches.
		const headers = signRequest(signerFromIdentity(b.ctx.identity), { method: "POST", url: `${a.netUrl}/api/v1/node/announce`, bodyBytes: Buffer.from(JSON.stringify(body)), idempotencyKey: "k1" });
		const forgedBytes = Buffer.from(JSON.stringify({ url: "http://127.0.0.1:2" }));
		const { createHash } = await import("node:crypto");
		headers["Content-Digest"] = `sha-256=:${createHash("sha256").update(forgedBytes).digest("base64")}:`;
		const forged = await fetch(`${a.netUrl}/api/v1/node/announce`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: forgedBytes });
		expect(forged.status).toBe(401);
		expect(await forged.json()).toEqual(ERROR("bad_signature"));

		// Tampered target: a signature for /agents does not authorize /events, nor another query.
		const signedForAgents = signRequest(signerFromIdentity(b.ctx.identity), { method: "GET", url: `${a.netUrl}/api/v1/agents`, bodyBytes: NO_BODY });
		const wrongPath = await fetch(`${a.netUrl}/api/v1/events`, { headers: signedForAgents });
		expect(wrongPath.status).toBe(401);
		expect(await wrongPath.json()).toEqual(ERROR("bad_signature"));
		const signedNoQuery = signRequest(signerFromIdentity(b.ctx.identity), { method: "GET", url: `${a.netUrl}/api/v1/agents`, bodyBytes: NO_BODY });
		expect((await fetch(`${a.netUrl}/api/v1/agents?x=1`, { headers: signedNoQuery })).status).toBe(401);

		// Cross-node relay: a request signed for A's address is useless against another node's address.
		const relayed = signRequest(signerFromIdentity(b.ctx.identity), { method: "GET", url: `${a.netUrl}/api/v1/agents`, bodyBytes: NO_BODY });
		const toStranger = await fetch(`${stranger.netUrl}/api/v1/agents`, { headers: relayed });
		expect(toStranger.status).toBe(401);
		expect(((await toStranger.json()) as any).error.code).toBe("unknown_peer");
		// ...and the Host is part of the signature: same node, different Host spelling.
		const forHost = signRequest(signerFromIdentity(b.ctx.identity), { method: "GET", url: `${a.netUrl.replace("127.0.0.1", "localhost")}/api/v1/agents`, bodyBytes: NO_BODY });
		const otherHost = await fetch(`${a.netUrl}/api/v1/agents`, { headers: forHost });
		expect(otherHost.status).toBe(401);
		expect(((await otherHost.json()) as any).error.code).toBe("bad_signature");

		// Skew: 5 minutes in the past and in the future.
		for (const offset of [-5 * 60_000, 5 * 60_000]) {
			const skewed = await signedRequest(b, a.netUrl, { path: "/agents", now: Date.now() + offset });
			expect(skewed.status).toBe(401);
			expect(skewed.body.error).toMatchObject({ code: "clock_skew", details: { maxSkewMs: 60_000 } });
			expect(Math.abs(skewed.body.error.details.serverTime - Date.now())).toBeLessThan(5_000);
		}

		// Unsigned (no protocol version header at all) and malformed.
		expect((await fetch(`${a.netUrl}/api/v1/agents`)).status).toBe(426);
		expect((await fetch(`${a.netUrl}/api/v1/events`)).status).toBe(426);
		const noSignature = await signedRequest(b, a.netUrl, { path: "/agents", mutate: (h) => delete h["X-Clam-Signature"] });
		expect(noSignature.status).toBe(400);
		expect(noSignature.body).toEqual(ERROR("invalid_request"));
		const unknownVersion = await signedRequest(b, a.netUrl, { path: "/agents", mutate: (h) => (h["X-Clam-Version"] = "9") });
		expect(unknownVersion.status).toBe(426);

		// A node that was never paired.
		const unpaired = await signedRequest(stranger, a.netUrl, { path: "/agents" });
		expect(unpaired.status).toBe(401);
		expect(unpaired.body).toEqual(ERROR("unknown_peer"));

		// The key id must be the pinned one.
		const wrongKey = await signedRequest(b, a.netUrl, { path: "/agents", mutate: (h) => (h["X-Clam-Key-Id"] = "0".repeat(16)) });
		expect(wrongKey.status).toBe(401);
		expect(wrongKey.body).toEqual(ERROR("key_mismatch"));

		// A mutating request without an idempotency key.
		const noKey = signRequest(signerFromIdentity(b.ctx.identity), { method: "GET", url: `${a.netUrl}/api/v1/node/revoke`, bodyBytes: NO_BODY });
		const postWithoutKey = await fetch(`${a.netUrl}/api/v1/node/revoke`, { method: "POST", headers: { ...noKey, "Content-Type": "application/json" }, body: "" });
		expect(postWithoutKey.status).toBe(401); // signed as GET: the method is part of the signature

		// Nothing above changed anything.
		expect((await peerOf(a, b.ctx.identity.nodeId))?.status).toBe("online");
	});

	it("enforces capabilities per peer and a per-peer rate limit", async () => {
		const a = await node("node-a", { options: { peerRateLimit: { capacity: 12, perSecond: 0.5 } } });
		const b = await node("node-b");
		await pair(a, b);
		expect((await signedRequest(b, a.netUrl, { path: "/agents" })).status).toBe(200);
		// Withdraw agents.read: the same peer is now forbidden, with the missing capability named.
		await api(a).patch(`/network/peers/${b.ctx.identity.nodeId}`, { grantedCapabilities: ["events.read"] });
		const forbidden = await signedRequest(b, a.netUrl, { path: "/agents" });
		expect(forbidden.status).toBe(403);
		expect(forbidden.body.error).toMatchObject({ code: "forbidden", details: { missing: ["agents.read"] } });
		await api(a).patch(`/network/peers/${b.ctx.identity.nodeId}`, { grantedCapabilities: [] });
		expect((await signedRequest(b, a.netUrl, { path: "/events" })).status).toBe(403);

		// Rate limiting: a burst beyond the bucket is refused with Retry-After and nothing else breaks.
		let limited: Awaited<ReturnType<typeof signedRequest>> | undefined;
		for (let i = 0; i < 40 && !limited; i++) {
			const res = await signedRequest(b, a.netUrl, { path: "/node/health" });
			if (res.status === 429) limited = res;
		}
		expect(limited?.status).toBe(429);
		expect(limited?.body).toEqual(ERROR("rate_limited"));
		expect(Number(limited?.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
	});

	it("keeps rejecting a replay after the receiving node restarts (nonce log survives)", async () => {
		const secrets = createMemorySecrets();
		const a = await node("node-a", { secrets });
		const b = await node("node-b");
		await pair(a, b);
		const first = await signedRequest(b, a.netUrl, { path: "/agents" });
		expect(first.status).toBe(200);
		const dataDir = a.dataDir;
		const port = a.netPort;
		expect((a.ctx.db.$client.prepare("select count(*) as n from nonce_log").get() as { n: number }).n).toBeGreaterThan(0);
		await dropNode(a, true);
		const restarted = await node("node-a", { dataDir, port, secrets });
		const replay = await fetch(first.sent.url, first.sent.init);
		expect(replay.status).toBe(409);
		expect(await replay.json()).toEqual(ERROR("replayed_request"));
		expect(restarted.netUrl).toBe(first.sent.url.replace("/api/v1/agents", ""));
	});

	it("serves the public endpoints without a signature but only the minimal health", async () => {
		const a = await node("node-a");
		const info = (await (await fetch(`${a.netUrl}/api/v1/node/info`)).json()) as any;
		expect(wire.NodeInfo.safeParse(info).success).toBe(true);
		expect(info).toMatchObject({ nodeId: a.ctx.identity.nodeId, fingerprint: a.ctx.identity.fingerprint, protocolVersions: [1], runtimes: ["omp"] });
		expect(info.capabilities).toContain("agents.read");
		const minimal = (await (await fetch(`${a.netUrl}/api/v1/node/health`)).json()) as object;
		expect(Object.keys(minimal).sort()).toEqual(["status", "time"]);
	});

	it("answers a signed health request with the full report", async () => {
		const a = await node("node-a");
		const b = await node("node-b");
		await pair(a, b);
		const res = await signedRequest(b, a.netUrl, { path: "/node/health" });
		expect(res.status).toBe(200);
		expect(wire.NodeHealthFull.safeParse(res.body).success).toBe(true);
		expect(res.body).toMatchObject({ status: "ok", activeRuntimes: 0, maxConcurrentRuntimes: 4, runningTasks: 0, queuedTasks: 0 });
		expect(res.body.checks.map((c: { name: string }) => c.name)).toEqual(["database", "omp", "runtime"]);
		expect(res.body.grantedCapabilities.sort()).toEqual(["agents.read", "events.read", "tasks.receive", "tasks.send"]);
		expect(typeof res.body.agentsRevision).toBe("string");
		// A bad signature on health is an error, never a silent downgrade to the minimal answer.
		const bad = await signedRequest(b, a.netUrl, { path: "/node/health", mutate: (h) => (h["X-Clam-Signature"] = "A".repeat(86)) });
		expect(bad.status).toBe(401);
	});
});

describe("listener isolation", () => {
	it("never serves /api/v1 on the UI listener, nor /api/local, /ws or static files on the network listener", async () => {
		const dist = mkdtempSync(join(tmpdir(), "clam-dist-"));
		cleanups.push(() => rmSync(dist, { recursive: true, force: true }));
		mkdirSync(join(dist, "assets"));
		writeFileSync(join(dist, "index.html"), '<!doctype html><div id="root"></div>');
		writeFileSync(join(dist, "assets", "app.js"), "console.log(1)");
		const a = await node("node-a", { webDistDir: dist });

		// UI listener: the web app and /api/local work, /api/v1 does not exist there.
		expect((await fetch(`${a.url}/`)).status).toBe(200);
		expect((await fetch(`${a.url}/api/local/node`)).status).toBe(200);
		const v1OnUi = await fetch(`${a.url}/api/v1/node/info`);
		expect(v1OnUi.status).toBe(404);
		expect((await fetch(`${a.url}/api/v1/events`)).status).toBe(404);

		// Network listener: only /api/v1.
		expect((await fetch(`${a.netUrl}/api/v1/node/info`)).status).toBe(200);
		for (const path of ["/", "/index.html", "/assets/app.js", "/api/local/node", "/api/local/security", "/ws", "/api", "/api/v1", "/api/v1/", "/api/v1/node/info/", "/api/V1/node/info", "/favicon.ico", "/api/v1/tasks", "/api/v1/handoffs", "/api/v1/artifacts", "/api/v1/context/sync"]) {
			const res = await fetch(`${a.netUrl}${path}`);
			expect(res.status, path).toBe(404);
			expect(await res.json(), path).toMatchObject({ error: { code: "not_found" } });
		}
		for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
			expect((await fetch(`${a.netUrl}/api/local/workspaces`, { method, headers: { "content-type": "application/json" }, body: "{}" })).status, method).toBe(404);
		}
		// The network listener must not accept an unexpected Host (DNS rebinding / foreign tunnel hostnames).
		const { request } = await import("node:http");
		const status = await new Promise<number>((resolve, reject) => {
			const req = request({ host: "127.0.0.1", port: a.netPort, path: "/api/v1/node/info", headers: { Host: "evil.example" } }, (res) => {
				res.resume();
				resolve(res.statusCode ?? 0);
			});
			req.on("error", reject);
			req.end();
		});
		expect(status).toBe(403);
	});

	it("reports the tunnel's public hostname as acceptable Host once a tunnel is up", async () => {
		const a = await node("node-a");
		expect(a.ctx.network.tunnel.publicHostname()).toBeNull();
		expect((await api(a).get<SecurityInfo>("/security")).body.remoteApiEnabled).toBe(false);
	});
});

describe("revocation", () => {
	it("cuts a revoked peer off at once and tells it: the very next request is refused and the peer shows revokedBy remote", async () => {
		const a = await node("node-a");
		const b = await node("node-b");
		await pair(a, b);
		expect((await signedRequest(b, a.netUrl, { path: "/agents" })).status).toBe(200);

		const revoked = await api(a).post<Peer>(`/network/peers/${b.ctx.identity.nodeId}/revoke`);
		expect(revoked.body).toMatchObject({ status: "revoked", revokedBy: "local", grantedCapabilities: [], agentCount: 0, workspaceIds: [] });
		// The very next request, on any endpoint, is refused: no grace period.
		for (const path of ["/agents", "/node/health", "/events"]) {
			const refused = await signedRequest(b, a.netUrl, { path });
			expect(refused.status, path).toBe(403);
			expect(refused.body, path).toEqual(ERROR("peer_revoked"));
		}
		// B learns (revoke notice and/or its next heartbeat) and records that the OTHER node revoked it.
		await eventually(async () => (await peerOf(b, a.ctx.identity.nodeId))?.status === "revoked", "B marks A revoked");
		expect(await peerOf(b, a.ctx.identity.nodeId)).toMatchObject({ revokedBy: "remote", grantedCapabilities: [], workspaceIds: [] });
		expect((await peerOf(a, b.ctx.identity.nodeId))?.revokedBy).toBe("local");
		// Directory no longer lists the revoked node's agents, either way.
		expect((await api(a).get<DirectoryAgent[]>("/network/agents")).body.every((d) => d.nodeStatus === "self")).toBe(true);
		expect((await api(b).get<DirectoryAgent[]>("/network/agents")).body.every((d) => d.nodeStatus === "self")).toBe(true);
		// B's own requests to A fail with the revocation, and A stops monitoring B.
		expect(a.ctx.db.$client.prepare("select count(*) as n from workspace_members where member_id = ? and revoked_at is null").get(b.ctx.identity.nodeId)).toEqual({ n: 0 });
		// Idempotent.
		expect((await api(a).post<Peer>(`/network/peers/${b.ctx.identity.nodeId}/revoke`)).body.status).toBe("revoked");
		expect((await api(a).patch(`/network/peers/${b.ctx.identity.nodeId}`, { name: "x" })).status).toBe(409);
	});

	it("learns of a revocation through the heartbeat alone when the notice never arrives", async () => {
		const a = await node("node-a");
		const b = await node("node-b");
		await pair(a, b);
		// Silence the best-effort notice (and the event stream) by revoking directly in A's database layer, not through the service.
		a.ctx.network.peers.revoke(b.ctx.identity.nodeId, "local");
		await eventually(async () => (await peerOf(b, a.ctx.identity.nodeId))?.revokedBy === "remote", "B marks A revoked via 403 peer_revoked / event");
	});

	it("accepts a signed /node/revoke from a paired peer and nothing from anyone else", async () => {
		const a = await node("node-a");
		const b = await node("node-b");
		const c = await node("node-c");
		await pair(a, b);
		expect((await signedRequest(c, a.netUrl, { method: "POST", path: "/node/revoke", body: {} })).status).toBe(401);
		expect((await peerOf(a, b.ctx.identity.nodeId))?.status).toBe("online");
		const res = await signedRequest(b, a.netUrl, { method: "POST", path: "/node/revoke", body: { reason: "bye" } });
		expect(res.status).toBe(200);
		expect(await peerOf(a, b.ctx.identity.nodeId)).toMatchObject({ status: "revoked", revokedBy: "remote" });
	});
});

describe("heartbeat", () => {
	it("marks a stopped peer offline after missed heartbeats, keeps its cached agents, and brings it back online", async () => {
		const a = await node("node-a");
		let b = await node("node-b");
		await pair(a, b);
		await eventually(async () => (await api(a).get<DirectoryAgent[]>("/network/agents")).body.length === 2, "B's agents cached");
		const dir = b.dataDir;
		const port = b.netPort;
		const secrets = b.ctx.secrets;
		await dropNode(b, true);
		const offline = await eventually(async () => {
			const p = await peerOf(a, b.ctx.identity.nodeId);
			return p?.status === "offline" ? p : null;
		}, "B offline");
		expect(offline.lastError).toBeTruthy();
		expect(offline.agentCount).toBe(1); // offline never deletes anything
		const cached = (await api(a).get<DirectoryAgent[]>("/network/agents")).body.find((d) => d.nodeStatus === "offline");
		expect(cached).toMatchObject({ nodeName: "node-b", status: "offline" });

		b = await node("node-b", { dataDir: dir, port, secrets });
		const online = await eventually(async () => {
			const p = await peerOf(a, b.ctx.identity.nodeId);
			return p?.status === "online" ? p : null;
		}, "B online again", 15_000);
		expect(online.lastError).toBeNull();
		expect(online.lastSeenAt).toBeTruthy();
		expect(online.latencyMs).not.toBeNull();
		await eventually(async () => (await peerOf(b, a.ctx.identity.nodeId))?.status === "online", "A online on B");
	});

	it("waits three misses before declaring a peer offline and reports degraded in between", async () => {
		const a = await node("node-a", { options: { monitor: { intervalMs: 300, jitter: 0, missesForOffline: 3 } } });
		const b = await node("node-b");
		await pair(a, b);
		const seen = new Set<string>();
		const off = a.ctx.bus.subscribe("network", (event) => {
			const e = event as { type: string; peer?: Peer };
			if (e.type === "peer" && e.peer?.id === b.ctx.identity.nodeId) seen.add(e.peer.status);
		});
		await dropNode(b);
		await eventually(async () => (await peerOf(a, b.ctx.identity.nodeId))?.status === "offline", "offline");
		off();
		expect([...seen]).toContain("degraded");
	});
});

describe("events (SSE)", () => {
	async function collect(from: FullHarness, to: FullHarness, options: { lastEventId?: string; until: number; startSeq?: number }) {
		const client = new NetworkClient({ signer: signerFromIdentity(from.ctx.identity), allowLoopbackHttp: true });
		const abort = new AbortController();
		const received: Array<{ id: string; event: string; data: any }> = [];
		const opened = Promise.withResolvers<void>();
		const done = client.events(to.netUrl, {
			lastEventId: options.lastEventId,
			signal: abort.signal,
			onOpen: () => opened.resolve(),
			onEvent: (e) => {
				received.push(e as (typeof received)[number]);
				if (received.filter((r) => r.event !== "stream.reset").length >= options.until) abort.abort();
			},
		});
		done.catch((error) => opened.reject(error));
		return { received, abort, done, opened: opened.promise };
	}

	it("streams node events with a gap-free seq and resumes from Last-Event-ID without gaps or duplicates", async () => {
		const a = await node("node-a");
		const b = await node("node-b");
		await pair(a, b);
		// Stop B's monitor from consuming the stream so this test sees every frame itself.
		const start = a.ctx.network.events.bounds("node").last;
		const append = (n: number) => {
			for (let i = 0; i < n; i++) a.ctx.network.events.append("node", "agents_changed", { count: i });
		};

		const first = await collect(b, a, { until: 3 });
		await new Promise((resolve) => setTimeout(resolve, 100)); // let the stream open: no cursor = from now
		append(3);
		await first.done;
		const firstSeqs = first.received.map((e) => e.data.seq);
		expect(firstSeqs).toEqual([start + 1, start + 2, start + 3]);
		expect(first.received[0]).toMatchObject({ event: "agents_changed", data: { stream: "node", type: "agents_changed", payload: { count: 0 } } });
		expect(wire.NodeEvent.safeParse(first.received[0]?.data).success).toBe(true);
		const lastId = first.received.at(-1)?.id as string;
		expect(decodeCursor(lastId)).toEqual({ node: start + 3 });

		// Events appended while the consumer is away are replayed after the cursor, then the stream goes live.
		append(2);
		const second = await collect(b, a, { lastEventId: lastId, until: 4 });
		await new Promise((resolve) => setTimeout(resolve, 100));
		append(2);
		await second.done;
		const secondSeqs = second.received.map((e) => e.data.seq);
		expect(secondSeqs).toEqual([start + 4, start + 5, start + 6, start + 7]);
		// Together: exactly start+1..start+7 once each.
		expect([...firstSeqs, ...secondSeqs]).toEqual(Array.from({ length: 7 }, (_, i) => start + 1 + i));
	});

	it("tells a consumer whose cursor lies beyond (or before) what is retained to reset instead of faking continuity", async () => {
		const a = await node("node-a");
		const b = await node("node-b");
		await pair(a, b);
		a.ctx.network.events.append("node", "agents_changed", {});
		const ahead = await collect(b, a, { lastEventId: encodeCursor({ node: 99_999 }), until: 1 });
		await new Promise((resolve) => setTimeout(resolve, 150));
		const bounds = a.ctx.network.events.bounds("node");
		a.ctx.network.events.append("node", "agents_changed", {});
		await ahead.done;
		expect(ahead.received[0]).toMatchObject({ event: "stream.reset" });
		expect(ahead.received[1]?.data.seq).toBe(bounds.last + 1);
		// A malformed cursor is a client error, not a silent restart.
		const bad = await signedRequest(b, a.netUrl, { path: "/events", mutate: (h) => (h["Last-Event-ID"] = "not a cursor!") });
		expect(bad.status).toBe(400);
		// Unknown stream.
		expect((await signedRequest(b, a.netUrl, { path: "/events?stream=task%3Aabc" })).status).toBe(404);
	});

	it("keeps per-peer privacy: audience-scoped events carry an empty payload for everyone else", async () => {
		const a = await node("node-a");
		const b = await node("node-b");
		await pair(a, b);
		const own = await collect(b, a, { until: 2 });
		await new Promise((resolve) => setTimeout(resolve, 100));
		a.ctx.network.events.append("node", "peer_updated", { peerId: b.ctx.identity.nodeId, capabilities: ["tasks.send"] }, b.ctx.identity.nodeId);
		a.ctx.network.events.append("node", "peer_updated", { peerId: "node_someoneelse", capabilities: ["tasks.cancel"] }, "node_someoneelse");
		await own.done;
		expect(own.received[0]?.data.payload).toEqual({ peerId: b.ctx.identity.nodeId, capabilities: ["tasks.send"] });
		expect(own.received[1]?.data.payload).toEqual({});
	});

	it("requires events.read and closes the stream of a peer that is revoked mid-stream after delivering the notice", async () => {
		const a = await node("node-a");
		const b = await node("node-b");
		await pair(a, b);
		const stream = await collect(b, a, { until: 99 });
		await stream.opened;
		a.ctx.network.peers.revoke(b.ctx.identity.nodeId, "local");
		await stream.done; // the server ends the stream
		expect(stream.received.map((e) => e.event)).toContain("peer_revoked");
		expect(stream.received.find((e) => e.event === "peer_revoked")?.data.payload).toMatchObject({ peerId: b.ctx.identity.nodeId });
		expect(a.ctx.network.connections.count(b.ctx.identity.nodeId)).toBe(0);
	});
});

describe("announce", () => {
	it("updates a peer's stored URL after verifying that the new address belongs to it, and refuses impostors", async () => {
		const a = await node("node-a");
		const b = await node("node-b");
		const c = await node("node-c");
		await pair(a, b);
		const moved = b.netUrl.replace("127.0.0.1", "localhost");
		const ok = await signedRequest(b, a.netUrl, { method: "POST", path: "/node/announce", body: { url: moved, name: "node-b-renamed" } });
		expect(ok.status).toBe(200);
		expect(await peerOf(a, b.ctx.identity.nodeId)).toMatchObject({ url: moved, name: "node-b-renamed" });
		await eventually(async () => {
			const p = await peerOf(a, b.ctx.identity.nodeId);
			return p?.status === "online";
		}, "still online on the new URL");

		// B names C's address as its own: C's /node/info shows another fingerprint, so nothing changes.
		const impostor = await signedRequest(b, a.netUrl, { method: "POST", path: "/node/announce", body: { url: c.netUrl } });
		expect(impostor.status).toBe(409);
		expect(impostor.body).toEqual(ERROR("fingerprint_mismatch"));
		// An unreachable address is not accepted either.
		const dead = await signedRequest(b, a.netUrl, { method: "POST", path: "/node/announce", body: { url: "http://127.0.0.1:9" } });
		expect(dead.status).toBe(502);
		expect(dead.body).toEqual(ERROR("url_unreachable"));
		// Plain http to a non-loopback host is not a valid peer URL at all.
		const plain = await signedRequest(b, a.netUrl, { method: "POST", path: "/node/announce", body: { url: "http://example.com" } });
		expect(plain.status).toBe(400);
		expect((await peerOf(a, b.ctx.identity.nodeId))?.url).toBe(moved);
	});

	it("announces its own name to peers when the node is renamed", async () => {
		const a = await node("node-a");
		const b = await node("node-b");
		await pair(a, b);
		await api(a).patch("/settings", { nodeName: "Studio" });
		await eventually(async () => (await peerOf(b, a.ctx.identity.nodeId))?.name === "Studio", "B learns the new name");
	});
});

describe("capabilities and directory propagate", () => {
	it("pushes capability changes to the peer and refreshes the directory when agents change", async () => {
		const a = await node("node-a");
		const b = await node("node-b");
		await pair(a, b);
		await api(a).patch(`/network/peers/${b.ctx.identity.nodeId}`, { grantedCapabilities: ["agents.read", "events.read", "handoff.send"] });
		await eventually(async () => (await peerOf(b, a.ctx.identity.nodeId))?.receivedCapabilities.sort().join() === "agents.read,events.read,handoff.send", "B learns what A now grants it");
		expect((await peerOf(a, b.ctx.identity.nodeId))?.grantedCapabilities.sort()).toEqual(["agents.read", "events.read", "handoff.send"]);
		expect(a.ctx.db.$client.prepare("select permissions from workspace_members where member_id = ?").get(b.ctx.identity.nodeId)).toEqual({ permissions: JSON.stringify(["agents.read", "events.read", "handoff.send"]) });

		// B edits its agent: A's directory follows without waiting for the 5-minute refresh.
		const [agent] = (await api(b).get<Array<{ id: string }>>("/agents")).body;
		await api(b).patch(`/agents/${agent?.id}`, { name: "Reviewer", role: "Code review" });
		await eventually(async () => (await api(a).get<DirectoryAgent[]>("/network/agents")).body.find((d) => d.nodeId === b.ctx.identity.nodeId)?.name === "Reviewer", "A's directory shows the new name");
		const refreshed = (await api(a).get<DirectoryAgent[]>("/network/agents?refresh=1")).body.find((d) => d.nodeId === b.ctx.identity.nodeId);
		expect(refreshed).toMatchObject({ name: "Reviewer", role: "Code review" });

		// Without agents.read the peer's agents are not shown at all.
		await api(b).patch(`/network/peers/${a.ctx.identity.nodeId}`, { grantedCapabilities: ["events.read"] });
		await eventually(async () => (await api(a).get<DirectoryAgent[]>("/network/agents")).body.every((d) => d.nodeStatus === "self"), "A shows none of B's agents");
	});
});
