import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ulid, wire } from "@clam/agent-network";
import type { Capability, Peer, Project, TaskStatus } from "@clam/contracts";
import { agents, projects } from "@clam/database";
import { makeFencingToken } from "@clam/handoff-engine";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execState } from "../src/tasks/exec-state.ts";
import { applyRecord } from "../src/tasks/mirror.ts";
import { newTaskId, type TaskInsert, type TaskRow } from "../src/tasks/store.ts";
import { api, createMemorySecrets, type FullHarness } from "./full-harness.ts";
import { eventually, pair, signedRequest, startNode } from "./net-helpers.ts";

const REPO_URL = "https://github.com/acme/widgets";
const REPO = { owner: "acme", name: "widgets", externalId: null, htmlUrl: REPO_URL, defaultBranch: "main", accountId: null };
const DONE = '@@fake-tool mesh_complete {"taskId":"{{taskId}}","outcome":"succeeded","summary":"all done"}';
const SHA = "a".repeat(64);
const ERROR = (code: string) => ({ error: expect.objectContaining({ code }) });

interface Env {
	/** Executor (inviter, so it granted `y` the default capabilities) and sender. */
	x: FullHarness;
	y: FullHarness;
	workspaceId: string;
	project: Project;
	dir: string;
}

const nodes: FullHarness[] = [];
const dirs: string[] = [];
let env: Env;

async function node(name: string): Promise<FullHarness> {
	const n = await startNode(name);
	nodes.push(n);
	return n;
}

beforeEach(async () => {
	const x = await node("exec-x");
	const y = await node("sender-y");
	const { workspace } = await pair(x, y);
	const dir = mkdtempSync(path.join(tmpdir(), "clam-fence-"));
	dirs.push(dir);
	const created = await api(x).post<Project>("/projects", { workspaceId: workspace.id, name: "work", path: dir });
	expect(created.status, JSON.stringify(created.body)).toBe(201);
	x.ctx.db.update(projects).set({ repository: REPO }).where(eq(projects.id, created.body.id)).run();
	env = { x, y, workspaceId: workspace.id, project: created.body, dir };
});

afterEach(async () => {
	for (const n of nodes.splice(0)) await n.cleanup();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const xId = () => env.x.ctx.identity.nodeId;
const yId = () => env.y.ctx.identity.nodeId;
const fence = () => env.x.ctx.handoffs.fence;
const tasksX = () => env.x.ctx.tasks.store;
const executor = () => env.x.ctx.tasks.executor;
const row = (id: string): TaskRow => tasksX().get(id);
/** Only for negative assertions ("nothing happens") against real fake-omp processes: there is no signal to await for an event that must NOT occur. */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(id: string, status: TaskStatus, timeoutMs = 20_000): Promise<TaskRow> {
	return eventually(() => (row(id).status === status ? row(id) : undefined), `task ${id} to be ${status} (is ${row(id).status})`, timeoutMs);
}

function request(over: Partial<wire.CreateTaskRequest> = {}): wire.CreateTaskRequest {
	return { taskId: newTaskId(), workspaceId: env.workspaceId, projectRef: { repoUrl: REPO_URL }, title: "Add the thing", description: "Please add the thing.", deliverAs: "summary", constraints: {}, epoch: 0, correlationId: ulid(), sender: { agentId: "agt_alice", agentName: "Alice" }, ...over };
}

/** Receive from the sender `y` and accept: the task starts running at once (one project, nothing queued). */
async function startTask(description: string, over: Partial<wire.CreateTaskRequest> = {}): Promise<TaskRow> {
	const { row: created } = await executor().receive(yId(), request({ description, ...over }));
	await executor().decide(created.id, { decision: "accept" });
	return created;
}

/** A row written directly, for states that cannot be reached without a running agent. */
function seed(on: FullHarness, over: Partial<TaskInsert> & Pick<TaskInsert, "peerId">): TaskRow {
	const outgoing = over.direction === "outgoing";
	const self = on.ctx.identity.nodeId;
	return on.ctx.tasks.store.insert({
		id: newTaskId(),
		direction: "incoming",
		workspaceId: env.workspaceId,
		title: "Seeded task",
		repoUrl: REPO_URL,
		deliverAs: "summary",
		status: "running",
		senderNodeId: outgoing ? self : over.peerId,
		senderNodeName: outgoing ? "self" : "peer",
		executorNodeId: outgoing ? over.peerId : self,
		executorNodeName: outgoing ? "peer" : "self",
		correlationId: ulid(),
		...over,
	});
}

/** A handoff row of the executor for `taskId` (the fence scan only reads role, kind, state, epochs). */
function seedHandoff(taskId: string, state: string, over: { role?: "source" | "target"; toEpoch?: number; id?: string } = {}) {
	const toEpoch = over.toEpoch ?? 1;
	return env.x.ctx.handoffs.store.insert({
		id: over.id ?? `hnd_${ulid()}`,
		kind: "task",
		role: over.role ?? "source",
		state,
		peerId: yId(),
		subjectId: taskId,
		title: "Seeded handoff",
		workspaceId: env.workspaceId,
		sourceNodeId: xId(),
		sourceNodeName: "exec-x",
		targetNodeId: yId(),
		targetNodeName: "sender-y",
		fromEpoch: toEpoch - 1,
		toEpoch,
		correlationId: ulid(),
	});
}

async function grant(on: FullHarness, peerId: string, capabilities: Capability[]): Promise<void> {
	const res = await api(on).patch<Peer>(`/network/peers/${peerId}`, { grantedCapabilities: capabilities });
	expect(res.status).toBe(200);
}

describe("FenceService", () => {
	it("freezes a task for one handoff at a time and unfreezes idempotently", () => {
		const task = seed(env.x, { peerId: yId() });
		expect(fence().isFrozen(task.id)).toBe(false);

		fence().freeze(task.id, "hnd_one");
		expect(fence().isFrozen(task.id)).toBe(true);
		expect(execState(row(task.id)).handoffId).toBe("hnd_one");
		fence().freeze(task.id, "hnd_one"); // same handoff: no-op
		expect(() => fence().freeze(task.id, "hnd_two")).toThrowError(expect.objectContaining({ status: 409, code: "handoff_in_progress", details: { handoffId: "hnd_one" } }));

		fence().unfreeze(task.id, "hnd_two"); // not the holder
		expect(fence().isFrozen(task.id)).toBe(true);
		fence().unfreeze(task.id, "hnd_one");
		expect(fence().isFrozen(task.id)).toBe(false);
		fence().unfreeze(task.id, "hnd_one");
		fence().freeze(task.id, "hnd_two");
		expect(execState(row(task.id)).handoffId).toBe("hnd_two");
	});

	it("fences at an epoch: idempotent, raises highestSeenEpoch only upwards, refuses a new freeze, writes no event", () => {
		const task = seed(env.x, { peerId: yId(), epoch: 1, highestSeenEpoch: 1, lastEventSeq: 4 });
		fence().fence(task.id, 3, "reconcile");
		expect(row(task.id)).toMatchObject({ fenced: true, highestSeenEpoch: 3, epoch: 1, status: "running", lastEventSeq: 4 });
		fence().fence(task.id, 2, "again");
		expect(row(task.id)).toMatchObject({ fenced: true, highestSeenEpoch: 3 });
		expect(fence().isFenced(task.id)).toBe(true);
		expect(tasksX().eventsSince(task.id, 0)).toHaveLength(0);
		expect(() => fence().freeze(task.id, "hnd_x")).toThrowError(expect.objectContaining({ status: 409, code: "task_fenced" }));
	});

	it("assertOwner: ok, stale_epoch for a moved epoch, task_fenced when fenced or a higher epoch was seen, 404 for unknown", () => {
		const task = seed(env.x, { peerId: yId(), epoch: 2, highestSeenEpoch: 2 });
		expect(() => fence().assertOwner(task.id)).not.toThrow();
		expect(() => fence().assertOwner(task.id, 2)).not.toThrow();
		expect(() => fence().assertOwner(task.id, 1)).toThrowError(expect.objectContaining({ status: 409, code: "stale_epoch", details: { currentEpoch: 2 } }));
		// A frozen task is still owned: the handoff engine itself works on it.
		fence().freeze(task.id, "hnd_a");
		expect(() => fence().assertOwner(task.id)).not.toThrow();

		tasksX().update(task.id, { highestSeenEpoch: 3 });
		expect(() => fence().assertOwner(task.id)).toThrowError(expect.objectContaining({ status: 409, code: "task_fenced", details: { currentEpoch: 3 } }));
		const other = seed(env.x, { peerId: yId() });
		fence().fence(other.id, 1, "test");
		expect(() => fence().assertOwner(other.id)).toThrowError(expect.objectContaining({ code: "task_fenced" }));
		expect(() => fence().assertOwner("tsk_unknown")).toThrowError(expect.objectContaining({ status: 404 }));
	});

	it("guards prompts of the executing session: frozen refuses except the handoff's own prompts, fenced refuses everything", () => {
		const task = seed(env.x, { peerId: yId(), executorSessionId: "ses_guarded" });
		const session = { id: "ses_guarded", kind: "chat", sharedSessionId: null };
		const guard = fence().guardPrompt;
		expect(() => guard(session, { clientId: "anything" })).not.toThrow();
		expect(() => guard({ id: "ses_other", kind: "chat", sharedSessionId: null }, { clientId: "anything" })).not.toThrow();

		fence().freeze(task.id, "hnd_g");
		expect(() => guard(session, { clientId: "anything" })).toThrowError(expect.objectContaining({ status: 409, code: "handoff_in_progress", details: { handoffId: "hnd_g" } }));
		expect(() => guard(session, { clientId: "handoff_hnd_g_resume" })).not.toThrow();

		fence().fence(task.id, 1, "test");
		expect(() => guard(session, { clientId: "anything" })).toThrowError(expect.objectContaining({ code: "task_fenced" }));
		expect(() => guard(session, { clientId: "handoff_hnd_g_resume" })).toThrowError(expect.objectContaining({ code: "task_fenced" }));
	});

	it("is wired into the session service: a prompt to a frozen task's session is refused", async () => {
		const agent = env.x.ctx.db.select().from(agents).get();
		expect(agent).toBeTruthy();
		const session = env.x.ctx.sessions.create({ projectId: env.project.id, title: "executing" }, { agentId: agent?.id ?? null });
		const task = seed(env.x, { peerId: yId(), executorSessionId: session.id });
		fence().freeze(task.id, "hnd_s");
		await expect(env.x.ctx.sessions.prompt(session.id, { message: "hello", clientId: "c1" })).rejects.toMatchObject({ status: 409, code: "handoff_in_progress" });
		fence().fence(task.id, 1, "test");
		await expect(env.x.ctx.sessions.prompt(session.id, { message: "hello", clientId: "handoff_x_resume" })).rejects.toMatchObject({ status: 409, code: "task_fenced" });
	});

	it("boot scan: fences released and lower-epoch tasks, blocks in-doubt ones, settles freeze markers", () => {
		const free = seed(env.x, { peerId: yId() });
		const lower = seed(env.x, { peerId: yId(), epoch: 1, highestSeenEpoch: 2 });
		const acked = seed(env.x, { peerId: yId(), epoch: 1 });
		seedHandoff(acked.id, "acked", { toEpoch: 2 });
		const doubt = seed(env.x, { peerId: yId(), executorSessionId: "ses_doubt" });
		seedHandoff(doubt.id, "awaiting_ack");
		const preparing = seed(env.x, { peerId: yId() });
		seedHandoff(preparing.id, "preparing");
		const finished = seed(env.x, { peerId: yId() });
		seedHandoff(finished.id, "cancelled");
		const handedOff = seed(env.x, { peerId: yId(), status: "handed_off", epoch: 1 });

		const liveFrozen = seed(env.x, { peerId: yId(), execState: { handoffId: "hnd_live" } });
		seedHandoff(liveFrozen.id, "offered", { id: "hnd_live" });
		const orphan = seed(env.x, { peerId: yId(), execState: { handoffId: "hnd_missing" } });
		const endedFrozen = seed(env.x, { peerId: yId(), execState: { handoffId: "hnd_ended" } });
		seedHandoff(endedFrozen.id, "cancelled", { id: "hnd_ended" });
		const halfRestored = seed(env.x, { peerId: yId(), status: "accepted", execState: { handoffId: "hnd_target_failed" } });
		seedHandoff(halfRestored.id, "failed", { id: "hnd_target_failed", role: "target" });

		fence().bootScan();

		expect(row(free.id)).toMatchObject({ fenced: false });
		expect(fence().blockedResume(free.id)).toBe(false);
		expect(row(lower.id)).toMatchObject({ fenced: true, highestSeenEpoch: 2 });
		expect(row(acked.id)).toMatchObject({ fenced: true, highestSeenEpoch: 2 });
		expect(row(handedOff.id)).toMatchObject({ fenced: true, status: "handed_off" });
		// In doubt: stays running and unfenced, but the executor must not auto-resume its session.
		expect(row(doubt.id)).toMatchObject({ fenced: false, status: "running" });
		expect(fence().blockedResume(doubt.id)).toBe(true);
		expect(fence().unblockResume(doubt.id)).toBe(true);
		expect(fence().blockedResume(doubt.id)).toBe(false);
		expect(fence().unblockResume(doubt.id)).toBe(false);
		// A source that is still preparing, or whose handoff ended, owns the task as before.
		for (const t of [preparing, finished]) expect(fence().blockedResume(t.id)).toBe(false);
		expect(row(finished.id).fenced).toBe(false);

		// Freeze markers: a live handoff keeps its marker, orphans and ended ones are lifted, a half-restored target row stays frozen.
		expect(fence().isFrozen(liveFrozen.id)).toBe(true);
		expect(fence().isFrozen(orphan.id)).toBe(false);
		expect(fence().isFrozen(endedFrozen.id)).toBe(false);
		expect(fence().isFrozen(halfRestored.id)).toBe(true);
	});
});

describe("executor and frozen tasks", () => {
	it("ignores a frozen running task: mesh_complete is refused, a cancel gets 409 with the handoff id, nothing completes; unfreezing resumes the agent", async () => {
		const task = await startTask(`@@fake-sh sleep 1\n${DONE}`);
		await waitFor(task.id, "running");
		const sessionId = await eventually(() => (execState(row(task.id)).sessionStarted ? row(task.id).executorSessionId : undefined), "the agent to start");
		fence().freeze(task.id, "hnd_frozen");

		// The agent's mesh_complete arrives while frozen; its settle is ignored too.
		await sleep(2_500);
		expect(row(task.id)).toMatchObject({ status: "running", result: null });
		expect(execState(row(task.id)).completion).toBeUndefined();
		await expect(executor().complete(sessionId as string, { outcome: "succeeded", summary: "nope" })).rejects.toMatchObject({ status: 409, code: "handoff_in_progress", details: { handoffId: "hnd_frozen" } });
		await expect(executor().cancel(task.id, { reason: null, by: "local" })).rejects.toMatchObject({ status: 409, code: "handoff_in_progress", details: { handoffId: "hnd_frozen" } });
		await expect(executor().cancel(task.id, { reason: null, by: "sender" })).rejects.toMatchObject({ status: 409, code: "handoff_in_progress" });
		expect(row(task.id).status).toBe("running");
		expect(tasksX().eventsSince(task.id, 0).some((e) => e.type === "note" && e.summary.startsWith("Agent reported"))).toBe(false);

		// The handoff ends without releasing the task: the executor asks the agent to continue and the task finishes normally.
		fence().unfreeze(task.id, "hnd_frozen");
		const done = await waitFor(task.id, "succeeded");
		expect(done.result).toBeTruthy();
		expect(tasksX().eventsSince(task.id, 0).some((e) => e.summary.includes("The handoff ended without moving the task"))).toBe(true);
	});

	it("the handoff engine may cancel a frozen task itself", async () => {
		const task = await startTask("@@fake-sh sleep 20");
		await waitFor(task.id, "running");
		fence().freeze(task.id, "hnd_c");
		const cancelled = await executor().cancel(task.id, { reason: "handoff failed", by: "handoff" });
		expect(cancelled.status).toBe("cancelled");
	});

	it("never starts a fenced or frozen queued task, and a frozen one keeps its project busy", async () => {
		const frozen = seed(env.x, { peerId: yId(), status: "accepted", projectId: env.project.id, executorAgentId: env.x.ctx.db.select().from(agents).get()?.id ?? null, execState: { handoffId: "hnd_hold" } });
		const next = await startTask(DONE);
		await sleep(1_200);
		expect(row(next.id).status).toBe("accepted"); // the frozen row occupies the tree
		expect(row(frozen.id).status).toBe("accepted");

		const fenced = seed(env.x, { peerId: yId(), status: "accepted", projectId: env.project.id });
		fence().fence(fenced.id, 1, "test");
		await executor().cancel(next.id, { reason: null, by: "local" });
		await sleep(500);
		expect(row(fenced.id).status).toBe("accepted");
	});

	it("stores a fenced task's finished run as a late_result, never touching status or result, and keeps it off the wire", async () => {
		const task = await startTask(`@@fake-sh sleep 2\n${DONE}`);
		await waitFor(task.id, "running");
		const sessionId = (await eventually(() => (execState(row(task.id)).sessionStarted ? row(task.id).executorSessionId : undefined), "the agent to start")) as string;
		fence().fence(task.id, 1, "the task continues elsewhere");

		const late = await eventually(() => tasksX().eventsSince(task.id, 0).find((e) => e.type === "late_result"), "the late result");
		expect(late.summary).toContain("Late result (succeeded)");
		expect(late.payload).toMatchObject({ outcome: "succeeded", summary: "all done", currentEpoch: 1 });
		expect(row(task.id)).toMatchObject({ status: "running", result: null, fenced: true, finishedAt: null });
		// Its runtime is released once the agent ended its turn; the result is stored once.
		await eventually(() => env.x.ctx.runtime.get(sessionId) === undefined, "the runtime to be released");
		expect(tasksX().eventsSince(task.id, 0).filter((e) => e.type === "late_result")).toHaveLength(1);
		expect(execState(row(task.id)).holdsTree).toBe(false);

		// The sender mirrors the timeline up to the seal only.
		const polled = await signedRequest(env.y, env.x.netUrl, { path: `/tasks/${task.id}?since=0` });
		expect(polled.status).toBe(200);
		const types = (polled.body.events as { type: string }[]).map((e) => e.type);
		expect(types).not.toContain("late_result");
		expect(types).toContain("status");
	});

	it("a fenced running task answers a local cancel with 409 task_fenced and is not resumed on request", async () => {
		const task = await startTask("@@fake-sh sleep 20");
		await waitFor(task.id, "running");
		fence().fence(task.id, 1, "test");
		// 409 task_fenced tells the human the task went elsewhere.
		await expect(executor().cancel(task.id, { reason: null, by: "local" })).rejects.toMatchObject({ status: 409, code: "task_fenced" });
		await expect(executor().resumeInDoubt(task.id)).resolves.toBeUndefined();
		expect(row(task.id).status).toBe("running");
	});

	it("adoptHandedOver wires a running task with a bound session as this node's running task", async () => {
		const agent = env.x.ctx.db.select().from(agents).get();
		const session = env.x.ctx.sessions.create({ projectId: env.project.id, title: "adopted" }, { agentId: agent?.id ?? null });
		const task = seed(env.x, { peerId: yId(), projectId: env.project.id, executorSessionId: session.id, execState: { handoffId: "hnd_target" } });
		executor().adoptHandedOver(task.id);
		expect(execState(row(task.id))).toMatchObject({ holdsTree: true, sessionStarted: true });
		expect(execState(row(task.id)).handoffId).toBeUndefined();
		expect(fence().isFrozen(task.id)).toBe(false);

		const accepted = seed(env.x, { peerId: yId(), status: "accepted" });
		expect(() => executor().adoptHandedOver(accepted.id)).toThrowError(expect.objectContaining({ status: 409 }));
		fence().fence(task.id, 5, "test");
		expect(() => executor().adoptHandedOver(task.id)).toThrowError(expect.objectContaining({ code: "task_fenced" }));
	});
});

describe("boot", () => {
	const prompts = (on: FullHarness): string[] =>
		existsSync(on.fakeLog)
			? readFileSync(on.fakeLog, "utf8")
					.split("\n")
					.filter(Boolean)
					.flatMap((line) => {
						const r = JSON.parse(line) as { kind: string; frame?: { type: string; message?: string } };
						return r.kind === "command" && r.frame?.type === "prompt" && r.frame.message ? [r.frame.message] : [];
					})
			: [];

	it("resumes an owned running task after a restart but never a fenced one (the scan runs before any runtime is spawned)", async () => {
		const secrets = createMemorySecrets();
		const first = await startNode("restart-r", { secrets });
		nodes.push(first);
		const workspace = (await api(first).post<{ id: string }>("/workspaces", { name: "Boot" })).body;
		const dir = mkdtempSync(path.join(tmpdir(), "clam-fence-boot-"));
		dirs.push(dir);
		const project = (await api(first).post<Project>("/projects", { workspaceId: workspace.id, name: "boot", path: dir })).body;
		const agent = first.ctx.db.select().from(agents).get();
		const rowFor = (title: string, over: Partial<TaskInsert>) => {
			const session = first.ctx.sessions.create({ projectId: project.id, title }, { agentId: agent?.id ?? null });
			return first.ctx.tasks.store.insert({
				id: newTaskId(),
				direction: "incoming",
				peerId: "node_somebody",
				workspaceId: workspace.id,
				projectId: project.id,
				title,
				deliverAs: "summary",
				repoUrl: null,
				status: "running",
				senderNodeId: "node_somebody",
				senderNodeName: "somebody",
				executorNodeId: first.ctx.identity.nodeId,
				executorNodeName: "restart-r",
				executorAgentId: agent?.id ?? null,
				executorSessionId: session.id,
				correlationId: ulid(),
				...over,
			});
		};
		// One project holds one running task at a time in normal operation; the rows are seeded to get both states on one boot.
		const owned = rowFor("owned", {});
		const lost = rowFor("lost", { highestSeenEpoch: 2 });

		const { dataDir, netPort } = first;
		await first.cleanup({ keepData: true });
		nodes.splice(nodes.indexOf(first), 1);
		const second = await startNode("restart-r", { dataDir, port: netPort, secrets });
		nodes.push(second);

		await eventually(() => prompts(second).some((p) => p.includes("The node restarted while you were working on task") && p.includes(owned.id)), "the owned task to be resumed");
		const store = second.ctx.tasks.store;
		expect(store.get(lost.id)).toMatchObject({ fenced: true, status: "running", highestSeenEpoch: 2 });
		expect(prompts(second).some((p) => p.includes(lost.id))).toBe(false);
		expect(second.ctx.handoffs.fence.isFenced(lost.id)).toBe(true);
	});

	it("an in-doubt task keeps running without auto-resume; resumeInDoubt lifts the block and prompts the session", async () => {
		const agent = env.x.ctx.db.select().from(agents).get();
		const session = env.x.ctx.sessions.create({ projectId: env.project.id, title: "doubt" }, { agentId: agent?.id ?? null });
		const task = seed(env.x, { peerId: yId(), projectId: env.project.id, executorSessionId: session.id, executorAgentId: agent?.id ?? null, status: "running" });
		seedHandoff(task.id, "awaiting_ack");
		fence().bootScan();
		expect(fence().blockedResume(task.id)).toBe(true);
		expect(row(task.id)).toMatchObject({ status: "running", fenced: false });

		await executor().resumeInDoubt(task.id);
		expect(fence().blockedResume(task.id)).toBe(false);
		await eventually(() => prompts(env.x).some((p) => p.includes("The node restarted while you were working on task") && p.includes(task.id)), "the session to be resumed");
	});
});

describe("tasks that came home (peer = this node)", () => {
	it("keep their thread local, never enqueue peer calls and tell the delegating session when they conclude", async () => {
		const agent = env.x.ctx.db.select().from(agents).get();
		const delegating = env.x.ctx.sessions.create({ projectId: env.project.id, title: "delegating" }, { agentId: agent?.id ?? null });
		const task = seed(env.x, { peerId: xId(), status: "offered", senderSessionId: delegating.id, description: DONE, senderAgentName: "Alice" });
		expect(tasksX().isSelfPeer(task)).toBe(true);

		const message = await env.x.ctx.tasks.postMessage(task.id, { text: "a note to myself", kind: "note", author: { kind: "human", agentId: null, agentName: null } });
		expect(message.delivery).toBe("local");
		expect(tasksX().outboxOfTask(task.id)).toHaveLength(0);

		await executor().decide(task.id, { decision: "accept" });
		const done = await waitFor(task.id, "succeeded");
		expect(done.result?.summary).toBe("all done");
		const noted = await eventually(() => (row(task.id).notifiedStatus === "succeeded" ? row(task.id) : undefined), "the delegating session to be told");
		expect(noted.senderSessionId).toBe(delegating.id);
		expect(tasksX().outboxOfTask(task.id)).toHaveLength(0);
	});
});

describe("wire: a task that is moving", () => {
	const messageBody = (taskId: string, epoch = 0) => ({ messageId: `msg_${ulid()}`, epoch, kind: "instruction", body: "please hurry", author: { kind: "human" }, createdAt: new Date().toISOString() });

	it("answers 503 handoff_in_progress + Retry-After while frozen, serves GET, and recovers after unfreeze", async () => {
		await grant(env.x, yId(), ["agents.read", "events.read", "tasks.send", "tasks.receive", "tasks.cancel"]);
		const task = seed(env.x, { peerId: yId() });
		fence().freeze(task.id, "hnd_wire");

		const message = await signedRequest(env.y, env.x.netUrl, { method: "POST", path: `/tasks/${task.id}/messages`, body: messageBody(task.id) });
		expect(message.status).toBe(503);
		expect(message.body).toEqual(ERROR("handoff_in_progress"));
		expect(message.headers.get("retry-after")).toBe("2");
		const cancel = await signedRequest(env.y, env.x.netUrl, { method: "POST", path: `/tasks/${task.id}/cancel`, body: { epoch: 0 } });
		expect(cancel.status).toBe(503);
		expect(cancel.body).toEqual(ERROR("handoff_in_progress"));
		expect(cancel.headers.get("retry-after")).toBe("2");
		expect(tasksX().messages(task.id)).toHaveLength(0);
		expect(row(task.id).status).toBe("running");

		const get = await signedRequest(env.y, env.x.netUrl, { path: `/tasks/${task.id}?since=0` });
		expect(get.status).toBe(200);
		expect(get.body).toMatchObject({ taskId: task.id, status: "running" });

		fence().unfreeze(task.id, "hnd_wire");
		const accepted = await signedRequest(env.y, env.x.netUrl, { method: "POST", path: `/tasks/${task.id}/messages`, body: messageBody(task.id) });
		expect(accepted.status).toBe(202);
	});

	it("answers 503 handed_off + Retry-After for a fenced or handed-off task and still serves its record and timeline", async () => {
		await grant(env.x, yId(), ["agents.read", "events.read", "tasks.send", "tasks.receive", "tasks.cancel"]);
		const task = seed(env.x, { peerId: yId(), status: "handed_off", epoch: 1, highestSeenEpoch: 2, fenced: true, lastEventSeq: 2 });
		tasksX().update(task.id, { lastEventSeq: 0 });
		tasksX().appendEvent(task.id, { type: "note", summary: "sealed" });
		tasksX().appendEvent(task.id, { type: "status", summary: "Handed over", payload: { from: "running", to: "running" } });

		const message = await signedRequest(env.y, env.x.netUrl, { method: "POST", path: `/tasks/${task.id}/messages`, body: messageBody(task.id, 1) });
		expect(message.status).toBe(503);
		expect(message.body.error).toMatchObject({ code: "handed_off", details: { currentEpoch: 2 } });
		expect(message.headers.get("retry-after")).toBe("2");
		const cancel = await signedRequest(env.y, env.x.netUrl, { method: "POST", path: `/tasks/${task.id}/cancel`, body: { epoch: 1 } });
		expect(cancel.status).toBe(503);
		expect(cancel.body).toEqual(ERROR("handed_off"));
		expect(cancel.headers.get("retry-after")).toBe("2");

		const get = await signedRequest(env.y, env.x.netUrl, { path: `/tasks/${task.id}?since=0` });
		expect(get.status).toBe(200);
		expect(get.body).toMatchObject({ taskId: task.id, status: "handed_off", epoch: 1 });
		expect(get.body.events).toHaveLength(2);
	});
});

describe("applyRecord and handed_off records", () => {
	function record(taskId: string, over: Partial<wire.TaskRecord>): wire.TaskRecord {
		const now = new Date().toISOString();
		return { taskId, status: "running", epoch: 0, agentId: null, agentName: null, reason: null, createdAt: now, updatedAt: now, startedAt: null, finishedAt: null, result: null, cost: null, lastEventSeq: 0, ...over };
	}
	const event = (seq: number, type: string, summary: string): wire.TaskEventWire => ({ seq, type, at: new Date().toISOString(), summary });

	it("mirrors the timeline of a handed_off record but adopts no status, epoch, result or end time; late results are never mirrored", () => {
		const task = seed(env.y, { peerId: xId(), direction: "outgoing", epoch: 0, lastEventSeq: 2 });
		const applied = applyRecord(env.y.ctx.tasks, task.id, record(task.id, { status: "handed_off", epoch: 0, lastEventSeq: 3, finishedAt: new Date().toISOString(), result: { summary: "x", autoCompleted: false, branch: null, commit: null, pushed: false, compareUrl: null, artifacts: [], files: null } }), [
			event(3, "note", "Handing over to node c"),
			event(4, "late_result", "Late result"),
		]);
		expect(applied).toMatchObject({ changed: true, settled: true });
		const after = env.y.ctx.tasks.store.get(task.id);
		expect(after).toMatchObject({ status: "running", epoch: 0, result: null, finishedAt: null, lastEventSeq: 3, peerId: xId() });
		expect(env.y.ctx.tasks.store.eventsSince(task.id, 0).map((e) => e.type)).toEqual(["note"]);

		// The same record again changes nothing; a normal record is still applied.
		expect(applyRecord(env.y.ctx.tasks, task.id, record(task.id, { status: "handed_off", lastEventSeq: 3 }), [event(3, "note", "Handing over to node c")])).toMatchObject({ changed: false });
		applyRecord(env.y.ctx.tasks, task.id, record(task.id, { status: "succeeded", lastEventSeq: 3, finishedAt: new Date().toISOString() }));
		expect(env.y.ctx.tasks.store.get(task.id).status).toBe("succeeded");
	});
});

describe("POST /tasks/:id/executor", () => {
	interface Follow {
		c: FullHarness;
		cId: string;
		task: TaskRow;
		/** A fencing token as node `c` signs it at step 8. */
		token(over?: { epoch?: number; handoffId?: string; manifestSha256?: string; sign?: FullHarness }): string;
		body(over?: Partial<wire.TaskExecutorChange>): wire.TaskExecutorChange;
	}

	/** `y` delegated a task to `x`; `c` (paired with `y`, holding `tasks.receive` from it) took it over. */
	async function setupFollow(): Promise<Follow> {
		const c = await node("exec-c");
		await pair(env.y, c, { workspaceName: "Other" });
		const task = seed(env.y, { peerId: xId(), direction: "outgoing", epoch: 0, lastEventSeq: 3, executorAgentId: "agt_old", executorSessionId: "ses_old" });
		const cId = c.ctx.identity.nodeId;
		const token = (over: { epoch?: number; handoffId?: string; manifestSha256?: string; sign?: FullHarness } = {}) =>
			makeFencingToken({ taskId: task.id, epoch: over.epoch ?? 1, handoffId: over.handoffId ?? "hnd_follow", manifestSha256: over.manifestSha256 ?? SHA, sign: (over.sign ?? c).ctx.identity.sign });
		const body = (over: Partial<wire.TaskExecutorChange> = {}): wire.TaskExecutorChange => ({
			epoch: 1,
			handoffId: "hnd_follow",
			manifestSha256: SHA,
			fencingToken: token({ epoch: over.epoch ?? 1 }),
			fromNodeId: xId(),
			agentId: "agt_new",
			agentName: "New agent",
			sessionId: "ses_new",
			eventSeqBase: 5,
			at: new Date().toISOString(),
			...over,
		});
		return { c, cId, task, token, body };
	}
	const post = (f: Follow, body: unknown, key?: string, taskId?: string) => signedRequest(f.c, env.y.netUrl, { method: "POST", path: `/tasks/${taskId ?? f.task.id}/executor`, body, ...(key ? { idempotencyKey: key } : {}) });
	const sender = (f: Follow) => env.y.ctx.tasks.store.get(f.task.id);

	it("follows the new executor: peer, executor columns, epoch, event base; replays are idempotent; no event is appended", async () => {
		const f = await setupFollow();
		const eventsBefore = env.y.ctx.tasks.store.eventsSince(f.task.id, 0).length;
		const key = `follow-${ulid()}`;
		const change = f.body();
		const res = await post(f, change, key);
		expect(res.status, res.text).toBe(200);
		expect(wire.TaskRecord.parse(res.body)).toMatchObject({ taskId: f.task.id, epoch: 1, lastEventSeq: 5 });
		expect(sender(f)).toMatchObject({
			direction: "outgoing",
			peerId: f.cId,
			executorNodeId: f.cId,
			executorNodeName: "exec-c",
			executorAgentId: "agt_new",
			executorAgentName: "New agent",
			executorSessionId: "ses_new",
			epoch: 1,
			highestSeenEpoch: 1,
			lastEventSeq: 5,
			status: "running",
		});
		expect(env.y.ctx.tasks.store.eventsSince(f.task.id, 0)).toHaveLength(eventsBefore);

		const replay = await post(f, change, key);
		expect(replay.status).toBe(200);
		expect(replay.headers.get("idempotent-replay")).toBe("true");
		// A resent notice under another key is a natural replay: same answer, nothing moves.
		const natural = await post(f, change, `follow-${ulid()}`);
		expect(natural.status).toBe(200);
		expect(sender(f)).toMatchObject({ peerId: f.cId, epoch: 1, lastEventSeq: 5 });
	});

	it("keeps a larger local event cursor (the new executor's timeline starts at the seal we already mirrored)", async () => {
		const f = await setupFollow();
		env.y.ctx.tasks.store.update(f.task.id, { lastEventSeq: 9 });
		const res = await post(f, f.body({ eventSeqBase: 5 }));
		expect(res.status).toBe(200);
		expect(sender(f).lastEventSeq).toBe(9);
	});

	it("retargets still-pending outbox items of the task to the new peer at the new epoch, keeping keys; settled ones stay", async () => {
		const f = await setupFollow();
		const store = env.y.ctx.tasks.store;
		const xPeer = xId();
		const msg = store.enqueue({ peerId: xPeer, taskId: f.task.id, kind: "task.message", refId: "msg_pending", path: `/tasks/${f.task.id}/messages`, body: { messageId: "msg_pending", epoch: 0, kind: "note", body: "hi" }, nextAttemptAt: new Date(Date.now() + 3_600_000).toISOString() });
		const cancel = store.enqueue({ peerId: xPeer, taskId: f.task.id, kind: "task.cancel", path: `/tasks/${f.task.id}/cancel`, body: { epoch: 0, reason: "stop" }, idempotencyKey: `task.cancel:${f.task.id}`, nextAttemptAt: new Date(Date.now() + 3_600_000).toISOString() });
		const sent = store.enqueue({ peerId: xPeer, taskId: f.task.id, kind: "task.message", refId: "msg_sent", path: `/tasks/${f.task.id}/messages`, body: { messageId: "msg_sent", epoch: 0, kind: "note", body: "old" } });
		store.updateOutbox(sent.id, { state: "sent" });

		expect((await post(f, f.body())).status).toBe(200);

		const after = (id: string) => store.outboxRow(id);
		expect(after(msg.id)).toMatchObject({ peerId: f.cId, idempotencyKey: msg.idempotencyKey, body: { messageId: "msg_pending", epoch: 1, kind: "note", body: "hi" } });
		expect(after(cancel.id)).toMatchObject({ peerId: f.cId, idempotencyKey: `task.cancel:${f.task.id}`, body: { epoch: 1, reason: "stop" } });
		expect(after(sent.id)).toMatchObject({ peerId: xPeer, state: "sent", body: { epoch: 0 } });
	});

	it("rejects a token that does not verify with the caller's key, or that is bound to another manifest, handoff, epoch or task", async () => {
		const f = await setupFollow();
		const other = await node("exec-other");
		const cases: [string, wire.TaskExecutorChange][] = [
			["signed by another node", f.body({ fencingToken: f.token({ sign: other }) })],
			["another manifest hash", f.body({ fencingToken: f.token({ manifestSha256: "b".repeat(64) }) })],
			["another handoff", f.body({ fencingToken: f.token({ handoffId: "hnd_other" }) })],
			["another epoch", f.body({ fencingToken: f.token({ epoch: 2 }) })],
			["malformed", f.body({ fencingToken: "garbage" })],
		];
		for (const [what, body] of cases) {
			const res = await post(f, body);
			expect(res.status, what).toBe(403);
			expect(res.body, what).toEqual(ERROR("invalid_fencing_token"));
		}
		const otherTask = seed(env.y, { peerId: xId(), direction: "outgoing", epoch: 0 });
		const wrongTask = await post(f, f.body(), undefined, otherTask.id); // token names the first task
		expect(wrongTask.status).toBe(403);
		expect(sender(f)).toMatchObject({ peerId: xId(), epoch: 0 });
	});

	it("enforces the epoch rules: stale or equal epochs, and a notice from a node that is not the executor", async () => {
		const f = await setupFollow();
		env.y.ctx.tasks.store.update(f.task.id, { epoch: 1 });
		const stale = await post(f, f.body({ epoch: 1 }));
		expect(stale.status).toBe(409);
		expect(stale.body.error).toMatchObject({ code: "stale_epoch", details: { currentEpoch: 1 } });
		env.y.ctx.tasks.store.update(f.task.id, { epoch: 0 });

		const wrongFrom = await post(f, f.body({ fromNodeId: f.cId }));
		expect(wrongFrom.status).toBe(409);
		expect(wrongFrom.body).toEqual(ERROR("executor_mismatch"));

		// Hops we never heard of (epoch jumps by more than one): the from-node cannot be checked.
		const missed = await post(f, f.body({ epoch: 3, fromNodeId: f.cId, fencingToken: f.token({ epoch: 3 }) }));
		expect(missed.status, missed.text).toBe(200);
		expect(sender(f)).toMatchObject({ peerId: f.cId, epoch: 3 });

		const backwards = await post(f, f.body({ epoch: 2, fencingToken: f.token({ epoch: 2 }) }));
		expect(backwards.status).toBe(409);
		expect(backwards.body.error).toMatchObject({ code: "stale_epoch", details: { currentEpoch: 3 } });
	});

	it("is only for outgoing tasks of this node and needs tasks.receive from the caller", async () => {
		const f = await setupFollow();
		const incoming = seed(env.y, { peerId: xId() });
		const notOurs = await post(f, f.body(), undefined, incoming.id);
		expect(notOurs.status).toBe(404);
		expect((await post(f, f.body(), undefined, "tsk_unknown")).status).toBe(404);

		await grant(env.y, f.cId, ["agents.read", "events.read"]);
		const denied = await post(f, f.body());
		expect(denied.status).toBe(403);
		expect(denied.body.error).toMatchObject({ code: "forbidden", details: { missing: ["tasks.receive"] } });
		expect(sender(f).peerId).toBe(xId());
	});
});
