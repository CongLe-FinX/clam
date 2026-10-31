import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Handoff, Task, TaskDetail } from "@clam/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { HandoffTimings } from "../src/handoff/hub.ts";
import type { HandoffRow } from "../src/handoff/store.ts";
import type { TaskRow } from "../src/tasks/store.ts";
import { writeNodeSettings } from "../src/services/settings.ts";
import { api, type FullHarness } from "./full-harness.ts";
import { BLOCK, FINISH, handoffFor, startTrio, type Trio, waitForHandoffOf, waitForTaskOn } from "./handoff-fixtures.ts";
import { eventually, signedRequest } from "./net-helpers.ts";
import { promptsOf } from "./task-fixtures.ts";

/**
 * Crash recovery of the TARGET (docs/handoff-protocol.md §6.2, §6.4) end to end: A delegates a files task to B, B hands it to C, C
 * "crashes" right after persisting one of its states (fault injection through `handoffFault`), is restarted on the same data directory
 * and must converge: the task runs exactly once (on C), no step is redone, no prompt is sent twice, and A follows C.
 * Real servers, fake omp.
 */

let trio: Trio;
afterEach(async () => {
	await trio?.cleanup();
});

const RESUME = "Continuing handed-over work";
/** A reviewed setup command with an observable side effect: every run appends one `x` to `setup-count.txt` in the restored folder. */
const SETUP = `node -e "require('fs').appendFileSync('setup-count.txt','x')"`;
const TARGET_POINTS = ["received", "accepted", "persisted", "files_restored", "context_restored", "deps_ready", "validated", "session_created", "acked", "owner", "resumed"] as const;

type Timings = Partial<HandoffTimings>;

interface Begin {
	/** Fault spec of C (`handoff:target:<state>`) / of B (`handoff:source:<state>`). */
	faultC?: string;
	faultB?: string;
	b?: Timings;
	c?: Timings;
	autoAccept?: boolean;
	setup?: "ask" | "auto" | "skip";
}

const fired: string[] = [];
const fault = (spec: string) => ({ spec, mode: "throw" as const, onFire: (point: string) => fired.push(point) });

async function begin(o: Begin = {}): Promise<void> {
	fired.length = 0;
	trio = await startTrio({
		b: { ...(o.b && { handoffTimings: o.b }), ...(o.faultB && { handoffFault: fault(o.faultB) }) },
		c: { ...(o.c && { handoffTimings: o.c }), ...(o.faultC && { handoffFault: fault(o.faultC) }) },
	});
	await api(trio.b).patch(`/network/peers/${trio.ids.a}`, { autoAcceptTasks: true });
	writeNodeSettings(trio.c.ctx.db, { autoAcceptHandoffs: o.autoAccept ?? true, dependencySetup: o.setup ?? "auto" });
}

/** A delegates to B; B's agent writes a file and blocks. */
async function delegate(title: string): Promise<Task> {
	const res = await api(trio.a).post<Task>("/tasks", {
		targetNodeId: trio.ids.b,
		title,
		description: ["Do the work.", "@@fake-sh echo hello > work.txt", BLOCK].join("\n"),
		workspaceId: trio.workspace.id,
		deliverAs: "files",
	});
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	await waitForTaskOn(trio.b, res.body.id, (t) => t.status === "blocked", "B runs the task until it blocks");
	return res.body;
}

async function handOff(task: Task, extra: Record<string, unknown> = {}): Promise<Handoff> {
	const created = await api(trio.b).post<Handoff>("/handoffs", { taskId: task.id, targetNodeId: trio.ids.c, setupCommands: [SETUP], ...extra });
	expect(created.status, JSON.stringify(created.body)).toBe(202);
	return created.body;
}

const taskOn = async (node: FullHarness, id: string): Promise<TaskDetail> => (await api(node).get<TaskDetail>(`/tasks/${id}`)).body;
const stateOnC = (id: string): string | undefined => trio.c.ctx.handoffs.store.find(id)?.state;
const projectPathOnC = (taskId: string): string => (trio.c.ctx.db.$client.prepare("select path from projects where id = ?").get(trio.c.ctx.tasks.store.get(taskId).projectId) as { path: string }).path;
/** First line of every prompt a node's agent received (assertion messages). */
const heads = (node: FullHarness): string => JSON.stringify(promptsOf(node).map((p) => `${p.streamingBehavior ?? "-"} ${p.message.split("\n")[0]?.slice(0, 60)} …${p.message.slice(-70).replaceAll("\n", " ")}`));
const countOn = (node: FullHarness, id: string, prefix: string): number => node.ctx.handoffs.store.events(id).filter((e) => e.summary.startsWith(prefix)).length;

/** Crash C right after `point` became durable, then stop it. Returns the task and the handoff id. */
async function crashC(point: string, o: Begin = {}): Promise<{ task: Task; id: string; deadlineAt: string | null; row: HandoffRow; taskRow: TaskRow | undefined }> {
	await begin({ ...o, faultC: `handoff:target:${point}` });
	const task = await delegate(`Crash at ${point}`);
	const created = await handOff(task);
	await eventually(() => fired.length > 0, `the fault at target:${point} to fire`, 20_000);
	expect(fired).toEqual([`target:${point}`]);
	const row = trio.c.ctx.handoffs.store.get(created.id);
	expect(row.state).toBe(point);
	const taskRow = trio.c.ctx.tasks.store.find(task.id);
	await trio.stop("c");
	return { task, id: created.id, deadlineAt: row.deadlineAt, row, taskRow };
}

async function restartC(o: Begin = {}): Promise<void> {
	await trio.start("c", o.c ? { handoffTimings: o.c } : {});
}

/** Where the task is on each node and what A still has queued for it: attached to a timeout so a hang explains itself. */
function taskDump(taskId: string): string {
	const view = (node: FullHarness) => {
		const t = node.ctx.tasks.store.find(taskId);
		return t && { status: t.status, reason: t.reason, epoch: t.epoch, fenced: t.fenced, executor: t.executorNodeName, frozen: t.execState.handoffId ?? null, events: node.ctx.tasks.store.eventsSince(taskId, 0).slice(-6).map((e) => `${e.type}: ${e.summary}`) };
	};
	const queued = trio.a.ctx.tasks.store.outboxOfTask(taskId).map((i) => [i.kind, i.state, i.attempts, i.lastStatus, i.lastError]);
	return JSON.stringify({ a: view(trio.a), b: view(trio.b), c: view(trio.c), queuedOnA: queued }, null, 1);
}

/** What both nodes know about the handoff (undelivered calls included): attached to a timeout so a hang explains itself. */
function dump(id: string): string {
	const side = (node: FullHarness, peerId: string) => ({
		state: node.ctx.handoffs.store.find(id)?.state,
		tail: node.ctx.handoffs.store.events(id).slice(-4).map((e) => `${e.state}: ${e.summary}`),
		open: node.ctx.tasks.store.outboxOfTask(`${id}:${peerId}`).filter((i) => i.state !== "sent").map((i) => [i.kind, i.state, i.attempts, i.lastStatus, i.lastError]),
	});
	return JSON.stringify({ b: side(trio.b, trio.ids.c), c: side(trio.c, trio.ids.b) }, null, 1);
}

/** The invariant of every crash test: one executor (C), A follows it, nothing ran or was sent twice. */
async function expectConverged(task: Task, id: string, options: { ordinaryRecovery?: boolean } = {}): Promise<void> {
	const onC = await waitForHandoffOf(trio.c, task.id, "target", (h) => h.state === "completed" || h.state === "failed", "the handoff ends on C", 20_000).catch((error: unknown) => {
		throw new Error(`${String(error)}\n${dump(id)}`);
	});
	expect(onC.failure, JSON.stringify(onC.failure)).toBeNull();
	expect(onC.state).toBe("completed");
	expect(onC.steps).toHaveLength(10);
	expect(onC.steps.every((s) => s.state === "done" || s.state === "skipped")).toBe(true);

	// every step happened once: its transition is on the timeline exactly one time
	for (const prefix of ["Accepted:", "Stored the task", "Files restored", "Dependencies ready", "Workspace validated", "New agent session", "Acknowledgement written", "Ownership acquired", "Resume prompt sent"]) {
		expect(countOn(trio.c, id, prefix), `C's timeline: "${prefix}"`).toBe(1);
	}
	const events = trio.c.ctx.handoffs.store.events(id);
	expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
	// the restored folder exists once, the setup command ran once
	expect((trio.c.ctx.db.$client.prepare("select count(*) as n from projects").get() as { n: number }).n).toBe(1);
	const folder = projectPathOnC(task.id);
	// (the handed-over brief repeats the original description, so the fake agent rewrites the file: read it when the write has landed)
	await eventually(() => readFileSync(path.join(folder, "work.txt"), "utf8") === "hello\n", "work.txt holds the restored content");
	expect(readFileSync(path.join(folder, "setup-count.txt"), "utf8")).toBe("x");
	// exactly ONE new session, the one of the handoff
	const sessions = trio.c.ctx.sessions.list({ archived: false });
	expect(sessions.map((s) => s.id)).toEqual([onC.target.sessionId]);

	// one executor: B fenced, C owns epoch 1, A follows C
	await waitForHandoffOf(trio.b, task.id, "source", (h) => h.state === "released" || h.state === "completed", "B released");
	expect(countOn(trio.b, id, "Released:")).toBe(1);
	expect(trio.b.ctx.tasks.store.get(task.id)).toMatchObject({ status: "handed_off", fenced: true, highestSeenEpoch: 1 });
	expect(trio.c.ctx.tasks.store.get(task.id)).toMatchObject({ direction: "incoming", epoch: 1, fenced: false, executorNodeId: trio.ids.c });
	await eventually(async () => {
		const a = (await taskOn(trio.a, task.id)).task;
		return a.executor.nodeId === trio.ids.c && a.epoch === 1;
	}, "A follows C at epoch 1");

	// the sender notice reached A exactly once
	await eventually(() => trio.c.ctx.tasks.store.outboxByKey(trio.ids.a, `task.executor:${id}`)?.state === "sent", "the executor notice was delivered to A");
	expect(trio.c.ctx.tasks.store.outboxOfTask(`${id}:${trio.ids.a}`).filter((i) => i.kind === "task.executor")).toHaveLength(1);
	await eventually(async () => (await taskOn(trio.a, task.id)).events.some((e) => e.summary.startsWith("Handed over from")), "A mirrors C's first event");
	expect((await taskOn(trio.a, task.id)).events.filter((e) => e.summary.startsWith("Handed over from"))).toHaveLength(1);

	// exactly one resume prompt for this handoff, none on B
	expect(promptsOf(trio.c).filter((p) => p.message.includes(RESUME)), heads(trio.c)).toHaveLength(1);
	expect(promptsOf(trio.b).filter((p) => p.message.includes(RESUME))).toEqual([]);

	if (options.ordinaryRecovery) {
		// After `resumed` the task is an ordinary local task again (§6.2). Where the crash caught the agent decides how it goes on, and
		// both outcomes are correct: mid-turn → the restart prompts the agent once to continue and the task ends by itself;
		// turn already settled (the agent reported `blocked` before the crash) → nothing is re-prompted, the task waits for a message.
		const settled = await eventually(() => {
			const t = trio.c.ctx.tasks.store.get(task.id);
			return t.status === "succeeded" || t.status === "blocked" ? t.status : undefined;
		}, "C's task settles after the restart", 40_000);
		const restartPrompts = promptsOf(trio.c).filter((p) => p.message.includes("The node restarted while you were working"));
		if (settled === "blocked") {
			expect(restartPrompts, heads(trio.c)).toHaveLength(0);
			const instruct = await api(trio.a).post(`/tasks/${task.id}/messages`, { text: `Please wrap up.\n${FINISH}`, kind: "instruction" });
			expect(instruct.status, JSON.stringify(instruct.body)).toBe(201);
		} else {
			expect(restartPrompts, heads(trio.c)).toHaveLength(1);
		}
		const done = await waitForTaskOn(trio.a, task.id, (t) => t.status === "succeeded", "A sees the task end on C", 40_000).catch((error: unknown) => {
			throw new Error(`${String(error)}\n${taskDump(task.id)}\nC prompts: ${heads(trio.c)}`);
		});
		expect(done.task.executor.nodeId).toBe(trio.ids.c);
		expect(promptsOf(trio.c).filter((p) => p.message.includes("The node restarted while you were working")), heads(trio.c).toString()).toHaveLength(settled === "blocked" ? 0 : 1);
	} else {
		// the work finishes on C, A sees the result, B never prompts again
		const instruct = await api(trio.a).post(`/tasks/${task.id}/messages`, { text: `Please wrap up.\n${FINISH}`, kind: "instruction" });
		expect(instruct.status, JSON.stringify(instruct.body)).toBe(201);
		const done = await waitForTaskOn(trio.a, task.id, (t) => t.status === "succeeded", "A sees the task succeed", 20_000).catch((error: unknown) => {
			throw new Error(`${String(error)}\n${taskDump(task.id)}\nC prompts: ${heads(trio.c)}`);
		});
		expect(done.task.executor.nodeId).toBe(trio.ids.c);
		expect(promptsOf(trio.c).filter((p) => p.message.includes("Please wrap up")), heads(trio.c)).toHaveLength(1);
	}
	expect(promptsOf(trio.b).filter((p) => p.message.includes("Please wrap up"))).toEqual([]);
	expect((await taskOn(trio.b, task.id)).task.status).toBe("handed_off");
}

describe("target crash at every state (docs/handoff-protocol.md §6.2)", () => {
	for (const point of TARGET_POINTS) {
		it(`crash after target:${point} → restart converges, the task runs once on C`, async () => {
			const crashed = await crashC(point);
			await restartC();
			await expectConverged(crashed.task, crashed.id, { ordinaryRecovery: point === "resumed" });
		}, 120_000);
	}
});

describe("target crash, further recovery variants", () => {
	it("received without auto-accept: the offer is still waiting after the restart and a later accept continues normally", async () => {
		const crashed = await crashC("received", { autoAccept: false });
		await restartC();
		const waiting = await waitForHandoffOf(trio.c, crashed.task.id, "target", (h) => h.state === "received", "the offer is back on C");
		expect(waiting.actions).toEqual(["accept", "reject"]);
		expect(waiting.steps[0]).toMatchObject({ n: 1, state: "done" });
		// nothing moves on its own
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(stateOnC(crashed.id)).toBe("received");
		expect((await handoffFor(trio.b, crashed.task.id, "source"))?.state).toBe("offered");
		const decided = await api(trio.c).post(`/handoffs/${crashed.id}/decide`, { decision: "accept" });
		expect(decided.status, JSON.stringify(decided.body)).toBe(200);
		await expectConverged(crashed.task, crashed.id);
	});

	for (const point of ["accepted", "persisted", "validated"] as const) {
		it(`${point}: when the restore deadline passed during the outage C fails (timeout), cleans up what it created, never continues, and B stays the executor`, async () => {
			const timings: Timings = { restoreDeadlineMs: 2_000, sweepMs: 100 };
			const crashed = await crashC(point, { b: timings, c: timings });
			expect(crashed.deadlineAt).not.toBeNull();
			await eventually(() => Date.now() > Date.parse(crashed.deadlineAt as string), "the deadline to pass while C is down", 10_000);
			await restartC({ c: timings });
			const failed = await waitForHandoffOf(trio.c, crashed.task.id, "target", (h) => h.state === "failed", "C fails the handoff after the deadline");
			expect(failed.failure).toMatchObject({ code: "timeout" });
			// the restore never went on: nothing prompted, no epoch taken
			expect(promptsOf(trio.c)).toEqual([]);
			// ... and what the handoff created is gone: no frozen task record, no unused session, no folder it created, no artifacts
			await eventually(() => trio.c.ctx.handoffs.store.get(crashed.id).meta.cleanedUp === true, "the recovery cleanup to finish");
			expect(trio.c.ctx.tasks.store.find(crashed.task.id)).toBeUndefined();
			expect(trio.c.ctx.sessions.list({ archived: false })).toEqual([]);
			expect((trio.c.ctx.db.$client.prepare("select count(*) as n from projects").get() as { n: number }).n).toBe(0);
			await eventually(() => !existsSync(path.join(trio.c.dataDir, "handoffs", crashed.id)), "the handoff directory to be gone");
			// B is still the executor of its own epoch (whatever it concluded about the offer), A mirrors B
			const source = await waitForHandoffOf(trio.b, crashed.task.id, "source", (h) => ["failed", "rejected", "ack_timeout", "cancelled"].includes(h.state), "B learns that the handoff did not go through");
			expect(source.state).not.toBe("released");
			expect(trio.b.ctx.tasks.store.get(crashed.task.id)).toMatchObject({ status: "blocked", fenced: false, epoch: 0 });
			expect((await taskOn(trio.a, crashed.task.id)).task.executor.nodeId).toBe(trio.ids.b);
		});
	}

	it("session_created: the session directory is reopened (not recreated) and the ack is written once, after the restart", async () => {
		const crashed = await crashC("session_created");
		const before = crashed.row.targetSessionId;
		expect(before).not.toBeNull();
		expect(crashed.row.ackAt).toBeNull();
		await restartC();
		await expectConverged(crashed.task, crashed.id);
		expect(trio.c.ctx.handoffs.store.get(crashed.id).targetSessionId).toBe(before);
	});

	it("acked: the ack row survives the crash; the source is told once and releases once", async () => {
		const crashed = await crashC("acked");
		const row = crashed.row;
		expect(row.ackAt).not.toBeNull();
		expect(row.fencingToken).not.toBeNull();
		await restartC();
		await expectConverged(crashed.task, crashed.id);
		expect(trio.c.ctx.tasks.store.outboxOfTask(`${crashed.id}:${trio.ids.b}`).filter((i) => i.kind === "handoff.ack")).toHaveLength(1);
		expect(countOn(trio.b, crashed.id, "Released:")).toBe(1);
	});

	it("owner: the resume prompt is sent exactly once after the restart", async () => {
		const crashed = await crashC("owner");
		expect(crashed.taskRow).toMatchObject({ epoch: 1 });
		expect(promptsOf(trio.c).filter((p) => p.message.includes(RESUME))).toEqual([]);
		await restartC();
		await expectConverged(crashed.task, crashed.id);
		expect(promptsOf(trio.c).filter((p) => p.message.includes(RESUME))).toHaveLength(1);
	});
});

describe("lost ack response (docs §6.4)", () => {
	it("C stays acked while the source cannot answer, takes the epoch only after the handoff deadline, and both nodes end consistent", async () => {
		const timings: Timings = { restoreDeadlineMs: 7_000 };
		// B persists the ack (valid, durable) and "crashes" before it answers and before it releases; its node then goes away for good.
		await begin({ faultB: "handoff:source:acked", b: timings, c: timings });
		const task = await delegate("Lost ack response");
		const created = await handOff(task);
		await eventually(() => fired.includes("source:acked"), "B persists the ack and crashes", 20_000);
		await trio.stop("b");

		const acked = await waitForHandoffOf(trio.c, task.id, "target", (h) => h.state === "acked", "C wrote the ack and waits for the answer");
		const deadline = Date.parse(acked.deadlineAt as string);
		// never earlier: while the deadline has not passed C neither takes the epoch nor resumes
		const watchUntil = Math.min(deadline - 1_500, Date.now() + 600);
		while (Date.now() < watchUntil) {
			expect(stateOnC(created.id)).toBe("acked");
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		expect(Date.now()).toBeLessThan(deadline);
		expect(trio.c.ctx.tasks.store.get(task.id)).toMatchObject({ epoch: 0 });
		expect(promptsOf(trio.c).filter((p) => p.message.includes(RESUME))).toEqual([]);

		// after the deadline, no reclaim seen: C is the owner at epoch n+1 and resumes
		const owner = await waitForHandoffOf(trio.c, task.id, "target", (h) => ["owner", "resumed", "completed"].includes(h.state), "C acquires the epoch after the deadline", 30_000);
		expect(owner.failure).toBeNull();
		const ownerEvent = trio.c.ctx.handoffs.store.events(created.id).find((e) => e.state === "owner");
		expect(Date.parse(ownerEvent?.at as string)).toBeGreaterThanOrEqual(deadline);
		expect(trio.c.ctx.tasks.store.get(task.id)).toMatchObject({ epoch: 1, fenced: false, executorNodeId: trio.ids.c });
		await eventually(() => promptsOf(trio.c).filter((p) => p.message.includes(RESUME)).length === 1, "C resumes once");

		// B comes back: it finds its durable ack, fences and releases; it never ran the task again
		await trio.start("b");
		await waitForHandoffOf(trio.b, task.id, "source", (h) => h.state === "released" || h.state === "completed", "B releases after its restart", 30_000);
		expect(trio.b.ctx.tasks.store.get(task.id)).toMatchObject({ status: "handed_off", fenced: true, highestSeenEpoch: 1 });
		await waitForHandoffOf(trio.c, task.id, "target", (h) => h.state === "completed", "C completes", 30_000);
		await eventually(async () => {
			const a = (await taskOn(trio.a, task.id)).task;
			return a.executor.nodeId === trio.ids.c && a.epoch === 1;
		}, "A follows C at epoch 1");

		const instruct = await api(trio.a).post(`/tasks/${task.id}/messages`, { text: `Please wrap up.\n${FINISH}`, kind: "instruction" });
		expect(instruct.status).toBe(201);
		await waitForTaskOn(trio.a, task.id, (t) => t.status === "succeeded", "A sees the task succeed", 40_000);
		expect(promptsOf(trio.c).filter((p) => p.message.includes(RESUME))).toHaveLength(1);
		expect(promptsOf(trio.b).filter((p) => p.message.includes(RESUME) || p.message.includes("Please wrap up"))).toEqual([]);
		expect(trio.c.ctx.tasks.store.outboxOfTask(`${created.id}:${trio.ids.b}`).filter((i) => i.kind === "handoff.ack")).toHaveLength(1);
	});
});

describe("reclaim and a stale ack", () => {
	it("B reclaims while C is slow; C's late ack is refused (stale_epoch), C ends failed(superseded) and B keeps running its task at epoch n+1", async () => {
		// C waits for the user's approval of the setup command (it is "slow") and never sweeps; B gives up quickly.
		await begin({ setup: "ask", b: { restoreDeadlineMs: 1_500, sweepMs: 100 }, c: { sweepMs: 3_600_000 } });
		const task = await delegate("Reclaimed before the ack");
		const created = await handOff(task);
		const waiting = await waitForHandoffOf(trio.c, task.id, "target", (h) => h.setup.some((s) => s.state === "pending_approval"), "C waits for the setup approval");
		await waitForHandoffOf(trio.b, task.id, "source", (h) => h.state === "ack_timeout", "B's acknowledgement is overdue", 20_000);

		// the notice of the reclaim cannot reach C (C withdraws handoff.receive from B): C only learns about it from the refused ack
		await trio.revoke("c", "b", ["handoff.receive"]);
		const reclaimed = await api(trio.b).post<Handoff>(`/handoffs/${created.id}/reclaim`, { override: true });
		expect(reclaimed.status, JSON.stringify(reclaimed.body)).toBe(200);
		expect(reclaimed.body.state).toBe("reclaimed");
		expect(trio.c.ctx.handoffs.store.get(created.id).state).toBe("context_restored");

		// B continues as the owner of epoch n+1, unfenced and not frozen
		expect(trio.b.ctx.tasks.store.get(task.id)).toMatchObject({ epoch: 1, highestSeenEpoch: 1, fenced: false, status: "blocked" });
		expect(trio.b.ctx.handoffs.fence.isFrozen(task.id)).toBe(false);
		expect(trio.b.ctx.handoffs.fence.isFenced(task.id)).toBe(false);

		// C's user approves; C restores on and sends its (now stale) ack
		const approved = await api(trio.c).post(`/handoffs/${created.id}/setup`, { approve: waiting.setup.map((s) => s.id), deny: [] });
		expect(approved.status, JSON.stringify(approved.body)).toBe(200);
		const failed = await waitForHandoffOf(trio.c, task.id, "target", (h) => h.state === "failed", "C's ack is refused", 30_000);
		expect(failed.failure).toMatchObject({ code: "superseded" });
		const ackRow = trio.c.ctx.tasks.store.outboxByKey(trio.ids.b, `handoff.ack:${created.id}`);
		expect(ackRow).toMatchObject({ state: "dead", lastStatus: 409 });
		// C never acquired the epoch, never prompted, and removed what the handoff created
		expect(trio.c.ctx.handoffs.store.events(created.id).some((e) => e.state === "owner")).toBe(false);
		await eventually(() => trio.c.ctx.tasks.store.find(task.id) === undefined, "C's frozen task record is removed");
		await eventually(() => trio.c.ctx.sessions.list({ archived: false }).length === 0, "C's unused session is removed");
		expect(promptsOf(trio.c)).toEqual([]);

		// B's task is not fenced: A (which still follows B, now at epoch 1) finishes it on B, B's handoff stays reclaimed
		expect((await handoffFor(trio.b, task.id, "source"))?.state).toBe("reclaimed");
		const instruct = await api(trio.a).post(`/tasks/${task.id}/messages`, { text: `Please wrap up.\n${FINISH}`, kind: "instruction" });
		expect(instruct.status, JSON.stringify(instruct.body)).toBe(201);
		const done = await waitForTaskOn(trio.a, task.id, (t) => t.status === "succeeded", "A sees B finish its task", 40_000);
		expect(done.task.executor.nodeId).toBe(trio.ids.b);
		expect(promptsOf(trio.b).filter((p) => p.message.includes("Please wrap up"))).toHaveLength(1);
		expect(promptsOf(trio.c)).toEqual([]);
		expect((await handoffFor(trio.b, task.id, "source"))?.state).toBe("reclaimed");
	});
});

describe("replayed and duplicated requests", () => {
	it("a replay with the same Idempotency-Key answers the stored body and changes nothing; the same data under a new key is idempotent by handoff id", async () => {
		await begin();
		const task = await delegate("Replays");
		const created = await handOff(task);
		const id = created.id;
		await waitForHandoffOf(trio.c, task.id, "target", (h) => h.state === "completed", "the handoff completes on C", 30_000);
		await waitForHandoffOf(trio.b, task.id, "source", (h) => h.state === "completed", "the handoff completes on B", 30_000);
		await eventually(() => trio.c.ctx.tasks.store.outboxByKey(trio.ids.a, `task.executor:${id}`)?.state === "sent", "the executor notice was delivered");

		// the handoff rows and their timelines, and what decides ownership on the task rows (the agent's own progress may still move other columns)
		const owner = (node: FullHarness) => {
			const { epoch, highestSeenEpoch, fenced, executorNodeId, direction } = node.ctx.tasks.store.get(task.id);
			return { epoch, highestSeenEpoch, fenced, executorNodeId, direction };
		};
		const snapshot = () =>
			JSON.stringify({
				b: [trio.b.ctx.handoffs.store.get(id), trio.b.ctx.handoffs.store.events(id).length, owner(trio.b)],
				c: [trio.c.ctx.handoffs.store.get(id), trio.c.ctx.handoffs.store.events(id).length, owner(trio.c)],
			});
		const before = snapshot();
		const promptsB = promptsOf(trio.b).length;
		const promptsC = promptsOf(trio.c).length;

		/** The queued call, as it was sent: the very same body and Idempotency-Key. */
		const queued = (sender: FullHarness, peerId: string, key: string) => {
			const item = sender.ctx.tasks.store.outboxByKey(peerId, key);
			expect(item, key).toBeDefined();
			expect(item?.state, key).toBe("sent");
			return item as NonNullable<typeof item>;
		};
		const calls = [
			{ name: "offer", from: trio.b, to: trio.c, item: queued(trio.b, trio.ids.c, `handoff.offer:${id}`) },
			{ name: "accept", from: trio.c, to: trio.b, item: queued(trio.c, trio.ids.b, `handoff.accept:${id}`) },
			{ name: "ack", from: trio.c, to: trio.b, item: queued(trio.c, trio.ids.b, `handoff.ack:${id}`) },
			{ name: "state", from: trio.c, to: trio.b, item: queued(trio.c, trio.ids.b, `handoff.state:${id}:target:persisted`) },
		];
		const replayOf = (call: (typeof calls)[number], key: string) => signedRequest(call.from, call.to.netUrl, { method: "POST", path: call.item.path, body: call.item.body, idempotencyKey: key });

		for (const call of calls) {
			const first = await replayOf(call, call.item.idempotencyKey);
			expect([200, 201], `${call.name}: ${first.text}`).toContain(first.status);
			expect(first.headers.get("idempotent-replay"), call.name).toBe("true");
			const second = await replayOf(call, call.item.idempotencyKey);
			expect(second.status, call.name).toBe(first.status);
			expect(second.headers.get("idempotent-replay"), call.name).toBe("true");
			expect(second.text, call.name).toBe(first.text);

			// the same data under a NEW key is executed again but idempotent by handoff id: same answer, nothing changes
			const fresh = await replayOf(call, `fresh-${call.name}-${Math.random().toString(36).slice(2)}`);
			expect(fresh.status, `${call.name}: ${fresh.text}`).toBeLessThan(300);
			expect(fresh.headers.get("idempotent-replay"), call.name).toBeNull();
			if (call.name === "ack") expect(fresh.body, "ack").toEqual(first.body);
			if (call.name === "offer") expect(fresh.body).toEqual({ handoffId: id, state: "received" });
			expect(snapshot(), `${call.name} changed something`).toBe(before);

			// the same key with a different request is a conflict, not a replay
			const conflict = await signedRequest(call.from, call.to.netUrl, { method: "POST", path: call.item.path, body: { ...(call.item.body as object), extra: call.name }, idempotencyKey: call.item.idempotencyKey });
			expect(conflict.status, call.name).toBe(409);
		}

		// an ack for other data under a new key is refused and changes nothing
		const ack = calls[2] as (typeof calls)[number];
		const other = await signedRequest(trio.c, trio.b.netUrl, { method: "POST", path: ack.item.path, body: { ...(ack.item.body as object), manifestSha256: "a".repeat(64) }, idempotencyKey: `other-${Math.random().toString(36).slice(2)}` });
		expect(other.status).toBe(409);
		expect(snapshot()).toBe(before);
		expect(promptsOf(trio.b)).toHaveLength(promptsB);
		expect(promptsOf(trio.c)).toHaveLength(promptsC);
		expect(trio.b.ctx.handoffs.store.get(id).state).toBe("completed");
		expect(trio.c.ctx.handoffs.store.get(id).state).toBe("completed");
	});
});
