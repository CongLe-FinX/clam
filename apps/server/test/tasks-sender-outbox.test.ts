import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { wire } from "@clam/agent-network";
import type { Project, Task, TaskDetail, TaskMessage, Workspace } from "@clam/contracts";
import { peerAgents, workspaceMembers } from "@clam/database";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { api, type FullHarness } from "./full-harness.ts";
import { eventually, peerOf, startNode } from "./net-helpers.ts";
import { applyRecord } from "../src/tasks/mirror.ts";
import { findTask, isolateGitConfig, REPO, startTaskPair, waitForTask, type TaskPair } from "./task-fixtures.ts";

let gitConfig: { restore(): void };
beforeAll(() => {
	gitConfig = isolateGitConfig();
});
afterAll(() => gitConfig.restore());

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function taskPair(): Promise<TaskPair> {
	const t = await startTaskPair();
	cleanups.push(() => t.cleanup());
	return t;
}

const bIdOf = (t: TaskPair): string => t.b.ctx.identity.nodeId;
const aIdOf = (t: TaskPair): string => t.a.ctx.identity.nodeId;

async function delegate(t: TaskPair, title: string, extra: Record<string, unknown> = {}): Promise<Task> {
	const res = await api(t.a).post<Task>("/tasks", { targetNodeId: bIdOf(t), projectId: t.projectA.id, title, description: `Work on ${title}`, deliverAs: "summary", ...extra });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body;
}

const outboxOf = (node: FullHarness, taskId: string) => node.ctx.tasks.store.outboxOfTask(taskId);
const createItem = (node: FullHarness, taskId: string) => outboxOf(node, taskId).find((o) => o.kind === "task.create");

describe("delivering a task (outbox → executor)", () => {
	it("queues the create without waiting for the peer and marks it delivered once the executor has the task", async () => {
		const t = await taskPair();
		const task = await delegate(t, "Deliver me");
		// The response is built before the HTTP round trip can possibly finish.
		expect(task).toMatchObject({ direction: "outgoing", status: "offered", epoch: 0, deliverAs: "summary", delivery: { state: "pending" }, lastEventSeq: 0 });
		expect(task.repo).toEqual({ url: REPO.htmlUrl, branch: null, commit: null });
		expect(task.sender).toMatchObject({ nodeId: aIdOf(t), nodeName: "node-a", sessionId: null });
		expect(task.executor).toMatchObject({ nodeId: bIdOf(t), nodeName: "node-b" });

		const delivered = await waitForTask(t.a, task.id, (x) => x.delivery.state === "delivered", "create delivered");
		expect(delivered.task.delivery.attempts).toBe(1);
		const onB = await waitForTask(t.b, task.id, () => true, "task on the executor");
		expect(onB.task).toMatchObject({ direction: "incoming", status: "offered", title: "Deliver me", sender: { nodeId: aIdOf(t), nodeName: "node-a" } });
		expect(createItem(t.a, task.id)).toMatchObject({ state: "sent", lastStatus: expect.any(Number), kind: "task.create", path: "/tasks" });
	});

	it("is idempotent when the same outbox call is delivered twice", async () => {
		const t = await taskPair();
		const task = await delegate(t, "Only once");
		await waitForTask(t.a, task.id, (x) => x.delivery.state === "delivered", "create delivered");
		const item = createItem(t.a, task.id);
		expect(item).toBeDefined();
		const before = t.b.ctx.tasks.store.get(task.id);

		// A lost answer looks exactly like this: the sender sends the same call (same key, same body) again.
		t.a.ctx.tasks.store.updateOutbox(item?.id as string, { state: "pending", nextAttemptAt: new Date().toISOString() });
		await t.a.ctx.tasks.outbox.drain(bIdOf(t));

		expect(createItem(t.a, task.id)).toMatchObject({ state: "sent", attempts: 2, idempotencyKey: item?.idempotencyKey });
		const onB = (await api(t.b).get<Task[]>("/tasks")).body.filter((x) => x.title === "Only once");
		expect(onB).toHaveLength(1);
		expect(t.b.ctx.tasks.store.get(task.id).createdAt).toBe(before.createdAt);
		expect((await api(t.a).get<TaskDetail>(`/tasks/${task.id}`)).body.task.delivery.state).toBe("delivered");
	});

	it("holds items for an offline peer without consuming attempts, keeps the order per task, and drains after it returns", async () => {
		const t = await taskPair();
		const b2dir = t.b.dataDir;
		const port = t.b.netPort;
		await t.b.cleanup({ keepData: true });
		await eventually(async () => (await peerOf(t.a, bIdOf(t)))?.status === "offline", "A sees B offline");

		const cancelled = await delegate(t, "Never sent");
		const kept = await delegate(t, "Sent later");
		const posted = await api(t.a).post<TaskMessage>(`/tasks/${kept.id}/messages`, { text: "context for later", kind: "note" });
		expect(posted.status).toBe(201);
		const lost = await api(t.a).post<TaskMessage>(`/tasks/${cancelled.id}/messages`, { text: "never arrives", kind: "note" });
		expect(lost.status).toBe(201);

		// A full pass over the queue runs while the peer is offline and attempts nothing.
		await t.a.ctx.tasks.outbox.drain(bIdOf(t));
		for (const item of [...outboxOf(t.a, cancelled.id), ...outboxOf(t.a, kept.id)]) expect(item).toMatchObject({ state: "pending", attempts: 0 });
		expect((await api(t.a).get<TaskDetail>(`/tasks/${kept.id}`)).body.task.delivery).toMatchObject({ state: "pending", attempts: 0 });

		// Cancelling a task that never left this node needs no peer and no capability.
		const cancelRes = await api(t.a).post<Task>(`/tasks/${cancelled.id}/cancel`, { reason: "changed my mind" });
		expect(cancelRes.status).toBe(200);
		expect(cancelRes.body).toMatchObject({ status: "cancelled", reason: "changed my mind" });
		expect(outboxOf(t.a, cancelled.id).map((o) => [o.kind, o.state])).toEqual([
			["task.create", "cancelled"],
			["task.message", "cancelled"],
		]);
		expect((await api(t.a).get<TaskDetail>(`/tasks/${cancelled.id}`)).body.messages[0]?.delivery).toBe("failed");

		const b2 = await startNode("node-b", { dataDir: b2dir, port });
		// The pair cleans up whatever node B is now; the stopped one is already gone.
		t.b = b2;
		const detail = await waitForTask(b2, kept.id, (x) => x.status === "offered", "kept task arrived after B came back");
		// The message could only be accepted because the create went first.
		await eventually(async () => (await api(b2).get<TaskDetail>(`/tasks/${kept.id}`)).body.messages.length === 1, "message arrived");
		expect(detail.task.title).toBe("Sent later");
		expect((await api(b2).get<TaskDetail>(`/tasks/${kept.id}`)).body.messages[0]).toMatchObject({ text: "context for later", author: { nodeId: aIdOf(t) } });
		const onA = await waitForTask(t.a, kept.id, (x) => x.delivery.state === "delivered", "delivered");
		expect(onA.messages[0]?.delivery).toBe("delivered");
		expect(await findTask(b2, "Never sent")).toBeUndefined();
		expect(createItem(t.a, kept.id)?.attempts).toBe(1);
	});

	it("fails the task with a clear reason when the executor refuses it for good, and retry creates a new task", async () => {
		const t = await taskPair();
		const { workspace } = t;
		// B no longer lists A as a member of the workspace: a permanent 403 on `POST /tasks`.
		t.b.ctx.db
			.update(workspaceMembers)
			.set({ revokedAt: new Date().toISOString() })
			.where(and(eq(workspaceMembers.workspaceId, workspace.id), eq(workspaceMembers.memberId, aIdOf(t))))
			.run();
		const task = await delegate(t, "Refused", { baseBranch: "release", constraints: { maxCostUsd: 3 } });

		const failed = await waitForTask(t.a, task.id, (x) => x.status === "failed", "task failed after the refusal");
		expect(failed.task.reason).toContain("Could not deliver the task to node-b");
		expect(failed.task.delivery).toMatchObject({ state: "failed", attempts: 1 });
		expect(failed.events.at(-1)).toMatchObject({ type: "status", summary: expect.stringContaining("failed") });
		expect(createItem(t.a, task.id)).toMatchObject({ state: "dead", lastStatus: 403 });
		expect(await findTask(t.b, "Refused")).toBeUndefined();

		// Not finished tasks cannot be retried; finished ones create a NEW task with the same parameters.
		t.b.ctx.db.update(workspaceMembers).set({ revokedAt: null }).where(eq(workspaceMembers.memberId, aIdOf(t))).run();
		const retried = await api(t.a).post<Task>(`/tasks/${task.id}/retry`);
		expect(retried.status).toBe(201);
		expect(retried.body).toMatchObject({ status: "offered", title: "Refused", retryOf: task.id, deliverAs: "summary", constraints: { maxCostUsd: 3 }, repo: { branch: "release" } });
		expect(retried.body.id).not.toBe(task.id);
		await waitForTask(t.b, retried.body.id, (x) => x.status === "offered", "retried task on the executor");
		expect((await api(t.a).post(`/tasks/${retried.body.id}/retry`)).status).toBe(409);
		expect((await api(t.a).get<TaskDetail>(`/tasks/${task.id}`)).body.task.status).toBe("failed");
	});
});

describe("cancelling a delivered task", () => {
	it("needs the tasks.cancel grant, then reaches the executor and is mirrored back", async () => {
		const t = await taskPair();
		const task = await delegate(t, "Cancel me later");
		await waitForTask(t.b, task.id, (x) => x.status === "offered", "delivered");
		await waitForTask(t.a, task.id, (x) => x.delivery.state === "delivered", "delivery acknowledged");

		const denied = await api(t.a).post<{ error: { code: string; details: { missing: string[] } } }>(`/tasks/${task.id}/cancel`, {});
		expect(denied.status).toBe(409);
		expect(denied.body.error).toMatchObject({ code: "capability_missing", details: { missing: ["tasks.cancel"] } });
		expect(outboxOf(t.a, task.id).some((o) => o.kind === "task.cancel")).toBe(false);

		await t.grantCancel();
		const cancel = await api(t.a).post<Task>(`/tasks/${task.id}/cancel`, { reason: "no longer needed" });
		expect(cancel.status).toBe(200);
		await waitForTask(t.b, task.id, (x) => x.status === "cancelled", "cancelled on the executor");
		const onA = await waitForTask(t.a, task.id, (x) => x.status === "cancelled", "cancel mirrored on the sender");
		expect(onA.task.finishedAt).not.toBeNull();
		expect(outboxOf(t.a, task.id).find((o) => o.kind === "task.cancel")).toMatchObject({ state: "sent", idempotencyKey: `task.cancel:${task.id}` });
		// The sender's timeline is the executor's, event for event.
		const timelineB = (await api(t.b).get<TaskDetail>(`/tasks/${task.id}`)).body.events;
		await eventually(async () => JSON.stringify((await api(t.a).get<TaskDetail>(`/tasks/${task.id}`)).body.events) === JSON.stringify(timelineB), "sender timeline equals the executor's");
	});
});

describe("mirroring the executor", () => {
	it("follows a task to its result by polling and copies the executor's events", async () => {
		const t = await taskPair();
		const task = await delegate(t, "Mirror me", {
			description: 'Please finish.\n@@fake-tool mesh_complete {"outcome":"succeeded","summary":"all done"}',
		});
		await waitForTask(t.b, task.id, (x) => x.status === "offered", "delivered");
		const decided = await api(t.b).post<Task>(`/tasks/${task.id}/decide`, { decision: "accept" });
		expect(decided.status, JSON.stringify(decided.body)).toBe(200);

		const finished = await waitForTask(t.a, task.id, (x) => x.status === "succeeded", "result mirrored to the sender", 30_000);
		expect(finished.task.result).toMatchObject({ summary: "all done", autoCompleted: false });
		expect(finished.task.executor.agentName).toBeTruthy();
		expect(finished.task.startedAt).not.toBeNull();
		expect(finished.task.finishedAt).not.toBeNull();
		const onB = (await api(t.b).get<TaskDetail>(`/tasks/${task.id}`)).body;
		expect(finished.events).toEqual(onB.events);
		expect(finished.task.lastEventSeq).toBe(onB.task.lastEventSeq);
		expect(finished.events.map((e) => e.seq)).toEqual(finished.events.map((_, i) => i + 1));

		// Polling again changes nothing.
		const before = t.a.ctx.tasks.store.get(task.id);
		await t.a.ctx.tasks.sender.syncTask(task.id);
		expect(t.a.ctx.tasks.store.get(task.id)).toEqual(before);
	});

	describe("applying records", () => {
		it("applies status, result and events once, ignores stale/foreign/finished answers, and publishes only real changes", async () => {
			const t = await taskPair();
			const hub = t.a.ctx.tasks;
			// A task B has never heard of: its mirror polls answer 404, which must stay quiet.
			const now = new Date().toISOString();
			const row = hub.store.insert({
				id: "tsk_01JTESTMIRROR0000000000001",
				direction: "outgoing",
				peerId: bIdOf(t),
				workspaceId: t.workspace.id,
				projectId: t.projectA.id,
				title: "Synthetic",
				status: "offered",
				repoUrl: REPO.htmlUrl,
				senderNodeId: aIdOf(t),
				senderNodeName: "node-a",
				executorNodeId: bIdOf(t),
				executorNodeName: "node-b",
				correlationId: "01JTESTCORR00000000000001",
			});
			await hub.sender.syncTask(row.id);
			expect(hub.store.get(row.id).status).toBe("offered");

			const published: unknown[] = [];
			const unsubscribe = t.a.ctx.bus.subscribe(`task:${row.id}`, (event) => published.push(event));
			cleanups.push(async () => unsubscribe());
			const record = (over: Partial<wire.TaskRecord> = {}): wire.TaskRecord => ({
				taskId: row.id,
				status: "running",
				epoch: 0,
				agentId: "agt_exec",
				agentName: "Exec",
				reason: null,
				createdAt: now,
				updatedAt: now,
				startedAt: now,
				finishedAt: null,
				result: null,
				cost: 0.5,
				lastEventSeq: 2,
				...over,
			});
			const events: wire.TaskEventWire[] = [
				{ seq: 1, type: "status", at: now, summary: "offered → accepted", payload: { from: "offered", to: "accepted" } },
				{ seq: 2, type: "status", at: now, summary: "accepted → running", payload: { from: "accepted", to: "running" } },
			];
			const current = () => hub.store.get(row.id);

			expect(applyRecord(hub, row.id, record(), events)).toEqual({ changed: true, gap: false, settled: true });
			expect(current()).toMatchObject({ status: "running", executorAgentId: "agt_exec", executorAgentName: "Exec", cost: 0.5, startedAt: now, lastEventSeq: 2 });
			expect(hub.store.eventsSince(row.id, 0).map((e) => e.seq)).toEqual([1, 2]);
			expect(published).toHaveLength(3); // the task + two events

			// The same answer again: nothing changes, nothing is published.
			const snapshot = current();
			expect(applyRecord(hub, row.id, record(), events)).toEqual({ changed: false, gap: false, settled: true });
			expect(current()).toEqual(snapshot);
			expect(published).toHaveLength(3);

			// An older answer (behind what we mirrored) is ignored.
			expect(applyRecord(hub, row.id, record({ status: "accepted", lastEventSeq: 1 }), [])).toMatchObject({ changed: false, settled: true });
			expect(current().status).toBe("running");

			// A lower epoch is a node that lost ownership; a higher one is adopted.
			hub.store.update(row.id, { epoch: 1 });
			expect(applyRecord(hub, row.id, record({ epoch: 0, status: "failed", lastEventSeq: 3 }), [])).toMatchObject({ changed: false });
			expect(current()).toMatchObject({ status: "running", epoch: 1 });
			expect(applyRecord(hub, row.id, record({ epoch: 2 }), [])).toMatchObject({ changed: true });
			expect(current().epoch).toBe(2);

			// A record that is ahead of our timeline and brings no events waits for the poll that brings both.
			const result = { summary: "built", autoCompleted: false, branch: null, commit: null, pushed: false, compareUrl: null, artifacts: [] };
			const finished = record({ epoch: 2, status: "succeeded", lastEventSeq: 3, finishedAt: now, result });
			expect(applyRecord(hub, row.id, finished, [])).toEqual({ changed: false, gap: false, settled: false });
			expect(current().status).toBe("running");
			expect(applyRecord(hub, row.id, finished, [{ seq: 3, type: "status", at: now, summary: "running → succeeded", payload: { from: "running", to: "succeeded" } }])).toMatchObject({ changed: true, settled: true });
			expect(current()).toMatchObject({ status: "succeeded", finishedAt: now, result, lastEventSeq: 3 });

			// Finished tasks are never reopened.
			expect(applyRecord(hub, row.id, record({ epoch: 2, status: "running", lastEventSeq: 4 }), [{ seq: 4, type: "note", at: now, summary: "late" }])).toMatchObject({ changed: false });
			expect(current()).toMatchObject({ status: "succeeded", lastEventSeq: 3 });
			expect(hub.store.eventsSince(row.id, 0)).toHaveLength(3);
		});
	});
});

describe("creating a task", () => {
	it("validates the peer, the grant, the project, the workspace and the agent before storing anything", async () => {
		const t = await taskPair();
		const base = { targetNodeId: bIdOf(t), projectId: t.projectA.id, title: "T", description: "d", deliverAs: "summary" as const, constraints: {} };
		const post = async (body: Record<string, unknown>) => api(t.a).post<{ error: { code: string } }>("/tasks", { ...base, ...body });
		const count = () => t.a.ctx.tasks.store.list().length;

		expect((await post({ targetNodeId: "node_unknown" })).status).toBe(404);
		expect((await post({ projectId: "prj_unknown" })).status).toBe(404);

		const unlinked = (await api(t.a).post<Project>("/projects", { workspaceId: t.workspace.id, name: "plain", path: mkDir(t, "plain") })).body;
		const noRepo = await post({ projectId: unlinked.id });
		expect([noRepo.status, noRepo.body.error.code]).toEqual([409, "project_not_linked"]);

		const other = (await api(t.a).post<Workspace>("/workspaces", { name: "Other" })).body;
		const foreign = (await api(t.a).post<Project>("/projects", { workspaceId: other.id, name: "foreign", path: mkDir(t, "foreign") })).body;
		await api(t.a).patch(`/projects/${foreign.id}`, { repository: { owner: REPO.owner, name: REPO.name, externalId: null, htmlUrl: REPO.htmlUrl, defaultBranch: "main", accountId: null } });
		const notShared = await post({ projectId: foreign.id });
		expect([notShared.status, notShared.body.error.code]).toEqual([409, "workspace_not_shared"]);

		await eventually(() => t.a.ctx.db.select().from(peerAgents).where(eq(peerAgents.peerId, bIdOf(t))).all().length > 0, "B's agents cached on A");
		const unknownAgent = await post({ targetAgentId: "agt_nope" });
		expect([unknownAgent.status, unknownAgent.body.error.code]).toEqual([400, "unknown_agent"]);
		expect(count()).toBe(0);

		// The grant check runs synchronously with the call, so the next heartbeat cannot restore it in between.
		const granted = (await peerOf(t.a, bIdOf(t)))?.receivedCapabilities ?? [];
		t.a.ctx.network.peers.setReceivedCapabilities(bIdOf(t), []);
		await expect(t.a.ctx.tasks.sender.create({ targetNodeId: bIdOf(t), projectId: t.projectA.id, title: "T", description: "d", deliverAs: "summary", constraints: {} })).rejects.toMatchObject({
			status: 409,
			code: "capability_missing",
			details: { missing: ["tasks.send"] },
		});
		t.a.ctx.network.peers.setReceivedCapabilities(bIdOf(t), granted);
		expect(count()).toBe(0);
	});
});

function mkDir(t: TaskPair, name: string): string {
	const dir = path.join(t.root, name);
	mkdirSync(dir, { recursive: true });
	cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
	return dir;
}
