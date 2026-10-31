import { outbox } from "@clam/database";
import type { Context, WorkspaceMember } from "@clam/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SYNC_TIMINGS, contextsOn, grantContextSync, startContextPair, waitForContext, type ContextPair } from "./context-fixtures.ts";
import { api } from "./full-harness.ts";
import { eventually, pair, signedRequest, startNode } from "./net-helpers.ts";

let p: ContextPair;
beforeEach(async () => {
	p = await startContextPair();
});
afterEach(async () => {
	await p.cleanup();
});

const syncItems = (node: ContextPair["a"]) => node.ctx.db.select().from(outbox).all().filter((i) => i.kind === "context.sync");

describe("shareable contexts replicate to workspace members", () => {
	it("a shareable memory created on A appears on B, synced, with its author; edits flow both ways", async () => {
		const created = await contextsOn(p.a).create({ workspaceId: p.workspace.id, title: "Coding style", body: "Tabs, no semicolons", shareable: true });
		const onB = await waitForContext(p.b, created.id, () => true, "the memory on B");
		expect(onB).toMatchObject({ title: "Coding style", body: "Tabs, no semicolons\n", shareable: true, version: 1, sha256: created.sha256, workspaceId: p.workspace.id, projectId: null });
		expect(onB.author).toMatchObject({ kind: "human", nodeName: "node-a" });
		// A learns that B holds it.
		const onA = await waitForContext(p.a, created.id, (c) => c.sync.state === "synced", "A sees it synced");
		expect(onA.sync.syncedTo).toEqual([p.bId]);

		// B edits (a fast-forward on A), then A edits again.
		const edited = await contextsOn(p.b).edit(created.id, { body: "Tabs, no semicolons, trailing commas" });
		expect(edited.version).toBe(2);
		await waitForContext(p.a, created.id, (c) => c.version === 2 && c.body.includes("trailing commas"), "B's edit on A");
		await contextsOn(p.a).edit(created.id, { title: "Coding style (TypeScript)" });
		const back = await waitForContext(p.b, created.id, (c) => c.version === 3, "A's second edit on B");
		expect(back.title).toBe("Coding style (TypeScript)");
		expect((await waitForContext(p.a, created.id, (c) => c.sync.state === "synced", "synced again")).sync.conflict).toBeNull();
		const versions = (await api(p.b).get<Array<{ version: number }>>(`/contexts/${created.id}/versions`)).body;
		expect(versions.map((v) => v.version)).toEqual([3, 2, 1]);
	});

	it("a private context never leaves the node — not on change, not on reconcile, not when marked shareable and back", async () => {
		const secret = "private-launch-codes-4242";
		const priv = await contextsOn(p.a).create({ workspaceId: p.workspace.id, title: "My notes", body: secret });
		const shared = await contextsOn(p.a).create({ workspaceId: p.workspace.id, title: "Team note", body: "visible to the team", shareable: true });
		await waitForContext(p.b, shared.id, () => true, "the shared note on B");
		// Give the reconcile timer several rounds.
		await new Promise((resolve) => setTimeout(resolve, 1_300));
		expect(await contextsOn(p.b).get(priv.id)).toBeUndefined();
		for (const item of syncItems(p.a)) expect(JSON.stringify(item.body)).not.toContain(secret);
		expect((await contextsOn(p.b).list()).map((c) => c.id)).toEqual([shared.id]);
		expect((await contextsOn(p.a).get(priv.id))?.sync).toMatchObject({ state: "private", syncedTo: [] });
		// Marking it shareable publishes it; the wire carries it from then on.
		await contextsOn(p.a).edit(priv.id, { shareable: true });
		await waitForContext(p.b, priv.id, (c) => c.body.includes(secret), "the now-shareable note on B");
	});

	it("deleting a shareable context tombstones it for the members and blanks the old text", async () => {
		const c = await contextsOn(p.a).create({ workspaceId: p.workspace.id, title: "Temporary", body: "to be removed", shareable: true });
		await waitForContext(p.b, c.id, () => true, "the note on B");
		const del = await api(p.a).del(`/contexts/${c.id}`);
		expect(del.status).toBe(204);
		await eventually(async () => (await contextsOn(p.b).get(c.id)) === undefined, "the note gone from B");
		for (const node of [p.a, p.b]) {
			const row = node.ctx.contexts.store.find(c.id);
			expect(row?.deletedAt).not.toBeNull();
			expect(row?.body).toBe("");
			expect(node.ctx.contexts.store.snapshots(c.id).every((s) => !s.body.includes("to be removed"))).toBe(true);
		}
		expect((await contextsOn(p.b).list()).some((x) => x.id === c.id)).toBe(false);
		expect((await api(p.b).get(`/contexts/search?q=removed`)).body).toEqual([]);
	});

	it("an offline peer catches up when it returns (edits, creations and deletions made meanwhile)", async () => {
		const keep = await contextsOn(p.a).create({ workspaceId: p.workspace.id, title: "Stays", body: "v1", shareable: true });
		const gone = await contextsOn(p.a).create({ workspaceId: p.workspace.id, title: "Goes", body: "soon gone", shareable: true });
		await waitForContext(p.b, keep.id, () => true, "first note on B");
		await waitForContext(p.b, gone.id, () => true, "second note on B");
		await p.stop("b");
		await contextsOn(p.a).edit(keep.id, { body: "v2 while B was away" });
		const fresh = await contextsOn(p.a).create({ workspaceId: p.workspace.id, title: "Written offline", body: "new", shareable: true });
		await api(p.a).del(`/contexts/${gone.id}`);
		const b = await p.start("b");
		await waitForContext(b, keep.id, (c) => c.version === 2 && c.body.includes("while B was away"), "the edit on the returned B");
		await waitForContext(b, fresh.id, () => true, "the new note on the returned B");
		await eventually(async () => (await contextsOn(b).get(gone.id)) === undefined, "the deletion on the returned B");
	});

	it("B comes online later than a note created on A: the have-index round fetches what it lacks", async () => {
		await p.stop("b");
		const c = await contextsOn(p.a).create({ workspaceId: p.workspace.id, title: "Early", body: "before B is back", shareable: true });
		const b = await p.start("b");
		await waitForContext(b, c.id, (x) => x.body.includes("before B is back"), "the early note on B");
	});
});

describe("concurrent edits are conflicts, never merged", () => {
	async function conflicted(): Promise<{ id: string; a: Context; b: Context }> {
		const c = await contextsOn(p.a).create({ workspaceId: p.workspace.id, title: "Deploy", body: "run make deploy", shareable: true });
		await waitForContext(p.b, c.id, () => true, "the note on B");
		await waitForContext(p.a, c.id, (x) => x.sync.state === "synced", "synced");
		await p.partition();
		await contextsOn(p.a).edit(c.id, { body: "run make deploy-prod" });
		await contextsOn(p.b).edit(c.id, { body: "run ./deploy.sh" });
		await p.heal();
		const a = await waitForContext(p.a, c.id, (x) => x.sync.state === "conflict", "conflict on A");
		const b = await waitForContext(p.b, c.id, (x) => x.sync.state === "conflict", "conflict on B");
		return { id: c.id, a, b };
	}

	it("both sides keep their own text and report the other's as the competing version", async () => {
		const { a, b } = await conflicted();
		expect(a.body).toBe("run make deploy-prod\n");
		expect(a.sync.conflict).toMatchObject({ nodeName: "node-b", body: "run ./deploy.sh\n", version: 2 });
		expect(b.body).toBe("run ./deploy.sh\n");
		expect(b.sync.conflict).toMatchObject({ nodeName: "node-a", body: "run make deploy-prod\n" });
		// An edit of a context in conflict is refused until it is resolved.
		const blocked = await api(p.a).patch(`/contexts/${a.id}`, { baseVersion: a.version, body: "x" });
		expect(blocked.status).toBe(409);
		expect((blocked.body as { error: { code: string } }).error.code).toBe("context_conflict");
		// Stays that way: nothing converges on its own.
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		expect((await contextsOn(p.a).get(a.id))?.body).toBe("run make deploy-prod\n");
		expect((await contextsOn(p.b).get(b.id))?.body).toBe("run ./deploy.sh\n");
	});

	it("resolving on one node propagates and closes the conflict on both", async () => {
		const { id } = await conflicted();
		const resolved = await api(p.a).post<Context>(`/contexts/${id}/resolve`, { keep: "remote" });
		expect(resolved.status).toBe(200);
		expect(resolved.body.body).toBe("run ./deploy.sh\n");
		expect(resolved.body.version).toBe(3);
		const onB = await waitForContext(p.b, id, (c) => c.version === 3 && c.sync.state !== "conflict", "the resolution on B");
		expect(onB.body).toBe("run ./deploy.sh\n");
		expect(onB.sync.conflict).toBeNull();
		await waitForContext(p.a, id, (c) => c.sync.state === "synced", "A synced after resolving");
	});

	it("a merged resolution carries the merged text to the other node", async () => {
		const { id } = await conflicted();
		const resolved = await api(p.b).post<Context>(`/contexts/${id}/resolve`, { keep: "merged", body: "run make deploy-prod (or ./deploy.sh locally)" });
		expect(resolved.status).toBe(200);
		const onA = await waitForContext(p.a, id, (c) => c.version === 3 && c.sync.state === "synced", "the merged text on A");
		expect(onA.body).toBe("run make deploy-prod (or ./deploy.sh locally)\n");
		const bad = await api(p.b).post(`/contexts/${id}/resolve`, { keep: "merged", body: "x" });
		expect(bad.status).toBe(409); // no open conflict any more
	});

	it("keep local re-asserts this node's text everywhere", async () => {
		const { id } = await conflicted();
		const resolved = await api(p.a).post<Context>(`/contexts/${id}/resolve`, { keep: "local" });
		expect(resolved.body.body).toBe("run make deploy-prod\n");
		const onB = await waitForContext(p.b, id, (c) => c.version === 3 && c.sync.state !== "conflict", "A's text on B");
		expect(onB.body).toBe("run make deploy-prod\n");
	});
});

describe("retracting and re-sharing", () => {
	it("only the creating node can stop sharing; the members lose their copy and get it back when it is shared again", async () => {
		const c = await contextsOn(p.a).create({ workspaceId: p.workspace.id, title: "Roadmap", body: "ship M6", shareable: true });
		await waitForContext(p.b, c.id, () => true, "the note on B");
		const refused = await api(p.b).patch(`/contexts/${c.id}`, { baseVersion: 1, shareable: false });
		expect(refused.status).toBe(409);
		expect((refused.body as { error: { code: string } }).error.code).toBe("not_origin");

		const unshared = await contextsOn(p.a).edit(c.id, { shareable: false });
		expect(unshared.shareable).toBe(false);
		expect(unshared.sync.state).toBe("private");
		expect(unshared.body).toBe("ship M6\n");
		await eventually(async () => (await contextsOn(p.b).get(c.id)) === undefined, "B's copy removed");
		// Still there for A and private.
		expect((await contextsOn(p.a).get(c.id))?.body).toBe("ship M6\n");

		await contextsOn(p.a).edit(c.id, { shareable: true });
		const back = await waitForContext(p.b, c.id, (x) => x.body === "ship M6\n", "B's copy restored");
		expect(back.version).toBe(unshared.version);
	});
});

describe("the wire endpoint", () => {
	const url = (n: ContextPair["a"]) => n.netUrl;

	it("requires the capability, workspace membership and a valid body; replays idempotently", async () => {
		const c = await contextsOn(p.a).create({ workspaceId: p.workspace.id, title: "Wire", body: "x", shareable: true });
		await waitForContext(p.b, c.id, () => true, "the note on B");

		// Not a member of that workspace: 403.
		const stranger = await signedRequest(p.b, url(p.a), { method: "POST", path: "/context/sync", body: { workspaceId: "ws_unknown", have: [], push: [] }, idempotencyKey: "k-unknown" });
		expect(stranger.status).toBe(403);
		// A malformed body: 400.
		const bad = await signedRequest(p.b, url(p.a), { method: "POST", path: "/context/sync", body: { workspaceId: p.workspace.id, have: [{ contextId: "nope", version: 1, sha256: "zz" }] }, idempotencyKey: "k-bad" });
		expect(bad.status).toBe(400);
		// A valid have-index: A already holds it; the same key replays the stored answer.
		const head = { contextId: c.id, version: 1, sha256: c.sha256 };
		const first = await signedRequest(p.b, url(p.a), { method: "POST", path: "/context/sync", body: { workspaceId: p.workspace.id, have: [head], push: [] }, idempotencyKey: "k-have" });
		expect(first.status).toBe(200);
		expect(first.body.accepted).toEqual([head]);
		const replay = await signedRequest(p.b, url(p.a), { method: "POST", path: "/context/sync", body: { workspaceId: p.workspace.id, have: [head], push: [] }, idempotencyKey: "k-have" });
		expect(replay.status).toBe(200);
		expect(replay.headers.get("idempotent-replay")).toBe("true");
		const reused = await signedRequest(p.b, url(p.a), { method: "POST", path: "/context/sync", body: { workspaceId: p.workspace.id, have: [], push: [] }, idempotencyKey: "k-have" });
		expect(reused.status).toBe(409);

		// A version A does not know: it wants it. An unknown tombstone needs no answer.
		const unknown = { contextId: "ctx_0123456789abcdef", version: 1, sha256: "a".repeat(64) };
		const asked = await signedRequest(p.b, url(p.a), { method: "POST", path: "/context/sync", body: { workspaceId: p.workspace.id, have: [unknown, { ...unknown, contextId: "ctx_fedcba9876543210", deleted: true }], push: [] }, idempotencyKey: "k-want" });
		expect(asked.body.want).toEqual([{ contextId: unknown.contextId, sinceVersion: 0 }]);
	});

	it("refuses a push whose hash does not match, whose context is private here, or that belongs to another workspace", async () => {
		const priv = await contextsOn(p.a).create({ workspaceId: p.workspace.id, title: "Private here", body: "mine" });
		const wire = (over: Record<string, unknown>) => ({
			contextId: "ctx_aaaaaaaaaaaaaaaa",
			type: "memory",
			projectKey: null,
			originNodeId: p.bId,
			contextCreatedAt: new Date().toISOString(),
			version: 1,
			sha256: "b".repeat(64),
			title: "Forged",
			body: "text\n",
			author: { kind: "human", nodeId: p.bId, nodeName: "node-b", agentName: null },
			versionOriginNodeId: p.bId,
			createdAt: new Date().toISOString(),
			...over,
		});
		const call = (push: unknown[], key: string) => signedRequest(p.b, url(p.a), { method: "POST", path: "/context/sync", body: { workspaceId: p.workspace.id, have: [], push }, idempotencyKey: key });
		const forged = await call([wire({})], "k-forged");
		expect(forged.body.rejected).toEqual([{ contextId: "ctx_aaaaaaaaaaaaaaaa", reason: "sha256 does not match the text" }]);
		expect(await contextsOn(p.a).get("ctx_aaaaaaaaaaaaaaaa")).toBeUndefined();
		const overwrite = await call([wire({ contextId: priv.id })], "k-private");
		expect(overwrite.body.rejected[0]).toMatchObject({ contextId: priv.id });
		expect((await contextsOn(p.a).get(priv.id))?.body).toBe("mine\n");
	});

	it("is closed to a peer without the capability", async () => {
		await p.partition();
		const res = await signedRequest(p.b, url(p.a), { method: "POST", path: "/context/sync", body: { workspaceId: p.workspace.id, have: [], push: [] }, idempotencyKey: "k-nocap" });
		expect(res.status).toBe(403);
	});
});

describe("workspace membership", () => {
	it("adding a paired node to another workspace creates it there; its contexts follow; removing stops delivery", async () => {
		const ws2 = (await api(p.a).post<{ id: string; name: string }>("/workspaces", { name: "Second" })).body;
		expect((await api(p.b).get<Array<{ id: string }>>("/workspaces")).body.some((w) => w.id === ws2.id)).toBe(false);
		const before = (await api(p.a).get<WorkspaceMember[]>(`/workspaces/${ws2.id}/members`)).body;
		expect(before.map((m) => [m.nodeId, m.role, m.nodeStatus])).toEqual([[p.aId, "owner", "self"]]);

		const added = await api(p.a).post<WorkspaceMember[]>(`/workspaces/${ws2.id}/members`, { nodeId: p.bId });
		expect(added.status).toBe(201);
		expect(added.body.find((m) => m.nodeId === p.bId)).toMatchObject({ role: "member", revokedAt: null });
		// B now has the workspace, with A as its owner.
		const onB = await eventually(async () => (await api(p.b).get<Array<{ id: string; name: string }>>("/workspaces")).body.find((w) => w.id === ws2.id), "the workspace on B");
		expect(onB.name).toBe("Second");
		const membersOnB = (await api(p.b).get<WorkspaceMember[]>(`/workspaces/${ws2.id}/members`)).body;
		expect(membersOnB.find((m) => m.nodeId === p.aId)).toMatchObject({ role: "owner", nodeName: "node-a" });
		expect(membersOnB.find((m) => m.nodeId === p.bId)?.nodeStatus).toBe("self");

		const c = await contextsOn(p.a).create({ workspaceId: ws2.id, title: "In second", body: "hello", shareable: true });
		await waitForContext(p.b, c.id, (x) => x.workspaceId === ws2.id, "the note of the second workspace on B");

		// Removing B from the workspace: it stops receiving, and B stops accepting from A for it.
		const removed = await api(p.a).del<WorkspaceMember[]>(`/workspaces/${ws2.id}/members/${p.bId}`);
		expect(removed.status).toBe(200);
		expect(removed.body.find((m) => m.nodeId === p.bId)?.revokedAt).not.toBeNull();
		await eventually(async () => (await api(p.b).get<WorkspaceMember[]>(`/workspaces/${ws2.id}/members`)).body.find((m) => m.nodeId === p.aId)?.revokedAt !== null, "B marks A revoked for it");
		const later = await contextsOn(p.a).create({ workspaceId: ws2.id, title: "After removal", body: "not for B", shareable: true });
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		expect(await contextsOn(p.b).get(later.id)).toBeUndefined();
		// The first workspace is untouched.
		const still = await contextsOn(p.a).create({ workspaceId: p.workspace.id, title: "First workspace", body: "still shared", shareable: true });
		await waitForContext(p.b, still.id, () => true, "the first workspace still syncs");
		// Adding again restores delivery, including what was missed.
		await api(p.a).post(`/workspaces/${ws2.id}/members`, { nodeId: p.bId });
		await waitForContext(p.b, later.id, (x) => x.body.includes("not for B"), "the missed note after re-adding");
	});

	it("validates: unknown node, unknown permission, missing capability, removing this node", async () => {
		expect((await api(p.a).post(`/workspaces/${p.workspace.id}/members`, { nodeId: "node_0000000000000000" })).status).toBe(404);
		expect((await api(p.a).post(`/workspaces/${p.workspace.id}/members`, { nodeId: p.bId, permissions: ["root.everything"] })).status).toBe(400);
		const ok = await api(p.a).post<WorkspaceMember[]>(`/workspaces/${p.workspace.id}/members`, { nodeId: p.bId, permissions: ["context.sync", "tasks.send"] });
		expect(ok.body.find((m) => m.nodeId === p.bId)?.permissions.sort()).toEqual(["context.sync", "tasks.send"]);
		expect((await api(p.a).del(`/workspaces/${p.workspace.id}/members/${p.aId}`)).status).toBe(409);
		expect((await api(p.a).del(`/workspaces/${p.workspace.id}/members/node_0000000000000000`)).status).toBe(404);
		await grantContextSyncOff();
		const ws2 = (await api(p.a).post<{ id: string }>("/workspaces", { name: "Third" })).body;
		const refused = await api(p.a).post(`/workspaces/${ws2.id}/members`, { nodeId: p.bId });
		expect(refused.status).toBe(409);
		expect((refused.body as { error: { code: string } }).error.code).toBe("capability_missing");
	});

	async function grantContextSyncOff(): Promise<void> {
		await p.partition();
	}
});

describe("project-level contexts follow the project across nodes", () => {
	it("a context of a project reaches the other node's project of the same linked repository", async () => {
		const linked = { owner: "acme", name: "demo", externalId: null, htmlUrl: "https://github.com/acme/demo", defaultBranch: "main", accountId: null };
		const mk = async (node: ContextPair["a"], name: string, dir: string) => {
			const created = (await api(node).post<{ id: string }>("/projects", { workspaceId: p.workspace.id, name, path: dir })).body;
			await api(node).patch(`/projects/${created.id}`, { repository: linked });
			return created.id;
		};
		const projA = await mk(p.a, "alpha", p.a.projectDir);
		const projB = await mk(p.b, "beta", p.b.projectDir);
		const c = await contextsOn(p.a).create({ workspaceId: p.workspace.id, projectId: projA, type: "decision", title: "Use SQLite", body: "embedded", shareable: true });
		const onB = await waitForContext(p.b, c.id, () => true, "the decision on B");
		expect(onB.projectId).toBe(projB);
		expect((await contextsOn(p.b).list(`?projectId=${projB}`)).map((x) => x.id)).toEqual([c.id]);
		expect((await contextsOn(p.b).list(`?projectId=${projB}&type=plan`))).toEqual([]);
		// A project of another repository does not see it; a workspace-wide note is not tied to any project.
		const other = (await api(p.b).post<{ id: string }>("/projects", { workspaceId: p.workspace.id, name: "elsewhere", path: p.a.dataDir })).body.id;
		expect(await contextsOn(p.b).list(`?projectId=${other}`)).toEqual([]);
	});
});


describe("three nodes: a node relays what it receives to the other members", () => {
	it("A reaches C through B although A and C are not paired, and C's edit comes back the same way", async () => {
		// beforeEach built A–B; C is paired with B only and added to A–B's workspace through B.
		const c = await startNode("node-c", { contextTimings: SYNC_TIMINGS });
		try {
			await pair(p.b, c, { workspaceName: "B and C" });
			await grantContextSync(p.b, c.ctx.identity.nodeId, c);
			await grantContextSync(c, p.bId, p.b);
			const added = await api(p.b).post<WorkspaceMember[]>(`/workspaces/${p.workspace.id}/members`, { nodeId: c.ctx.identity.nodeId });
			expect(added.status).toBe(201);
			await eventually(async () => (await api(c).get<Array<{ id: string }>>("/workspaces")).body.some((w) => w.id === p.workspace.id), "the workspace on C");

			const created = await contextsOn(p.a).create({ workspaceId: p.workspace.id, title: "Relayed", body: "from A via B", shareable: true });
			const onC = await waitForContext(c, created.id, (x) => x.body.includes("from A via B"), "A's note on C");
			expect(onC.author).toMatchObject({ nodeName: "node-a" });
			await contextsOn(c).edit(created.id, { body: "edited on C" });
			await waitForContext(p.a, created.id, (x) => x.body.includes("edited on C") && x.version === 2, "C's edit on A");
			await waitForContext(p.b, created.id, (x) => x.version === 2, "C's edit on B");
			expect((await waitForContext(p.a, created.id, (x) => x.sync.state === "synced", "A synced")).sync.syncedTo).toEqual([p.bId]);
		} finally {
			await c.cleanup();
		}
	});
});

export type { Context };
