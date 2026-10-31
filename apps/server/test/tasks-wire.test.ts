import { createHash } from "node:crypto";
import { SseParser, signRequest, signerFromIdentity, ulid, wire, type SseFrame } from "@clam/agent-network";
import type { Capability, Peer } from "@clam/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { api, type FullHarness } from "./full-harness.ts";
import { eventually, pair, signedRequest, startNode } from "./net-helpers.ts";
import type { TaskInsert, TaskRow } from "../src/tasks/store.ts";

const nodes: FullHarness[] = [];
async function node(name: string): Promise<FullHarness> {
	const n = await startNode(name);
	nodes.push(n);
	return n;
}
afterEach(async () => {
	for (const n of nodes.splice(0)) await n.cleanup();
});

const REPO = "https://github.com/acme/widgets";
const ERROR = (code: string) => ({ error: expect.objectContaining({ code }) });

/** Executor `a`, sender `b`, both in one workspace; `a` granted `b` the default capabilities (no `tasks.cancel`). */
async function setup() {
	const a = await node("exec-a");
	const b = await node("sender-b");
	const paired = await pair(a, b);
	return { a, b, workspaceId: paired.workspace.id, bId: b.ctx.identity.nodeId, aId: a.ctx.identity.nodeId };
}

function createBody(workspaceId: string, over: Record<string, unknown> = {}) {
	return {
		taskId: `tsk_${ulid()}`,
		workspaceId,
		projectRef: { repoUrl: REPO },
		title: "Add retries",
		description: "Please add retries to the client.",
		deliverAs: "summary",
		constraints: {},
		epoch: 0,
		correlationId: ulid(),
		sender: {},
		...over,
	};
}

/** A task row written directly, for states the wire cannot reach without running agents. */
function seedTask(on: FullHarness, over: Partial<TaskInsert> & Pick<TaskInsert, "peerId">): TaskRow {
	const outgoing = over.direction === "outgoing";
	const self = { nodeId: on.ctx.identity.nodeId, name: "self" };
	return on.ctx.tasks.store.insert({
		id: `tsk_${ulid()}`,
		direction: "incoming",
		workspaceId: "ws_seed",
		title: "Seeded task",
		repoUrl: REPO,
		senderNodeId: outgoing ? self.nodeId : over.peerId,
		senderNodeName: outgoing ? self.name : "peer",
		executorNodeId: outgoing ? over.peerId : self.nodeId,
		executorNodeName: outgoing ? "peer" : self.name,
		correlationId: ulid(),
		...over,
	});
}

async function grant(on: FullHarness, peerId: string, capabilities: Capability[]): Promise<void> {
	const res = await api(on).patch<Peer>(`/network/peers/${peerId}`, { grantedCapabilities: capabilities });
	expect(res.status).toBe(200);
}

const taskCount = (on: FullHarness): number => on.ctx.tasks.store.list().length;

/** A signed GET returning raw bytes (`signedRequest` parses JSON). */
async function signedBytes(from: FullHarness, toNetUrl: string, path: string): Promise<{ status: number; bytes: Buffer; headers: Headers }> {
	const url = `${toNetUrl}/api/v1${path}`;
	const headers = signRequest(signerFromIdentity(from.ctx.identity), { method: "GET", url, bodyBytes: new Uint8Array(0) });
	const res = await fetch(url, { headers });
	return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers };
}

describe("POST /tasks", () => {
	it("creates a task once: validation errors are not stored, a replay answers the stored response, a changed body conflicts, a new key for a known id is a natural replay", async () => {
		const { a, b, workspaceId, bId } = await setup();
		const body = createBody(workspaceId);
		const key = `create-${ulid()}`;

		const invalid = await signedRequest(b, a.netUrl, { method: "POST", path: "/tasks", body: { ...body, title: "" }, idempotencyKey: key });
		expect(invalid.status).toBe(400);
		expect(invalid.body).toEqual(ERROR("invalid_request"));
		expect(taskCount(a)).toBe(0);

		// The failed attempt did not burn the key.
		const created = await signedRequest(b, a.netUrl, { method: "POST", path: "/tasks", body, idempotencyKey: key });
		expect(created.status).toBe(202); // no local project matches the repository: waits for a human
		expect(created.headers.get("idempotent-replay")).toBeNull();
		expect(wire.TaskRecord.parse(created.body)).toMatchObject({ taskId: body.taskId, status: "offered", epoch: 0, lastEventSeq: 1 });
		expect(taskCount(a)).toBe(1);
		expect(a.ctx.tasks.store.get(body.taskId)).toMatchObject({ direction: "incoming", peerId: bId, senderNodeName: "sender-b", executorNodeName: "exec-a" });

		const replay = await signedRequest(b, a.netUrl, { method: "POST", path: "/tasks", body, idempotencyKey: key });
		expect(replay.status).toBe(202);
		expect(replay.headers.get("idempotent-replay")).toBe("true");
		expect(replay.body).toEqual(created.body);
		expect(taskCount(a)).toBe(1);

		const changed = await signedRequest(b, a.netUrl, { method: "POST", path: "/tasks", body: { ...body, title: "Another title" }, idempotencyKey: key });
		expect(changed.status).toBe(409);
		expect(changed.body).toEqual(ERROR("idempotency_conflict"));

		const natural = await signedRequest(b, a.netUrl, { method: "POST", path: "/tasks", body, idempotencyKey: `create-${ulid()}` });
		expect(natural.status).toBe(200);
		expect(natural.headers.get("idempotent-replay")).toBeNull();
		expect(natural.body).toMatchObject({ taskId: body.taskId, status: "offered" });
		expect(taskCount(a)).toBe(1);
	});

	it("needs tasks.send, workspace membership and a GitHub repository", async () => {
		const { a, b, workspaceId, bId } = await setup();
		await grant(a, bId, ["agents.read", "events.read"]);
		const denied = await signedRequest(b, a.netUrl, { method: "POST", path: "/tasks", body: createBody(workspaceId) });
		expect(denied.status).toBe(403);
		expect(denied.body.error).toMatchObject({ code: "forbidden", details: { missing: ["tasks.send"] } });
		await grant(a, bId, ["agents.read", "events.read", "tasks.send"]);

		const elsewhere = await signedRequest(b, a.netUrl, { method: "POST", path: "/tasks", body: createBody("ws_unknown") });
		expect(elsewhere.status).toBe(403);
		const notGithub = await signedRequest(b, a.netUrl, { method: "POST", path: "/tasks", body: createBody(workspaceId, { projectRef: { repoUrl: "https://example.com/x/y" } }) });
		expect(notGithub.status).toBe(400);
		expect(taskCount(a)).toBe(0);
	});
});

describe("GET /tasks/:id", () => {
	it("is only visible to the peer the task was exchanged with and returns events after `since`", async () => {
		const { a, b, workspaceId } = await setup();
		const c = await node("third-c");
		await pair(a, c, { workspaceName: "Other" });
		const body = createBody(workspaceId);
		expect((await signedRequest(b, a.netUrl, { method: "POST", path: "/tasks", body })).status).toBe(202);

		const record = await signedRequest(b, a.netUrl, { path: `/tasks/${body.taskId}` });
		expect(record.status).toBe(200);
		expect(wire.GetTaskResponse.parse(record.body)).toMatchObject({ taskId: body.taskId, status: "offered", lastEventSeq: 1 });
		expect(record.body.events).toBeUndefined();

		const all = await signedRequest(b, a.netUrl, { path: `/tasks/${body.taskId}?since=0` });
		expect(all.body.events).toEqual([expect.objectContaining({ seq: 1, type: "status" })]);
		const none = await signedRequest(b, a.netUrl, { path: `/tasks/${body.taskId}?since=1` });
		expect(none.body.events).toEqual([]);
		expect((await signedRequest(b, a.netUrl, { path: `/tasks/${body.taskId}?since=-1` })).status).toBe(400);
		expect((await signedRequest(b, a.netUrl, { path: `/tasks/${body.taskId}?since=abc` })).status).toBe(400);

		// A paired third node learns nothing, not even that the task exists.
		const stranger = await signedRequest(c, a.netUrl, { path: `/tasks/${body.taskId}` });
		const unknown = await signedRequest(c, a.netUrl, { path: `/tasks/tsk_${ulid()}` });
		expect(stranger.status).toBe(404);
		expect(stranger.body.error.message).toBe(unknown.body.error.message);
		expect((await signedRequest(b, a.netUrl, { path: `/tasks/tsk_${ulid()}` })).status).toBe(404);
		expect((await signedRequest(c, a.netUrl, { method: "POST", path: `/tasks/${body.taskId}/messages`, body: { messageId: `msg_${ulid()}`, epoch: 0, kind: "note", body: "hi", author: { kind: "human" }, createdAt: new Date().toISOString() } })).status).toBe(404);
	});

	it("keeps cancel and artifact download executor-only: an outgoing task has neither", async () => {
		const { a, b, aId } = await setup();
		const outgoing = seedTask(b, { peerId: aId, direction: "outgoing" });
		// Cancel and artifacts are executor-side endpoints: an outgoing task has neither.
		await grant(b, a.ctx.identity.nodeId, ["agents.read", "events.read", "tasks.send", "tasks.receive", "tasks.cancel"]);
		expect((await signedRequest(a, b.netUrl, { method: "POST", path: `/tasks/${outgoing.id}/cancel`, body: { epoch: 0 } })).status).toBe(404);
		expect((await signedBytes(a, b.netUrl, `/tasks/${outgoing.id}/artifacts/art_x`)).status).toBe(404);
	});
});

describe("POST /tasks/:id/cancel", () => {
	it("needs tasks.cancel, checks the epoch, cancels and answers idempotently", async () => {
		const { a, b, workspaceId, bId } = await setup();
		const body = createBody(workspaceId);
		await signedRequest(b, a.netUrl, { method: "POST", path: "/tasks", body });

		const denied = await signedRequest(b, a.netUrl, { method: "POST", path: `/tasks/${body.taskId}/cancel`, body: { epoch: 0 } });
		expect(denied.status).toBe(403);
		expect(denied.body.error).toMatchObject({ code: "forbidden", details: { missing: ["tasks.cancel"] } });
		await grant(a, bId, ["agents.read", "events.read", "tasks.send", "tasks.receive", "tasks.cancel"]);

		expect((await signedRequest(b, a.netUrl, { method: "POST", path: `/tasks/${body.taskId}/cancel`, body: { reason: "x" } })).status).toBe(400);
		a.ctx.tasks.store.update(body.taskId, { epoch: 2 });
		const stale = await signedRequest(b, a.netUrl, { method: "POST", path: `/tasks/${body.taskId}/cancel`, body: { epoch: 1 } });
		expect(stale.status).toBe(409);
		expect(stale.body.error).toMatchObject({ code: "stale_epoch", details: { currentEpoch: 2 } });
		const future = await signedRequest(b, a.netUrl, { method: "POST", path: `/tasks/${body.taskId}/cancel`, body: { epoch: 3 } });
		expect(future.status).toBe(409);
		expect(future.body.error.code).toBe("conflict");
		expect(a.ctx.tasks.store.get(body.taskId).status).toBe("offered");

		const key = `cancel-${ulid()}`;
		const cancelled = await signedRequest(b, a.netUrl, { method: "POST", path: `/tasks/${body.taskId}/cancel`, body: { epoch: 2, reason: "changed my mind" }, idempotencyKey: key });
		expect(cancelled.status).toBe(200);
		expect(wire.TaskRecord.parse(cancelled.body)).toMatchObject({ taskId: body.taskId, status: "cancelled", reason: "changed my mind" });
		const replay = await signedRequest(b, a.netUrl, { method: "POST", path: `/tasks/${body.taskId}/cancel`, body: { epoch: 2, reason: "changed my mind" }, idempotencyKey: key });
		expect(replay.status).toBe(200);
		expect(replay.headers.get("idempotent-replay")).toBe("true");
		// A second cancel with a new key returns the finished task unchanged.
		const again = await signedRequest(b, a.netUrl, { method: "POST", path: `/tasks/${body.taskId}/cancel`, body: { epoch: 2 } });
		expect(again.status).toBe(200);
		expect(again.body.status).toBe("cancelled");
		expect(a.ctx.tasks.store.eventsSince(body.taskId, 0).filter((e) => e.type === "status").map((e) => e.summary)).toHaveLength(2);
	});
});

describe("POST /tasks/:id/messages", () => {
	const message = (over: Record<string, unknown> = {}) => ({ messageId: `msg_${ulid()}`, epoch: 0, kind: "instruction", body: "Use exponential backoff.", author: { kind: "human" }, createdAt: new Date().toISOString(), ...over });

	it("stores out-of-order and duplicate deliveries once, in thread order", async () => {
		const { a, b, workspaceId } = await setup();
		const body = createBody(workspaceId);
		await signedRequest(b, a.netUrl, { method: "POST", path: "/tasks", body });
		const first = message({ createdAt: "2026-01-01T10:00:00.000Z", body: "first" });
		const second = message({ createdAt: "2026-01-01T10:00:05.000Z", body: "second" });

		const late = await signedRequest(b, a.netUrl, { method: "POST", path: `/tasks/${body.taskId}/messages`, body: second });
		expect(late.status).toBe(202);
		expect(wire.TaskMessageAccepted.parse(late.body)).toMatchObject({ messageId: second.messageId, accepted: true });
		const early = await signedRequest(b, a.netUrl, { method: "POST", path: `/tasks/${body.taskId}/messages`, body: first });
		expect(early.status).toBe(202);
		const seqAfter = a.ctx.tasks.store.get(body.taskId).lastEventSeq;

		const key = `msg-${ulid()}`;
		const viaKey = await signedRequest(b, a.netUrl, { method: "POST", path: `/tasks/${body.taskId}/messages`, body: first, idempotencyKey: key });
		expect(viaKey.status).toBe(202);
		const replayed = await signedRequest(b, a.netUrl, { method: "POST", path: `/tasks/${body.taskId}/messages`, body: first, idempotencyKey: key });
		expect(replayed.headers.get("idempotent-replay")).toBe("true");
		expect(replayed.body).toEqual(viaKey.body);

		expect(a.ctx.tasks.store.messages(body.taskId).map((m) => m.text)).toEqual(["first", "second"]);
		expect(a.ctx.tasks.store.get(body.taskId).lastEventSeq).toBe(seqAfter);
		expect(a.ctx.tasks.store.messages(body.taskId)[0]).toMatchObject({ authorNodeId: b.ctx.identity.nodeId, authorKind: "human", delivery: "local" });
	});

	it("checks the epoch, the body and the capability of our role", async () => {
		const { a, b, workspaceId, bId, aId } = await setup();
		const body = createBody(workspaceId);
		await signedRequest(b, a.netUrl, { method: "POST", path: "/tasks", body });
		const path = `/tasks/${body.taskId}/messages`;

		expect((await signedRequest(b, a.netUrl, { method: "POST", path, body: { ...message(), body: "" } })).status).toBe(400);
		expect((await signedRequest(b, a.netUrl, { method: "POST", path, body: { ...message(), kind: "gossip" } })).status).toBe(400);
		a.ctx.tasks.store.update(body.taskId, { epoch: 2 });
		const stale = await signedRequest(b, a.netUrl, { method: "POST", path, body: message({ epoch: 1 }) });
		expect(stale.status).toBe(409);
		expect(stale.body.error).toMatchObject({ code: "stale_epoch", details: { currentEpoch: 2 } });
		expect((await signedRequest(b, a.netUrl, { method: "POST", path, body: message({ epoch: 3 }) })).body).toEqual(ERROR("conflict"));
		expect(a.ctx.tasks.store.messages(body.taskId)).toHaveLength(0);

		// We are the executor: the sender needs tasks.send.
		await grant(a, bId, ["agents.read", "events.read", "tasks.receive"]);
		const denied = await signedRequest(b, a.netUrl, { method: "POST", path, body: message({ epoch: 2 }) });
		expect(denied.status).toBe(403);
		expect(denied.body.error.details).toEqual({ missing: ["tasks.send"] });

		// We are the sender of this other task: the executor needs tasks.receive.
		const outgoing = seedTask(b, { peerId: aId, direction: "outgoing", status: "running" });
		const question = message({ kind: "question", author: { kind: "agent", agentId: "agt_x", agentName: "Coder" }, body: "Which client?" });
		await grant(b, aId, ["agents.read", "events.read", "tasks.send"]);
		const refused = await signedRequest(a, b.netUrl, { method: "POST", path: `/tasks/${outgoing.id}/messages`, body: question });
		expect(refused.status).toBe(403);
		expect(refused.body.error.details).toEqual({ missing: ["tasks.receive"] });
		await grant(b, aId, ["agents.read", "events.read", "tasks.send", "tasks.receive"]);
		const accepted = await signedRequest(a, b.netUrl, { method: "POST", path: `/tasks/${outgoing.id}/messages`, body: question });
		expect(accepted.status).toBe(202);
		expect(b.ctx.tasks.store.messages(outgoing.id)).toEqual([expect.objectContaining({ id: question.messageId, kind: "question", authorKind: "agent", authorAgentName: "Coder", delivery: "local" })]);
	});
});

describe("GET /tasks/:id/artifacts/:artifactId", () => {
	it("serves a task artifact to the task's own sender only, with a verifiable digest", async () => {
		const { a, b, workspaceId } = await setup();
		const c = await node("third-c");
		await pair(a, c, { workspaceName: "Other" });
		const body = createBody(workspaceId);
		await signedRequest(b, a.netUrl, { method: "POST", path: "/tasks", body });
		const bytes = Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 7) % 256));
		const artifact = await a.ctx.tasks.artifacts.add(body.taskId, { name: "changes.bin", mediaType: "application/octet-stream", bytes });

		const res = await signedBytes(b, a.netUrl, `/tasks/${body.taskId}/artifacts/${artifact.id}`);
		expect(res.status).toBe(200);
		expect(res.bytes.equals(bytes)).toBe(true);
		expect(createHash("sha256").update(res.bytes).digest("hex")).toBe(artifact.sha256);
		expect(res.headers.get("content-digest")).toBe(`sha-256=:${createHash("sha256").update(bytes).digest("base64")}:`);
		expect(res.headers.get("content-type")).toBe("application/octet-stream");
		expect(res.headers.get("content-length")).toBe(String(bytes.length));
		expect(res.headers.get("content-disposition")).toBe('attachment; filename="changes.bin"');

		expect((await signedBytes(c, a.netUrl, `/tasks/${body.taskId}/artifacts/${artifact.id}`)).status).toBe(404);
		expect((await signedBytes(b, a.netUrl, `/tasks/${body.taskId}/artifacts/art_${ulid()}`)).status).toBe(404);
		const other = seedTask(a, { peerId: b.ctx.identity.nodeId });
		expect((await signedBytes(b, a.netUrl, `/tasks/${other.id}/artifacts/${artifact.id}`)).status).toBe(404);
	});
});

describe("node health, agents and the event stream", () => {
	it("reports real task counts, agent load and busy state", async () => {
		const { a, b, bId } = await setup();
		const agents = await signedRequest(b, a.netUrl, { path: "/agents" });
		const agentId: string = agents.body.agents[0].agentId;
		expect(agents.body.agents[0]).toMatchObject({ activeTasks: 0, status: "online", acceptsTasks: true });
		const idle = await signedRequest(b, a.netUrl, { path: "/node/health" });
		expect(idle.body).toMatchObject({ runningTasks: 0, queuedTasks: 0 });
		const revisionBefore = a.net.agentsWatcher.revision();

		// Only queued work: the agent is still available.
		seedTask(a, { peerId: bId, status: "accepted", executorAgentId: agentId });
		const queued = await signedRequest(b, a.netUrl, { path: "/agents" });
		expect(queued.body.agents[0]).toMatchObject({ activeTasks: 1, status: "online", acceptsTasks: true });
		expect(await signedRequest(b, a.netUrl, { path: "/node/health" }).then((r) => r.body)).toMatchObject({ runningTasks: 0, queuedTasks: 1 });

		seedTask(a, { peerId: bId, status: "running", executorAgentId: agentId });
		seedTask(a, { peerId: bId, status: "blocked", executorAgentId: agentId });
		seedTask(a, { peerId: bId, status: "succeeded", executorAgentId: agentId });
		seedTask(b, { peerId: a.ctx.identity.nodeId, direction: "outgoing", status: "running" });
		const busy = await signedRequest(b, a.netUrl, { path: "/agents" });
		expect(busy.body.agents[0]).toMatchObject({ activeTasks: 3, status: "busy", acceptsTasks: true });
		expect(wire.AgentsResponse.safeParse(busy.body).success).toBe(true);
		expect(await signedRequest(b, a.netUrl, { path: "/node/health" }).then((r) => r.body)).toMatchObject({ runningTasks: 2, queuedTasks: 1 });
		expect(a.net.agentsWatcher.revision()).not.toBe(revisionBefore);
		// The local agent list shows the same state.
		expect((await api(a).get<Array<{ status: string }>>("/agents")).body[0]?.status).toBe("busy");
		// Tasks this node delegated do not count as load.
		expect(await signedRequest(a, b.netUrl, { path: "/node/health" }).then((r) => r.body)).toMatchObject({ runningTasks: 0, queuedTasks: 0 });
	});

	it("delivers task.updated on /events to the audience peer only (others get an empty payload)", async () => {
		const { a, b, workspaceId } = await setup();
		const c = await node("third-c");
		await pair(a, c, { workspaceName: "Other" });

		const streams = await Promise.all(
			[b, c].map(async (from) => {
				const url = `${a.netUrl}/api/v1/events`;
				const abort = new AbortController();
				const headers = signRequest(signerFromIdentity(from.ctx.identity), { method: "GET", url, bodyBytes: new Uint8Array(0) });
				const res = await fetch(url, { headers, signal: abort.signal });
				expect(res.status).toBe(200);
				const frames: SseFrame[] = [];
				const parser = new SseParser();
				const decoder = new TextDecoder();
				void (async () => {
					const reader = (res.body as ReadableStream<Uint8Array>).getReader();
					try {
						for (;;) {
							const { done, value } = await reader.read();
							if (done) return;
							frames.push(...parser.push(decoder.decode(value, { stream: true })));
						}
					} catch {
						// aborted by the test
					}
				})();
				return { frames, abort };
			}),
		);
		const [forB, forC] = streams as [(typeof streams)[number], (typeof streams)[number]];
		try {
			const body = createBody(workspaceId);
			expect((await signedRequest(b, a.netUrl, { method: "POST", path: "/tasks", body })).status).toBe(202);
			const updated = (frames: SseFrame[]) => frames.filter((f) => f.event === "task.updated").map((f) => JSON.parse(f.data) as { payload: Record<string, unknown> });
			await eventually(() => updated(forB.frames).length > 0 && updated(forC.frames).length > 0, "task.updated on both streams");
			expect(updated(forB.frames)[0]?.payload).toMatchObject({ taskId: body.taskId, status: "offered" });
			expect(updated(forC.frames)[0]?.payload).toEqual({});
		} finally {
			for (const s of streams) s.abort.abort();
		}
	});
});
