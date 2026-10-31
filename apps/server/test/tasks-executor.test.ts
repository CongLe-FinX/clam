import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ulid, type wire } from "@clam/agent-network";
import type { Project, TaskStatus } from "@clam/contracts";
import { agentSessions, peers, projects } from "@clam/database";
import { eq } from "drizzle-orm";
import type { SecretStore } from "@clam/secret-store";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { writeNodeSettings } from "../src/services/settings.ts";
import { execState } from "../src/tasks/exec-state.ts";
import { newMessageId, newTaskId, type TaskRow } from "../src/tasks/store.ts";
import { api, createMemorySecrets, type FullHarness } from "./full-harness.ts";
import { eventually, pair, startNode } from "./net-helpers.ts";

const OLD_ENV = { ...process.env };
let globalConfigDir: string;

beforeAll(() => {
	// Isolate from the developer's git configuration (identity, hooks, credential helpers, signing).
	globalConfigDir = mkdtempSync(path.join(tmpdir(), "clam-gitcfg-"));
	const file = path.join(globalConfigDir, "gitconfig");
	writeFileSync(file, "[init]\n\tdefaultBranch = main\n");
	process.env.GIT_CONFIG_GLOBAL = file;
	process.env.GIT_CONFIG_NOSYSTEM = "1";
});
afterAll(() => {
	process.env = OLD_ENV;
	rmSync(globalConfigDir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function identify(dir: string): void {
	git(dir, "config", "user.name", "Local Dev");
	git(dir, "config", "user.email", "dev@example.com");
}

interface Fixture {
	root: string;
	origin: string;
	work: string;
	other: string;
}

/** A bare "remote" plus two working clones, each a candidate project for the same repository. */
function makeFixture(): Fixture {
	const root = realpathSync(mkdtempSync(path.join(tmpdir(), "clam-exec-")));
	const origin = path.join(root, "origin.git");
	git(root, "init", "--bare", "-b", "main", origin);
	const seed = path.join(root, "seed");
	git(root, "clone", origin, seed);
	identify(seed);
	writeFileSync(path.join(seed, "a.txt"), "one\n");
	git(seed, "add", ".");
	git(seed, "commit", "-m", "seed");
	git(seed, "push", "origin", "main");
	const work = path.join(root, "work");
	const other = path.join(root, "other");
	git(root, "clone", origin, work);
	git(root, "clone", origin, other);
	identify(work);
	identify(other);
	return { root, origin, work, other };
}

const REPO = { owner: "acme", name: "widgets", externalId: null, htmlUrl: "https://github.com/acme/widgets", defaultBranch: "main", accountId: null };
const REPO_URL = "https://github.com/acme/widgets";
const DONE = '@@fake-tool mesh_complete {"taskId":"{{taskId}}","outcome":"succeeded","summary":"all done"}';

/** Node `a` delegates (only its identity is used), node `b` executes. */
interface Env {
	a: FullHarness;
	b: FullHarness;
	secretsB: SecretStore;
	workspaceId: string;
	fx: Fixture;
	project: Project;
}

const nodes: FullHarness[] = [];
let fixtures: Fixture[] = [];
let env: Env;

async function linkedProject(b: FullHarness, workspaceId: string, name: string, dir: string, linked = true): Promise<Project> {
	const created = await api(b).post<Project>("/projects", { workspaceId, name, path: dir });
	expect(created.status, JSON.stringify(created.body)).toBe(201);
	if (linked) b.ctx.db.update(projects).set({ repository: REPO }).where(eq(projects.id, created.body.id)).run();
	return created.body;
}

beforeEach(async () => {
	const secretsB = createMemorySecrets();
	const a = await startNode("alpha");
	const b = await startNode("bravo", { secrets: secretsB });
	nodes.push(a, b);
	const { workspace } = await pair(a, b);
	const fx = makeFixture();
	fixtures.push(fx);
	const project = await linkedProject(b, workspace.id, "work", fx.work);
	env = { a, b, secretsB, workspaceId: workspace.id, fx, project };
});

afterEach(async () => {
	for (const node of nodes.splice(0)) await node.cleanup();
	for (const fx of fixtures.splice(0)) rmSync(fx.root, { recursive: true, force: true });
});

const executor = () => env.b.ctx.tasks.executor;
const store = () => env.b.ctx.tasks.store;
const peerId = () => env.a.ctx.identity.nodeId;

function request(over: Partial<wire.CreateTaskRequest> = {}): wire.CreateTaskRequest {
	return {
		taskId: newTaskId(),
		workspaceId: env.workspaceId,
		projectRef: { repoUrl: REPO_URL },
		title: "Add the thing",
		description: "Please add the thing.",
		deliverAs: "summary",
		constraints: {},
		epoch: 0,
		correlationId: ulid(),
		sender: { agentId: "agt_alice", agentName: "Alice" },
		...over,
	};
}

const row = (id: string): TaskRow => store().get(id);

async function waitFor(id: string, status: TaskStatus, timeoutMs = 20_000): Promise<TaskRow> {
	return eventually(() => (row(id).status === status ? row(id) : undefined), `task ${id} to be ${status} (is ${row(id).status})`, timeoutMs);
}

interface FakeRecord {
	kind: string;
	args?: { approvalMode?: string; maxCost?: string };
	frame?: { type: string; message?: string };
}

function fakeRecords(node: FullHarness): FakeRecord[] {
	if (!existsSync(node.fakeLog)) return [];
	return readFileSync(node.fakeLog, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as FakeRecord);
}

const prompts = (node: FullHarness): string[] => fakeRecords(node).flatMap((r) => (r.kind === "command" && r.frame?.type === "prompt" && r.frame.message ? [r.frame.message] : []));
const spawns = (node: FullHarness) => fakeRecords(node).filter((r) => r.kind === "spawn");

describe("receiving tasks", () => {
	it("stores a delegated task as offered, replays are idempotent, bad input is refused", async () => {
		const req = request();
		const first = await executor().receive(peerId(), req);
		expect(first.created).toBe(true);
		expect(first.row).toMatchObject({
			id: req.taskId,
			direction: "incoming",
			status: "offered",
			peerId: peerId(),
			senderNodeName: "alpha",
			senderAgentName: "Alice",
			executorNodeName: "bravo",
			epoch: 0,
			repoUrl: REPO_URL,
		});
		expect(store().eventsSince(req.taskId, 0).map((e) => [e.seq, e.type])).toEqual([[1, "status"]]);

		const again = await executor().receive(peerId(), req);
		expect(again.created).toBe(false);
		expect(again.row.id).toBe(req.taskId);
		expect(store().list({ direction: "incoming" })).toHaveLength(1);

		await expect(executor().receive(peerId(), request({ workspaceId: "ws_unknown" }))).rejects.toMatchObject({ status: 403, code: "forbidden" });
		await expect(executor().receive(peerId(), request({ projectRef: { repoUrl: "https://example.com/x/y" } }))).rejects.toMatchObject({ status: 400 });
		await expect(executor().receive(peerId(), request({ targetAgentId: "agt_nope" }))).rejects.toMatchObject({ status: 400, code: "unknown_agent" });
		await expect(executor().receive("node_stranger", request())).rejects.toMatchObject({ status: 403, code: "forbidden" });
	});

	it("refuses a task id that belongs to another peer's or an outgoing task", async () => {
		const req = request();
		store().insert({
			id: req.taskId,
			direction: "outgoing",
			peerId: peerId(),
			workspaceId: env.workspaceId,
			title: "mine",
			repoUrl: REPO_URL,
			senderNodeId: env.b.ctx.identity.nodeId,
			senderNodeName: "bravo",
			executorNodeId: peerId(),
			executorNodeName: "alpha",
			correlationId: ulid(),
		});
		await expect(executor().receive(peerId(), req)).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
	});

	it("auto-accepts only with the peer policy AND exactly one matching project", async () => {
		// Policy off: stays offered.
		const off = await executor().receive(peerId(), request());
		expect(off.row.status).toBe("offered");

		env.b.ctx.db.update(peers).set({ autoAcceptTasks: true }).where(eq(peers.id, peerId())).run();

		// A different repository matches no project.
		const none = await executor().receive(peerId(), request({ projectRef: { repoUrl: "https://github.com/acme/other" } }));
		expect(none.row.status).toBe("offered");

		// Two projects for the repository: ambiguous, a human decides.
		await linkedProject(env.b, env.workspaceId, "second", env.fx.other);
		const two = await executor().receive(peerId(), request());
		expect(two.row.status).toBe("offered");
		env.b.ctx.db.delete(projects).where(eq(projects.path, env.fx.other)).run();

		// Exactly one match: accepted and run straight away.
		const one = await executor().receive(peerId(), request({ description: DONE }));
		expect(one.row.status).not.toBe("offered");
		expect(one.row.projectId).toBe(env.project.id);
		const done = await waitFor(one.row.id, "succeeded");
		expect(done.result).toMatchObject({ summary: "all done", autoCompleted: false });
	});
});

describe("deciding", () => {
	it("accepts with an explicit project, validates the choice, rejects, and refuses wrong states", async () => {
		const second = await linkedProject(env.b, env.workspaceId, "second", env.fx.other);
		const unlinked = await linkedProject(env.b, env.workspaceId, "unlinked", mkdtempSync(path.join(env.fx.root, "plain-")), false);

		const ambiguous = (await executor().receive(peerId(), request({ description: DONE }))).row;
		await expect(executor().decide(ambiguous.id, { decision: "accept" })).rejects.toMatchObject({ status: 409, code: "project_required" });
		await expect(executor().decide(ambiguous.id, { decision: "accept", projectId: unlinked.id })).rejects.toMatchObject({ status: 409, code: "project_mismatch" });
		await expect(executor().decide(ambiguous.id, { decision: "accept", projectId: "prj_nope" })).rejects.toMatchObject({ status: 404 });
		expect(row(ambiguous.id).status).toBe("offered");

		const accepted = await executor().decide(ambiguous.id, { decision: "accept", projectId: second.id });
		expect(accepted.projectId).toBe(second.id);
		expect(accepted.executorAgentName).toBeTruthy();
		await expect(executor().decide(ambiguous.id, { decision: "accept", projectId: second.id })).rejects.toMatchObject({ status: 409 });
		await expect(executor().decide(ambiguous.id, { decision: "reject", reason: "late" })).rejects.toMatchObject({ status: 409 });
		await waitFor(ambiguous.id, "succeeded");

		const rejected = (await executor().receive(peerId(), request())).row;
		const after = await executor().decide(rejected.id, { decision: "reject", reason: "not now" });
		expect(after).toMatchObject({ status: "rejected", reason: "not now" });
		expect(row(rejected.id).finishedAt).not.toBeNull();
	});
});

describe("running tasks", () => {
	it("runs one task per project at a time; the next waits as accepted", async () => {
		const first = (await executor().receive(peerId(), request({ title: "first", description: `@@fake-sh sleep 2\n${DONE}` }))).row;
		const second = (await executor().receive(peerId(), request({ title: "second", description: DONE }))).row;
		await executor().decide(first.id, { decision: "accept" });
		await waitFor(first.id, "running");
		await executor().decide(second.id, { decision: "accept" });
		expect(row(second.id).status).toBe("accepted");

		const firstDone = await waitFor(first.id, "succeeded");
		const secondDone = await waitFor(second.id, "succeeded");
		expect(String(secondDone.startedAt) >= String(firstDone.finishedAt)).toBe(true);
	});

	it("briefs the agent, applies the stricter approval mode and --max-cost, and finalises mesh_complete when the session settles", async () => {
		const req = request({ title: "Brief me", description: `Details here.\n${DONE}`, constraints: { maxCostUsd: 1.5, approvalMode: "always-ask" } });
		const task = (await executor().receive(peerId(), req)).row;
		await executor().decide(task.id, { decision: "accept" });
		const done = await waitFor(task.id, "succeeded");

		expect(done.result).toMatchObject({ summary: "all done", autoCompleted: false, branch: null, pushed: false });
		expect(done.reason).toBeNull();
		expect(done.executorSessionId).toBeTruthy();
		expect(done.cost).not.toBeNull();
		const brief = prompts(env.b)[0] ?? "";
		expect(brief).toContain(task.id);
		expect(brief).toContain("Details here.");
		expect(brief).toContain("Alice@alpha");
		expect(spawns(env.b)).toHaveLength(1);
		expect(spawns(env.b)[0]?.args).toMatchObject({ approvalMode: "always-ask", maxCost: "1.5" });
		const events = store().eventsSince(task.id, 0);
		expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
		expect(events.map((e) => e.type)).toContain("result");
		// One reminder-free run: only the brief was sent, and the runtime slot was released.
		expect(prompts(env.b)).toHaveLength(1);
		await eventually(() => env.b.ctx.runtime.get(done.executorSessionId as string) === undefined, "the runtime to be stopped");
		expect(execState(row(task.id)).holdsTree).toBe(false);
	});

	it("never lets a task loosen the node's approval mode", async () => {
		writeNodeSettings(env.b.ctx.db, { approvalMode: "write" });
		const task = (await executor().receive(peerId(), request({ description: DONE, constraints: { approvalMode: "yolo" } }))).row;
		await executor().decide(task.id, { decision: "accept" });
		await waitFor(task.id, "succeeded");
		expect(spawns(env.b)[0]?.args?.approvalMode).toBe("write");
		expect(spawns(env.b)[0]?.args?.maxCost).toBeUndefined();
	});

	it("sends ONE reminder when the agent never calls mesh_complete, then completes from the last answer", async () => {
		const task = (await executor().receive(peerId(), request({ description: "No tools, just thinking." }))).row;
		await executor().decide(task.id, { decision: "accept" });
		const done = await waitFor(task.id, "succeeded");

		const sent = prompts(env.b);
		expect(sent).toHaveLength(2);
		expect(sent[1]).toContain("is not completed");
		expect(sent[1]).toContain(task.id);
		expect(done.result?.autoCompleted).toBe(true);
		expect(done.result?.summary).toContain("is not completed");
	});

	it("blocks on an unanswered question and an answer from the sender resumes the run", async () => {
		const description = `@@fake-tool mesh_message {"taskId":"{{taskId}}","kind":"question","text":"which database?"}`;
		const task = (await executor().receive(peerId(), request({ description }))).row;
		await executor().decide(task.id, { decision: "accept" });
		const blocked = await waitFor(task.id, "blocked");
		expect(blocked.reason).toBe("Waiting for an answer from alpha");
		expect(execState(blocked)).toMatchObject({ blockedFor: "question", holdsTree: true });
		expect(store().messages(task.id).map((m) => [m.kind, m.authorNodeId])).toEqual([["question", env.b.ctx.identity.nodeId]]);

		const accepted = await env.b.ctx.tasks.receiveMessage(peerId(), task.id, {
			messageId: newMessageId(),
			epoch: 0,
			kind: "answer",
			body: 'Use sqlite.\n@@fake-tool mesh_complete {"outcome":"succeeded","summary":"used sqlite"}',
			author: { kind: "human", agentId: null, agentName: null },
			createdAt: new Date().toISOString(),
		});
		expect(accepted.accepted).toBe(true);
		const done = await waitFor(task.id, "succeeded");
		expect(done.result).toMatchObject({ summary: "used sqlite", autoCompleted: false });
		expect(store().eventsSince(task.id, 0).some((e) => e.type === "status" && e.summary.includes("blocked → running"))).toBe(true);
	});

	it("a failed outcome fails the task and a blocked outcome keeps the tree until a message arrives", async () => {
		const failing = (await executor().receive(peerId(), request({ description: '@@fake-tool mesh_complete {"outcome":"failed","summary":"cannot build"}' }))).row;
		await executor().decide(failing.id, { decision: "accept" });
		const failed = await waitFor(failing.id, "failed");
		expect(failed.reason).toBe("cannot build");
		expect(failed.result).toMatchObject({ summary: "cannot build", pushed: false });

		const stuck = (await executor().receive(peerId(), request({ description: '@@fake-tool mesh_complete {"outcome":"blocked","summary":"need credentials"}' }))).row;
		await executor().decide(stuck.id, { decision: "accept" });
		const blocked = await waitFor(stuck.id, "blocked");
		expect(blocked.reason).toBe("need credentials");
		expect(execState(blocked)).toMatchObject({ blockedFor: "agent", holdsTree: true });
		expect(execState(blocked).completion).toBeUndefined();
	});

	it("rejects mesh_complete from a session that does not execute a task, for another task or a finished one", async () => {
		await expect(executor().complete("ses_unknown", { outcome: "succeeded", summary: "x" })).rejects.toMatchObject({ status: 409 });
		const task = (await executor().receive(peerId(), request({ description: DONE }))).row;
		await executor().decide(task.id, { decision: "accept" });
		const done = await waitFor(task.id, "succeeded");
		const sessionId = done.executorSessionId as string;
		await expect(executor().complete(sessionId, { taskId: "tsk_other", outcome: "succeeded", summary: "x" })).rejects.toMatchObject({ status: 409, code: "wrong_task" });
		await expect(executor().complete(sessionId, { outcome: "succeeded", summary: "x" })).rejects.toMatchObject({ status: 409, code: "task_not_active" });
	});
});

describe("deliverAs branch", () => {
	it("blocks on tracked uncommitted changes and runs after the human cleans the tree and accepts again", async () => {
		writeFileSync(path.join(env.fx.work, "a.txt"), "dirty\n");
		const description = `@@fake-sh echo hello > new.txt\n${DONE}`;
		const task = (await executor().receive(peerId(), request({ deliverAs: "branch", description }))).row;
		await executor().decide(task.id, { decision: "accept" });
		const blocked = await waitFor(task.id, "blocked");
		expect(blocked.reason).toContain("uncommitted changes");
		expect(execState(blocked)).toMatchObject({ blockedFor: "tree", holdsTree: false });
		expect(blocked.executorSessionId).toBeNull();
		expect(git(env.fx.work, "branch", "--show-current").trim()).toBe("main");

		// A message does not unblock a tree problem.
		await executor().messageInjected(blocked, store().insertMessage({ id: newMessageId(), taskId: task.id, authorKind: "human", authorNodeId: peerId(), authorNodeName: "alpha", kind: "note", text: "hi", createdAt: new Date().toISOString(), delivery: "local" }).row);
		expect(row(task.id).status).toBe("blocked");

		git(env.fx.work, "checkout", "--", "a.txt");
		const resumed = await executor().decide(task.id, { decision: "accept" });
		expect(resumed.status === "accepted" || resumed.status === "running").toBe(true);
		const done = await waitFor(task.id, "succeeded");
		expect(done.result?.branch).toMatch(/^clam\/bravo\//);
		expect(done.result?.commit).toBeTruthy();
		expect(done.result?.pushed).toBe(true);
		expect(git(env.fx.origin, "branch", "--list", done.result?.branch as string)).toContain(done.result?.branch as string);
		expect(git(env.fx.work, "branch", "--show-current").trim()).toBe("main");
		expect(prompts(env.b)[0]).toContain(done.result?.branch as string);
	});

	it("cancels a running task: aborts the session and records the branch it leaves behind, losing nothing", async () => {
		const description = `@@fake-sh echo partial > partial.txt\n@@fake-sh sleep 20\n${DONE}`;
		const task = (await executor().receive(peerId(), request({ deliverAs: "branch", description }))).row;
		await executor().decide(task.id, { decision: "accept" });
		await eventually(() => existsSync(path.join(env.fx.work, "partial.txt")), "the agent to write its file");
		const sessionId = row(task.id).executorSessionId as string;

		const cancelled = await executor().cancel(task.id, { reason: "changed my mind", by: "local" });
		expect(cancelled.status).toBe("cancelled");
		expect(cancelled.reason).toContain("changed my mind");
		expect(cancelled.reason).toContain("clam/bravo/");
		expect(existsSync(path.join(env.fx.work, "partial.txt"))).toBe(true);
		expect(git(env.fx.work, "branch", "--show-current").trim()).toMatch(/^clam\/bravo\//);
		expect(execState(cancelled).holdsTree).toBe(false);
		await eventually(() => env.b.ctx.runtime.get(sessionId) === undefined, "the runtime to be stopped");

		// Idempotent, and the finished task is left alone.
		expect((await executor().cancel(task.id, { reason: null, by: "sender" })).reason).toBe(cancelled.reason);
	});
});

describe("cancelling and restarting", () => {
	it("cancels offered and accepted tasks directly and frees the queue for the next one", async () => {
		const running = (await executor().receive(peerId(), request({ description: "@@fake-sh sleep 20" }))).row;
		const queued = (await executor().receive(peerId(), request({ description: DONE }))).row;
		const offered = (await executor().receive(peerId(), request())).row;
		await executor().decide(running.id, { decision: "accept" });
		await waitFor(running.id, "running");
		await executor().decide(queued.id, { decision: "accept" });
		expect(row(queued.id).status).toBe("accepted");

		expect((await executor().cancel(offered.id, { reason: null, by: "sender" })).status).toBe("cancelled");
		expect(row(offered.id).reason).toContain("alpha");

		await executor().cancel(running.id, { reason: "stop", by: "local" });
		expect(row(running.id).status).toBe("cancelled");
		// The tree is free again: the queued task starts and finishes.
		await waitFor(queued.id, "succeeded");
	});

	it("resumes a running task after the node restarted: the session gets the resume prompt and the limits apply again", async () => {
		const description = "@@fake-sh sleep 20";
		const task = (await executor().receive(peerId(), request({ description, constraints: { maxCostUsd: 2, approvalMode: "always-ask" } }))).row;
		await executor().decide(task.id, { decision: "accept" });
		await eventually(() => prompts(env.b).length === 1 && row(task.id).executorSessionId, "the agent to start");
		const sessionId = row(task.id).executorSessionId as string;
		const { dataDir, netPort } = env.b;

		await env.b.cleanup({ keepData: true });
		nodes.splice(nodes.indexOf(env.b), 1);
		const b = await startNode("bravo", { dataDir, port: netPort, secrets: env.secretsB });
		nodes.push(b);
		env.b = b;

		await eventually(() => prompts(b).some((p) => p.includes("The node restarted while you were working on task")), "the resume prompt");
		expect(prompts(b).filter((p) => p.includes("The node restarted"))[0]).toContain(task.id);
		expect(row(task.id).executorSessionId).toBe(sessionId);
		const reopened = spawns(b);
		expect(reopened).toHaveLength(2);
		expect(reopened[1]?.args).toMatchObject({ approvalMode: "always-ask", maxCost: "2" });

		// The resumed agent answers without mesh_complete: the reminder and the auto-completion follow as usual.
		const done = await waitFor(task.id, "succeeded");
		expect(done.result?.autoCompleted).toBe(true);
	});

	it("fails a running task whose session vanished while the node was down", async () => {
		const task = (await executor().receive(peerId(), request({ description: "@@fake-sh sleep 20" }))).row;
		await executor().decide(task.id, { decision: "accept" });
		const sessionId = await eventually(() => row(task.id).executorSessionId, "the session");
		env.b.ctx.db.delete(agentSessions).where(eq(agentSessions.id, sessionId)).run();
		const { dataDir, netPort } = env.b;
		await env.b.cleanup({ keepData: true });
		nodes.splice(nodes.indexOf(env.b), 1);
		const b = await startNode("bravo", { dataDir, port: netPort, secrets: env.secretsB });
		nodes.push(b);
		env.b = b;
		const failed = await waitFor(task.id, "failed");
		expect(failed.reason).toContain("no longer exists");
		expect(execState(failed).holdsTree).toBe(false);
	});
});
