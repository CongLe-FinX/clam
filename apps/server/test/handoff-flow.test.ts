import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Handoff, HandoffDetail, Task, TaskDetail } from "@clam/contracts";
import { sealManifest } from "@clam/handoff-engine";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HANDOFF_PROMPT_PREFIX } from "../src/handoff/fence.ts";
import { newHandoffId } from "../src/handoff/store.ts";
import { writeNodeSettings } from "../src/services/settings.ts";
import { api, type FullHarness } from "./full-harness.ts";
import { BLOCK, FINISH, cloneFor, gitOut, handoffFor, linkedProject, makeRepo, managedProject, readProjectFile, startTrio, type Trio, waitForHandoff, waitForHandoffOf, waitForTaskOn, whenResumeSettled, writeProjectFile } from "./handoff-fixtures.ts";
import { expectEventsLocalised, expectI18nMatches } from "./i18n-helpers.ts";
import { eventually, signedRequest } from "./net-helpers.ts";
import { type GitConfigIsolation, branchesOf, isolateGitConfig, promptsOf, statusSequence } from "./task-fixtures.ts";

/**
 * End-to-end acceptance of the handoff protocol (docs/handoff-protocol.md): A delegates a task to B, B's agent blocks, B hands the task
 * to C, and A's follow-up instruction finishes it on C. Real servers, real git, fake omp.
 */

let trio: Trio;
let isolation: GitConfigIsolation;
beforeAll(() => {
	isolation = isolateGitConfig();
});
afterAll(() => isolation.restore());
afterEach(async () => {
	await trio?.cleanup();
});

interface Begin {
	/** C's dependency-setup policy (default `auto`). */
	setup?: "ask" | "auto" | "skip";
	/** false: C waits for the user. */
	autoAccept?: boolean;
}

async function begin(options: Begin = {}): Promise<void> {
	trio = await startTrio();
	await api(trio.b).patch(`/network/peers/${trio.ids.a}`, { autoAcceptTasks: true });
	writeNodeSettings(trio.c.ctx.db, { autoAcceptHandoffs: options.autoAccept ?? true, dependencySetup: options.setup ?? "auto" });
}

/** A delegates to B and B's agent runs `work` and blocks. */
async function delegate(title: string, work: string, extra: Record<string, unknown> = {}): Promise<Task> {
	const res = await api(trio.a).post<Task>("/tasks", {
		targetNodeId: trio.ids.b,
		title,
		description: ["Do the work.", work, BLOCK].filter(Boolean).join("\n"),
		workspaceId: trio.workspace.id,
		deliverAs: "files",
		...extra,
	});
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	await waitForTaskOn(trio.b, res.body.id, (t) => t.status === "blocked", "B runs the task until it blocks");
	return res.body;
}

async function handOff(task: Task, extra: Record<string, unknown> = {}, from: "b" | "c" | "a" = "b", to: "a" | "b" | "c" = "c"): Promise<Handoff> {
	const created = await api(trio.node(from)).post<Handoff>("/handoffs", { taskId: task.id, targetNodeId: trio.ids[to], ...extra });
	expect(created.status, JSON.stringify(created.body)).toBe(202);
	return created.body;
}

const message = (node: FullHarness, taskId: string, text: string, kind: "instruction" | "note" | "answer" = "instruction") => api(node).post(`/tasks/${taskId}/messages`, { text, kind });
const finishFromA = async (taskId: string) => expect((await message(trio.a, taskId, `Please wrap up.\n${FINISH}`)).status).toBe(201);
const taskOn = async (node: FullHarness, id: string): Promise<TaskDetail> => (await api(node).get<TaskDetail>(`/tasks/${id}`)).body;
const projectPath = (node: FullHarness, task: Task): string => (node.ctx.db.$client.prepare("select path from projects where id = ?").get(node.ctx.tasks.store.get(task.id).projectId) as { path: string }).path;

/** Wait until the full detail (state, failure, timeline) of a handoff satisfies the predicate. */
function waitForDetail(node: FullHarness, id: string, predicate: (d: HandoffDetail) => boolean, what: string, timeoutMs = 25_000): Promise<HandoffDetail> {
	return eventually(async () => {
		const res = await api(node).get<HandoffDetail>(`/handoffs/${id}`);
		return res.status === 200 && predicate(res.body) ? res.body : undefined;
	}, what, timeoutMs);
}

/** Handoff events are numbered 1..n without gaps; every generated summary carries an i18n twin that renders to its English text. */
function expectGapFree(detail: HandoffDetail): void {
	expect(detail.events.length).toBeGreaterThan(0);
	expect(detail.events.map((e) => e.seq)).toEqual(detail.events.map((_, i) => i + 1));
	expectEventsLocalised(detail.events, false);
	expect(detail.events.some((e) => e.i18n !== undefined)).toBe(true);
	if (detail.handoff.failure?.i18n) expectI18nMatches(detail.handoff.failure, detail.handoff.failure.detail);
}

/** The task row exists exactly once as an executing one: on C only, B is fenced, A mirrors. */
async function expectExecutorC(task: Task): Promise<void> {
	const onC = trio.c.ctx.tasks.store.get(task.id);
	expect(onC).toMatchObject({ direction: "incoming", epoch: 1, fenced: false });
	const onB = trio.b.ctx.tasks.store.get(task.id);
	expect(onB).toMatchObject({ status: "handed_off", fenced: true, highestSeenEpoch: 1 });
	await eventually(async () => {
		const a = (await taskOn(trio.a, task.id)).task;
		return a.executor.nodeId === trio.ids.c && a.epoch === 1;
	}, "A follows C at epoch 1");
}

describe("happy path, git", () => {
	it("hands uncommitted work to C's dedicated branch; finishing on C delivers the branch to A", async () => {
		const repo = makeRepo();
		await begin();
		const projectA = await linkedProject(trio.a, trio.workspace.id, "demo-a", repo.workA);
		await linkedProject(trio.b, trio.workspace.id, "demo-b", repo.workB);
		const workC = cloneFor(repo, "work-c", "c@example.com");
		await linkedProject(trio.c, trio.workspace.id, "demo-c", workC);
		// the user's own state on C: an untracked scratch file that must survive
		writeFileSync(path.join(workC, "my-notes.txt"), "mine\n");
		const mainBefore = gitOut(workC, "rev-parse", "main").trim();

		const task = await delegate("Git flow", "@@fake-sh echo wip > feature.txt", { projectId: projectA.id, deliverAs: "branch" });
		const created = await handOff(task);
		expect(created).toMatchObject({ role: "source", fromEpoch: 0 });

		const onC = await waitForHandoffOf(trio.c, task.id, "target", (h) => h.state === "completed" || h.state === "failed", "the handoff ends on C");
		expect(onC.failure, JSON.stringify(onC.failure)).toBeNull();
		expect(onC.state).toBe("completed");
		expect(onC.vcs).toBe("git");
		await whenResumeSettled(trio.c, task.id);
		const branch = gitOut(workC, "rev-parse", "--abbrev-ref", "HEAD").trim();
		expect(branch).toMatch(/^clam\/node-c\//);
		expect(gitOut(workC, "rev-parse", "HEAD").trim()).toBe(onC.git?.commit);
		expect(readProjectFile(workC, "feature.txt")).toBe("wip\n");
		// the user's own work is untouched
		expect(gitOut(workC, "rev-parse", "main").trim()).toBe(mainBefore);
		expect(readProjectFile(workC, "my-notes.txt")).toBe("mine\n");

		const onB = await waitForHandoffOf(trio.b, task.id, "source", (h) => h.state === "completed" || h.state === "released", "B released");
		expect(onB.failure).toBeNull();
		await expectExecutorC(task);
		expectGapFree(await waitForHandoff(trio.b, created.id, (h) => h.state === "completed" || h.state === "released", "B's timeline"));
		expectGapFree({ handoff: onC, events: (await api(trio.c).get<HandoffDetail>(`/handoffs/${onC.id}`)).body.events });

		await finishFromA(task.id);
		const done = await waitForTaskOn(trio.a, task.id, (t) => t.status === "succeeded", "A sees the task succeed", 40_000);
		expect(done.task.executor.nodeId).toBe(trio.ids.c);
		expect(done.task.result?.branch).toBe(branch);
		expect(done.task.result?.pushed).toBe(true);
		expect(branchesOf(repo.origin)).toContain(branch);
		expect(gitOut(repo.origin, "show", `${branch}:feature.txt`)).toBe("wip\n");
		// B never prompted again after the release
		expect(promptsOf(trio.b).filter((p) => p.message.includes("Please wrap up"))).toEqual([]);
		expect((await taskOn(trio.b, task.id)).task.status).toBe("handed_off");
	});
});

describe("happy path, files", () => {
	it("restores the folder on C; the result bundle holds B's and C's files measured against the original base", async () => {
		await begin();
		const projectA = await managedProject(trio.a, trio.workspace.id, "docs-a");
		writeProjectFile(projectA.path, "input/notes.txt", "alpha\n");
		const task = await delegate("Files flow", "@@fake-sh echo from-b > b-made.txt", { projectId: projectA.id, deliverAs: "files", inputPaths: ["input"] });
		await handOff(task);
		const onC = await waitForHandoffOf(trio.c, task.id, "target", (h) => h.state === "completed" || h.state === "failed", "the handoff ends on C");
		expect(onC.failure, JSON.stringify(onC.failure)).toBeNull();
		expect(onC).toMatchObject({ vcs: "files", state: "completed" });
		await whenResumeSettled(trio.c, task.id);
		const folderC = projectPath(trio.c, task);
		expect(readProjectFile(folderC, "b-made.txt")).toBe("from-b\n");
		expect(readProjectFile(folderC, "input/notes.txt")).toBe("alpha\n");
		await expectExecutorC(task);

		expect((await message(trio.a, task.id, `@@fake-sh echo from-c > c-made.txt\n${FINISH}`)).status).toBe(201);
		const done = await waitForTaskOn(trio.a, task.id, (t) => t.status === "succeeded", "A sees the task succeed", 40_000);
		expect(done.task.result?.files).toMatchObject({ fileCount: 2 });
		const preview = await api(trio.a).get<{ files: Array<{ path: string; status: string }> }>(`/tasks/${task.id}/files/preview?projectId=${projectA.id}`);
		expect(preview.status, JSON.stringify(preview.body)).toBe(200);
		expect(Object.fromEntries(preview.body.files.map((f) => [f.path, f.status]))).toEqual({ "b-made.txt": "new", "c-made.txt": "new" });
	});

	/**
	 * The handed-over brief repeats the task description, so the agent on C replays its `@@fake-sh` lines on the restored folder (an `echo x > f`
	 * truncates `f` an instant before it writes it). This line holds the replay open at exactly the moment the assertions used to look: it truncates the
	 * restored copy, then waits for `gate` (or for its directory to go away, so a failed test leaves no shell behind) before it writes the file again.
	 * B runs the same line on a folder without the file and just writes it.
	 */
	it("the folder on C is read only once C's resume turn settled: that turn truncates and rewrites a restored file", async () => {
		await begin();
		const gateDir = mkdtempSync(path.join(tmpdir(), "clam-gate-"));
		const gate = path.join(gateDir, "open");
		try {
			const projectA = await managedProject(trio.a, trio.workspace.id, "docs-a");
			writeProjectFile(projectA.path, "input/notes.txt", "alpha\n");
			const replay = `if [ -f b-made.txt ]; then : > b-made.txt; until [ -f '${gate}' ] || [ ! -d '${gateDir}' ]; do sleep 0.05; done; fi; echo from-b > b-made.txt`;
			const task = await delegate("Files replay", `@@fake-sh ${replay}`, { projectId: projectA.id, deliverAs: "files", inputPaths: ["input"] });
			await handOff(task);
			const onC = await waitForHandoffOf(trio.c, task.id, "target", (h) => h.state === "completed" || h.state === "failed", "the handoff ends on C");
			expect(onC.failure, JSON.stringify(onC.failure)).toBeNull();
			expect(onC.state).toBe("completed");

			// the handoff is completed and the restored file is empty: what a read right after `completed` can see
			const folderC = projectPath(trio.c, task);
			await eventually(() => readProjectFile(folderC, "b-made.txt") === "", "C's agent to truncate the restored b-made.txt", 20_000);
			const during = await api(trio.c).get<{ runtime: { state: string } }>(`/sessions/${onC.target.sessionId}/state`);
			expect(during.status, JSON.stringify(during.body)).toBe(200);
			expect(during.body.runtime.state).toBe("busy");

			writeFileSync(gate, "");
			await whenResumeSettled(trio.c, task.id);
			expect(readProjectFile(folderC, "b-made.txt")).toBe("from-b\n");
			expect(readProjectFile(folderC, "input/notes.txt")).toBe("alpha\n");
		} finally {
			rmSync(gateDir, { recursive: true, force: true });
		}
	});
});

describe("happy path, none", () => {
	it("a summary task has nothing to restore; the resume prompt carries the summary and the task description", async () => {
		await begin();
		const task = await delegate("Just thinking", "Remember the codeword PINEAPPLE.", { deliverAs: "summary" });
		await handOff(task);
		const onC = await waitForHandoffOf(trio.c, task.id, "target", (h) => h.state === "completed" || h.state === "failed", "the handoff ends on C");
		expect(onC.failure, JSON.stringify(onC.failure)).toBeNull();
		expect(onC.vcs).toBe("none");
		expect(onC.steps[2]).toMatchObject({ n: 3, state: "skipped" });
		expect(onC.conversationSummary).toBeTruthy();
		await eventually(() => promptsOf(trio.c).length > 0, "C's agent gets a prompt");
		const resume = promptsOf(trio.c).find((p) => p.message.includes(task.id));
		expect(resume?.message).toContain("Just thinking");
		expect(resume?.message).toContain("PINEAPPLE");
		expect(resume?.message).toContain(onC.conversationSummary as string);
	});
});

describe("live updates: everything persisted is published", () => {
	/** Records every publish of a node's event bus (topic, event): what a connected browser would have received. */
	function record(node: FullHarness): Array<{ topic: string; event: { type: string; handoff?: Handoff; handoffId?: string; event?: { seq: number } } }> {
		const published: Array<{ topic: string; event: { type: string; handoff?: Handoff; handoffId?: string; event?: { seq: number } } }> = [];
		const original = node.ctx.bus.publish.bind(node.ctx.bus);
		node.ctx.bus.publish = (topic, event) => {
			if (topic === "handoffs" || topic.startsWith("handoff:")) published.push({ topic, event: structuredClone(event) as (typeof published)[number]["event"] });
			original(topic, event);
		};
		return published;
	}

	it("every step change, every state and every timeline event of a handoff reaches `handoffs` and `handoff:<id>` as it is persisted, on the source and on the target", async () => {
		await begin();
		const onB = record(trio.b);
		const onC = record(trio.c);
		const task = await delegate("Live updates", "Remember the codeword KUMQUAT.", { deliverAs: "summary" });
		const created = await handOff(task);
		const target = await waitForHandoffOf(trio.c, task.id, "target", (h) => h.state === "completed" || h.state === "failed", "the handoff ends on C");
		expect(target.failure, JSON.stringify(target.failure)).toBeNull();
		const source = await waitForHandoffOf(trio.b, task.id, "source", (h) => h.state === "completed" || h.state === "released", "B released");

		for (const [node, published, row] of [
			[trio.c, onC, target],
			[trio.b, onB, source],
		] as const) {
			const snapshots = published.filter((p) => p.topic === `handoff:${row.id}` && p.event.type === "handoff").map((p) => p.event.handoff as Handoff);
			const list = published.filter((p) => p.topic === "handoffs" && p.event.type === "handoff").map((p) => p.event.handoff as Handoff).filter((h) => h.id === row.id);
			expect(list.length, `${row.role}: the list topic`).toBe(snapshots.length);
			// the last thing published is the final row, steps included
			const detail = await api(node).get<HandoffDetail>(`/handoffs/${row.id}`);
			const final = detail.body.handoff;
			expect(snapshots.at(-1), row.role).toMatchObject({ state: final.state, steps: final.steps });
			// every state the timeline went through was published as a row of that state
			// (`draft` is only the insert of a source row that moves on to `preparing` in the same call: its event is published, no row of that state)
			for (const state of new Set(detail.body.events.map((e) => e.state).filter((state) => state !== "draft"))) expect(snapshots.some((h) => h.state === state), `${row.role}: state ${state}`).toBe(true);
			// every step reached its final state in a published row, and the running steps 2-8 of the target were visible while they ran
			for (const step of final.steps) expect(snapshots.some((h) => h.steps.find((s) => s.n === step.n)?.state === step.state), `${row.role}: step ${step.n} ${step.state}`).toBe(true);
			if (row.role === "target") for (let n = 2; n <= 8; n++) expect(snapshots.some((h) => h.steps.find((s) => s.n === n)?.state === "running"), `target: step ${n} running`).toBe(true);
			// every persisted timeline event was published on the handoff's topic
			const eventSeqs = new Set(published.filter((p) => p.topic === `handoff:${row.id}` && p.event.type === "event").map((p) => p.event.event?.seq));
			for (const e of detail.body.events) expect(eventSeqs.has(e.seq), `${row.role}: event ${e.seq} ${e.summary}`).toBe(true);
		}
		expect(created.id).toBe(source.id);
	});
});

describe("the target says no", () => {
	it("a user rejection unfreezes the task on B, keeps the epoch free and a new handoff succeeds", async () => {
		await begin({ autoAccept: false });
		const task = await delegate("Please decline", "@@fake-sh echo x > a.txt");
		const first = await handOff(task);
		const received = await waitForHandoffOf(trio.c, task.id, "target", (h) => h.state === "received", "C received the offer");
		expect(received.actions).toEqual(["accept", "reject"]);
		const offered = await waitForHandoff(trio.b, first.id, (h) => h.state === "offered" || h.state === "accepted", "B offered");
		expect(offered.handoff.actions).toEqual(["cancel"]);

		const rejected = await api(trio.c).post<Handoff>(`/handoffs/${received.id}/decide`, { decision: "reject", reason: "no capacity today" });
		expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
		const onB = await waitForHandoff(trio.b, first.id, (h) => h.state === "rejected", "B learns the rejection");
		expect(onB.handoff.failure?.detail ?? onB.events.map((e) => e.summary).join("\n")).toContain("no capacity today");
		expect(onB.handoff.actions).toEqual([]);
		expectGapFree(onB);
		expect(onB.events.map((e) => e.state)).toContain("rejected");
		const onC = (await api(trio.c).get<HandoffDetail>(`/handoffs/${received.id}`)).body;
		expect(onC.handoff).toMatchObject({ state: "rejected", actions: [] });
		expectGapFree(onC);

		// B's task is unfrozen: still blocked on B, the epoch unchanged, its session accepts prompts again
		expect(trio.b.ctx.tasks.store.get(task.id)).toMatchObject({ status: "blocked", epoch: 0, fenced: false });
		expect(trio.c.ctx.tasks.store.find(task.id)).toBeUndefined();
		// B's agent takes A's next message again
		expect((await message(trio.a, task.id, "Carry on, B.")).status).toBe(201);
		await eventually(() => promptsOf(trio.b).some((p) => p.message.includes("Carry on, B.")), "B's agent gets the message");

		// the epoch was not consumed: a second handoff to the same node works
		// (the message above started a turn on B: stopRunning settles it, otherwise the handoff would answer 409 session_busy)
		const second = await handOff(task, { stopRunning: true });
		expect(second).toMatchObject({ fromEpoch: 0, toEpoch: 1 });
		expect(second.id).not.toBe(first.id);
		const again = await waitForHandoffOf(trio.c, task.id, "target", (h) => h.state === "received" && h.id !== received.id, "C receives the second offer");
		expect((await api(trio.c).post(`/handoffs/${again.id}/decide`, { decision: "accept" })).status).toBe(200);
		await waitForHandoff(trio.c, again.id, (h) => h.state === "completed", "the second handoff completes");
		await waitForHandoff(trio.b, second.id, (h) => h.state === "completed" || h.state === "released", "B releases");
		await expectExecutorC(task);
	});

	it("a sender that revoked tasks.receive from C: C refuses by policy and both sides say why", async () => {
		await begin();
		const task = await delegate("No receipts", "@@fake-sh echo x > a.txt");
		await trio.revoke("a", "c", ["tasks.receive"]);
		const created = await handOff(task);
		const onB = await waitForHandoff(trio.b, created.id, (h) => h.state === "rejected", "B sees the rejection");
		expect(onB.handoff.failure).toMatchObject({ code: "policy_denied" });
		expect(onB.handoff.failure?.detail).toMatch(/node-a.*tasks\.receive/);
		const onC = await waitForHandoffOf(trio.c, task.id, "target", (h) => h.state === "rejected", "C rejected");
		expect(onC.failure).toMatchObject({ code: "policy_denied" });
		expect(onC.failure?.detail).toMatch(/node-a.*tasks\.receive/);
		expect(trio.b.ctx.tasks.store.get(task.id)).toMatchObject({ status: "blocked", epoch: 0, fenced: false });
		expect(trio.c.ctx.tasks.store.find(task.id)).toBeUndefined();
	});

	it("a sender C does not trust (revoked peer) is refused by policy", async () => {
		await begin();
		const task = await delegate("Unknown sender", "@@fake-sh echo x > a.txt");
		const revoked = await api(trio.c).post(`/network/peers/${trio.ids.a}/revoke`);
		expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
		const created = await handOff(task);
		const onB = await waitForHandoff(trio.b, created.id, (h) => h.state === "rejected", "B sees the rejection");
		expect(onB.handoff.failure).toMatchObject({ code: "policy_denied" });
		expect(onB.handoff.failure?.detail).toMatch(/node-a/);
		expect(await handoffFor(trio.c, task.id, "target")).toMatchObject({ state: "rejected", failure: { code: "policy_denied" } });
		expect(trio.b.ctx.tasks.store.get(task.id)).toMatchObject({ status: "blocked", fenced: false });
	});
});

describe("dependency setup policy", () => {
	const PACKAGE = `@@fake-sh echo '{"name":"tiny","version":"1.0.0"}' > package.json`;
	const MARK = "node -e \"require('fs').appendFileSync('setup-ran.txt','x')\"";

	async function withSetup(setup: "ask" | "auto" | "skip", commands: string[] = [MARK], extra: Record<string, unknown> = {}) {
		await begin({ setup });
		const task = await delegate("Needs setup", PACKAGE);
		const created = await handOff(task, { setupCommands: commands, ...extra });
		return { task, created };
	}

	it("ask: waits for the approval, visible with its actions, and runs the approved commands", async () => {
		const { task } = await withSetup("ask");
		const waiting = await waitForHandoffOf(trio.c, task.id, "target", (h) => h.setup.some((s) => s.state === "pending_approval"), "C waits for the approval");
		expect(waiting.setup.map((s) => [s.purpose, s.command])).toEqual([["install", "npm install"], ["setup", MARK]]);
		const detail = (await api(trio.c).get<HandoffDetail>(`/handoffs/${waiting.id}`)).body;
		expect(detail.handoff.actions).toEqual(expect.arrayContaining(["approve_setup", "deny_setup"]));
		expect(detail.handoff.setup.map((s) => s.command)).toContain(MARK);
		expect(detail.handoff.setup.every((s) => s.state === "pending_approval")).toBe(true);
		expect(readProjectFile(projectPath(trio.c, task), "setup-ran.txt")).toBeNull();
		// nothing moved on: B still owns the task, waiting for the ack
		expect(trio.b.ctx.tasks.store.get(task.id)).toMatchObject({ fenced: false });
		expect((await handoffFor(trio.b, task.id, "source"))?.state).toBe("awaiting_ack");

		const approved = await api(trio.c).post(`/handoffs/${waiting.id}/setup`, { approve: waiting.setup.map((s) => s.id) });
		expect(approved.status, JSON.stringify(approved.body)).toBe(200);
		const done = await waitForHandoff(trio.c, waiting.id, (h) => h.state === "completed", "the handoff completes");
		expect(done.handoff.setup.every((s) => s.state === "succeeded")).toBe(true);
		expect(readProjectFile(projectPath(trio.c, task), "setup-ran.txt")).toBe("x");
		expect(readProjectFile(projectPath(trio.c, task), "package-lock.json")).not.toBeNull();
		expectGapFree(done);
		await expectExecutorC(task);
	});

	it("ask + deny: the handoff continues, nothing ran and the resume prompt names the skipped command", async () => {
		const { task } = await withSetup("ask");
		const waiting = await waitForHandoffOf(trio.c, task.id, "target", (h) => h.setup.some((s) => s.state === "pending_approval"), "C waits for the approval");
		const denied = await api(trio.c).post(`/handoffs/${waiting.id}/setup`, { deny: waiting.setup.map((s) => s.id) });
		expect(denied.status, JSON.stringify(denied.body)).toBe(200);
		const done = await waitForHandoff(trio.c, waiting.id, (h) => h.state === "completed", "the handoff completes without the setup");
		expect(done.handoff.failure).toBeNull();
		expect(done.handoff.setup.every((s) => s.state === "skipped" || s.state === "denied")).toBe(true);
		expect(readProjectFile(projectPath(trio.c, task), "setup-ran.txt")).toBeNull();
		await eventually(() => promptsOf(trio.c).some((p) => p.message.includes(task.id)), "C's resume prompt");
		const resume = promptsOf(trio.c).find((p) => p.message.includes("Continuing handed-over work"))?.message ?? "";
		expect(resume).toContain(`Skipped \`${MARK}\`: denied by the user on this node`);
		expect(resume).toContain("Skipped `npm install`: denied by the user on this node");
	});

	it("auto: the install and setup commands run without asking", async () => {
		const { task } = await withSetup("auto");
		const done = await waitForHandoffOf(trio.c, task.id, "target", (h) => h.state === "completed" || h.state === "failed", "the handoff ends on C");
		expect(done.failure, JSON.stringify(done.failure)).toBeNull();
		expect(done.setup.every((s) => s.state === "succeeded")).toBe(true);
		expect(done.setup.map((s) => s.command)).toContain(MARK);
		expect(readProjectFile(projectPath(trio.c, task), "setup-ran.txt")).toBe("x");
		expect(readProjectFile(projectPath(trio.c, task), "package-lock.json")).not.toBeNull();
		expect(done.actions).toEqual([]);
	});

	it("skip: no command runs and the handoff still completes", async () => {
		const { task } = await withSetup("skip");
		const done = await waitForHandoffOf(trio.c, task.id, "target", (h) => h.state === "completed" || h.state === "failed", "the handoff ends on C");
		expect(done.failure, JSON.stringify(done.failure)).toBeNull();
		expect(done.setup.every((s) => s.state === "skipped")).toBe(true);
		expect(readProjectFile(projectPath(trio.c, task), "setup-ran.txt")).toBeNull();
		expect(readProjectFile(projectPath(trio.c, task), "package-lock.json")).toBeNull();
	});
});

describe("failures on the target", () => {
	const FLAG_CHECK = "node -e \"process.exit(require('fs').existsSync('flag.txt')?0:3)\"";

	it("a failing setup command is a retryable failure: the source keeps waiting, frozen, and the retry completes the handoff", async () => {
		await begin();
		const task = await delegate("Flaky setup", "@@fake-sh echo x > a.txt");
		const created = await handOff(task, { setupCommands: [FLAG_CHECK] });
		const failed = await waitForHandoffOf(trio.c, task.id, "target", (h) => h.state === "failed", "C fails the setup");
		expect(failed.failure).toMatchObject({ code: "deps_failed", step: 5 });
		expect(failed.failure?.detail).toBeTruthy();
		expect(failed.setup[0]).toMatchObject({ state: "failed", exitCode: 3 });
		expect(failed.actions).toEqual(["retry"]);

		// B: the failure is shown, the handoff is NOT failed and the task stays frozen on B
		const waiting = await waitForDetail(trio.b, created.id, (h) => h.events.some((e) => e.summary.includes("deps_failed")), "B notes the failure");
		expect(waiting.handoff.state).toBe("awaiting_ack");
		expect(waiting.handoff.actions).toEqual(["cancel", "extend"]);
		expect(trio.b.ctx.handoffs.fence.isFrozen(task.id)).toBe(true);
		expect(trio.b.ctx.tasks.store.get(task.id)).toMatchObject({ fenced: false, epoch: 0 });
		expect(trio.c.ctx.tasks.store.get(task.id)).toMatchObject({ epoch: 0 });

		writeProjectFile(projectPath(trio.c, task), "flag.txt", "ok");
		const retry = await api(trio.c).post<Handoff>(`/handoffs/${failed.id}/retry`);
		expect(retry.status, JSON.stringify(retry.body)).toBe(200);
		const done = await waitForHandoff(trio.c, failed.id, (h) => h.state === "completed", "the handoff completes after the retry");
		expect(done.handoff.failure).toBeNull();
		expect(done.handoff.setup[0]).toMatchObject({ state: "succeeded" });
		expectGapFree(done);
		const onB = await waitForHandoff(trio.b, created.id, (h) => h.state === "completed" || h.state === "released", "B releases");
		expectGapFree(onB);
		await expectExecutorC(task);
	});

	it("a user cancel on C is final: the source fails the handoff, B's task works again and takes prompts", async () => {
		await begin({ setup: "ask" });
		const task = await delegate("Cancel on C", "@@fake-sh echo x > a.txt");
		const created = await handOff(task, { setupCommands: ["echo hi"] });
		const waiting = await waitForHandoffOf(trio.c, task.id, "target", (h) => h.setup.some((s) => s.state === "pending_approval"), "C waits for the approval");
		expect((await api(trio.c).del(`/handoffs/${waiting.id}`)).status).toBe(200);
		const onB = await waitForHandoff(trio.b, created.id, (h) => h.state === "failed" || h.state === "cancelled", "B ends the handoff");
		expect(onB.handoff.state).toBe("failed");
		expect(onB.handoff.failure).toMatchObject({ code: "cancelled" });
		expect(onB.handoff.actions).toEqual([]);
		expectGapFree(onB);
		expect(await handoffFor(trio.c, task.id, "target")).toMatchObject({ failure: { code: "cancelled" }, actions: [] });
		await eventually(() => trio.c.ctx.tasks.store.find(task.id) === undefined, "C removed the frozen task record");

		expect(trio.b.ctx.handoffs.fence.isFrozen(task.id)).toBe(false);
		expect(trio.b.ctx.tasks.store.get(task.id)).toMatchObject({ epoch: 0, fenced: false });
		expect((await message(trio.a, task.id, "Still yours, B. Run @@fake-sh echo more > more.txt")).status).toBe(201);
		await eventually(() => promptsOf(trio.b).some((p) => p.message.includes("Still yours, B")), "B's agent gets A's instruction");
		expect(promptsOf(trio.c).some((p) => p.message.includes("Still yours, B"))).toBe(false);
	});
});

describe("validation on the target", () => {
	it("a failing checkCommand fails step 6 (validation_failed) with its detail; the source stays the owner; a retry after the fix completes", async () => {
		await begin();
		const task = await delegate("Check me", "@@fake-sh echo x > a.txt");
		const created = await handOff(task, { checkCommand: "node -e \"process.exit(require('fs').existsSync('green.txt')?0:4)\"" });
		const failed = await waitForHandoffOf(trio.c, task.id, "target", (h) => h.state === "failed", "C fails the validation");
		expect(failed.failure).toMatchObject({ code: "validation_failed", step: 6 });
		expect(failed.failure?.detail).toBeTruthy();
		expect(failed.actions).toEqual(["retry"]);
		const onB = await waitForDetail(trio.b, created.id, (h) => h.events.some((e) => e.summary.includes("validation_failed")), "B notes the failure");
		expect(onB.handoff.state).toBe("awaiting_ack");
		expect(trio.b.ctx.tasks.store.get(task.id)).toMatchObject({ fenced: false, epoch: 0 });
		expect(trio.b.ctx.handoffs.fence.isFrozen(task.id)).toBe(true);

		writeProjectFile(projectPath(trio.c, task), "green.txt", "ok");
		expect((await api(trio.c).post(`/handoffs/${failed.id}/retry`)).status).toBe(200);
		await waitForHandoff(trio.c, failed.id, (h) => h.state === "completed", "the handoff completes after the retry");
		await waitForHandoff(trio.b, created.id, (h) => h.state === "completed" || h.state === "released", "B releases");
		await expectExecutorC(task);
	});

	it("a required file that is missing after the setup fails step 6; the retry does not rerun the (fingerprinted) setup", async () => {
		await begin();
		const task = await delegate("Required files", "@@fake-sh echo needed > needed.txt");
		// the reviewed setup command removes what the validation requires and counts its own runs
		const sabotage = "node -e \"require('fs').appendFileSync('runs.txt','x');require('fs').rmSync('needed.txt',{force:true})\"";
		const created = await handOff(task, { setupCommands: [sabotage] });
		const failed = await waitForHandoffOf(trio.c, task.id, "target", (h) => h.state === "failed", "C fails the validation");
		expect(failed.failure).toMatchObject({ code: "validation_failed", step: 6 });
		expect(failed.failure?.detail).toContain("needed.txt");
		const dir = projectPath(trio.c, task);
		expect(readProjectFile(dir, "runs.txt")).toBe("x");
		expect((await handoffFor(trio.b, task.id, "source"))?.state).toBe("awaiting_ack");

		writeProjectFile(dir, "needed.txt", "needed\n");
		expect((await api(trio.c).post(`/handoffs/${failed.id}/retry`)).status).toBe(200);
		await waitForHandoff(trio.c, failed.id, (h) => h.state === "completed", "the handoff completes after the retry");
		await waitForHandoff(trio.b, created.id, (h) => h.state === "completed" || h.state === "released", "B releases");
		expect(readProjectFile(dir, "runs.txt")).toBe("x");
		await expectExecutorC(task);
	});
});

describe("the sender follows the new executor", () => {
	it("an instruction sent while the handoff is in flight is held back (503 handoff_in_progress) until the executor changed, then reaches C's agent and not B's", async () => {
		await begin({ setup: "ask" });
		const task = await delegate("Window", "@@fake-sh echo x > a.txt");
		const created = await handOff(task, { setupCommands: ["echo hi"] });
		const waiting = await waitForHandoffOf(trio.c, task.id, "target", (h) => h.setup.some((s) => s.state === "pending_approval"), "C waits for the approval");
		await waitForHandoff(trio.b, created.id, (h) => h.state === "awaiting_ack", "B waits for the ack");
		// Actions per role/state at this stop
		expect((await api(trio.b).get<HandoffDetail>(`/handoffs/${created.id}`)).body.handoff.actions).toEqual(["cancel", "extend"]);
		expect(waiting.actions).toEqual(["approve_setup", "deny_setup", "cancel"]);

		// the manifest is sealed: A's instruction now meets the freeze on B
		await finishFromA(task.id);
		const held = await eventually(() => trio.a.ctx.tasks.store.outboxOfTask(task.id).find((o) => o.kind === "task.message" && o.lastStatus === 503), "B answers 503 to A's message");
		expect(held.state).toBe("pending");
		expect(held.peerId).toBe(trio.ids.b);
		expect((await taskOn(trio.a, task.id)).messages.at(-1)).toMatchObject({ delivery: "pending" });
		expect(promptsOf(trio.b).some((p) => p.message.includes("Please wrap up"))).toBe(false);

		// C's user approves: the handoff completes, the held message is retargeted to C and finishes the task there
		expect((await api(trio.c).post(`/handoffs/${waiting.id}/setup`, { approve: waiting.setup.map((s) => s.id) })).status).toBe(200);
		await waitForHandoff(trio.c, waiting.id, (h) => h.state === "completed", "the handoff completes");
		const done = await waitForTaskOn(trio.a, task.id, (t) => t.status === "succeeded", "the task finishes on C", 40_000);
		expect(done.task.executor.nodeId).toBe(trio.ids.c);
		expect(done.task.result?.summary).toBe("finished on the new executor");
		expect(promptsOf(trio.c).some((p) => p.message.includes("Please wrap up"))).toBe(true);
		expect(promptsOf(trio.b).some((p) => p.message.includes("Please wrap up"))).toBe(false);
		await eventually(() => trio.a.ctx.tasks.store.outboxOfTask(task.id).every((o) => o.state === "sent"), "A's outbox is drained");
		expect(trio.a.ctx.tasks.store.outboxOfTask(task.id).find((o) => o.kind === "task.message")?.peerId).toBe(trio.ids.c);
		expect((await taskOn(trio.a, task.id)).messages.at(-1)).toMatchObject({ delivery: "delivered" });
	});

	/**
	 * A's instruction can reach C while C's step 10 is still building and sending the brief: the executor notice goes out when C becomes owner and A
	 * forwards what it held at once. The brief must be the first thing the new session reads, the instruction must follow it exactly once, and step 10
	 * must not count it as part of the brief. The brief's prompt is held here right after its thread was read, and the instruction is delivered meanwhile.
	 */
	it("an instruction that reaches C while the resume prompt is being sent follows the brief, once, and the brief does not swallow it", async () => {
		await begin();
		const sessions = trio.c.ctx.sessions;
		const send = sessions.prompt.bind(sessions);
		const held = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		sessions.prompt = async (id, input) => {
			if (input.clientId.startsWith(HANDOFF_PROMPT_PREFIX)) {
				held.resolve();
				await release.promise;
			}
			return send(id, input);
		};
		const task = await delegate("Mid resume", "Do the work.");
		await handOff(task);
		await held.promise;
		await eventually(async () => (await taskOn(trio.a, task.id)).task.executor.nodeId === trio.ids.c, "A follows C");

		await finishFromA(task.id);
		await eventually(() => trio.c.ctx.tasks.store.messages(task.id).some((m) => m.text.includes("Please wrap up")), "the instruction reaches C while the brief is held");
		release.resolve();

		const done = await waitForTaskOn(trio.a, task.id, (t) => t.status === "succeeded", "the task finishes on C", 25_000);
		expect(done.task.result?.summary).toBe("finished on the new executor");
		const prompts = promptsOf(trio.c);
		const briefAt = prompts.findIndex((p) => p.message.includes("# Continuing handed-over work"));
		const instructionAt = prompts.findIndex((p) => p.message.includes("Please wrap up"));
		expect(briefAt, "C's agent got the brief").toBeGreaterThanOrEqual(0);
		expect(instructionAt, "C's agent got the instruction").toBeGreaterThan(briefAt);
		expect(prompts.filter((p) => p.message.includes("Please wrap up")), "the instruction reached the agent once").toHaveLength(1);
	});

	it("A's row follows C (executor columns, peer, epoch); its timeline continues without a gap from the seal; a cancel from A cancels the task on C", async () => {
		await begin();
		const task = await delegate("Follow me", "@@fake-sh echo x > a.txt");
		const before = await taskOn(trio.a, task.id);
		expect(before.task).toMatchObject({ epoch: 0, executor: { nodeId: trio.ids.b } });
		await handOff(task);
		await waitForHandoffOf(trio.c, task.id, "target", (h) => h.state === "completed", "the handoff completes");
		await expectExecutorC(task);

		const detail = await eventually(async () => {
			const d = await taskOn(trio.a, task.id);
			return d.events.some((e) => e.summary.includes("Handed over from node-b")) ? d : undefined;
		}, "A mirrors C's first events");
		expect(trio.a.ctx.tasks.store.get(task.id)).toMatchObject({ peerId: trio.ids.c, epoch: 1, executorNodeId: trio.ids.c });
		expect(detail.task.executor).toMatchObject({ nodeId: trio.ids.c, nodeName: "node-c" });
		expect(detail.events.map((e) => e.seq)).toEqual(detail.events.map((_, i) => i + 1));
		const sealed = detail.events.findIndex((e) => e.summary.includes("Handing over to node-c"));
		const resumed = detail.events.findIndex((e) => e.summary.includes("Handed over from node-b"));
		expect(sealed).toBeGreaterThan(0);
		expect(resumed).toBe(sealed + 1);
		const statuses = statusSequence(detail.events);
		expect(statuses.slice(0, 3)).toEqual(["offered", "accepted", "running"]);
		// events up to the seal come from B, later ones from C: the same task id, one executing timeline
		const onC = await taskOn(trio.c, task.id);
		const mirrored = new Map(detail.events.map((e) => [e.seq, e.summary]));
		expect(onC.events.length).toBeGreaterThan(0);
		for (const event of onC.events.filter((e) => mirrored.has(e.seq))) expect(mirrored.get(event.seq)).toBe(event.summary);
		expect(onC.events[0]?.seq).toBe(detail.events[resumed]?.seq);

		const cancelled = await api(trio.a).post<Task>(`/tasks/${task.id}/cancel`, { reason: "never mind" });
		expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
		await waitForTaskOn(trio.c, task.id, (t) => t.status === "cancelled", "the cancel reaches C");
		await waitForTaskOn(trio.a, task.id, (t) => t.status === "cancelled", "A mirrors the cancellation");
		expect(trio.b.ctx.tasks.store.get(task.id).status).toBe("handed_off");
	});
});

describe("the old source after the ack (§8)", () => {
	it("a restarted B fences the task, never resumes its session, shows the new owner and keeps a late result for review only", async () => {
		await begin();
		const task = await delegate("Fenced B", "@@fake-sh echo x > a.txt");
		const oldSession = trio.b.ctx.tasks.store.get(task.id).executorSessionId as string;
		expect(oldSession).toBeTruthy();
		const created = await handOff(task);
		await waitForHandoff(trio.b, created.id, (h) => h.state === "completed" || h.state === "released", "B released");
		await waitForHandoffOf(trio.c, task.id, "target", (h) => h.state === "completed", "the handoff completes");
		const promptsBefore = promptsOf(trio.b).length;

		await trio.stop("b");
		await trio.start("b");
		await eventually(async () => (await taskOn(trio.b, task.id)).task.status === "handed_off", "B shows handed_off after the boot");
		const afterBoot = await taskOn(trio.b, task.id);
		expect(afterBoot.task).toMatchObject({ status: "handed_off", executor: { nodeId: trio.ids.c } });
		expect(trio.b.ctx.tasks.store.get(task.id)).toMatchObject({ fenced: true, highestSeenEpoch: 1 });
		// the source handoff is terminal and nothing was re-run
		expect(await handoffFor(trio.b, task.id, "source")).toMatchObject({ actions: [] });
		expect(["released", "completed"]).toContain((await handoffFor(trio.b, task.id, "source"))?.state);

		// the fence guards: the old session is never prompted or resumed
		await new Promise((resolve) => setTimeout(resolve, 600));
		expect(promptsOf(trio.b)).toHaveLength(promptsBefore);
		await expect(trio.b.ctx.sessions.prompt(oldSession, { message: "are you still there?", clientId: "late-prompt" })).rejects.toMatchObject({ status: 409, code: "task_fenced" });
		expect(promptsOf(trio.b)).toHaveLength(promptsBefore);
		// a cancel on the old executor cannot touch the task
		await api(trio.b).post(`/tasks/${task.id}/cancel`, { reason: "late" });
		expect(trio.b.ctx.tasks.store.get(task.id)).toMatchObject({ status: "handed_off", fenced: true });
		expect(trio.c.ctx.tasks.store.get(task.id).status).not.toBe("cancelled");

		// what the old session would still report is stored for a human, status and result stay
		const answer = await trio.b.ctx.tasks.executor.complete(oldSession, { outcome: "succeeded", summary: "B thinks it is done" });
		expect(answer).toMatch(/no longer owns/);
		const late = trio.b.ctx.tasks.store.eventsSince(task.id, 0).filter((e) => e.type === "late_result");
		expect(late).toHaveLength(1);
		expect(late[0]?.summary).toContain("Late result (succeeded)");
		expect(trio.b.ctx.tasks.store.get(task.id)).toMatchObject({ status: "handed_off", result: null, fenced: true });

		// the real executor is unaffected: C still owns the task and A follows it, and the finish on C reaches A
		await expectExecutorC(task);
		expect(trio.c.ctx.tasks.store.get(task.id).status).not.toBe("succeeded");
		await finishFromA(task.id);
		const done = await waitForTaskOn(trio.a, task.id, (t) => t.status === "succeeded", "A sees C finish", 40_000);
		expect(done.task.result?.summary).toBe("finished on the new executor");
		expect(done.events.some((e) => e.type === "late_result")).toBe(false);
		expect(promptsOf(trio.b)).toHaveLength(promptsBefore);
	});
});

describe("competing handoffs", () => {
	it("a second handoff of the same task on B is refused (competing_handoff) while the first lives; the first is unaffected", async () => {
		await begin({ autoAccept: false });
		const task = await delegate("Two at once", "@@fake-sh echo x > a.txt");
		const first = await handOff(task);
		const second = await api(trio.b).post<{ error: { code: string; details?: { holderId?: string | null } } }>("/handoffs", { taskId: task.id, targetNodeId: trio.ids.a });
		expect(second.status).toBe(409);
		expect(second.body.error.code).toBe("competing_handoff");
		expect(second.body.error.details?.holderId).toBe(first.id);
		await waitForHandoffOf(trio.c, task.id, "target", (h) => h.id === first.id, "C received the first offer");
		const sources = (await api(trio.b).get<Handoff[]>("/handoffs")).body.filter((h) => h.role === "source" && h.subjectId === task.id);
		expect(sources.map((h) => h.id)).toEqual([first.id]);
		expect(await handoffFor(trio.c, task.id, "target")).toMatchObject({ id: first.id, state: "received" });
	});
});

describe("competing offers at the target", () => {
	/** The offer B really sent, re-signed as another handoff of the same task and epoch, from `source`. */
	function rivalOffer(real: Handoff, source: "a" | "b") {
		const manifest = trio.c.ctx.handoffs.store.get(real.id).manifest as Record<string, unknown> & { source: Record<string, unknown> };
		const node = trio.node(source);
		const id = newHandoffId();
		const sealed = sealManifest({ ...manifest, handoffId: id, correlationId: `corr_${id}`, source: { ...manifest.source, nodeId: node.ctx.identity.nodeId, name: source === "a" ? "node-a" : "node-b", fingerprint: node.ctx.identity.fingerprint } });
		if (!sealed.ok) throw new Error(`cannot seal the rival offer: ${JSON.stringify(sealed)}`);
		return { handoffId: id, taskId: real.subjectId, fromEpoch: real.fromEpoch, toEpoch: real.toEpoch, manifest: JSON.parse(sealed.canonical) as Record<string, unknown>, manifestSha256: sealed.sha256, expiresAt: sealed.manifest.expiresAt };
	}

	it("a second offer for the same task and epoch, from another source or the same one, gets 409 competing_handoff; a replay of the first is idempotent", async () => {
		await begin({ autoAccept: false });
		const task = await delegate("Rivals", "@@fake-sh echo x > a.txt");
		const first = await handOff(task);
		const received = await waitForHandoffOf(trio.c, task.id, "target", (h) => h.id === first.id && h.state === "received", "C received the first offer");

		const fromA = await signedRequest(trio.a, trio.c.netUrl, { method: "POST", path: "/handoffs", body: rivalOffer(received, "a") });
		expect(fromA.status, JSON.stringify(fromA.body)).toBe(409);
		expect(fromA.body.error.code).toBe("competing_handoff");
		const fromB = await signedRequest(trio.b, trio.c.netUrl, { method: "POST", path: "/handoffs", body: rivalOffer(received, "b") });
		expect(fromB.status, JSON.stringify(fromB.body)).toBe(409);
		expect(fromB.body.error.code).toBe("competing_handoff");

		// replaying the real offer (same handoff id, a new request) changes nothing
		const replay = await signedRequest(trio.b, trio.c.netUrl, { method: "POST", path: "/handoffs", body: { handoffId: first.id, taskId: task.id, fromEpoch: received.fromEpoch, toEpoch: received.toEpoch, manifest: trio.c.ctx.handoffs.store.get(first.id).manifest, manifestSha256: received.manifestSha256, expiresAt: received.expiresAt } });
		expect(replay.status, JSON.stringify(replay.body)).toBe(200);
		const rows = (await api(trio.c).get<Handoff[]>("/handoffs")).body.filter((h) => h.subjectId === task.id);
		expect(rows.map((h) => [h.id, h.state])).toEqual([[first.id, "received"]]);
		expect(received.actions).toEqual(["accept", "reject"]);

		// the real one still goes through
		expect((await api(trio.c).post(`/handoffs/${first.id}/decide`, { decision: "accept" })).status).toBe(200);
		await waitForHandoff(trio.c, first.id, (h) => h.state === "completed", "the first handoff completes");
		await expectExecutorC(task);
	});
});

describe("return home", () => {
	it("B hands the task back to its sender A, which finishes it locally", async () => {
		await begin();
		writeNodeSettings(trio.a.ctx.db, { autoAcceptHandoffs: true, dependencySetup: "auto" });
		const task = await delegate("Back home", "@@fake-sh echo home > home.txt");
		const created = await handOff(task, {}, "b", "a");
		const onA = await waitForHandoffOf(trio.a, task.id, "target", (h) => h.state === "completed" || h.state === "failed", "the handoff ends on A");
		expect(onA.failure, JSON.stringify(onA.failure)).toBeNull();
		const onB = await waitForHandoff(trio.b, created.id, (h) => h.state === "completed" || h.state === "released", "B releases");
		expect(onB.handoff.failure).toBeNull();
		expectGapFree(onB);
		expectGapFree(await waitForHandoff(trio.a, onA.id, (h) => h.state === "completed", "A's timeline"));

		const taskA = (await taskOn(trio.a, task.id)).task;
		expect(taskA).toMatchObject({ direction: "incoming", epoch: 1, executor: { nodeId: trio.ids.a } });
		expect(trio.b.ctx.tasks.store.get(task.id)).toMatchObject({ status: "handed_off", fenced: true });
		await whenResumeSettled(trio.a, task.id);
		expect(readProjectFile(projectPath(trio.a, task), "home.txt")).toBe("home\n");

		// the work is local now: A's person is both sender and executor, so an instruction goes straight into the new session
		const note = await message(trio.a, task.id, "Just a note for the thread.", "note");
		expect(note.status, JSON.stringify(note.body)).toBe(201);
		const sent = await message(trio.a, task.id, `Finish it yourself.\n${FINISH}`);
		expect(sent.status, JSON.stringify(sent.body)).toBe(201);
		await eventually(() => promptsOf(trio.a).some((p) => p.message.includes("Finish it yourself")), "the instruction is injected into A's new session");
		expect((await taskOn(trio.a, task.id)).messages.find((m) => m.kind === "instruction")).toMatchObject({ delivery: "local", injectedIntoSession: true });
		const done = await waitForTaskOn(trio.a, task.id, (t) => t.status === "succeeded", "A finishes locally", 40_000);
		expect(done.task.result?.summary).toBe("finished on the new executor");
		expect(done.task.executor.nodeId).toBe(trio.ids.a);
		expect(done.events.map((e) => e.seq)).toEqual(done.events.map((_, i) => i + 1));
		expect(promptsOf(trio.b).some((p) => p.message.includes("Finish it yourself"))).toBe(false);
	});
});
