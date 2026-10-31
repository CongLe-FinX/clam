import { randomBytes } from "node:crypto";
import type { Context, ContextSearchHit, ContextVersion, Project, Workspace } from "@clam/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contextsOn } from "./context-fixtures.ts";
import { api, connectWs, createFullHarness, type FullHarness, type WsClient } from "./full-harness.ts";

let node: FullHarness;
let http: ReturnType<typeof api>;
let ws: Workspace;
let project: Project;
const sockets: WsClient[] = [];

beforeEach(async () => {
	node = await createFullHarness();
	http = api(node);
	ws = (await http.post<Workspace>("/workspaces", { name: "W" })).body;
	project = (await http.post<Project>("/projects", { workspaceId: ws.id, name: "P", path: node.projectDir })).body;
});
afterEach(async () => {
	for (const s of sockets.splice(0)) s.close();
	await node.cleanup();
});

const create = (over: Record<string, unknown> = {}) => http.post<Context>("/contexts", { workspaceId: ws.id, type: "memory", title: "Title", body: "Body", ...over });
const errorCode = (res: { body: unknown }) => (res.body as { error: { code: string } }).error.code;

describe("create, read, list", () => {
	it("creates a private version 1 authored by the human of this node", async () => {
		const res = await create({ title: "  Coding   style ", body: "Tabs\r\nNo semicolons  \r\n\r\n" });
		expect(res.status).toBe(201);
		expect(res.body).toMatchObject({ workspaceId: ws.id, projectId: null, type: "memory", title: "Coding style", body: "Tabs\nNo semicolons\n", shareable: false, version: 1, gitPath: null });
		expect(res.body.id).toMatch(/^ctx_[0-9a-f]{16}$/);
		expect(res.body.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(res.body.author).toEqual({ kind: "human", nodeId: node.ctx.identity.nodeId, nodeName: expect.any(String), agentName: null });
		expect(res.body.sync).toEqual({ state: "private", syncedTo: [], conflict: null });
		const got = await http.get<Context>(`/contexts/${res.body.id}`);
		expect(got.body).toEqual(res.body);
	});

	it("a shareable context with nobody to share with is synced; a project context carries its project", async () => {
		const shared = await create({ shareable: true, projectId: project.id });
		expect(shared.body).toMatchObject({ shareable: true, projectId: project.id });
		expect(shared.body.sync).toEqual({ state: "synced", syncedTo: [], conflict: null });
	});

	it("validates the body, the workspace and the project", async () => {
		expect((await create({ title: "   " })).status).toBe(400);
		expect((await create({ type: "essay" })).status).toBe(400);
		expect((await create({ body: "x".repeat(200_001) })).status).toBe(400);
		expect((await create({ workspaceId: "ws_missing" })).status).toBe(404);
		expect((await create({ projectId: "prj_missing" })).status).toBe(404);
		const otherWs = (await http.post<Workspace>("/workspaces", { name: "Other" })).body;
		const foreign = (await http.post<Project>("/projects", { workspaceId: otherWs.id, name: "F", path: node.dataDir })).body;
		expect((await create({ projectId: foreign.id })).status).toBe(404);
		expect((await http.get(`/contexts/ctx_missing`)).status).toBe(404);
	});

	it("lists newest first and filters by workspace, project, type and shareability", async () => {
		const a = (await create({ title: "A", projectId: project.id })).body;
		const b = (await create({ title: "B", type: "decision", shareable: true })).body;
		const c = (await create({ title: "C", projectId: project.id, type: "plan" })).body;
		const otherWs = (await http.post<Workspace>("/workspaces", { name: "Other" })).body;
		const d = (await http.post<Context>("/contexts", { workspaceId: otherWs.id, type: "note", title: "D", body: "x" })).body;
		const ids = async (q: string) => (await http.get<Context[]>(`/contexts${q}`)).body.map((x) => x.id);
		expect(await ids("")).toEqual([d.id, c.id, b.id, a.id]);
		expect(await ids(`?workspaceId=${ws.id}`)).toEqual([c.id, b.id, a.id]);
		expect(await ids(`?projectId=${project.id}`)).toEqual([c.id, a.id]);
		expect(await ids(`?workspaceId=${ws.id}&type=decision`)).toEqual([b.id]);
		expect(await ids(`?shareable=true`)).toEqual([b.id]);
		expect(await ids(`?shareable=false&workspaceId=${ws.id}`)).toEqual([c.id, a.id]);
		expect((await http.get(`/contexts?type=essay`)).status).toBe(400);
		expect((await http.get(`/contexts?projectId=prj_missing`)).status).toBe(404);
	});
});

describe("versions and optimistic concurrency", () => {
	it("every edit is a new immutable version; an edit based on an old version is refused", async () => {
		const c = (await create({ body: "one" })).body;
		const v2 = await http.patch<Context>(`/contexts/${c.id}`, { baseVersion: 1, body: "two" });
		expect(v2.status).toBe(200);
		expect(v2.body).toMatchObject({ version: 2, body: "two\n" });
		expect(v2.body.sha256).not.toBe(c.sha256);
		const stale = await http.patch(`/contexts/${c.id}`, { baseVersion: 1, body: "three" });
		expect(stale.status).toBe(409);
		expect(errorCode(stale)).toBe("stale_version");
		expect((stale.body as { error: { details: { currentVersion: number } } }).error.details.currentVersion).toBe(2);
		const v3 = await http.patch<Context>(`/contexts/${c.id}`, { baseVersion: 2, title: "Renamed" });
		expect(v3.body).toMatchObject({ version: 3, title: "Renamed", body: "two\n" });
		const versions = (await http.get<ContextVersion[]>(`/contexts/${c.id}/versions`)).body;
		expect(versions.map((v) => [v.version, v.title, v.body])).toEqual([[3, "Renamed", "two\n"], [2, "Title", "two\n"], [1, "Title", "one\n"]]);
		expect(versions[2]?.sha256).toBe(c.sha256);
		expect(versions.every((v) => v.author.kind === "human")).toBe(true);
	});

	it("an edit that changes nothing is not a version; marking shareable keeps the version", async () => {
		const c = (await create({ body: "same" })).body;
		const same = await http.patch<Context>(`/contexts/${c.id}`, { baseVersion: 1, body: "same\r\n", title: "Title" });
		expect(same.body.version).toBe(1);
		const shared = await http.patch<Context>(`/contexts/${c.id}`, { baseVersion: 1, shareable: true });
		expect(shared.body).toMatchObject({ version: 1, shareable: true });
		expect((await http.get<ContextVersion[]>(`/contexts/${c.id}/versions`)).body).toHaveLength(1);
		expect((await http.patch(`/contexts/${c.id}`, { baseVersion: 1, title: "  " })).status).toBe(400);
		expect((await http.patch(`/contexts/${c.id}`, { body: "x" })).status).toBe(400);
		expect((await http.patch(`/contexts/ctx_missing`, { baseVersion: 1 })).status).toBe(404);
	});

	it("two writers racing on the same base: exactly one wins", async () => {
		const c = (await create({ body: "base" })).body;
		const results = await Promise.all([http.patch(`/contexts/${c.id}`, { baseVersion: 1, body: "writer one" }), http.patch(`/contexts/${c.id}`, { baseVersion: 1, body: "writer two" })]);
		expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
		expect((await http.get<Context>(`/contexts/${c.id}`)).body.version).toBe(2);
	});

	it("resolving a context that is not in conflict is refused", async () => {
		const c = (await create()).body;
		const res = await http.post(`/contexts/${c.id}/resolve`, { keep: "local" });
		expect(res.status).toBe(409);
		expect(errorCode(res)).toBe("no_conflict");
		expect((await http.post(`/contexts/${c.id}/resolve`, { keep: "nonsense" })).status).toBe(400);
	});
});

describe("deleting", () => {
	it("hard-deletes a private context with its history and index entry", async () => {
		const c = (await create({ body: "ephemeral words" })).body;
		await http.patch(`/contexts/${c.id}`, { baseVersion: 1, body: "ephemeral words two" });
		expect((await http.del(`/contexts/${c.id}`)).status).toBe(204);
		expect((await http.get(`/contexts/${c.id}`)).status).toBe(404);
		expect(node.ctx.contexts.store.find(c.id)).toBeUndefined();
		expect(node.ctx.contexts.store.snapshots(c.id)).toEqual([]);
		expect((await http.get<ContextSearchHit[]>(`/contexts/search?q=ephemeral`)).body).toEqual([]);
		expect((await http.del(`/contexts/${c.id}`)).status).toBe(404);
	});

	it("tombstones a shareable context: hidden everywhere, old text blanked, the deletion remembered", async () => {
		const c = (await create({ body: "shared words", shareable: true })).body;
		await http.patch(`/contexts/${c.id}`, { baseVersion: 1, body: "shared words v2" });
		expect((await http.del(`/contexts/${c.id}`)).status).toBe(204);
		expect((await http.get(`/contexts/${c.id}`)).status).toBe(404);
		expect((await http.get<Context[]>(`/contexts`)).body).toEqual([]);
		expect((await http.get<ContextSearchHit[]>(`/contexts/search?q=shared`)).body).toEqual([]);
		const row = node.ctx.contexts.store.find(c.id);
		expect(row).toMatchObject({ body: "", version: 3 });
		expect(row?.deletedAt).not.toBeNull();
		const snaps = node.ctx.contexts.store.snapshots(c.id);
		expect(snaps.map((s) => [s.version, s.deleted, s.body])).toEqual([[3, true, ""], [2, false, ""], [1, false, ""]]);
	});
});

describe("search", () => {
	it("ranks, shows excerpts and honours the filters", async () => {
		const body = (await create({ title: "Notes", body: "Remember the deployment checklist before every release." })).body;
		const title = (await create({ title: "Deployment checklist", body: "Steps." })).body;
		const plan = (await create({ title: "Plan", type: "plan", projectId: project.id, body: "deployment in March" })).body;
		const hits = (await http.get<ContextSearchHit[]>(`/contexts/search?q=deployment&workspaceId=${ws.id}`)).body;
		expect(hits.map((h) => h.context.id)).toEqual([title.id, body.id, plan.id].sort((x, y) => (hits.findIndex((h) => h.context.id === x) - hits.findIndex((h) => h.context.id === y))));
		expect(hits[0]?.context.id).toBe(title.id);
		expect(hits[0]?.snippet).toContain("«Deployment»");
		expect(hits[0]?.rank).toBeGreaterThan(hits[1]?.rank ?? 0);
		expect(hits.every((h) => !("body" in h.context))).toBe(true);
		expect((await http.get<ContextSearchHit[]>(`/contexts/search?q=deploy&projectId=${project.id}`)).body.map((h) => h.context.id)).toEqual([plan.id]);
		expect((await http.get<ContextSearchHit[]>(`/contexts/search?q=deploy&type=plan`)).body.map((h) => h.context.id)).toEqual([plan.id]);
		expect((await http.get<ContextSearchHit[]>(`/contexts/search?q=deploy&limit=1`)).body).toHaveLength(1);
	});

	it("treats FTS syntax as words and rejects an empty query", async () => {
		await create({ title: "Normal", body: "just words here" });
		for (const q of ['"', "(", "NEAR(", "title:x OR", "*", "a AND b"]) expect((await http.get(`/contexts/search?q=${encodeURIComponent(q)}`)).status).toBe(200);
		expect((await http.get(`/contexts/search?q=`)).status).toBe(400);
		expect((await http.get(`/contexts/search`)).status).toBe(400);
		expect((await http.get(`/contexts/search?q=words&limit=0`)).status).toBe(400);
	});

	it("answers within 100 ms over 10 000 snapshots (a context is searched by its current text)", async () => {
		const sqlite = node.ctx.db.$client;
		const words = "alpha beta gamma delta epsilon zeta theta iota kappa lambda sigma omega project memory plan decision summary note build deploy release test review style format commit branch merge cache queue worker server client".split(" ");
		const pick = (i: number): string => words[(i * 7919) % words.length] as string;
		const insertContext = sqlite.prepare("insert into contexts(id,workspace_id,origin_node_id,type,title,body,version,sha256,author) values(?,?,?,?,?,?,?,?,?)");
		const insertSnapshot = sqlite.prepare("insert into context_snapshots(id,context_id,version,sha256,title,body,author,origin_node_id) values(?,?,?,?,?,?,?,?)");
		const author = JSON.stringify({ kind: "human", nodeId: "n", nodeName: "n", agentName: null });
		sqlite.transaction(() => {
			for (let c = 0; c < 2_000; c++) {
				const id = `ctx_${c.toString(16).padStart(16, "0")}`;
				const make = (v: number) => ({
					title: `${pick(c)} ${pick(c + v)} notes ${c}`,
					body: Array.from({ length: 60 }, (_, k) => pick(c * 31 + v * 17 + k)).join(" ") + ` marker${c} v${v}`,
				});
				const head = make(5);
				insertContext.run(id, ws.id, node.ctx.identity.nodeId, "memory", head.title, head.body, 5, randomBytes(32).toString("hex"), author);
				for (let v = 1; v <= 5; v++) {
					const { title, body } = make(v);
					insertSnapshot.run(`snap_${c}_${v}`, id, v, randomBytes(32).toString("hex"), title, body, author, node.ctx.identity.nodeId);
				}
			}
		})();
		expect((sqlite.prepare("select count(*) n from context_snapshots").get() as { n: number }).n).toBe(10_000);
		const timed = async (q: string): Promise<number> => {
			const t0 = performance.now();
			const res = await http.get<ContextSearchHit[]>(`/contexts/search?q=${encodeURIComponent(q)}&workspaceId=${ws.id}&limit=20`);
			expect(res.status).toBe(200);
			return performance.now() - t0;
		};
		const queries = ["alpha", "deploy release", '"memory plan"', "marker77", "ker", "style form", "zzzz"];
		for (const q of queries) await timed(q); // warm up
		const worst = Math.max(...(await Promise.all(queries.map(timed))).map((ms) => ms));
		const hit = (await http.get<ContextSearchHit[]>(`/contexts/search?q=marker77`)).body;
		// `marker77` is a prefix: it also finds marker770… but the exact one is among the hits.
		expect(hit.map((h) => h.context.id)).toContain(`ctx_${(77).toString(16).padStart(16, "0")}`);
		expect(worst).toBeLessThan(100);
		// Sequentially (no queueing behind other requests) it is far below that.
		const sequential: number[] = [];
		for (const q of queries) sequential.push(await timed(q));
		expect(Math.max(...sequential)).toBeLessThan(100);
	});
});

describe("events on the contexts topic", () => {
	it("publishes created, edited and removed contexts to subscribers", async () => {
		const socket = await connectWs(node);
		sockets.push(socket);
		socket.send({ type: "subscribe", topics: ["contexts"] });
		await socket.waitFor((f) => f.type === "subscribed", "subscribed");
		const c = (await create({ title: "Live" })).body;
		await socket.waitFor((f) => f.type === "event" && f.topic === "contexts" && f.event.type === "context" && f.event.context.id === c.id && f.event.context.version === 1, "created event");
		await http.patch(`/contexts/${c.id}`, { baseVersion: 1, body: "changed" });
		await socket.waitFor((f) => f.type === "event" && f.topic === "contexts" && f.event.type === "context" && f.event.context.version === 2, "edited event");
		await http.del(`/contexts/${c.id}`);
		await socket.waitFor((f) => f.type === "event" && f.topic === "contexts" && f.event.type === "removed" && f.event.contextId === c.id, "removed event");
	});
});

describe("workspace members of a solo node", () => {
	it("lists this node as the owner", async () => {
		const res = await http.get<Array<{ nodeId: string; role: string; nodeStatus: string }>>(`/workspaces/${ws.id}/members`);
		expect(res.body).toEqual([expect.objectContaining({ nodeId: node.ctx.identity.nodeId, role: "owner", nodeStatus: "self", revokedAt: null })]);
		expect((await http.get(`/workspaces/ws_missing/members`)).status).toBe(404);
	});
});

export { contextsOn };
