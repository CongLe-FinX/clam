import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { wire } from "@clam/agent-network";
import type { Peer, Task } from "@clam/contracts";
import { plainMsg } from "@clam/contracts";
import { projects } from "@clam/database";
import { HandoffManifest, makeFencingToken, sha256OfCanonical } from "@clam/handoff-engine";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../src/http/errors.ts";
import type { HandoffRow } from "../src/handoff/store.ts";
import { api, type FullHarness } from "./full-harness.ts";
import { BLOCK, startTrio, type Trio } from "./handoff-fixtures.ts";
import { eventually, peerOf, signedRequest } from "./net-helpers.ts";
import { git, isolateGitConfig, startTaskPair, type GitConfigIsolation, type TaskPair } from "./task-fixtures.ts";

/**
 * Source side of a task handoff against hand-built targets: the real source flow, real tasks/sessions (fake omp), real wire routes. The
 * target's own flow is replaced by a recorder (`stubTarget`), and what a target sends back (accept, ack, state) is signed by the real node
 * key of that peer through `signedRequest`.
 */

let gitConfig: GitConfigIsolation;
beforeAll(() => {
	gitConfig = isolateGitConfig();
});
afterAll(() => gitConfig.restore());

/** The target node's flow, replaced by a recorder that accepts every offer. */
function stubTarget(node: FullHarness): wire.HandoffOfferRequest[] {
	const offers: wire.HandoffOfferRequest[] = [];
	node.ctx.handoffs.target.receive = async (_peerId, request) => {
		offers.push(request);
		return { row: undefined as unknown as HandoffRow, created: true };
	};
	return offers;
}

const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
const now = (): string => new Date().toISOString();

function expectApiError(error: unknown, status: number, code: string): void {
	expect(error).toBeInstanceOf(ApiError);
	expect(error).toMatchObject({ status, code });
}

async function rejection(work: Promise<unknown>): Promise<unknown> {
	try {
		await work;
	} catch (error) {
		return error;
	}
	throw new Error("expected the call to be rejected");
}

describe("source flow on three nodes (vcs none / files, wire paths)", () => {
	let trio: Trio;
	let offers: wire.HandoffOfferRequest[];
	let counter = 0;

	beforeAll(async () => {
		trio = await startTrio();
		offers = stubTarget(trio.c);
		const peer = (await peerOf(trio.b, trio.ids.a)) as Peer;
		const res = await api(trio.b).patch<Peer>(`/network/peers/${peer.id}`, { autoAcceptTasks: true });
		expect(res.status).toBe(200);
	}, 90_000);

	afterAll(async () => {
		await trio?.cleanup();
	});

	const b = (): FullHarness => trio.b;

	/** A task delegated by A that B runs and parks as `blocked` (an idle session: nothing turns while the handoff is prepared). */
	async function startTask(description = BLOCK): Promise<Task> {
		const title = `Handoff task ${++counter}`;
		const created = await api(trio.a).post<Task>("/tasks", { targetNodeId: trio.ids.b, title, description, deliverAs: "files" });
		expect(created.status, JSON.stringify(created.body)).toBe(201);
		return eventually(
			() => {
				const task = b().ctx.tasks.store.list({ direction: "incoming" }).find((t) => t.title === title);
				return task?.status === "blocked" ? b().ctx.tasks.store.toTask(task) : undefined;
			},
			`task ${title} to be blocked on B`,
			30_000,
		);
	}

	const projectDir = (task: Task): string => {
		const row = b().ctx.db.select().from(projects).where(eq(projects.id, task.projectId as string)).get();
		if (!row) throw new Error("the task has no project");
		return row.path;
	};

	const source = () => b().ctx.handoffs.source;
	const store = () => b().ctx.handoffs.store;
	const start = (taskId: string, extra: Partial<{ includeTranscript: boolean; stopRunning: boolean; setupCommands: string[]; checkCommand: string }> = {}) =>
		source().create({ taskId, targetNodeId: trio.ids.c, stopRunning: false, includeTranscript: false, setupCommands: [], ...extra });
	const stateOf = (id: string) => store().get(id).state;
	const waitState = (id: string, state: string, timeoutMs = 20_000) => eventually(() => (stateOf(id) === state ? store().get(id) : undefined), `handoff ${id} to be ${state} (is ${stateOf(id)})`, timeoutMs);
	const net = (path: string, body: unknown) => signedRequest(trio.c, trio.b.netUrl, { method: "POST", path, body });
	/** The `/state` notices queued for the target (the target holds no row in these tests, so they are not delivered). */
	const notices = (id: string): string[] =>
		b()
			.ctx.tasks.store.outboxOfTask(`${id}:${trio.ids.c}`)
			.filter((o) => o.kind === "handoff.state")
			.map((o) => (o.body as wire.HandoffStateRequest).state);

	function ackBody(row: HandoffRow, over: Partial<wire.HandoffAckRequest> = {}, signer: FullHarness = trio.c): wire.HandoffAckRequest {
		const manifestSha256 = row.manifestSha256 as string;
		return {
			epoch: row.toEpoch,
			targetSessionId: "ses_target",
			manifestSha256,
			validation: { gitCommit: null, workspaceClean: true, depsOk: true },
			ackedAt: now(),
			fencingToken: makeFencingToken({ taskId: row.subjectId, epoch: row.toEpoch, handoffId: row.id, manifestSha256, sign: signer.ctx.identity.sign }),
			...over,
		};
	}

	async function offered(task: Task): Promise<HandoffRow> {
		const row = await start(task.id);
		expect(row.state).toBe("preparing");
		return waitState(row.id, "offered");
	}

	async function accepted(task: Task): Promise<HandoffRow> {
		const row = await offered(task);
		const res = await net(`/handoffs/${row.id}/accept`, { epoch: row.toEpoch, targetAgentName: "Agent C", acceptedAt: now() } satisfies wire.HandoffAcceptRequest);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		return waitState(row.id, "awaiting_ack");
	}

	it("freezes the task, appends one note, seals a summary-only manifest and queues the offer", async () => {
		const task = await startTask();
		const before = b().ctx.tasks.store.get(task.id);
		const row = await offered(task);

		const manifest = HandoffManifest.parse(row.manifest);
		expect(row.manifestSha256).toBe(sha256OfCanonical(row.manifest));
		expect(manifest).toMatchObject({ handoffId: row.id, vcs: "none", git: null, files: null, fromEpoch: before.epoch, toEpoch: before.epoch + 1, source: { nodeId: trio.ids.b }, target: { nodeId: trio.ids.c } });
		expect(manifest.task).toMatchObject({ id: task.id, status: "blocked", sender: { nodeId: trio.ids.a }, taskCorrelationId: before.correlationId });
		expect(manifest.conversationSummary).toMatchObject({ generatedBy: "omp-handoff", scanned: true });
		expect(manifest.conversationSummary.text).toContain("# Handoff");
		expect(manifest.expiresAt).toBe(row.expiresAt);

		// One note on the task timeline, then the sealed sequence number.
		const after = b().ctx.tasks.store.get(task.id);
		const events = b().ctx.tasks.store.eventsSince(task.id, before.lastEventSeq);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: "note", seq: after.lastEventSeq });
		expect(events[0]?.summary).toContain(`Handing over to node-c (handoff ${row.id})`);
		expect(manifest.task.lastEventSeq).toBe(after.lastEventSeq);
		expect(b().ctx.handoffs.fence.isFrozen(task.id)).toBe(true);

		const offer = await eventually(() => offers.find((o) => o.handoffId === row.id), "the offer to reach the target");
		expect(offer).toMatchObject({ taskId: task.id, fromEpoch: row.fromEpoch, toEpoch: row.toEpoch, manifestSha256: row.manifestSha256 });
		expect(sha256OfCanonical(offer.manifest)).toBe(offer.manifestSha256);
		const states = store().events(row.id).map((e) => e.state);
		expect(states[0]).toBe("draft");
		expect(states).toContain("preparing");
		expect(states.at(-1)).toBe("offered");

		// A second handoff of the same task while this one lives is refused.
		expectApiError(await rejection(start(task.id)), 409, "competing_handoff");
		await source().cancel(row.id);
	});

	it("bundles the task folder for vcs files with the base manifest and required files", async () => {
		const task = await startTask();
		const dir = projectDir(task);
		writeFileSync(path.join(dir, "notes.txt"), "work in progress\n");
		const row = await offered(task);
		const manifest = HandoffManifest.parse(row.manifest);
		expect(manifest.vcs).toBe("files");
		expect(manifest.files).toMatchObject({ fileCount: 1 });
		expect(manifest.requiredFiles).toEqual(["notes.txt"]);
		const bundle = store().artifact(row.id, manifest.files?.artifactId ?? "");
		expect(bundle).toMatchObject({ kind: "files-bundle", sha256: manifest.files?.sha256, size: manifest.files?.size });
		expect(sha256(bundle?.path ?? "")).toBe(manifest.files?.sha256);
		const base = store().artifact(row.id, manifest.files?.base?.artifactId ?? "");
		expect(base?.kind).toBe("base-manifest");
		expect(JSON.parse(readFileSync(base?.path ?? "", "utf8")).files).toEqual([]);
		expect(store().toHandoff(row).files).toEqual({ sha256: manifest.files?.sha256, size: manifest.files?.size, fileCount: 1 });
		await source().cancel(row.id);
		expect(b().ctx.handoffs.fence.isFrozen(task.id)).toBe(false);
	});

	it("refuses files that look like credentials (prepare_failed, secret_detected), then a retry succeeds once they are gone", async () => {
		const task = await startTask();
		const dir = projectDir(task);
		const secretFile = path.join(dir, "config.txt");
		writeFileSync(secretFile, "aws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n");
		const created = await start(task.id);
		const failed = await waitState(created.id, "prepare_failed");
		expect(failed).toMatchObject({ failureCode: "secret_detected" });
		expect(failed.failureDetail).toContain("config.txt");
		expect(failed.failureDetail).not.toContain("wJalrXUtnFEMI");
		expect(store().toHandoff(failed).actions).toEqual(["retry"]);
		expect(b().ctx.handoffs.fence.isFrozen(task.id)).toBe(false);
		expect(offers.some((o) => o.handoffId === created.id)).toBe(false);

		rmSync(secretFile);
		writeFileSync(path.join(dir, "ok.txt"), "fine\n");
		const retried = await source().retry(created.id);
		expect(retried.state).toBe("preparing");
		const row = await waitState(created.id, "offered");
		expect(HandoffManifest.parse(row.manifest).requiredFiles).toEqual(["ok.txt"]);
		expect(row.failureCode).toBeNull();
		await source().cancel(row.id);
	});

	it("validates the request: unknown task, wrong state, missing capability", async () => {
		expectApiError(await rejection(start("tsk_unknown")), 404, "not_found");
		const task = await startTask();
		expectApiError(await rejection(source().create({ taskId: task.id, targetNodeId: "nod_unknown", stopRunning: false, includeTranscript: false, setupCommands: [] })), 404, "not_found");
		await trio.revoke("c", "b", ["handoff.receive"]);
		try {
			expectApiError(await rejection(start(task.id)), 409, "capability_missing");
		} finally {
			await trio.grant("c", "b", ["handoff.receive"]);
		}
		expect(b().ctx.handoffs.fence.isFrozen(task.id)).toBe(false);
		expect(store().bySubject(task.id)).toEqual([]);
	});

	it("accept moves to awaiting_ack with a deadline and is idempotent; a stale epoch is refused", async () => {
		const task = await startTask();
		const row = await offered(task);
		const first = await net(`/handoffs/${row.id}/accept`, { epoch: row.toEpoch, targetAgentName: "Agent C", acceptedAt: now() });
		expect(first.status).toBe(200);
		expect(first.body).toMatchObject({ handoffId: row.id, state: "accepted" });
		const awaiting = await waitState(row.id, "awaiting_ack");
		expect(first.body.deadlineAt).toBe(awaiting.deadlineAt);
		expect(awaiting.targetAgentName).toBe("Agent C");
		const replay = await net(`/handoffs/${row.id}/accept`, { epoch: row.toEpoch, targetAgentName: "Agent C", acceptedAt: now() });
		expect(replay.body).toEqual(first.body);
		const stale = await net(`/handoffs/${row.id}/accept`, { epoch: row.toEpoch + 1, acceptedAt: now() });
		expect(stale).toMatchObject({ status: 409, body: { error: { code: "stale_epoch" } } });
		await source().cancel(row.id);
		const late = await net(`/handoffs/${row.id}/accept`, { epoch: row.toEpoch, acceptedAt: now() });
		expect(late.body).toMatchObject({ state: "rejected" });
	});

	it("rejects bad acks (hash, epoch, key), persists a valid one first, releases the task and answers duplicates identically", async () => {
		const task = await startTask();
		const row = await accepted(task);
		const sealed = b().ctx.tasks.store.get(task.id);
		const ackPath = `/handoffs/${row.id}/ack`;

		expect((await net(ackPath, ackBody(row, { manifestSha256: "0".repeat(64) }))).body).toMatchObject({ error: { code: "hash_mismatch" } });
		expect((await net(ackPath, ackBody(row, { epoch: row.toEpoch + 1 }))).body).toMatchObject({ error: { code: "stale_epoch" } });
		const forged = await net(ackPath, ackBody(row, {}, trio.a));
		expect(forged).toMatchObject({ status: 403, body: { error: { code: "invalid_fencing_token" } } });
		expect(stateOf(row.id)).toBe("awaiting_ack");
		expect(b().ctx.tasks.store.get(task.id).status).toBe("blocked");

		const request = ackBody(row);
		const ack = await net(ackPath, request);
		expect(ack.status, JSON.stringify(ack.body)).toBe(200);
		expect(ack.body).toMatchObject({ handoffId: row.id, state: "acked", fencingToken: request.fencingToken, sourceLastEventSeq: sealed.lastEventSeq });
		expect(store().get(row.id)).toMatchObject({ fencingToken: request.fencingToken, targetSessionId: "ses_target", ackAt: request.ackedAt });

		await waitState(row.id, "released");
		const after = b().ctx.tasks.store.get(task.id);
		expect(after).toMatchObject({ status: "handed_off", fenced: true, epoch: sealed.epoch, highestSeenEpoch: row.toEpoch, executorNodeId: trio.ids.c, executorNodeName: "node-c" });
		expect(after.lastEventSeq).toBe(sealed.lastEventSeq);
		expect(b().ctx.tasks.store.eventsSince(task.id, sealed.lastEventSeq)).toEqual([]);
		expect(after.executorSessionId && b().ctx.runtime.get(after.executorSessionId)).toBeFalsy();
		expect(notices(row.id)).toContain("released");

		const duplicate = await net(ackPath, request);
		expect(duplicate.status).toBe(200);
		expect(duplicate.body).toEqual(ack.body);
		const other = await net(ackPath, ackBody(row, { fencingToken: ackBody(row, {}, trio.a).fencingToken }));
		expect(other.status).toBe(409);

		const resumed = await net(`/handoffs/${row.id}/state`, { epoch: row.toEpoch, state: "resumed", at: now() } satisfies wire.HandoffStateRequest);
		expect(resumed.status).toBe(200);
		await waitState(row.id, "completed");
		expect(store().events(row.id).map((e) => e.state)).toContain("acked");
	});

	it("a target that fails ends the handoff and the task runs here again; progress and an unknown state only add timeline notes", async () => {
		const task = await startTask();
		const row = await accepted(task);
		const progress = await net(`/handoffs/${row.id}/state`, { epoch: row.toEpoch, state: "persisted", summary: "manifest stored", at: now() });
		expect(progress.status).toBe(200);
		const strange = await net(`/handoffs/${row.id}/state`, { epoch: row.toEpoch, state: "brand_new_state", at: now() });
		expect(strange.status).toBe(200);
		expect(store().events(row.id).some((e) => e.summary.includes("manifest stored"))).toBe(true);
		expect(stateOf(row.id)).toBe("awaiting_ack");

		const failed = await net(`/handoffs/${row.id}/state`, { epoch: row.toEpoch, state: "failed", failure: { code: "manifest_invalid", detail: "the manifest hash does not match", step: 1 }, at: now() });
		expect(failed.status).toBe(200);
		const ended = store().get(row.id);
		expect(ended).toMatchObject({ state: "failed", failureCode: "manifest_invalid", failureDetail: "the manifest hash does not match", failureStep: 1 });
		expect(b().ctx.handoffs.fence.isFrozen(task.id)).toBe(false);
		expect(b().ctx.tasks.store.eventsSince(task.id, 0).some((e) => e.summary.includes("stays the executor"))).toBe(true);
		// A replay is accepted silently.
		expect((await net(`/handoffs/${row.id}/state`, { epoch: row.toEpoch, state: "failed", at: now() })).status).toBe(200);
		// The task can be handed off again.
		const again = await start(task.id);
		await waitState(again.id, "offered");
		await source().cancel(again.id);
	});

	it("a retryable target failure keeps the handoff awaiting the ack (frozen); a later ack after the retry is accepted", async () => {
		const task = await startTask();
		const row = await accepted(task);
		const at = now();
		const failure = { epoch: row.toEpoch, state: "failed", failure: { code: "deps_failed", detail: "npm exited with code 1", step: 5 }, at } satisfies wire.HandoffStateRequest;
		expect((await net(`/handoffs/${row.id}/state`, failure)).status).toBe(200);
		expect((await net(`/handoffs/${row.id}/state`, failure)).status).toBe(200);
		expect(stateOf(row.id)).toBe("awaiting_ack");
		expect(b().ctx.handoffs.fence.isFrozen(task.id)).toBe(true);
		const reported = store().events(row.id).filter((e) => e.summary.includes("reports deps_failed: npm exited with code 1; waiting for it to retry"));
		expect(reported).toHaveLength(1);
		expect(store().get(row.id).failureCode).toBeNull();

		// The target's user retried and it got through: the ack is accepted normally.
		const ack = await net(`/handoffs/${row.id}/ack`, ackBody(row));
		expect(ack.status, JSON.stringify(ack.body)).toBe(200);
		await waitState(row.id, "released");
	});

	it("cancel while awaiting the ack notifies the target, unfreezes, and a late ack gets 409 stale_epoch", async () => {
		const task = await startTask();
		const row = await accepted(task);
		const cancelled = await source().cancel(row.id);
		expect(cancelled.state).toBe("cancelled");
		expect(b().ctx.handoffs.fence.isFrozen(task.id)).toBe(false);
		expect(notices(row.id)).toContain("cancelled");
		const late = await net(`/handoffs/${row.id}/ack`, ackBody(row));
		expect(late).toMatchObject({ status: 409, body: { error: { code: "stale_epoch" } } });
		expect(b().ctx.tasks.store.get(task.id).status).toBe("blocked");
		expect((await source().cancel(row.id)).state).toBe("cancelled");
	});

	it("extend revives an overdue handoff; reclaim with proof retires the epoch and refuses the late ack", async () => {
		const task = await startTask();
		const row = await accepted(task);
		expectApiError(await rejection(source().reclaim(row.id, false)), 409, "conflict");

		b().ctx.handoffs.transition(row.id, "ack_timeout", { summary: plainMsg("Deadline passed"), from: ["awaiting_ack"] });
		const extended = await source().extend(row.id, 10);
		expect(extended.state).toBe("awaiting_ack");
		expect(Date.parse(extended.deadlineAt as string)).toBeGreaterThan(Date.parse(row.deadlineAt as string));
		expect(notices(row.id)).toContain("extended");
		const sameState = await source().extend(row.id, 5);
		expect(Date.parse(sameState.deadlineAt as string)).toBeGreaterThan(Date.parse(extended.deadlineAt as string));

		b().ctx.handoffs.transition(row.id, "ack_timeout", { summary: plainMsg("Deadline passed again"), from: ["awaiting_ack"] });
		const sealed = b().ctx.tasks.store.get(task.id);
		// The target answers `404`: it holds no acknowledgement for this handoff — the proof reclaim needs.
		const reclaimed = await source().reclaim(row.id, false);
		expect(reclaimed.state).toBe("reclaimed");
		expect(b().ctx.tasks.store.get(task.id)).toMatchObject({ epoch: row.toEpoch, highestSeenEpoch: row.toEpoch, status: "blocked" });
		expect(b().ctx.handoffs.fence.isFrozen(task.id)).toBe(false);
		expect(notices(row.id)).toContain("reclaimed");
		expect(sealed.epoch).toBe(row.fromEpoch);
		const late = await net(`/handoffs/${row.id}/ack`, ackBody(row));
		expect(late).toMatchObject({ status: 409, body: { error: { code: "stale_epoch" } } });
	});

	it("resume drives persisted rows: accepted → awaiting_ack, acked → released, a dead offer is queued again", async () => {
		const accepting = await startTask();
		const first = await offered(accepting);
		b().ctx.handoffs.transition(first.id, "accepted", { summary: plainMsg("accepted (test)"), from: ["offered"], notify: false });
		await source().resume(first.id);
		expect(store().get(first.id)).toMatchObject({ state: "awaiting_ack" });
		expect(store().get(first.id).deadlineAt).toBeTruthy();
		await source().cancel(first.id);

		const dead = await startTask();
		const second = await offered(dead);
		const item = b().ctx.tasks.store.outboxByKey(trio.ids.c, `handoff.offer:${second.id}`);
		expect(item).toBeDefined();
		b().ctx.tasks.store.updateOutbox(item?.id ?? "", { state: "dead" });
		await source().resume(second.id);
		await eventually(() => (b().ctx.tasks.store.outboxByKey(trio.ids.c, `handoff.offer:${second.id}`)?.state === "sent" ? true : undefined), "the offer to be delivered again");
		await source().cancel(second.id);

		const releasing = await startTask();
		const third = await accepted(releasing);
		b().ctx.handoffs.advance(third.id, "acked", { summary: plainMsg("acked (test)"), patch: { fencingToken: ackBody(third).fencingToken, targetSessionId: "ses_target", ackAt: now() }, notify: false });
		await source().resume(third.id);
		expect(store().get(third.id).state).toBe("released");
		expect(b().ctx.tasks.store.get(releasing.id)).toMatchObject({ status: "handed_off", fenced: true });
		// Releasing again is a no-op.
		await source().finishRelease(third.id);
		expect(store().get(third.id).state).toBe("released");
	});

	it("an unreachable target needs the user's override to reclaim", async () => {
		const task = await startTask();
		const row = await accepted(task);
		b().ctx.handoffs.transition(row.id, "ack_timeout", { summary: plainMsg("Deadline passed"), from: ["awaiting_ack"] });
		await trio.stop("c");
		const refused = await rejection(source().reclaim(row.id, false));
		expectApiError(refused, 409, "override_required");
		expect((refused as ApiError).message).toContain("could not be reached");
		expect(stateOf(row.id)).toBe("ack_timeout");
		const reclaimed = await source().reclaim(row.id, true);
		expect(reclaimed.state).toBe("reclaimed");
		expect(b().ctx.tasks.store.get(task.id).epoch).toBe(row.toEpoch);
	}, 60_000);
});

describe("source flow with a git repository (the target is the task's sender)", () => {
	let pair: TaskPair;
	let offers: wire.HandoffOfferRequest[];
	const clones: string[] = [];

	beforeEach(async () => {
		pair = await startTaskPair();
		offers = stubTarget(pair.a);
		await pair.autoAcceptOnB(true);
		// B hands off to A: A must grant B `handoff.receive` (what `assertPeerCapable(A, "received")` checks on B).
		const aId = pair.a.ctx.identity.nodeId;
		const bId = pair.b.ctx.identity.nodeId;
		const granted = (await peerOf(pair.a, bId))?.grantedCapabilities ?? [];
		const res = await api(pair.a).patch<Peer>(`/network/peers/${bId}`, { grantedCapabilities: [...new Set([...granted, "handoff.receive"])] });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		await eventually(async () => ((await peerOf(pair.b, aId))?.receivedCapabilities ?? []).includes("handoff.receive"), "B sees handoff.receive from A");
	}, 60_000);

	afterEach(async () => {
		await pair?.cleanup();
		for (const dir of clones.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	async function startGitTask(): Promise<Task> {
		const description = ["Write WIP.txt", "@@fake-sh echo wip > WIP.txt", BLOCK].join("\n");
		const created = await api(pair.a).post<Task>("/tasks", { targetNodeId: pair.b.ctx.identity.nodeId, projectId: pair.projectA.id, title: "Git handoff", description, deliverAs: "branch" });
		expect(created.status, JSON.stringify(created.body)).toBe(201);
		return eventually(
			() => {
				const task = pair.b.ctx.tasks.store.list({ direction: "incoming" }).find((t) => t.title === "Git handoff");
				return task?.status === "blocked" ? pair.b.ctx.tasks.store.toTask(task) : undefined;
			},
			"the git task to be blocked on B",
			30_000,
		);
	}

	const handOff = async (taskId: string): Promise<HandoffRow> => {
		const created = await pair.b.ctx.handoffs.source.create({ taskId, targetNodeId: pair.a.ctx.identity.nodeId, stopRunning: false, includeTranscript: false, setupCommands: [] });
		return eventually(() => {
			const row = pair.b.ctx.handoffs.store.get(created.id);
			if (row.state === "prepare_failed") throw new Error(`preparation failed: ${row.failureDetail}`);
			return row.state === "offered" ? row : undefined;
		}, "the git handoff to be offered", 30_000);
	};

	it("commits the work in progress on the task branch and pushes it", async () => {
		const task = await startGitTask();
		expect(readFileSync(path.join(pair.workB, "WIP.txt"), "utf8")).toBe("wip\n");
		const row = await handOff(task.id);
		const manifest = HandoffManifest.parse(row.manifest);
		expect(manifest.vcs).toBe("git");
		expect(manifest.git).toMatchObject({ repoUrl: "https://github.com/acme/demo", baseBranch: "main", pushed: true });
		expect(manifest.git?.branch).toMatch(/^clam\/node-b\/git-handoff-[a-z0-9]{6}$/);
		expect(manifest.git?.patchArtifact).toBeUndefined();
		expect(manifest.git?.commit).toBe(git(pair.origin, "rev-parse", manifest.git?.branch ?? "").trim());
		expect(git(pair.origin, "show", `${manifest.git?.branch}:WIP.txt`)).toBe("wip\n");
		expect(manifest.requiredFiles).toEqual(["WIP.txt"]);
		expect(git(pair.workB, "status", "--porcelain").trim()).toBe("");
		await eventually(() => offers.find((o) => o.handoffId === row.id), "the offer to reach A");
	});

	it("ships a binary patch on the base commit when the branch cannot be pushed, and never pushes", async () => {
		const task = await startGitTask();
		git(pair.workB, "remote", "set-url", "origin", path.join(pair.root, "missing.git"));
		const baseSha = git(pair.workB, "rev-parse", "origin/main").trim();
		const row = await handOff(task.id);
		const manifest = HandoffManifest.parse(row.manifest);
		expect(manifest.git).toMatchObject({ pushed: false, commit: baseSha });
		const patch = manifest.git?.patchArtifact;
		expect(patch).toMatchObject({ baseCommit: baseSha, files: ["WIP.txt"] });
		const artifact = pair.b.ctx.handoffs.store.artifact(row.id, patch?.artifactId ?? "");
		expect(artifact).toMatchObject({ kind: "patch", sha256: patch?.sha256 });
		expect(readFileSync(artifact?.path ?? "", "utf8")).toContain("+wip");
		expect(manifest.requiredFiles).toEqual(["WIP.txt"]);
		expect(pair.b.ctx.handoffs.store.events(row.id).some((e) => e.summary.includes("Could not push"))).toBe(true);

		// The patch applies on a clean checkout of the base commit.
		const clone = mkdtempSync(path.join(tmpdir(), "clam-handoff-apply-"));
		clones.push(clone);
		git(pair.root, "clone", pair.origin, clone);
		git(clone, "checkout", baseSha);
		execFileSync("git", ["apply", "--check", artifact?.path ?? ""], { cwd: clone });
		execFileSync("git", ["apply", artifact?.path ?? ""], { cwd: clone });
		expect(readFileSync(path.join(clone, "WIP.txt"), "utf8")).toBe("wip\n");
		expect(existsSync(path.join(pair.origin, "refs/heads/clam"))).toBe(false);
	});

	it("refuses to commit or push credentials", async () => {
		const task = await startGitTask();
		writeFileSync(path.join(pair.workB, "deploy.txt"), "aws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n");
		const created = await pair.b.ctx.handoffs.source.create({ taskId: task.id, targetNodeId: pair.a.ctx.identity.nodeId, stopRunning: false, includeTranscript: false, setupCommands: [] });
		const failed = await eventually(() => {
			const row = pair.b.ctx.handoffs.store.get(created.id);
			return row.state === "prepare_failed" ? row : undefined;
		}, "the preparation to fail");
		expect(failed.failureCode).toBe("secret_detected");
		expect(failed.failureDetail).toContain("deploy.txt");
		expect(failed.failureDetail).not.toContain("wJalrXUtnFEMI");
		expect(git(pair.workB, "log", "-1", "--format=%s").trim()).not.toContain("WIP");
		expect(git(pair.origin, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean)).toEqual(["main"]);
	});
});
