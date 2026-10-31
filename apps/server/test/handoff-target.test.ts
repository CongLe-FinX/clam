import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Task, TaskDetail } from "@clam/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { writeNodeSettings } from "../src/services/settings.ts";
import { api } from "./full-harness.ts";
import { BLOCK, cloneFor, gitOut, handoffFor, linkedProject, makeRepo, readProjectFile, startTrio, type Trio, waitForHandoffOf, waitForTaskOn } from "./handoff-fixtures.ts";
import { eventually } from "./net-helpers.ts";
import { type GitConfigIsolation, isolateGitConfig } from "./task-fixtures.ts";

/**
 * The target side of a task handoff end to end with the source side and a task sender: A delegates a files task to B, B hands it to C.
 * Real servers, fake omp.
 */

let trio: Trio;
afterEach(async () => {
	await trio?.cleanup();
});

async function startWork(title: string, setup: string): Promise<Task> {
	const res = await api(trio.a).post<Task>("/tasks", { targetNodeId: trio.ids.b, title, description: ["Do the work.", setup, BLOCK].join("\n"), deliverAs: "files", workspaceId: trio.workspace.id });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	await waitForTaskOn(trio.b, res.body.id, (t) => t.status === "blocked", "B runs the task until it blocks");
	return res.body;
}

async function begin(): Promise<void> {
	trio = await startTrio();
	await api(trio.b).patch(`/network/peers/${trio.ids.a}`, { autoAcceptTasks: true });
}

describe("handoff target, files mode", () => {
	it("restores the folder, sets up, acks, takes the epoch, resumes and tells the sender", async () => {
		await begin();
		writeNodeSettings(trio.c.ctx.db, { autoAcceptHandoffs: true, dependencySetup: "auto" });
		const task = await startWork("Move me", "@@fake-sh echo hello > work.txt");

		const created = await api(trio.b).post("/handoffs", { taskId: task.id, targetNodeId: trio.ids.c });
		expect(created.status, JSON.stringify(created.body)).toBe(202);

		const onC = await waitForHandoffOf(trio.c, task.id, "target", (h) => h.state === "completed", "the handoff completes on C");
		expect(onC.steps).toHaveLength(10);
		expect(onC.steps.every((s) => s.state === "done" || s.state === "skipped")).toBe(true);
		expect(onC.failure).toBeNull();
		expect(onC.target.sessionId).not.toBeNull();

		const taskC = (await api(trio.c).get<TaskDetail>(`/tasks/${task.id}`)).body.task;
		expect(taskC).toMatchObject({ direction: "incoming", epoch: 1, executor: { nodeId: trio.ids.c } });
		expect(["running", "blocked", "succeeded"]).toContain(taskC.status);
		const project = taskC.projectId ? trio.c.ctx.db.$client.prepare("select path from projects where id = ?").get(taskC.projectId) : undefined;
		expect(readProjectFile((project as { path: string }).path, "work.txt")).toBe("hello\n");

		// the source released, the sender follows C
		await waitForHandoffOf(trio.b, task.id, "source", (h) => h.state === "released" || h.state === "completed", "B released");
		const onB = (await api(trio.b).get<TaskDetail>(`/tasks/${task.id}`)).body.task;
		expect(onB.status).toBe("handed_off");
		await eventually(async () => (await api(trio.a).get<TaskDetail>(`/tasks/${task.id}`)).body.task.executor.nodeId === trio.ids.c, "A follows the new executor");
		expect(await handoffFor(trio.c, task.id, "target")).toMatchObject({ state: "completed" });
	});

	it("waits for the user when auto-accept is off, and rejecting tells the source", async () => {
		await begin();
		const task = await startWork("Please decline", "@@fake-sh echo x > a.txt");
		await api(trio.b).post("/handoffs", { taskId: task.id, targetNodeId: trio.ids.c });
		const received = await waitForHandoffOf(trio.c, task.id, "target", (h) => h.state === "received", "C received the offer");
		expect(received.actions).toEqual(["accept", "reject"]);
		expect(received.steps[0]).toMatchObject({ n: 1, state: "done" });
		const rejected = await api(trio.c).post(`/handoffs/${received.id}/decide`, { decision: "reject", reason: "not now" });
		expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
		await waitForHandoffOf(trio.b, task.id, "source", (h) => h.state === "rejected", "B learns the rejection");
		expect((await api(trio.b).get<TaskDetail>(`/tasks/${task.id}`)).body.task.status).toBe("blocked");
		expect(trio.c.ctx.tasks.store.find(task.id)).toBeUndefined();
	});

	it("setup commands wait for approval under the ask policy and run after it", async () => {
		await begin();
		writeNodeSettings(trio.c.ctx.db, { autoAcceptHandoffs: true, dependencySetup: "ask" });
		const task = await startWork("Needs setup", `@@fake-sh echo '{"name":"x","version":"1.0.0"}' > package.json`);
		// the source declares one reviewed setup command
		await api(trio.b).post("/handoffs", { taskId: task.id, targetNodeId: trio.ids.c, setupCommands: ["node -e \"require('fs').writeFileSync('setup-ran.txt','yes')\""] });
		const waiting = await waitForHandoffOf(trio.c, task.id, "target", (h) => h.setup.some((s) => s.state === "pending_approval"), "C waits for the setup approval");
		expect(waiting.state).toBe("context_restored");
		expect(waiting.actions).toContain("approve_setup");
		const approve = await api(trio.c).post(`/handoffs/${waiting.id}/setup`, { approve: waiting.setup.map((s) => s.id), deny: [] });
		expect(approve.status, JSON.stringify(approve.body)).toBe(200);
		const done = await waitForHandoffOf(trio.c, task.id, "target", (h) => h.state === "completed", "the handoff completes after the approval");
		expect(done.setup.every((s) => s.state === "succeeded")).toBe(true);
	});

	it("a user cancel before ownership removes what the handoff created", async () => {
		await begin();
		writeNodeSettings(trio.c.ctx.db, { autoAcceptHandoffs: true, dependencySetup: "ask" });
		const task = await startWork("Cancel me", `@@fake-sh echo '{"name":"x","version":"1.0.0"}' > package.json`);
		await api(trio.b).post("/handoffs", { taskId: task.id, targetNodeId: trio.ids.c, setupCommands: ["echo hi"] });
		const waiting = await waitForHandoffOf(trio.c, task.id, "target", (h) => h.setup.some((s) => s.state === "pending_approval"), "C waits for the setup approval");
		const cancelled = await api(trio.c).del(`/handoffs/${waiting.id}`);
		expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
		await waitForHandoffOf(trio.b, task.id, "source", (h) => h.state === "cancelled" || h.state === "failed", "B learns the cancel");
		await eventually(async () => trio.c.ctx.tasks.store.find(task.id) === undefined, "C's frozen task record is removed");
		expect(trio.c.ctx.sessions.list({ archived: false })).toEqual([]);
	});
});

describe("handoff target, git mode", () => {
	let isolation: GitConfigIsolation;
	beforeAll(() => {
		isolation = isolateGitConfig();
	});
	afterAll(() => isolation.restore());

	it("restores the pushed work on a dedicated branch of the linked project and leaves the user's branch alone", async () => {
		const repo = makeRepo();
		trio = await startTrio();
		await api(trio.b).patch(`/network/peers/${trio.ids.a}`, { autoAcceptTasks: true });
		writeNodeSettings(trio.c.ctx.db, { autoAcceptHandoffs: true, dependencySetup: "auto" });
		const projectA = await linkedProject(trio.a, trio.workspace.id, "demo-a", repo.workA);
		await linkedProject(trio.b, trio.workspace.id, "demo-b", repo.workB);
		const workC = cloneFor(repo, "work-c", "c@example.com");
		const projectC = await linkedProject(trio.c, trio.workspace.id, "demo-c", workC);

		const res = await api(trio.a).post<Task>("/tasks", {
			targetNodeId: trio.ids.b,
			projectId: projectA.id,
			title: "Git handoff",
			description: ["Add a file.", "@@fake-sh echo wip > feature.txt", BLOCK].join("\n"),
			deliverAs: "branch",
		});
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		await waitForTaskOn(trio.b, res.body.id, (t) => t.status === "blocked", "B runs the task until it blocks");

		await api(trio.b).post("/handoffs", { taskId: res.body.id, targetNodeId: trio.ids.c });
		const done = await waitForHandoffOf(trio.c, res.body.id, "target", (h) => h.state === "completed" || h.state === "failed", "the handoff ends on C");
		expect(done.failure, JSON.stringify(done.failure)).toBeNull();
		expect(done.state).toBe("completed");

		const branch = gitOut(workC, "rev-parse", "--abbrev-ref", "HEAD").trim();
		expect(branch).toMatch(/^clam\/node-c\/git-handoff-[a-z0-9]+-h[a-z0-9]+$/);
		expect(readProjectFile(workC, "feature.txt")).toBe("wip\n");
		expect(gitOut(workC, "rev-parse", "HEAD").trim()).toBe(done.git?.commit);
		expect(gitOut(workC, "branch", "--list", "main").trim()).toMatch(/main/);
		const taskC = (await api(trio.c).get<TaskDetail>(`/tasks/${res.body.id}`)).body.task;
		expect(taskC).toMatchObject({ epoch: 1, projectId: projectC.id, executor: { nodeId: trio.ids.c } });
		const prepared = trio.c.ctx.tasks.store.get(res.body.id).execState.prepared as { workBranch: string; originalBranch: string } | undefined;
		expect(prepared).toMatchObject({ workBranch: branch, originalBranch: "main" });
	});

	it("applies the source's uncommitted work as a patch on top of the pushed commit when it could not push", async () => {
		const repo = makeRepo();
		trio = await startTrio();
		await api(trio.b).patch(`/network/peers/${trio.ids.a}`, { autoAcceptTasks: true });
		writeNodeSettings(trio.c.ctx.db, { autoAcceptHandoffs: true, dependencySetup: "auto" });
		const projectA = await linkedProject(trio.a, trio.workspace.id, "demo-a", repo.workA);
		await linkedProject(trio.b, trio.workspace.id, "demo-b", repo.workB);
		const workC = cloneFor(repo, "work-c", "c@example.com");
		await linkedProject(trio.c, trio.workspace.id, "demo-c", workC);

		const res = await api(trio.a).post<Task>("/tasks", { targetNodeId: trio.ids.b, projectId: projectA.id, title: "Patch handoff", description: ["x", "@@fake-sh echo patched > feature.txt", BLOCK].join("\n"), deliverAs: "branch" });
		await waitForTaskOn(trio.b, res.body.id, (t) => t.status === "blocked", "B blocks");
		// B cannot push any more: its work can only travel as a patch
		gitOut(repo.workB, "remote", "set-url", "--push", "origin", path.join(repo.root, "nowhere.git"));
		await api(trio.b).post("/handoffs", { taskId: res.body.id, targetNodeId: trio.ids.c });
		const done = await waitForHandoffOf(trio.c, res.body.id, "target", (h) => h.state === "completed" || h.state === "failed", "the handoff ends on C");
		expect(done.failure, JSON.stringify(done.failure)).toBeNull();
		expect(done.git).toMatchObject({ pushed: false, patch: true });
		expect(readProjectFile(workC, "feature.txt")).toBe("patched\n");
		expect(gitOut(workC, "rev-parse", "HEAD").trim()).toBe(done.git?.commit);
	});

	it("a cancel removes the dedicated branch and puts the user back on their own branch", async () => {
		const repo = makeRepo();
		trio = await startTrio();
		await api(trio.b).patch(`/network/peers/${trio.ids.a}`, { autoAcceptTasks: true });
		writeNodeSettings(trio.c.ctx.db, { autoAcceptHandoffs: true, dependencySetup: "ask" });
		const projectA = await linkedProject(trio.a, trio.workspace.id, "demo-a", repo.workA);
		await linkedProject(trio.b, trio.workspace.id, "demo-b", repo.workB);
		const workC = cloneFor(repo, "work-c", "c@example.com");
		await linkedProject(trio.c, trio.workspace.id, "demo-c", workC);

		const res = await api(trio.a).post<Task>("/tasks", { targetNodeId: trio.ids.b, projectId: projectA.id, title: "Cancel git", description: ["x", "@@fake-sh echo wip > feature.txt", BLOCK].join("\n"), deliverAs: "branch" });
		await waitForTaskOn(trio.b, res.body.id, (t) => t.status === "blocked", "B blocks");
		await api(trio.b).post("/handoffs", { taskId: res.body.id, targetNodeId: trio.ids.c, setupCommands: ["echo hi"] });
		const waiting = await waitForHandoffOf(trio.c, res.body.id, "target", (h) => h.setup.some((s) => s.state === "pending_approval"), "C waits for the setup approval");
		expect(gitOut(workC, "rev-parse", "--abbrev-ref", "HEAD").trim()).toMatch(/^clam\//);
		expect((await api(trio.c).del(`/handoffs/${waiting.id}`)).status).toBe(200);
		await eventually(async () => trio.c.ctx.tasks.store.find(res.body.id) === undefined, "C cleaned up");
		await eventually(async () => gitOut(workC, "branch", "--list", "clam/*").trim() === "", "the dedicated branch is gone");
		expect(gitOut(workC, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
		expect(readProjectFile(workC, "feature.txt")).toBeNull();
	});

	it("refuses to touch a checkout with uncommitted tracked changes (checkout_conflict) and keeps the user's work", async () => {
		const repo = makeRepo();
		trio = await startTrio();
		await api(trio.b).patch(`/network/peers/${trio.ids.a}`, { autoAcceptTasks: true });
		writeNodeSettings(trio.c.ctx.db, { autoAcceptHandoffs: true, dependencySetup: "auto" });
		const projectA = await linkedProject(trio.a, trio.workspace.id, "demo-a", repo.workA);
		await linkedProject(trio.b, trio.workspace.id, "demo-b", repo.workB);
		const workC = cloneFor(repo, "work-c", "c@example.com");
		await linkedProject(trio.c, trio.workspace.id, "demo-c", workC);
		writeFileSync(path.join(workC, "README.md"), "# my own edit\n");

		const res = await api(trio.a).post<Task>("/tasks", { targetNodeId: trio.ids.b, projectId: projectA.id, title: "Conflict", description: ["x", "@@fake-sh echo wip > feature.txt", BLOCK].join("\n"), deliverAs: "branch" });
		await waitForTaskOn(trio.b, res.body.id, (t) => t.status === "blocked", "B blocks");
		await api(trio.b).post("/handoffs", { taskId: res.body.id, targetNodeId: trio.ids.c });
		const failed = await waitForHandoffOf(trio.c, res.body.id, "target", (h) => h.state === "failed", "C fails the restore");
		expect(failed.failure).toMatchObject({ code: "checkout_conflict", step: 3 });
		expect(readProjectFile(workC, "README.md")).toBe("# my own edit\n");
		expect(gitOut(workC, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
		expect(failed.actions).toContain("retry");
		// the task record of the handoff is kept for the retry; the user's change is untouched
		expect(trio.c.ctx.tasks.store.find(res.body.id)).toBeDefined();
	});
});

describe("handoff target, returning home and retries", () => {
	it("a task handed back to its sender flips the sender's mirror into the executor row", async () => {
		await begin();
		writeNodeSettings(trio.a.ctx.db, { autoAcceptHandoffs: true, dependencySetup: "auto" });
		const task = await startWork("Back home", "@@fake-sh echo home > work.txt");
		const created = await api(trio.b).post("/handoffs", { taskId: task.id, targetNodeId: trio.ids.a });
		expect(created.status, JSON.stringify(created.body)).toBe(202);
		const onA = await waitForHandoffOf(trio.a, task.id, "target", (h) => h.state === "completed" || h.state === "failed", "the handoff ends on A");
		expect(onA.failure, JSON.stringify(onA.failure)).toBeNull();
		const taskA = (await api(trio.a).get<TaskDetail>(`/tasks/${task.id}`)).body.task;
		expect(taskA).toMatchObject({ direction: "incoming", epoch: 1, executor: { nodeId: trio.ids.a } });
		const project = trio.a.ctx.db.$client.prepare("select path from projects where id = ?").get(taskA.projectId) as { path: string };
		expect(readProjectFile(project.path, "work.txt")).toBe("home\n");
		// no executor notice goes anywhere: the sender is the executor
		expect(trio.a.ctx.tasks.store.pendingOutbox().filter((i) => i.kind === "task.executor")).toEqual([]);
	});

	it("a failing setup command fails the step (deps_failed) and a retry re-enters it", async () => {
		await begin();
		writeNodeSettings(trio.c.ctx.db, { autoAcceptHandoffs: true, dependencySetup: "auto" });
		const task = await startWork("Flaky setup", "@@fake-sh echo x > a.txt");
		const command = `node -e "process.exit(require('fs').existsSync('flag.txt')?0:3)"`;
		await api(trio.b).post("/handoffs", { taskId: task.id, targetNodeId: trio.ids.c, setupCommands: [command] });
		const failed = await waitForHandoffOf(trio.c, task.id, "target", (h) => h.state === "failed", "C fails the setup");
		expect(failed.failure).toMatchObject({ code: "deps_failed", step: 5 });
		expect(failed.setup[0]).toMatchObject({ state: "failed", exitCode: 3 });
		expect(failed.actions).toEqual(["retry"]);
		const projectId = trio.c.ctx.tasks.store.get(task.id).projectId as string;
		const dir = (trio.c.ctx.db.$client.prepare("select path from projects where id = ?").get(projectId) as { path: string }).path;
		writeFileSync(path.join(dir, "flag.txt"), "ok");
		const retry = await api(trio.c).post(`/handoffs/${failed.id}/retry`);
		expect(retry.status, JSON.stringify(retry.body)).toBe(200);
		// the source may already have given up on this handoff (it saw `failed`); the target side itself re-entered the step
		const again = await waitForHandoffOf(trio.c, task.id, "target", (h) => h.failure === null && h.steps[4]?.state === "done", "step 5 runs again");
		expect(again.setup[0]?.state).toBe("succeeded");
	});
});
