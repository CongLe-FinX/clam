import { createHash } from "node:crypto";
import { ulid } from "@clam/agent-network";
import { Task, TaskDetail, TaskMessage, type ActivityItem, type Project, type TaskResult } from "@clam/contracts";
import { nodeEvents, peers, projects } from "@clam/database";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { recordPeerActivity } from "../src/tasks/activity.ts";
import type { TaskInsert, TaskRow } from "../src/tasks/store.ts";
import { api, connectWs, createFullHarness, type FullHarness } from "./full-harness.ts";
import { FAST, eventually, pair, startNode } from "./net-helpers.ts";

const nodes: FullHarness[] = [];
afterEach(async () => {
	for (const n of nodes.splice(0)) await n.cleanup();
});

const REPO = "https://github.com/acme/widgets";
const ERROR = (code: string) => ({ error: expect.objectContaining({ code }) });

async function node(name: string): Promise<FullHarness> {
	const n = await startNode(name);
	nodes.push(n);
	return n;
}

/** A sender whose mirror poll never fires on its own, so rows seeded below stay exactly as written. */
async function quietNode(name: string): Promise<FullHarness> {
	const n = await createFullHarness({ network: { nodeName: name, options: FAST }, taskTimings: { mirrorIntervalMs: 3_600_000 } });
	nodes.push(n);
	return n;
}

/** A project in `workspaceId` linked to the test repository (the executor maps tasks to projects by repository). */
async function linkedProject(on: FullHarness, workspaceId: string, name: string): Promise<Project> {
	const created = await api(on).post<Project>("/projects", { workspaceId, name, path: on.projectDir });
	expect(created.status).toBe(201);
	on.ctx.db
		.update(projects)
		.set({ repository: { owner: "acme", name: "widgets", externalId: "1", htmlUrl: REPO, defaultBranch: "main", accountId: null }, repositoryId: "1" })
		.where(eq(projects.id, created.body.id))
		.run();
	return created.body;
}

function seedTask(on: FullHarness, over: Partial<TaskInsert> & Pick<TaskInsert, "id" | "peerId" | "direction">): TaskRow {
	const outgoing = over.direction === "outgoing";
	return on.ctx.tasks.store.insert({
		workspaceId: "ws_seed",
		title: "Seeded task",
		repoUrl: REPO,
		senderNodeId: outgoing ? on.ctx.identity.nodeId : over.peerId,
		senderNodeName: outgoing ? "sender" : "peer",
		executorNodeId: outgoing ? over.peerId : on.ctx.identity.nodeId,
		executorNodeName: outgoing ? "peer" : "executor",
		correlationId: ulid(),
		...over,
	});
}

describe("local task routes", () => {
	it("delegates a task, shows it on both nodes, and supports decide, discussion, read, cancel, retry", async () => {
		const a = await node("exec-a");
		const b = await node("sender-b");
		const { workspace } = await pair(a, b);
		const project = await linkedProject(b, workspace.id, "widgets");
		const aId = a.ctx.identity.nodeId;
		const body = { targetNodeId: aId, projectId: project.id, title: "Add retries", description: "Retry the client.", deliverAs: "summary" };

		expect((await api(b).post("/tasks", {})).status).toBe(400);
		expect((await api(b).post("/tasks", { ...body, targetNodeId: "node_unknown" })).status).toBe(404);
		const created = await api(b).post<Task>("/tasks", body);
		expect(created.status).toBe(201);
		const first = Task.parse(created.body);
		expect(first).toMatchObject({ direction: "outgoing", status: "offered", title: "Add retries", workspaceId: workspace.id, projectId: project.id, epoch: 0, deliverAs: "summary" });
		expect(first.executor.nodeId).toBe(aId);

		// Lists: filters narrow, detail has the timeline and thread.
		const list = (query: string) => api(b).get<Task[]>(`/tasks${query}`).then((r) => r.body.map((t) => t.id));
		expect(await list("")).toEqual([first.id]);
		expect(await list("?direction=outgoing&status=offered,running")).toEqual([first.id]);
		expect(await list("?direction=incoming")).toEqual([]);
		expect(await list(`?peerId=${aId}&workspaceId=${workspace.id}`)).toEqual([first.id]);
		expect(await list("?status=succeeded")).toEqual([]);
		const detail = await api(b).get<TaskDetail>(`/tasks/${first.id}`);
		expect(detail.status).toBe(200);
		expect(TaskDetail.parse(detail.body).task.id).toBe(first.id);
		expect((await api(b).get(`/tasks/tsk_${ulid()}`)).status).toBe(404);

		// The executor receives it (outbox), offered; only it can decide.
		const offered = await eventually(async () => (await api(a).get<Task[]>("/tasks?direction=incoming&status=offered")).body[0], "the task offered on the executor");
		expect(offered).toMatchObject({ id: first.id, direction: "incoming", title: "Add retries" });
		expect((await api(b).post(`/tasks/${first.id}/decide`, { decision: "reject", reason: "no" })).status).toBe(409);
		expect((await api(a).post(`/tasks/${first.id}/decide`, { decision: "reject" })).status).toBe(400);
		const rejected = await api(a).post<Task>(`/tasks/${first.id}/decide`, { decision: "reject", reason: "Not this week" });
		expect(rejected.status).toBe(200);
		expect(Task.parse(rejected.body)).toMatchObject({ status: "rejected", reason: "Not this week" });
		await eventually(async () => (await api(b).get<TaskDetail>(`/tasks/${first.id}`)).body.task.status === "rejected", "the rejection mirrored to the sender");

		// A finished task has no discussion; retry creates a new task that remembers its origin (sender side only).
		const closed = await api(b).post(`/tasks/${first.id}/messages`, { text: "hello", kind: "note" });
		expect(closed.status).toBe(409);
		expect(closed.body).toEqual(ERROR("task_finished"));
		expect((await api(a).post(`/tasks/${first.id}/retry`)).status).toBe(409);
		const retried = await api(b).post<Task>(`/tasks/${first.id}/retry`);
		expect(retried.status).toBe(201);
		const second = Task.parse(retried.body);
		expect(second).toMatchObject({ retryOf: first.id, status: "offered", title: "Add retries" });
		expect(second.id).not.toBe(first.id);
		await eventually(async () => (await api(a).get<Task[]>(`/tasks?status=offered`)).body.some((t) => t.id === second.id), "the retry offered on the executor");

		// Discussion: a human on the executor posts; it reaches the sender's thread, unread there, until marked read.
		expect((await api(a).post(`/tasks/${second.id}/messages`, { text: "", kind: "note" })).status).toBe(400);
		expect((await api(a).post(`/tasks/${second.id}/messages`, { text: "hi", kind: "question" })).status).toBe(400);
		expect((await api(a).post(`/tasks/tsk_${ulid()}/messages`, { text: "hi" })).status).toBe(404);
		const posted = await api(a).post<TaskMessage>(`/tasks/${second.id}/messages`, { text: "Which branch should I base this on?", kind: "note" });
		expect(posted.status).toBe(201);
		expect(TaskMessage.parse(posted.body)).toMatchObject({ taskId: second.id, text: "Which branch should I base this on?", author: { kind: "human", nodeId: aId, agentId: null } });
		await eventually(async () => (await api(b).get<TaskDetail>(`/tasks/${second.id}`)).body.task.unreadMessages === 1, "the message unread on the sender");
		const thread = (await api(b).get<TaskDetail>(`/tasks/${second.id}`)).body.messages;
		expect(thread).toEqual([expect.objectContaining({ id: posted.body.id, delivery: "local", author: expect.objectContaining({ kind: "human", nodeName: "exec-a" }) })]);
		expect((await api(b).post(`/tasks/${second.id}/read`)).status).toBe(204);
		expect((await api(b).get<TaskDetail>(`/tasks/${second.id}`)).body.task.unreadMessages).toBe(0);
		expect((await api(b).post(`/tasks/tsk_${ulid()}/read`)).status).toBe(404);
		const answer = await api(b).post<TaskMessage>(`/tasks/${second.id}/messages`, { text: "Use main.", kind: "answer" });
		expect(answer.status).toBe(201);
		await eventually(async () => (await api(a).get<TaskDetail>(`/tasks/${second.id}`)).body.messages.length === 2, "the answer on the executor");

		// Cancelling remotely needs tasks.cancel; the sender learns of the grant with the next heartbeat.
		const refused = await api(b).post(`/tasks/${second.id}/cancel`, { reason: "Not needed" });
		expect(refused.status).toBe(409);
		expect(refused.body).toEqual(ERROR("capability_missing"));
		await api(a).patch(`/network/peers/${b.ctx.identity.nodeId}`, { grantedCapabilities: ["agents.read", "events.read", "tasks.send", "tasks.receive", "tasks.cancel"] });
		const cancelled = await eventually(async () => {
			const res = await api(b).post<Task>(`/tasks/${second.id}/cancel`, { reason: "Not needed" });
			return res.status === 200 ? res : null;
		}, "the cancel capability to reach the sender");
		await eventually(async () => (await api(a).get<TaskDetail>(`/tasks/${second.id}`)).body.task.status === "cancelled", "the executor cancelled");
		await eventually(async () => (await api(b).get<TaskDetail>(`/tasks/${second.id}`)).body.task.status === "cancelled", "the sender mirrors the cancellation");
		expect((await api(b).post(`/tasks/tsk_${ulid()}/cancel`, {})).status).toBe(404);
	});

	it("serves topics `tasks` and `task:<id>` with TaskTopicEvents over the WebSocket", async () => {
		const a = await node("exec-a");
		const b = await node("sender-b");
		const { workspace } = await pair(a, b);
		const project = await linkedProject(b, workspace.id, "widgets");
		const ws = await connectWs(b);
		try {
			ws.send({ type: "subscribe", topics: ["tasks", "task:bad topic", "task:tsk_abc"] });
			await ws.waitFor((f) => f.type === "subscribed", "subscribe ack");
			expect(ws.frames.find((f) => f.type === "subscribed")?.topics).toEqual(["tasks", "task:tsk_abc"]);
			expect(ws.frames.find((f) => f.type === "error")?.message).toContain("Unknown topic");

			const created = (await api(b).post<Task>("/tasks", { targetNodeId: a.ctx.identity.nodeId, projectId: project.id, title: "Watch me", description: "d", deliverAs: "summary" })).body;
			const listFrame = await ws.waitFor((f) => f.topic === "tasks" && f.event?.type === "task" && f.event.task.id === created.id, "a `task` event on the tasks topic");
			expect(Task.parse(listFrame.event.task).status).toBe("offered");

			ws.send({ type: "subscribe", topics: [`task:${created.id}`] });
			await ws.waitFor((f) => f.type === "subscribed" && f.topics.includes(`task:${created.id}`), "detail subscribe ack");
			await eventually(async () => (await api(a).get<Task[]>("/tasks?status=offered")).body.length === 1, "offered on the executor");
			const sent = await api(b).post<TaskMessage>(`/tasks/${created.id}/messages`, { text: "Please hurry", kind: "instruction" });
			expect(sent.status).toBe(201);
			const messageFrame = await ws.waitFor((f) => f.topic === `task:${created.id}` && f.event?.type === "message", "a `message` event on the task topic");
			expect(messageFrame.event).toMatchObject({ taskId: created.id, message: { id: sent.body.id, text: "Please hurry" } });
			await ws.waitFor((f) => f.topic === `task:${created.id}` && f.event?.type === "task", "a `task` event on the task topic");
		} finally {
			ws.close();
		}
	});
});

describe("activity feed", () => {
	it("merges task status changes, messages and peer changes newest first, with limit/before/workspace filters", async () => {
		const a = await node("exec-a");
		const b = await node("sender-b");
		const { workspace } = await pair(a, b);
		const aId = a.ctx.identity.nodeId;
		const stop = recordPeerActivity(b.ctx);
		try {
			const id = `tsk_${ulid()}`;
			seedTask(b, { id, peerId: aId, direction: "outgoing", workspaceId: workspace.id, title: "Ship it", executorNodeName: "exec-a" });
			const store = b.ctx.tasks.store;
			store.appendEvent(id, { type: "status", summary: "offered → running", payload: { from: "offered", to: "running" } });
			store.appendEvent(id, { type: "progress", summary: "thinking hard" });
			store.insertMessage({ id: `msg_${ulid()}`, taskId: id, authorKind: "agent", authorNodeId: aId, authorNodeName: "exec-a", authorAgentName: "Coder", kind: "question", text: "Which   client\nshould I use?", createdAt: "2099-01-01T00:00:00.000Z", delivery: "local" });
			store.appendEvent(id, { type: "result", summary: "succeeded", payload: null });
			// A revoked peer is recorded through the hook.
			const c = await node("third-c");
			await pair(b, c, { workspaceName: "Other" });
			await b.net.revokePeer(c.ctx.identity.nodeId);
			b.ctx.db.insert(nodeEvents).values({ nodeId: b.ctx.identity.nodeId, type: "peer.online", payload: { peerId: aId, peerName: "exec-a" }, createdAt: "2000-01-01T00:00:00.000Z" }).run();

			const feed = (await api(b).get<ActivityItem[]>("/activity")).body;
			expect(feed.map((i) => i.at)).toEqual([...feed.map((i) => i.at)].sort().reverse());
			expect(new Set(feed.map((i) => i.id)).size).toBe(feed.length);
			const tasksItems = feed.filter((i) => i.kind === "task");
			expect(tasksItems.map((i) => i.summary)).toEqual(expect.arrayContaining(["Ship it: offered → running", "Ship it: succeeded"]));
			expect(tasksItems.some((i) => i.summary.includes("thinking hard"))).toBe(false);
			expect(tasksItems[0]).toMatchObject({ taskId: id, workspaceId: workspace.id, nodeName: "exec-a" });
			// Seqs 1 (status) and 3 (result) are feed items; seq 2 is progress and stays out of it.
			expect(tasksItems.map((i) => i.id).sort()).toEqual([`task:${id}:1`, `task:${id}:3`]);
			const message = feed.find((i) => i.kind === "message");
			expect(message).toMatchObject({ taskId: id, workspaceId: workspace.id, nodeName: "exec-a", summary: "Coder@exec-a: Which client should I use?" });
			expect(message?.id).toMatch(/^message:msg_/);
			expect(feed[0]).toBe(message); // its timestamp is far in the future
			const peerItems = feed.filter((i) => i.kind === "peer");
			expect(peerItems.map((i) => i.summary)).toEqual(expect.arrayContaining(["Peer third-c revoked", "Peer exec-a online"]));
			expect(peerItems.every((i) => i.taskId === null && i.workspaceId === null && /^node:\d+$/.test(i.id))).toBe(true);

			expect((await api(b).get<ActivityItem[]>("/activity?limit=2")).body.map((i) => i.id)).toEqual(feed.slice(0, 2).map((i) => i.id));
			const older = (await api(b).get<ActivityItem[]>(`/activity?before=${encodeURIComponent(message?.at as string)}`)).body;
			expect(older.map((i) => i.id)).toEqual(feed.slice(1).map((i) => i.id));
			const scoped = (await api(b).get<ActivityItem[]>(`/activity?workspaceId=${workspace.id}`)).body;
			expect(scoped.length).toBeGreaterThan(0);
			expect(scoped.every((i) => i.workspaceId === workspace.id)).toBe(true);
			expect((await api(b).get<ActivityItem[]>("/activity?workspaceId=ws_nowhere")).body).toEqual([]);
			expect((await api(b).get("/activity?limit=0")).status).toBe(400);
			expect((await api(b).get("/activity?limit=201")).status).toBe(400);
			expect((await api(b).get("/activity?before=yesterday")).status).toBe(400);
		} finally {
			stop();
		}
	});
});

describe("artifact download", () => {
	const download = async (on: FullHarness, taskId: string, artifactId: string) => {
		const res = await fetch(`${on.url}/api/local/tasks/${taskId}/artifacts/${artifactId}`);
		return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers };
	};

	it("serves it locally on the executor and proxies it from the executor on the sender, only when the result lists it", async () => {
		const a = await node("exec-a");
		const b = await quietNode("sender-b");
		const { workspace } = await pair(a, b);
		const taskId = `tsk_${ulid()}`;
		seedTask(a, { id: taskId, peerId: b.ctx.identity.nodeId, direction: "incoming", workspaceId: workspace.id, status: "succeeded" });
		seedTask(b, { id: taskId, peerId: a.ctx.identity.nodeId, direction: "outgoing", workspaceId: workspace.id, status: "succeeded" });
		const bytes = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 13) % 251));
		const stored = await a.ctx.tasks.artifacts.add(taskId, { name: "task.patch", mediaType: "text/x-diff", bytes: Buffer.from("diff --git a/x b/x\n") });
		const binary = await a.ctx.tasks.artifacts.add(taskId, { name: "blob.bin", mediaType: "application/octet-stream", bytes });
		const unlisted = await a.ctx.tasks.artifacts.add(taskId, { name: "secret-notes.txt", mediaType: "text/plain", bytes: Buffer.from("not part of the result") });
		const entry = (row: { id: string; name: string; sha256: string; size: number }) => ({ artifactId: row.id, name: row.name, sha256: row.sha256, size: row.size });
		const result: TaskResult = { summary: "done", autoCompleted: false, branch: null, commit: null, pushed: false, compareUrl: null, artifacts: [entry(stored), entry(binary)], files: null };
		a.ctx.tasks.store.update(taskId, { result });
		b.ctx.tasks.store.update(taskId, { result });

		for (const [side, on] of [["executor", a], ["sender", b]] as const) {
			const res = await download(on, taskId, binary.id);
			expect(res.status, side).toBe(200);
			expect(res.bytes.equals(bytes), side).toBe(true);
			expect(res.headers.get("content-disposition"), side).toBe('attachment; filename="blob.bin"');
			expect(res.headers.get("content-length"), side).toBe(String(bytes.length));
			expect(res.headers.get("content-digest"), side).toBe(`sha-256=:${createHash("sha256").update(bytes).digest("base64")}:`);
			expect(res.headers.get("x-content-type-options"), side).toBe("nosniff");
			// Not listed in the result: not downloadable, although the file exists on the executor.
			expect((await download(on, taskId, unlisted.id)).status, side).toBe(404);
			expect((await download(on, taskId, `art_${ulid()}`)).status, side).toBe(404);
		}
		expect((await download(a, taskId, stored.id)).headers.get("content-type")).toBe("text/x-diff");
		// What the sender fetched from a peer is always an opaque download.
		expect((await download(b, taskId, stored.id)).headers.get("content-type")).toBe("application/octet-stream");
		expect((await download(b, `tsk_${ulid()}`, binary.id)).status).toBe(404);

		// The executor no longer has the file: 404 passes through. A different file than the one listed: 502.
		const missing = { artifactId: `art_${ulid()}`, name: "gone.bin", sha256: "0".repeat(64), size: 3 };
		const tampered = { ...entry(binary), sha256: createHash("sha256").update("other").digest("hex") };
		b.ctx.tasks.store.update(taskId, { result: { ...result, artifacts: [...result.artifacts, missing] } });
		expect((await download(b, taskId, missing.artifactId)).status).toBe(404);
		b.ctx.tasks.store.update(taskId, { result: { ...result, artifacts: [tampered] } });
		const mismatch = await fetch(`${b.url}/api/local/tasks/${taskId}/artifacts/${binary.id}`);
		expect(mismatch.status).toBe(502);
		expect(await mismatch.json()).toEqual(ERROR("upstream_error"));

		// Unreachable executor: 502, nothing leaked.
		b.ctx.tasks.store.update(taskId, { result });
		b.ctx.db.update(peers).set({ url: "http://127.0.0.1:1" }).where(eq(peers.id, a.ctx.identity.nodeId)).run();
		const unreachable = await fetch(`${b.url}/api/local/tasks/${taskId}/artifacts/${binary.id}`);
		expect(unreachable.status).toBe(502);
		expect(await unreachable.json()).toEqual(ERROR("upstream_error"));
	});
});
