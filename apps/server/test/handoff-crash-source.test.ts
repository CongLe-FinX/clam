import { existsSync, readFileSync } from "node:fs";
import type { HandoffRow } from "../src/handoff/store.ts";
import type { OutboxRow, TaskRow } from "../src/tasks/store.ts";
import type { Handoff, Task, TaskDetail } from "@clam/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { HandoffTimings } from "../src/handoff/hub.ts";
import { writeNodeSettings } from "../src/services/settings.ts";
import { api, type FullHarness } from "./full-harness.ts";
import { BLOCK, cloneFor, FINISH, gitOut, handoffFor, linkedProject, makeRepo, type NodeOptions, type Side, startTrio, type Trio, waitForHandoffOf, waitForTaskOn } from "./handoff-fixtures.ts";
import { eventually } from "./net-helpers.ts";
import { branchesOf, type GitConfigIsolation, isolateGitConfig, promptsOf } from "./task-fixtures.ts";

/**
 * Process crash of the SOURCE node (B) at every source state of a task handoff (docs/handoff-protocol.md §6.1), against the real target
 * (C) and the task sender (A): real servers, fake omp. B runs with a `throw` fault right after the state became durable; the test stops
 * B (a crash on the same data directory), starts it again without the fault and asserts the recovery through the nodes' local APIs. The
 * invariant of every test: the task executes exactly once (never on two nodes), is never lost, the fake-omp logs show no duplicate
 * resume prompt, and A follows the final executor.
 */

let trio: Trio;
let fired: string | undefined;
let bTimings: Partial<HandoffTimings> = {};
let isolation: GitConfigIsolation;
beforeAll(() => {
	isolation = isolateGitConfig();
});
afterAll(() => isolation.restore());
afterEach(async () => {
	await trio?.cleanup();
});

interface Begin {
	/** The source state B crashes after (`handoff:source:<point>`); none = no fault. */
	point?: string;
	timings?: Partial<HandoffTimings>;
	/** C's dependency-setup policy (default `auto`). */
	setup?: "ask" | "auto";
}

async function begin(options: Begin = {}): Promise<void> {
	fired = undefined;
	bTimings = options.timings ?? {};
	const b: NodeOptions = { handoffTimings: bTimings };
	if (options.point) {
		b.handoffFault = {
			spec: `handoff:source:${options.point}`,
			mode: "throw",
			onFire: (point) => {
				fired = point;
			},
		};
	}
	trio = await startTrio({ b });
	await api(trio.b).patch(`/network/peers/${trio.ids.a}`, { autoAcceptTasks: true });
	writeNodeSettings(trio.c.ctx.db, { autoAcceptHandoffs: true, dependencySetup: options.setup ?? "auto" });
}

/** A delegates a files task to B whose agent blocks (an idle session: nothing turns while the handoff is prepared). */
async function delegate(title: string, extra: Record<string, unknown> = {}): Promise<Task> {
	const res = await api(trio.a).post<Task>("/tasks", { targetNodeId: trio.ids.b, title, description: ["Do the work.", BLOCK].join("\n"), workspaceId: trio.workspace.id, deliverAs: "files", ...extra });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	await waitForTaskOn(trio.b, res.body.id, (t) => t.status === "blocked", "B runs the task until it blocks");
	return res.body;
}

const handOffRaw = (task: Task, extra: Record<string, unknown> = {}) => api(trio.b).post<Handoff>("/handoffs", { taskId: task.id, targetNodeId: trio.ids.c, ...extra });

async function handOff(task: Task, extra: Record<string, unknown> = {}): Promise<Handoff> {
	const created = await handOffRaw(task, extra);
	expect(created.status, JSON.stringify(created.body)).toBe(202);
	return created.body;
}

/** What B had persisted when it crashed (read before the node is stopped: a stopped node has no open database). */
interface Crash {
	row: Handoff;
	source: HandoffRow;
	task: TaskRow;
	frozen: boolean;
	outbox: OutboxRow[];
	onC: Handoff | undefined;
	/** B's fake-omp log at the crash. */
	prompts: number;
	spawns: number;
}

/** B crashes: wait for the fault, snapshot what is durable, then stop the node (data directory kept). */
async function crashB(task: Task, point: string, cOnline = true): Promise<Crash> {
	expect(await eventually(() => fired, `the fault source:${point} fires`, 25_000)).toBe(`source:${point}`);
	const row = await eventually(() => handoffFor(trio.b, task.id, "source"), "the source row exists");
	const crash: Crash = {
		row,
		source: trio.b.ctx.handoffs.store.get(row.id),
		task: trio.b.ctx.tasks.store.get(task.id),
		frozen: trio.b.ctx.handoffs.fence.isFrozen(task.id),
		outbox: trio.b.ctx.tasks.store.outboxOfTask(`${row.id}:${trio.ids.c}`),
		onC: cOnline ? await handoffFor(trio.c, task.id, "target") : undefined,
		prompts: promptsOf(trio.b).length,
		spawns: 0,
	};
	await trio.stop("b");
	crash.spawns = spawnsOf(trio.b);
	return crash;
}

const restartB = (): Promise<FullHarness> => trio.start("b", { handoffTimings: bTimings });
const sourceRow = (id: string) => trio.b.ctx.handoffs.store.get(id);
/** Proves a negative ("nothing happens meanwhile"): a bounded real wait, no event exists to await. */
const quiet = (): Promise<void> => {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, 600);
	return promise;
};

const message = (node: FullHarness, taskId: string, text: string) => api(node).post(`/tasks/${taskId}/messages`, { text, kind: "instruction" });
const taskOn = async (node: FullHarness, id: string): Promise<TaskDetail> => (await api(node).get<TaskDetail>(`/tasks/${id}`)).body;

function spawnsOf(node: FullHarness): number {
	if (!existsSync(node.fakeLog)) return 0;
	const records = readFileSync(node.fakeLog, "utf8").split("\n").filter(Boolean);
	return records.filter((line) => /"kind":"spawn"/.test(line)).length;
}

/** Sides on which the task is the live executing task: an incoming row that is neither fenced, frozen nor finished. */
function executing(task: Task): Side[] {
	return (["b", "c"] as const).filter((side) => {
		const node = trio.node(side);
		const row = node.ctx.tasks.store.find(task.id);
		return row !== undefined && row.direction === "incoming" && !row.fenced && !node.ctx.handoffs.fence.isFrozen(task.id) && (row.status === "running" || row.status === "blocked");
	});
}

/** Exactly one executing owner, the other node holds no live copy, A's mirror follows the owner. */
async function expectOwner(task: Task, owner: "b" | "c"): Promise<void> {
	await eventually(() => {
		const sides = executing(task);
		return sides.length === 1 && sides[0] === owner;
	}, `the task executes only on ${owner} (executing on: ${executing(task).join(",") || "nowhere"})`, 20_000);
	if (owner === "c") {
		expect(trio.c.ctx.tasks.store.get(task.id)).toMatchObject({ epoch: 1, fenced: false });
		expect(trio.b.ctx.tasks.store.get(task.id)).toMatchObject({ status: "handed_off", fenced: true, highestSeenEpoch: 1 });
	} else {
		expect(trio.b.ctx.tasks.store.get(task.id)).toMatchObject({ fenced: false });
	}
	await eventually(async () => (await taskOn(trio.a, task.id)).task.executor.nodeId === trio.ids[owner], `A follows ${owner}`, 20_000);
}

/** A's instruction finishes the task on the owner; A sees the result; nobody else ran or got the instruction. */
async function finishOn(task: Task, owner: "b" | "c", handoffId: string): Promise<void> {
	expect((await message(trio.a, task.id, `Please wrap up.\n${FINISH}`)).status).toBe(201);
	const done = await waitForTaskOn(trio.a, task.id, (t) => t.status === "succeeded", "A sees the task succeed", 40_000);
	expect(done.task.executor.nodeId).toBe(trio.ids[owner]);
	const other: "b" | "c" = owner === "b" ? "c" : "b";
	expect(trio.node(owner).ctx.tasks.store.get(task.id).status).toBe("succeeded");
	expect(trio.node(other).ctx.tasks.store.find(task.id)?.status).not.toBe("succeeded");
	expect(promptsOf(trio.node(other)).filter((p) => p.message.includes("Please wrap up"))).toEqual([]);
	expect(promptsOf(trio.node(owner)).filter((p) => p.message.includes("Please wrap up"))).toHaveLength(1);
	// the new session got its resume prompt exactly once (for this handoff), the old one never again
	expect(promptsOf(trio.c).filter((p) => p.message.includes(`handoff ${handoffId},`))).toHaveLength(owner === "c" ? 1 : 0);
	if (owner === "c") expect(promptsOf(trio.b).filter((p) => p.message.includes("The node restarted while you were working"))).toEqual([]);
}

/** The handoff ran to the end after the recovery: C owns the task from epoch 1, B released, A follows, A's instruction finishes it on C. */
async function completeOnC(task: Task, id: string): Promise<void> {
	const onC = await waitForHandoffOf(trio.c, task.id, "target", (h) => h.state === "completed" || h.state === "failed", "the handoff ends on C");
	expect(onC.failure, JSON.stringify(onC.failure)).toBeNull();
	expect(onC.state).toBe("completed");
	const onB = await waitForHandoffOf(trio.b, task.id, "source", (h) => h.state === "released" || h.state === "completed" || h.state === "failed", "B's side ends");
	expect(onB.id).toBe(id);
	expect(onB.failure, JSON.stringify(onB.failure)).toBeNull();
	expect(["released", "completed"]).toContain(onB.state);
	await expectOwner(task, "c");
	await finishOn(task, "c", id);
}

describe("source crash, files mode", () => {
	it("preparing: nothing was sent; the preparation restarts under the same handoff and the task moves exactly once", async () => {
		await begin({ point: "preparing" });
		const task = await delegate("Crash preparing");
		const created = await handOffRaw(task);
		expect(created.status).not.toBe(202);
		const crash = await crashB(task, "preparing");
		expect(crash.row.state).toBe("preparing");
		// persisted: frozen, no package, nothing queued, the target knows nothing
		expect(crash.frozen).toBe(true);
		expect(crash.outbox).toEqual([]);
		expect(crash.onC).toBeUndefined();

		await restartB();
		await completeOnC(task, crash.row.id);
		// the sealing note was written once, by the restarted preparation
		const notes = (await taskOn(trio.b, task.id)).events.filter((e) => e.summary.includes("Handing over to"));
		expect(notes).toHaveLength(1);
	}, 60_000);

	it("offered: the offer is resent under the same idempotency key; C holds one copy and takes the task once", async () => {
		await begin({ point: "offered" });
		const task = await delegate("Crash offered");
		await handOff(task);
		const crash = await crashB(task, "offered");
		expect(crash.row.state).toBe("offered");
		expect(crash.source.manifestSha256).toBeTruthy();
		expect(crash.outbox.filter((o) => o.kind === "handoff.offer")).toHaveLength(1);
		expect(crash.task.status).toBe("blocked");

		await restartB();
		await completeOnC(task, crash.row.id);
		const offers = trio.b.ctx.tasks.store.outboxOfTask(`${crash.row.id}:${trio.ids.c}`).filter((o) => o.kind === "handoff.offer");
		expect(offers).toHaveLength(1);
		expect((await api(trio.c).get<Handoff[]>("/handoffs")).body.filter((h) => h.id === crash.row.id)).toHaveLength(1);
	}, 60_000);

	it("offered, target offline: the offer expires after the restart per offerExpiryMs; the task is unfrozen and finishes on B", async () => {
		await begin({ point: "offered", timings: { offerExpiryMs: 4_000 } });
		const task = await delegate("Crash offered, expires");
		await trio.stop("c");
		await handOff(task);
		const crash = await crashB(task, "offered", false);
		expect(crash.row.state).toBe("offered");

		await restartB();
		const expired = await waitForHandoffOf(trio.b, task.id, "source", (h) => h.state === "expired", "the offer expires");
		expect(expired.id).toBe(crash.row.id);
		expect(trio.b.ctx.handoffs.fence.isFrozen(task.id)).toBe(false);
		expect(trio.b.ctx.tasks.store.get(task.id)).toMatchObject({ status: "blocked", fenced: false, epoch: 0 });

		// the target returns: it never received the offer and must not receive it now
		await trio.start("c");
		await quiet();
		expect(await handoffFor(trio.c, task.id, "target")).toBeUndefined();
		expect(trio.c.ctx.tasks.store.find(task.id)).toBeUndefined();
		await expectOwner(task, "b");
		await finishOn(task, "b", crash.row.id);
	}, 60_000);

	it("accepted: the accept is delivered again; B queries C and the handoff completes", async () => {
		await begin({ point: "accepted" });
		const task = await delegate("Crash accepted");
		await handOff(task);
		const crash = await crashB(task, "accepted");
		expect(crash.row.state).toBe("accepted");
		expect(crash.task.status).toBe("blocked");

		await restartB();
		await completeOnC(task, crash.row.id);
	}, 60_000);

	it("accepted, target offline: B never releases on silence; it completes when C returns", async () => {
		await begin({ point: "accepted" });
		const task = await delegate("Crash accepted, target down");
		await handOff(task);
		const crash = await crashB(task, "accepted");
		await trio.stop("c");

		await restartB();
		await quiet();
		expect(["accepted", "awaiting_ack"]).toContain(sourceRow(crash.row.id).state);
		expect(trio.b.ctx.tasks.store.get(task.id)).toMatchObject({ status: "blocked", fenced: false, epoch: 0 });
		expect(trio.b.ctx.handoffs.fence.isFrozen(task.id)).toBe(true);
		expect(promptsOf(trio.b)).toHaveLength(crash.prompts);

		await trio.start("c");
		await completeOnC(task, crash.row.id);
	}, 60_000);

	it("awaiting_ack: B asks C after the restart and releases only on C's valid ack", async () => {
		await begin({ point: "awaiting_ack" });
		const task = await delegate("Crash awaiting ack");
		await handOff(task);
		const crash = await crashB(task, "awaiting_ack");
		expect(crash.row.state).toBe("awaiting_ack");
		expect(crash.row.deadlineAt).toBeTruthy();
		expect(crash.task.status).toBe("blocked");

		await restartB();
		await completeOnC(task, crash.row.id);
	}, 60_000);

	it("awaiting_ack, target offline: B stays awaiting_ack, frozen and owner (no release on silence) until C is back", async () => {
		await begin({ point: "awaiting_ack" });
		const task = await delegate("Crash awaiting ack, target down");
		await handOff(task);
		const crash = await crashB(task, "awaiting_ack");
		await trio.stop("c");

		await restartB();
		await quiet();
		expect(sourceRow(crash.row.id).state).toBe("awaiting_ack");
		expect(trio.b.ctx.tasks.store.get(task.id)).toMatchObject({ status: "blocked", fenced: false, epoch: 0 });
		expect(trio.b.ctx.handoffs.fence.isFrozen(task.id)).toBe(true);
		expect(promptsOf(trio.b)).toHaveLength(crash.prompts);
		expect((await taskOn(trio.a, task.id)).task.executor.nodeId).toBe(trio.ids.b);

		await trio.start("c");
		await completeOnC(task, crash.row.id);
	}, 60_000);

	describe("ack_timeout (C offline past a short restore deadline)", () => {
		/** C restores until it needs the user's approval, then goes offline; B enters ack_timeout and crashes right after. */
		async function overdue(title: string): Promise<{ task: Task; id: string }> {
			await begin({ point: "ack_timeout", setup: "ask", timings: { restoreDeadlineMs: 5_000 } });
			const task = await delegate(title);
			await handOff(task, { setupCommands: ["echo hi"] });
			await waitForHandoffOf(trio.c, task.id, "target", (h) => h.setup.some((s) => s.state === "pending_approval"), "C waits for the setup approval");
			await trio.stop("c");
			const crash = await crashB(task, "ack_timeout", false);
			expect(crash.row.state).toBe("ack_timeout");
			expect(crash.task).toMatchObject({ status: "blocked", fenced: false });
			return { task, id: crash.row.id };
		}

		it("stays ack_timeout after the restart; reclaim needs the override; extend revives; cancel gives the task back to B", async () => {
			const { task, id } = await overdue("Crash ack timeout, extend");
			await restartB();
			await quiet();
			expect(sourceRow(id).state).toBe("ack_timeout");
			expect(trio.b.ctx.handoffs.fence.isFrozen(task.id)).toBe(true);
			expect(trio.b.ctx.tasks.store.get(task.id)).toMatchObject({ status: "blocked", fenced: false, epoch: 0 });

			// C could not be asked: no proof it did not ack, so no reclaim without the user's override
			const refused = await api(trio.b).post<{ error: { code: string } }>(`/handoffs/${id}/reclaim`, { override: false });
			expect(refused).toMatchObject({ status: 409, body: { error: { code: "override_required" } } });
			expect(sourceRow(id).state).toBe("ack_timeout");

			const extended = await api(trio.b).post<Handoff>(`/handoffs/${id}/extend`, { minutes: 5 });
			expect(extended.status, JSON.stringify(extended.body)).toBe(200);
			expect(extended.body.state).toBe("awaiting_ack");
			expect(Date.parse(extended.body.deadlineAt as string)).toBeGreaterThan(Date.now() + 4 * 60_000);
			await quiet();
			expect(sourceRow(id).state).toBe("awaiting_ack");
			expect(trio.b.ctx.tasks.store.get(task.id)).toMatchObject({ status: "blocked", fenced: false });

			// the user gives up on C: the task is B's again
			const cancelled = await api(trio.b).del(`/handoffs/${id}`);
			expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
			expect(sourceRow(id).state).toBe("cancelled");
			expect(trio.b.ctx.handoffs.fence.isFrozen(task.id)).toBe(false);

			// C returns late: it ends its side and never executes
			await trio.start("c");
			await waitForHandoffOf(trio.c, task.id, "target", (h) => h.state === "failed" || h.state === "cancelled", "C ends its side");
			expect(executing(task)).toEqual(["b"]);
			await expectOwner(task, "b");
			await finishOn(task, "b", id);
		}, 90_000);

		it("reclaim with the override retires epoch 1 (no ack proof existed); a returning C never takes the task", async () => {
			const { task, id } = await overdue("Crash ack timeout, reclaim");
			await restartB();
			await quiet();
			expect(sourceRow(id).state).toBe("ack_timeout");

			const reclaimed = await api(trio.b).post<Handoff>(`/handoffs/${id}/reclaim`, { override: true });
			expect(reclaimed.status, JSON.stringify(reclaimed.body)).toBe(200);
			expect(reclaimed.body.state).toBe("reclaimed");
			expect(trio.b.ctx.tasks.store.get(task.id)).toMatchObject({ epoch: 1, highestSeenEpoch: 1, fenced: false, status: "blocked" });
			expect(trio.b.ctx.handoffs.fence.isFrozen(task.id)).toBe(false);

			await trio.start("c");
			const onC = await waitForHandoffOf(trio.c, task.id, "target", (h) => h.state === "failed" || h.state === "cancelled", "C ends its side");
			expect(onC.state).not.toBe("completed");
			await expectOwner(task, "b");
			await finishOn(task, "b", id);
		}, 90_000);
	});

	it("acked: the release is completed idempotently after the restart; B's runtime is not restarted and gets no prompt; C continues", async () => {
		await begin({ point: "acked" });
		const task = await delegate("Crash acked");
		await handOff(task);
		const crash = await crashB(task, "acked");
		expect(crash.row.state).toBe("acked");
		// the token is durable, the release was not done yet
		expect(crash.source.fencingToken).toBeTruthy();
		expect(crash.task).toMatchObject({ status: "blocked", fenced: false });

		await restartB();
		await completeOnC(task, crash.row.id);
		expect(trio.b.ctx.tasks.store.get(task.id)).toMatchObject({ status: "handed_off", fenced: true });
		expect(promptsOf(trio.b)).toHaveLength(crash.prompts);
		expect(spawnsOf(trio.b)).toBe(crash.spawns);
	}, 60_000);

	it("released: the restarted B completes the handoff once C's resume is known, without touching the task again", async () => {
		await begin({ point: "released" });
		const task = await delegate("Crash released");
		await handOff(task);
		const crash = await crashB(task, "released");
		expect(crash.row.state).toBe("released");
		// the task row was already handed off when the crash hit
		expect(crash.task).toMatchObject({ status: "handed_off", fenced: true });

		await restartB();
		await waitForHandoffOf(trio.b, task.id, "source", (h) => h.state === "completed", "B completes the handoff");
		await completeOnC(task, crash.row.id);
		expect(promptsOf(trio.b)).toHaveLength(crash.prompts);
		expect(spawnsOf(trio.b)).toBe(crash.spawns);
	}, 60_000);
});

describe("network disconnect between the offer and the ack", () => {
	it("C goes away while it waits for the user's setup approval: B keeps waiting without releasing; the handoff completes when C returns", async () => {
		await begin({ setup: "ask" });
		const task = await delegate("Disconnect before ack");
		const created = await handOff(task, { setupCommands: ["echo hi"] });
		const waiting = await waitForHandoffOf(trio.c, task.id, "target", (h) => h.setup.some((s) => s.state === "pending_approval"), "C waits for the setup approval");
		const bPrompts = promptsOf(trio.b).length;

		await trio.stop("c");
		await quiet();
		expect(trio.b.ctx.handoffs.store.get(created.id).state).toBe("awaiting_ack");
		expect(trio.b.ctx.tasks.store.get(task.id)).toMatchObject({ status: "blocked", fenced: false, epoch: 0 });
		expect(promptsOf(trio.b)).toHaveLength(bPrompts);

		await trio.start("c");
		const back = await waitForHandoffOf(trio.c, task.id, "target", (h) => h.setup.some((s) => s.state === "pending_approval"), "C still waits for the approval after the restart");
		expect(back.id).toBe(waiting.id);
		const approve = await api(trio.c).post(`/handoffs/${back.id}/setup`, { approve: back.setup.map((s) => s.id), deny: [] });
		expect(approve.status, JSON.stringify(approve.body)).toBe(200);
		await completeOnC(task, created.id);
	}, 60_000);
});

describe("source crash, git mode", () => {
	it("acked: the pushed work and the dedicated branch on C survive; the release completes after the restart; C delivers the branch", async () => {
		const repo = makeRepo();
		await begin({ point: "acked" });
		const projectA = await linkedProject(trio.a, trio.workspace.id, "demo-a", repo.workA);
		await linkedProject(trio.b, trio.workspace.id, "demo-b", repo.workB);
		const workC = cloneFor(repo, "work-c", "c@example.com");
		await linkedProject(trio.c, trio.workspace.id, "demo-c", workC);

		const task = await delegate("Crash acked, git", { projectId: projectA.id, deliverAs: "branch", description: ["Add a file.", "@@fake-sh echo wip > feature.txt", BLOCK].join("\n") });
		await handOff(task);
		const crash = await crashB(task, "acked");
		expect(crash.row.state).toBe("acked");
		expect(crash.task).toMatchObject({ status: "blocked", fenced: false });

		await restartB();
		await completeOnC(task, crash.row.id);
		expect(promptsOf(trio.b)).toHaveLength(crash.prompts);
		expect(spawnsOf(trio.b)).toBe(crash.spawns);
		const done = await waitForTaskOn(trio.a, task.id, (t) => t.status === "succeeded", "the result reaches A");
		const branch = done.task.result?.branch as string;
		expect(branch).toMatch(/^clam\/node-c\//);
		expect(branchesOf(repo.origin)).toContain(branch);
		// the work B pushed travelled through C's dedicated branch to the result
		expect(gitOut(repo.origin, "show", `${branch}:feature.txt`)).toBe("wip\n");
		expect(gitOut(workC, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
	}, 90_000);
});
