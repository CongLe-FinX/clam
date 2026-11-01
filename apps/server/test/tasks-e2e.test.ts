import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentSession, MessagesPage, Task, TaskDetail } from "@clam/contracts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { api } from "./full-harness.ts";
import { expectEventsLocalised, expectReasonLocalised } from "./i18n-helpers.ts";
import { eventually, peerOf, signedRequest, startNode } from "./net-helpers.ts";
import {
	branchesOf,
	findTask,
	git,
	isolateGitConfig,
	promptsOf,
	readFileAtBranch,
	startTaskPair,
	statusSequence,
	waitForTask,
	type GitConfigIsolation,
	type TaskPair,
} from "./task-fixtures.ts";

/**
 * End-to-end delegation between two real in-process nodes (real server, real git against a local bare origin, fake omp
 * driven through `@@fake-*` directives in task descriptions and messages). Nothing in the task engine is replaced.
 */

let gitConfig: GitConfigIsolation;
beforeAll(() => {
	gitConfig = isolateGitConfig();
});
afterAll(() => gitConfig.restore());

let pair: TaskPair;
afterEach(async () => {
	await pair?.cleanup();
});

const tool = (name: string, args: unknown): string => `@@fake-tool ${name} ${JSON.stringify(args)}`;
const COMPLETE = '@@fake-tool mesh_complete {"taskId":"{{taskId}}","outcome":"succeeded","summary":"created TASK_SMOKE.md"}';
const smokeDescription = (extra: string[] = []): string => ["Create TASK_SMOKE.md with one line.", "@@fake-sh echo hello from B > TASK_SMOKE.md", ...extra, COMPLETE].join("\n");

async function delegate(title: string, description: string, over: Record<string, unknown> = {}): Promise<Task> {
	const res = await api(pair.a).post<Task>("/tasks", {
		targetNodeId: pair.b.ctx.identity.nodeId,
		projectId: pair.projectA.id,
		title,
		description,
		deliverAs: "branch",
		...over,
	});
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body;
}

describe("delegation from the UI route", () => {
	beforeEach(async () => {
		pair = await startTaskPair();
	});

	it("auto-accepts, runs, pushes a task branch and the sender's mirror shows the result", async () => {
		await pair.autoAcceptOnB(true);
		const mainBefore = git(pair.origin, "rev-parse", "main").trim();
		const created = await delegate("Smoke", smokeDescription());
		expect(created).toMatchObject({ direction: "outgoing", status: "offered", epoch: 0, deliverAs: "branch", repo: { url: "https://github.com/acme/demo" }, projectId: pair.projectA.id });
		expect(created.sender.nodeId).toBe(pair.a.ctx.identity.nodeId);
		expect(created.executor.nodeId).toBe(pair.b.ctx.identity.nodeId);

		const done = await waitForTask(pair.a, created.id, (t) => t.status === "succeeded", "A mirrors the task as succeeded");
		const result = done.task.result;
		expect(result).toMatchObject({ pushed: true, autoCompleted: false, summary: "created TASK_SMOKE.md" });
		expect(result?.branch).toMatch(/^clam\/node-b\/smoke-[a-z0-9]{6}$/);
		expect(result?.compareUrl).toBe(`https://github.com/acme/demo/compare/main...${result?.branch}`);
		expect(done.task.delivery.state).toBe("delivered");
		expect(done.task.executor.agentName).toBe("OMP Agent");
		expect(done.task.finishedAt).not.toBeNull();

		// the pushed branch carries the agent's file with the task trailers; main is untouched
		expect(branchesOf(pair.origin).sort()).toEqual(["main", result?.branch].sort());
		expect(git(pair.origin, "rev-parse", "main").trim()).toBe(mainBefore);
		expect(readFileAtBranch(pair.origin, result?.branch as string, "TASK_SMOKE.md")).toBe("hello from B\n");
		const message = git(pair.origin, "log", "-1", "--format=%B", result?.branch as string);
		expect(message).toContain("Smoke");
		expect(message).toContain(`Task: ${created.id}`);
		expect(message).toMatch(/Agent: OMP Agent@node-b/);

		// the timeline is the executor's: gap-free seqs from offered to succeeded
		expect(statusSequence(done.events)).toEqual(["offered", "accepted", "running", "succeeded"]);
		expect(done.events.map((e) => e.seq)).toEqual(done.events.map((_, i) => i + 1));
		// every line the executor generated (offered, session started, delivery, result, status changes) has a translatable twin that renders to it
		expectEventsLocalised(done.events);

		// B: the same task id, its executing session, and the working tree back on main and clean
		const onB = await api(pair.b).get<TaskDetail>(`/tasks/${created.id}`);
		expect(onB.body.task).toMatchObject({ direction: "incoming", status: "succeeded", projectId: pair.projectB.id });
		const sessionId = onB.body.task.executor.sessionId as string;
		expect(sessionId).toBeTruthy();
		const session = await api(pair.b).get<{ title: string }>(`/sessions/${sessionId}`);
		expect(session.body.title).toBe("Task: Smoke");
		expect(git(pair.workB, "branch", "--show-current").trim()).toBe("main");
		expect(git(pair.workB, "status", "--porcelain").trim()).toBe("");
		expect(git(pair.workB, "rev-parse", "--abbrev-ref", `${result?.branch}@{upstream}`).trim()).toBe(`origin/${result?.branch}`);
	});

	it("offered tasks wait for a human on B: accept with a project choice, then A sees it run", async () => {
		const created = await delegate("Manual", smokeDescription());
		const offered = await eventually(async () => findTask(pair.b, "Manual"), "task offered on B");
		expect(offered).toMatchObject({ status: "offered", direction: "incoming", projectId: null, id: created.id });
		expect((await api(pair.a).get<TaskDetail>(`/tasks/${created.id}`)).body.task.status).toBe("offered");

		const decided = await api(pair.b).post<Task>(`/tasks/${created.id}/decide`, { decision: "accept", projectId: pair.projectB.id });
		expect(decided.status, JSON.stringify(decided.body)).toBe(200);
		expect(decided.body.status === "accepted" || decided.body.status === "running").toBe(true);
		const done = await waitForTask(pair.a, created.id, (t) => t.status === "succeeded", "A sees succeeded after the manual accept");
		expect(done.task.result?.pushed).toBe(true);
		// a decided task cannot be decided again
		const again = await api(pair.b).post(`/tasks/${created.id}/decide`, { decision: "reject", reason: "too late" });
		expect(again.status).toBe(409);
	});

	it("a rejection reaches the sender with its reason", async () => {
		const created = await delegate("Nope", "Please do nothing.");
		await eventually(async () => findTask(pair.b, "Nope"), "task offered on B");
		const rejected = await api(pair.b).post<Task>(`/tasks/${created.id}/decide`, { decision: "reject", reason: "Not this week" });
		expect(rejected.status).toBe(200);
		expect(rejected.body).toMatchObject({ status: "rejected", reason: "Not this week" });
		const mirrored = await waitForTask(pair.a, created.id, (t) => t.status === "rejected", "A sees the rejection");
		expect(mirrored.task.reason).toBe("Not this week");
		// a person's own words are never twinned
		expect(mirrored.task.reasonI18n).toBeUndefined();
		expect(mirrored.task.finishedAt).not.toBeNull();
	});

	it("a dirty tracked file blocks the task with a clear reason; cleaning and re-accepting finishes it", async () => {
		await pair.autoAcceptOnB(true);
		writeFileSync(path.join(pair.workB, "README.md"), "# demo\nlocal edit\n");
		const created = await delegate("Dirty", smokeDescription());
		const blocked = await waitForTask(pair.a, created.id, (t) => t.status === "blocked", "A sees the task blocked");
		expect(blocked.task.reason).toMatch(/README\.md/);
		expect(blocked.task.reason).toMatch(/commit|stash|discard/i);

		git(pair.workB, "checkout", "--", "README.md");
		const again = await api(pair.b).post<Task>(`/tasks/${created.id}/decide`, { decision: "accept", projectId: pair.projectB.id });
		expect(again.status, JSON.stringify(again.body)).toBe(200);
		const done = await waitForTask(pair.a, created.id, (t) => t.status === "succeeded", "A sees succeeded after re-accept");
		expect(done.task.result?.pushed).toBe(true);
	});

	it("cancel from the sender aborts the executor and keeps its work", async () => {
		await pair.autoAcceptOnB(true);
		await pair.grantCancel();
		// the agent asks a question and then waits: the task is blocked, branch checked out, nothing completes by itself
		const question = '@@fake-tool mesh_message {"taskId":"{{taskId}}","kind":"question","text":"Which file name should I use?"}';
		const created = await delegate("Cancel me", ["Create a file.", "@@fake-sh echo partial > PARTIAL.md", question].join("\n"));
		const blockedA = await waitForTask(pair.a, created.id, (t) => t.status === "blocked", "task blocked waiting for an answer");
		const blockedB = await waitForTask(pair.b, created.id, (t) => t.status === "blocked", "task blocked on B");
		// the executor's own sentence replicates with its twin (wire `reasonI18n`) and the twin renders to the English reason on both nodes
		for (const { task } of [blockedA, blockedB]) {
			expect(task.reason).toMatch(/^Waiting for an answer from /);
			expect(task.reasonI18n, `no twin on ${task.direction}`).toEqual({ key: "Waiting for an answer from {node}", params: { node: "node-a" } });
			expectReasonLocalised(task);
		}

		const cancelled = await api(pair.a).post<Task>(`/tasks/${created.id}/cancel`, { reason: "changed my mind" });
		expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
		const mirrored = await waitForTask(pair.a, created.id, (t) => t.status === "cancelled", "A sees cancelled");
		expect(mirrored.task.reason).toContain("changed my mind");
		const onB = await waitForTask(pair.b, created.id, (t) => t.status === "cancelled", "B cancelled");
		// never destroys work: the task branch and the agent's file stay on B
		expect(onB.task.reason).toMatch(/branch|uncommitted/);
		expect(git(pair.workB, "branch", "--show-current").trim()).toMatch(/^clam\/node-b\/cancel-me-/);
		expect(git(pair.workB, "status", "--porcelain")).toContain("PARTIAL.md");
	});

	it("cancel without the tasks.cancel grant is refused up front", async () => {
		await pair.autoAcceptOnB(true);
		const question = '@@fake-tool mesh_message {"taskId":"{{taskId}}","kind":"question","text":"Wait for me?"}';
		const created = await delegate("No grant", ["Think.", question].join("\n"));
		await waitForTask(pair.a, created.id, (t) => t.status === "blocked", "blocked");
		const refused = await api(pair.a).post<{ error: { code: string } }>(`/tasks/${created.id}/cancel`, {});
		expect(refused.status).toBe(409);
		expect(refused.body.error.code).toBe("capability_missing");
	});
});

/** Prompt `session` of `node` with `message`, as a user would. */
async function promptSession(node: TaskPair["a"], sessionId: string, message: string, clientId: string): Promise<void> {
	const res = await api(node).post(`/sessions/${sessionId}/prompt`, { message, clientId });
	expect(res.status, JSON.stringify(res.body)).toBe(202);
}

/** Wait until the agent of the session finished its turn (a prompt sent mid-turn would be refused without a delivery mode). */
async function waitIdle(node: TaskPair["a"], sessionId: string): Promise<void> {
	await eventually(async () => (await api(node).get<AgentSession>(`/sessions/${sessionId}`)).body.status === "idle", "the session to be idle");
}

async function openSession(node: TaskPair["a"], projectId: string, title: string): Promise<AgentSession> {
	const res = await api(node).post<AgentSession>("/sessions", { projectId, title });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body;
}

/** All assistant/user text of a session, as the session API serves it. */
async function transcript(node: TaskPair["a"], sessionId: string): Promise<string> {
	const res = await api(node).get<MessagesPage>(`/sessions/${sessionId}/messages?limit=200`);
	return res.body.messages.flatMap((m) => m.content.flatMap((b) => (b.type === "text" ? [b.text] : []))).join("\n");
}

describe("agent discussion through both sessions", () => {
	beforeEach(async () => {
		pair = await startTaskPair();
		await pair.autoAcceptOnB(true);
	});

	it("B's agent asks one question, A's agent answers it, B completes and A's session is told", async () => {
		// Each agent is scripted through the directives embedded in the texts it receives (`{{taskId}}` = the first task id in that prompt).
		const finish = tool("mesh_complete", { taskId: "{{taskId}}", outcome: "succeeded", summary: "wrote NOTES.md" });
		const answer = tool("mesh_message", { taskId: "{{taskId}}", kind: "answer", text: ["Use NOTES.md.", finish].join("\n") });
		const question = tool("mesh_message", { taskId: "{{taskId}}", kind: "question", text: ["Which file name should I use?", answer].join("\n") });
		const delegateCall = tool("mesh_delegate", { node: "node-b", title: "Ask first", instructions: ["Write a note file after one clarifying question.", question].join("\n"), deliverAs: "summary" });

		const session = await openSession(pair.a, pair.projectA.id, "Delegator");
		await promptSession(pair.a, session.id, delegateCall, "c1");

		const task = await eventually(async () => findTask(pair.a, "Ask first"), "A's agent delegated the task");
		expect(task.sender.sessionId).toBe(session.id);
		expect(task.sender.agentName).toBe("OMP Agent");
		const done = await waitForTask(pair.a, task.id, (t) => t.status === "succeeded", "task succeeded after the discussion", 30_000);
		expect(done.task.result).toMatchObject({ summary: "wrote NOTES.md", autoCompleted: false, pushed: false, branch: null });

		// A's thread: B's question, then A's answer; B's thread is the same two messages
		for (const [node, name] of [[pair.a, "A"], [pair.b, "B"]] as const) {
			const detail = (await api(node).get<TaskDetail>(`/tasks/${task.id}`)).body;
			expect(detail.messages.map((m) => [m.kind, m.author.kind, m.author.nodeName]), name).toEqual([
				["question", "agent", "node-b"],
				["answer", "agent", "node-a"],
			]);
			expect(detail.messages[0]?.author.agentName).toBe("OMP Agent");
		}
		const onA = (await api(pair.a).get<TaskDetail>(`/tasks/${task.id}`)).body;
		const onB = (await api(pair.b).get<TaskDetail>(`/tasks/${task.id}`)).body;
		expect(onA.messages[0]).toMatchObject({ injectedIntoSession: true, delivery: "local" }); // B's question went into A's delegating session
		expect(onB.messages[1]).toMatchObject({ injectedIntoSession: true, delivery: "local" }); // A's answer went into B's executing session
		expect(onA.messages[1]?.delivery).toBe("delivered");
		expect(onB.messages[0]?.delivery).toBe("delivered");

		// the status note goes into A's delegating session after the task shows as succeeded: the injector records it as notified once the prompt was handed over
		await eventually(() => pair.a.ctx.tasks.store.get(task.id).notifiedStatus === "succeeded", "the status note to be injected into A's delegating session");
		// what the agents actually received
		const aPrompts = promptsOf(pair.a).map((p) => p.message);
		const questionPrompt = aPrompts.find((m) => m.startsWith("[CL Agent Mesh]") && m.includes("kind question"));
		expect(questionPrompt?.split("\n")[0]).toBe(`[CL Agent Mesh] task ${task.id} \u00b7 "Ask first" \u00b7 from OMP Agent@node-b \u00b7 kind question`);
		expect(questionPrompt).toContain("Which file name should I use?");
		const notes = aPrompts.filter((m) => m.startsWith(`[CL Agent Mesh] task ${task.id}`) && m.includes("\u00b7 status succeeded"));
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("summary: wrote NOTES.md");
		const bPrompts = promptsOf(pair.b).map((p) => p.message);
		expect(bPrompts.filter((m) => m.includes("kind answer") && m.startsWith("[CL Agent Mesh]"))).toHaveLength(1);
		// and the humans can read it in the session transcript of A
		const text = await transcript(pair.a, session.id);
		expect(text).toContain("kind question");
		expect(text).toContain("status succeeded");

		// the discussion is part of the timeline on both nodes
		expect(done.events.filter((e) => e.type === "message").map((e) => e.summary)).toHaveLength(2);
	});

	it("loop guard: 12 agent messages per node without a human, the 13th is refused, a human message replenishes", async () => {
		await pair.autoAcceptOnB(false); // the task stays offered on B, so the thread is open and nothing completes behind our back
		const session = await openSession(pair.a, pair.projectA.id, "Chatty");
		await promptSession(pair.a, session.id, tool("mesh_delegate", { node: "node-b", title: "Chatty", instructions: "wait for me", deliverAs: "summary" }), "c1");
		const task = await eventually(async () => findTask(pair.a, "Chatty"), "task delegated");
		await waitForTask(pair.b, task.id, () => true, "task arrived on B");
		await waitIdle(pair.a, session.id);

		const pings = Array.from({ length: 13 }, (_, i) => tool("mesh_message", { taskId: task.id, kind: "note", text: `ping ${i + 1}` }));
		await promptSession(pair.a, session.id, [`Keep talking about ${task.id}`, ...pings].join("\n"), "c2");
		await eventually(async () => (await transcript(pair.a, session.id)).includes("FAKE_TOOL_RESULT mesh_message: ERROR"), "the 13th message was refused", 30_000);

		const detail = (await api(pair.a).get<TaskDetail>(`/tasks/${task.id}`)).body;
		const mine = detail.messages.filter((m) => m.author.kind === "agent" && m.author.nodeName === "node-a");
		expect(mine.map((m) => m.text)).toEqual(Array.from({ length: 12 }, (_, i) => `ping ${i + 1}`));
		expect(detail.task.agentMessageBudget).toBe(0);
		const refusal = (await transcript(pair.a, session.id)).split("\n").find((l) => l.startsWith("FAKE_TOOL_RESULT mesh_message: ERROR"));
		expect(refusal).toMatch(/limit/i);
		expect(refusal).toMatch(/human must continue/i);

		// a human stepping in on either side replenishes the budget, and B's thread holds all 12 agent messages
		const human = await api(pair.b).post(`/tasks/${task.id}/messages`, { text: "Carry on, I am here.", kind: "note" });
		expect(human.status).toBe(201);
		await eventually(async () => ((await api(pair.a).get<TaskDetail>(`/tasks/${task.id}`)).body.task.agentMessageBudget === 12), "A's budget replenished by B's human message");
		const onB = (await api(pair.b).get<TaskDetail>(`/tasks/${task.id}`)).body;
		expect(onB.messages.filter((m) => m.author.kind === "agent")).toHaveLength(12);
		expect(onB.messages.filter((m) => m.author.kind === "human")).toHaveLength(1);
	});
});

describe("a sender that goes away (T3) and comes back", () => {
	beforeEach(async () => {
		pair = await startTaskPair();
		await pair.autoAcceptOnB(true);
	});

	/** Stop node A keeping its data, then bring it back on the same network port (as a restart of the process would). */
	async function restartA(): Promise<void> {
		const { dataDir, netPort } = pair.a;
		const secrets = pair.a.ctx.secrets;
		await pair.a.cleanup({ keepData: true });
		pair.a = await startNode("node-a", { dataDir, port: netPort, secrets });
	}

	it("B keeps running and shows the task while A is down; A reconciles on return with nothing duplicated", async () => {
		const description = ["Slow job.", "@@fake-sh sleep 3; echo done > T3.md", tool("mesh_message", { taskId: "{{taskId}}", kind: "note", text: "progress: wrote T3.md" }), COMPLETE].join("\n");
		const created = await delegate("T3 job", description);
		const running = await waitForTask(pair.b, created.id, (t) => t.status === "running", "B runs the task");
		expect(running.task.direction).toBe("incoming");

		await restartAStop();
		// A is down: B finishes by itself and shows it
		const finished = await waitForTask(pair.b, created.id, (t) => t.status === "succeeded", "B completes while A is down", 30_000);
		expect(finished.task.result?.pushed).toBe(true);
		const queued = pair.b.ctx.tasks.store.outboxOfTask(created.id);
		expect(queued.map((o) => [o.kind, o.state])).toEqual([["task.message", "pending"]]);
		expect((await peerOf(pair.b, pair.a.ctx.identity.nodeId))?.status).not.toBe("online");

		await restartAStart();
		// A returns: status, result, events and the queued message all arrive, exactly once
		const back = await waitForTask(pair.a, created.id, (t) => t.status === "succeeded", "A reconciles the finished task", 30_000);
		expect(back.task.result).toMatchObject({ pushed: true, summary: "created TASK_SMOKE.md" });
		expect(statusSequence(back.events)).toEqual(["offered", "accepted", "running", "succeeded"]);
		expect(back.events.map((e) => e.seq)).toEqual(back.events.map((_, i) => i + 1));
		expectEventsLocalised(back.events);
		await eventually(() => pair.b.ctx.tasks.store.outboxOfTask(created.id).every((o) => o.state === "sent"), "B's queued message delivered");
		const after = (await api(pair.a).get<TaskDetail>(`/tasks/${created.id}`)).body;
		expect(after.messages.map((m) => [m.kind, m.text, m.author.nodeName])).toEqual([["note", "progress: wrote T3.md", "node-b"]]);
		expect((await api(pair.a).get<Task[]>("/tasks")).body.filter((t) => t.id === created.id)).toHaveLength(1);
		expect((await api(pair.b).get<Task[]>("/tasks")).body.filter((t) => t.id === created.id)).toHaveLength(1);
		// B ran it once: one brief, one task branch
		expect(promptsOf(pair.b).filter((p) => p.message.includes("Slow job.") && p.message.includes(created.id))).toHaveLength(1);
		expect(branchesOf(pair.origin).filter((b) => b.startsWith("clam/"))).toHaveLength(1);
	});

	let held: { dataDir: string; netPort: number; secrets: TaskPair["a"]["ctx"]["secrets"] } | null = null;
	async function restartAStop(): Promise<void> {
		held = { dataDir: pair.a.dataDir, netPort: pair.a.netPort, secrets: pair.a.ctx.secrets };
		await pair.a.cleanup({ keepData: true });
	}
	async function restartAStart(): Promise<void> {
		if (!held) throw new Error("A was not stopped");
		pair.a = await startNode("node-a", { dataDir: held.dataDir, port: held.netPort, secrets: held.secrets });
		held = null;
	}

	it("a task queued while B is down survives A's restart and is delivered, and run, once B is back", async () => {
		const bHeld = { dataDir: pair.b.dataDir, port: pair.b.netPort, secrets: pair.b.ctx.secrets };
		await pair.b.cleanup({ keepData: true });
		await eventually(async () => (await peerOf(pair.a, pair.b.ctx.identity.nodeId))?.status === "offline", "A sees B offline");

		const created = await delegate("Queued", smokeDescription());
		expect(created.delivery).toMatchObject({ state: "pending", attempts: 0 });
		await restartA();
		const pending = (await api(pair.a).get<TaskDetail>(`/tasks/${created.id}`)).body.task;
		expect(pending).toMatchObject({ status: "offered", delivery: { state: "pending" } });

		pair.b = await startNode("node-b", bHeld);
		const done = await waitForTask(pair.a, created.id, (t) => t.status === "succeeded", "A's queued task ran on B after it came back", 40_000);
		expect(done.task.delivery.state).toBe("delivered");
		expect((await api(pair.b).get<Task[]>("/tasks")).body.filter((t) => t.id === created.id)).toHaveLength(1);
		expect(branchesOf(pair.origin).filter((b) => b.startsWith("clam/"))).toHaveLength(1);
	});

	it("a task cancelled before it was ever delivered is cancelled locally and never reaches B", async () => {
		await pair.b.cleanup({ keepData: true });
		await eventually(async () => (await peerOf(pair.a, pair.b.ctx.identity.nodeId))?.status === "offline", "A sees B offline");
		const created = await delegate("Never sent", smokeDescription());
		const cancelled = await api(pair.a).post<Task>(`/tasks/${created.id}/cancel`, { reason: "changed my mind" });
		expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
		expect(cancelled.body).toMatchObject({ status: "cancelled", reason: "changed my mind" });
		expect(pair.a.ctx.tasks.store.outboxOfTask(created.id).map((o) => o.state)).toEqual(["cancelled"]);
		// our own delivery error text carries its twin through the task view
		expect(pair.a.ctx.tasks.store.outboxOfTask(created.id).map((o) => o.lastErrorI18n)).toEqual([{ key: "Cancelled before delivery" }]);
	});
});

describe("a network disconnect between two live nodes", () => {
	beforeEach(async () => {
		pair = await startTaskPair();
		await pair.autoAcceptOnB(true);
	});

	it("holds the task and a message in the outbox while B is unreachable, then delivers each exactly once", async () => {
		const bId = pair.b.ctx.identity.nodeId;
		const goodUrl = pair.b.netUrl;
		// Nothing listens on port 1: the node B itself keeps running, only the path to it is cut.
		pair.a.ctx.network.peers.applyAnnounce(bId, { url: "http://127.0.0.1:1" });
		await eventually(async () => (await peerOf(pair.a, bId))?.status === "offline", "A sees B unreachable", 15_000);

		const created = await delegate("Through the cut", smokeDescription());
		const queued = await api(pair.a).get<TaskDetail>(`/tasks/${created.id}`);
		expect(queued.body.task).toMatchObject({ status: "offered", delivery: { state: "pending" } });
		expect(await findTask(pair.b, "Through the cut")).toBeUndefined();

		pair.a.ctx.network.peers.applyAnnounce(bId, { url: goodUrl });
		const done = await waitForTask(pair.a, created.id, (t) => t.status === "succeeded", "the task ran after the connection came back", 30_000);
		expect(done.task.delivery.state).toBe("delivered");
		expect((await api(pair.b).get<Task[]>("/tasks")).body.filter((t) => t.id === created.id)).toHaveLength(1);
		expect(pair.a.ctx.tasks.store.outboxOfTask(created.id).map((o) => [o.kind, o.state])).toEqual([["task.create", "sent"]]);
		expect(branchesOf(pair.origin).filter((b) => b.startsWith("clam/"))).toHaveLength(1);
	});
});

describe("an executor that restarts mid-run", () => {
	beforeEach(async () => {
		pair = await startTaskPair();
		await pair.autoAcceptOnB(true);
	});

	it("re-opens the session with a resume prompt and still finishes the task", async () => {
		const created = await delegate("Long job", ["A long job.", "@@fake-sh sleep 30"].join("\n"), { deliverAs: "summary" });
		await waitForTask(pair.b, created.id, (t) => t.status === "running", "B runs the task");
		const { dataDir, netPort, secrets } = { dataDir: pair.b.dataDir, netPort: pair.b.netPort, secrets: pair.b.ctx.secrets };
		await pair.b.cleanup({ keepData: true });
		pair.b = await startNode("node-b", { dataDir, port: netPort, secrets });

		const done = await waitForTask(pair.a, created.id, (t) => t.status === "succeeded", "A sees the task finish after B's restart", 40_000);
		expect(done.task.result?.autoCompleted).toBe(true);
		const resumes = promptsOf(pair.b).filter((p) => p.message.includes("The node restarted while you were working on task"));
		expect(resumes).toHaveLength(1);
		expect(resumes[0]?.message).toContain(created.id);
		expect(promptsOf(pair.b).filter((p) => p.message.includes("A long job."))).toHaveLength(1);
	});
});

describe("a refused push", () => {
	beforeEach(async () => {
		pair = await startTaskPair();
		await pair.autoAcceptOnB(true);
	});

	it("keeps the work as a patch artifact that the sender (only) can download", async () => {
		const hook = path.join(pair.origin, "hooks", "pre-receive");
		writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do\n  case "$ref" in refs/heads/clam/*) echo "push blocked by the test hook" >&2; exit 1;; esac\ndone\n');
		chmodSync(hook, 0o755);

		const created = await delegate("Refused", smokeDescription());
		const done = await waitForTask(pair.a, created.id, (t) => t.status === "succeeded", "task succeeded without a push", 30_000);
		const result = done.task.result;
		expect(result).toMatchObject({ pushed: false, compareUrl: null });
		expect(result?.branch).toMatch(/^clam\/node-b\/refused-/);
		expect(branchesOf(pair.origin)).toEqual(["main"]);
		expect(result?.artifacts).toHaveLength(1);
		const artifact = result?.artifacts[0];
		expect(artifact?.name).toMatch(/\.patch$/);

		// the sender downloads it through its local route (proxied from B)
		const download = await fetch(`${pair.a.url}/api/local/tasks/${created.id}/artifacts/${artifact?.artifactId}`);
		expect(download.status).toBe(200);
		const bytes = Buffer.from(await download.arrayBuffer());
		expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact?.sha256);
		expect(bytes.length).toBe(artifact?.size);
		const scratch = mkdtempSync(path.join(tmpdir(), "clam-am-"));
		try {
			git(scratch, "clone", pair.origin, "fresh");
			const fresh = path.join(scratch, "fresh");
			git(fresh, "config", "user.name", "Applier");
			git(fresh, "config", "user.email", "apply@example.com");
			writeFileSync(path.join(scratch, "task.patch"), bytes);
			git(fresh, "am", path.join(scratch, "task.patch"));
			expect(readFileSync(path.join(fresh, "TASK_SMOKE.md"), "utf8")).toBe("hello from B\n");
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}

		// a signed request from the sender works on the wire as well; the artifact is not offered through the local API of B for another task id
		const wire = await signedRequest(pair.a, pair.b.netUrl, { path: `/tasks/${created.id}/artifacts/${artifact?.artifactId}` });
		expect(wire.status).toBe(200);
		const unknown = await fetch(`${pair.a.url}/api/local/tasks/${created.id}/artifacts/art_unknown`);
		expect(unknown.status).toBe(404);
	});
});
