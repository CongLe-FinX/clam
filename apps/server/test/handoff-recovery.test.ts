import { peers } from "@clam/database";
import { makeFencingToken } from "@clam/handoff-engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type HandoffInsert, newHandoffId, type HandoffRow } from "../src/handoff/store.ts";
import { api, createFullHarness, type FullHarness } from "./full-harness.ts";
import { pairIn, startHandoffNode } from "./handoff-fixtures.ts";
import { eventually, peerOf } from "./net-helpers.ts";

const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();
const SHA = "a".repeat(64);

const nodes: FullHarness[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const node of nodes.splice(0)) await node.cleanup();
});

/** One node with the network + task engine (so every handoff unit exists); the sweeper is effectively off unless `sweepMs` is given. */
async function node(timings: { sweepMs?: number; completeGraceMs?: number } = {}): Promise<FullHarness> {
	const harness = await createFullHarness({ network: { nodeName: "node-x" }, handoffTimings: { sweepMs: 3_600_000, ...timings } });
	// A pinned peer nobody listens for (connection refused): outbox rows and notices need a real peer, queries to it fail fast.
	harness.ctx.db.insert(peers).values({ id: "peer_unreachable", name: "node-peer", fingerprint: "f".repeat(64), publicKey: "AAAA", keyId: "f".repeat(16), url: "http://127.0.0.1:1", status: "offline" }).run();
	nodes.push(harness);
	return harness;
}

function seed(harness: FullHarness, over: Partial<HandoffInsert> & Pick<HandoffInsert, "role" | "state">): HandoffRow {
	const id = over.id ?? newHandoffId();
	const self = harness.ctx.identity.nodeId;
	const source = over.role === "source";
	return harness.ctx.handoffs.store.insert({
		id,
		kind: "task",
		subjectId: `tsk_${id}`,
		title: "A task in flight",
		workspaceId: "ws_test",
		peerId: "peer_unreachable",
		sourceNodeId: source ? self : "peer_unreachable",
		sourceNodeName: source ? "node-x" : "node-peer",
		targetNodeId: source ? "peer_unreachable" : self,
		targetNodeName: source ? "node-peer" : "node-x",
		fromEpoch: 1,
		toEpoch: 2,
		correlationId: `corr_${id}`,
		expiresAt: iso(3_600_000),
		deadlineAt: iso(7_200_000),
		...over,
	});
}

/** The units other agents own are spied: this file tests the decisions and what recovery persists around them. */
function spies(harness: FullHarness) {
	const { source, target, fence } = harness.ctx.handoffs;
	return {
		finishRelease: vi.spyOn(source, "finishRelease").mockResolvedValue(undefined),
		sourceResume: vi.spyOn(source, "resume").mockResolvedValue(undefined),
		targetResume: vi.spyOn(target, "resume").mockResolvedValue(undefined),
		ackConfirmed: vi.spyOn(target, "ackConfirmed").mockResolvedValue(undefined),
		fence: vi.spyOn(fence, "fence").mockImplementation(() => {}),
		unfreeze: vi.spyOn(fence, "unfreeze").mockImplementation(() => {}),
	};
}

const stateOf = (harness: FullHarness, id: string): string => harness.ctx.handoffs.store.get(id).state;

describe("source recovery (docs/handoff-protocol.md §6.1)", () => {
	it("offered past expiresAt → expired, task unfrozen", async () => {
		const h = await node();
		const spy = spies(h);
		const row = seed(h, { role: "source", state: "offered", expiresAt: iso(-1_000) });
		await h.ctx.handoffs.recovery.recover();
		expect(stateOf(h, row.id)).toBe("expired");
		expect(spy.unfreeze).toHaveBeenCalledWith(row.subjectId, row.id);
		expect(spy.sourceResume).not.toHaveBeenCalled();
	});

	it("offered within its lifetime with no queued offer → handed to source.resume to re-queue it; a sent offer is not duplicated", async () => {
		const h = await node();
		const spy = spies(h);
		const lost = seed(h, { role: "source", state: "offered" });
		const sent = seed(h, { role: "source", state: "offered" });
		const item = h.ctx.tasks.store.enqueue({ peerId: sent.peerId, taskId: `${sent.id}:${sent.peerId}`, kind: "handoff.offer", refId: sent.id, path: "/handoffs", body: {}, idempotencyKey: `handoff.offer:${sent.id}` });
		h.ctx.tasks.store.updateOutbox(item.id, { state: "sent" });
		await h.ctx.handoffs.recovery.recover();
		expect(stateOf(h, lost.id)).toBe("offered");
		expect(spy.sourceResume).toHaveBeenCalledTimes(1);
		expect(spy.sourceResume).toHaveBeenCalledWith(lost.id);
	});

	it("preparing is driven by source.resume", async () => {
		const h = await node();
		const spy = spies(h);
		const row = seed(h, { role: "source", state: "preparing" });
		await h.ctx.handoffs.recovery.recover();
		expect(spy.sourceResume).toHaveBeenCalledWith(row.id);
		expect(stateOf(h, row.id)).toBe("preparing");
	});

	it("awaiting_ack past the deadline with an unreachable target → ack_timeout; never released", async () => {
		const h = await node();
		const spy = spies(h);
		const row = seed(h, { role: "source", state: "awaiting_ack", deadlineAt: iso(-1_000) });
		await h.ctx.handoffs.recovery.recover();
		expect(stateOf(h, row.id)).toBe("ack_timeout");
		expect(spy.finishRelease).not.toHaveBeenCalled();
		expect(spy.unfreeze).not.toHaveBeenCalled();
	});

	it("accepted past the deadline walks accepted → awaiting_ack → ack_timeout, persisting every hop", async () => {
		const h = await node();
		spies(h);
		const row = seed(h, { role: "source", state: "accepted", deadlineAt: iso(-1_000) });
		await h.ctx.handoffs.recovery.recover();
		expect(stateOf(h, row.id)).toBe("ack_timeout");
		expect(h.ctx.handoffs.store.events(row.id).map((e) => e.state)).toEqual(["awaiting_ack", "ack_timeout"]);
	});

	it("awaiting_ack before the deadline with an unreachable target stays awaiting_ack (no release on silence)", async () => {
		const h = await node();
		const spy = spies(h);
		const row = seed(h, { role: "source", state: "awaiting_ack" });
		await h.ctx.handoffs.recovery.recover();
		expect(stateOf(h, row.id)).toBe("awaiting_ack");
		expect(spy.finishRelease).not.toHaveBeenCalled();
	});

	it("accepted before the deadline moves to awaiting_ack", async () => {
		const h = await node();
		spies(h);
		const row = seed(h, { role: "source", state: "accepted" });
		await h.ctx.handoffs.recovery.recover();
		expect(stateOf(h, row.id)).toBe("awaiting_ack");
	});

	it("a persisted ack in awaiting_ack → acked, fence, finishRelease", async () => {
		const h = await node();
		const spy = spies(h);
		const row = seed(h, { role: "source", state: "awaiting_ack", fencingToken: "tsk:2:sig", ackAt: iso(-500) });
		await h.ctx.handoffs.recovery.recover();
		expect(stateOf(h, row.id)).toBe("acked");
		expect(spy.fence).toHaveBeenCalledWith(row.subjectId, 2, expect.any(String));
		expect(spy.finishRelease).toHaveBeenCalledWith(row.id);
	});

	it("crash after the ack (acked) → finishRelease only, the state stays for finishRelease to move", async () => {
		const h = await node();
		const spy = spies(h);
		const row = seed(h, { role: "source", state: "acked", fencingToken: "tsk:2:sig", ackAt: iso(-500) });
		await h.ctx.handoffs.recovery.recover();
		expect(spy.finishRelease).toHaveBeenCalledTimes(1);
		expect(stateOf(h, row.id)).toBe("acked");
	});

	it("ack_timeout stays put (the user decides: extend / reclaim)", async () => {
		const h = await node();
		const spy = spies(h);
		const row = seed(h, { role: "source", state: "ack_timeout", deadlineAt: iso(-60_000) });
		await h.ctx.handoffs.recovery.recover();
		expect(stateOf(h, row.id)).toBe("ack_timeout");
		expect(spy.finishRelease).not.toHaveBeenCalled();
	});

	it("rows of kind session are never touched", async () => {
		const h = await node();
		spies(h);
		const row = seed(h, { role: "source", state: "offered", kind: "session", expiresAt: iso(-1_000) });
		await h.ctx.handoffs.recovery.recover();
		expect(stateOf(h, row.id)).toBe("offered");
	});
});

describe("target recovery (docs/handoff-protocol.md §6.2)", () => {
	it("received past the restore deadline → failed(timeout)", async () => {
		const h = await node();
		spies(h);
		const row = seed(h, { role: "target", state: "received", deadlineAt: iso(-1_000) });
		await h.ctx.handoffs.recovery.recover();
		const after = h.ctx.handoffs.store.get(row.id);
		expect(after.state).toBe("failed");
		expect(after.failureCode).toBe("timeout");
		expect(after.meta.cleanedUp).toBe(true);
	});

	it("persisted past the deadline → failed(timeout)", async () => {
		const h = await node();
		spies(h);
		const row = seed(h, { role: "target", state: "persisted", deadlineAt: iso(-1_000) });
		await h.ctx.handoffs.recovery.recover();
		expect(h.ctx.handoffs.store.get(row.id).failureCode).toBe("timeout");
	});

	it("a source reclaim seen in the timeline → failed(superseded) before the ack", async () => {
		const h = await node();
		spies(h);
		const row = seed(h, { role: "target", state: "validated" });
		h.ctx.handoffs.store.appendEvent(row.id, { state: "reclaimed", summary: "The source reclaimed the task", nodeId: row.sourceNodeId });
		await h.ctx.handoffs.recovery.recover();
		expect(h.ctx.handoffs.store.get(row.id).failureCode).toBe("superseded");
	});

	it("received without a stored manifest cannot be repaired → failed(manifest_invalid)", async () => {
		const h = await node();
		spies(h);
		const row = seed(h, { role: "target", state: "received", manifest: null });
		await h.ctx.handoffs.recovery.recover();
		const after = h.ctx.handoffs.store.get(row.id);
		expect(after.state).toBe("failed");
		expect(after.failureCode).toBe("manifest_invalid");
	});

	it("steps and acceptance are driven by target.resume", async () => {
		const h = await node();
		const spy = spies(h);
		const stepped = seed(h, { role: "target", state: "files_restored" });
		await h.ctx.handoffs.recovery.recover();
		expect(spy.targetResume).toHaveBeenCalledWith(stepped.id);
		expect(stateOf(h, stepped.id)).toBe("files_restored");
	});

	it("acked within the deadline: a queued ack is left alone, a missing one falls back to target.resume", async () => {
		const h = await node();
		const spy = spies(h);
		const queued = seed(h, { role: "target", state: "acked" });
		h.ctx.tasks.store.enqueue({ peerId: queued.peerId, taskId: `${queued.id}:${queued.peerId}`, kind: "handoff.ack", refId: queued.id, path: `/handoffs/${queued.id}/ack`, body: {}, idempotencyKey: `handoff.ack:${queued.id}`, nextAttemptAt: iso(3_600_000) });
		await h.ctx.handoffs.recovery.recover();
		expect(spy.targetResume).not.toHaveBeenCalled();
		expect(spy.ackConfirmed).not.toHaveBeenCalled();
		expect(h.ctx.tasks.store.pendingOutbox(queued.peerId).filter((o) => o.refId === queued.id)).toHaveLength(1);
	});

	it("acked and the ack response was received → ackConfirmed (step 9)", async () => {
		const h = await node();
		const spy = spies(h);
		const row = seed(h, { role: "target", state: "acked" });
		const item = h.ctx.tasks.store.enqueue({ peerId: row.peerId, taskId: `${row.id}:${row.peerId}`, kind: "handoff.ack", refId: row.id, path: `/handoffs/${row.id}/ack`, body: {}, idempotencyKey: `handoff.ack:${row.id}` });
		h.ctx.tasks.store.updateOutbox(item.id, { state: "sent" });
		await h.ctx.handoffs.recovery.recover();
		expect(spy.ackConfirmed).toHaveBeenCalledWith(row.id);
	});

	it("§6.4(b): acked, deadline passed, source unreachable and no reclaim → acquire ownership", async () => {
		const h = await node();
		const spy = spies(h);
		const row = seed(h, { role: "target", state: "acked", deadlineAt: iso(-1_000) });
		await h.ctx.handoffs.recovery.recover();
		expect(spy.ackConfirmed).toHaveBeenCalledWith(row.id);
		expect(h.ctx.handoffs.store.events(row.id).some((e) => /acquiring ownership/.test(e.summary))).toBe(true);
	});

	it("owner without turns in the new session → the resume prompt is re-sent through target.resume", async () => {
		const h = await node();
		const spy = spies(h);
		const row = seed(h, { role: "target", state: "owner" });
		await h.ctx.handoffs.recovery.recover();
		expect(spy.targetResume).toHaveBeenCalledWith(row.id);
		expect(stateOf(h, row.id)).toBe("owner");
	});

	it("resumed past the complete grace → completed", async () => {
		const h = await node();
		spies(h);
		const row = seed(h, { role: "target", state: "resumed", updatedAt: iso(-3_600_000) });
		await h.ctx.handoffs.recovery.recover();
		expect(stateOf(h, row.id)).toBe("completed");
	});
});

describe("timers (docs/handoff-protocol.md §7)", () => {
	it("the sweeper expires offers, completes resumed targets and archives old releases, and stops with stop()", async () => {
		const h = await node({ sweepMs: 40, completeGraceMs: 100 });
		const spy = spies(h);
		const offered = seed(h, { role: "source", state: "offered", expiresAt: iso(-1_000) });
		const resumed = seed(h, { role: "target", state: "resumed" });
		const released = seed(h, { role: "source", state: "released", updatedAt: iso(-3 * 24 * 3_600_000) });
		const awaiting = seed(h, { role: "source", state: "awaiting_ack", deadlineAt: iso(-1_000) });
		await eventually(() => (stateOf(h, offered.id) === "expired" && stateOf(h, resumed.id) === "completed" && stateOf(h, released.id) === "completed" && stateOf(h, awaiting.id) === "ack_timeout") || undefined, "the sweeper to settle every row");
		expect(spy.unfreeze).toHaveBeenCalledWith(offered.subjectId, offered.id);
		expect(spy.finishRelease).not.toHaveBeenCalled();

		await h.ctx.handoffs.recovery.stop();
		const late = seed(h, { role: "source", state: "offered", expiresAt: iso(-1_000) });
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(stateOf(h, late.id)).toBe("offered");
	});

	it("a sweep leaves rows that are not due alone", async () => {
		const h = await node({ sweepMs: 40 });
		spies(h);
		const offered = seed(h, { role: "source", state: "offered" });
		const target = seed(h, { role: "target", state: "persisted" });
		await new Promise((resolve) => setTimeout(resolve, 250));
		expect(stateOf(h, offered.id)).toBe("offered");
		expect(stateOf(h, target.id)).toBe("persisted");
	});
});

describe("peer reconcile (docs/handoff-protocol.md §6, §8.2)", () => {
	async function pair(): Promise<{ a: FullHarness; b: FullHarness }> {
		const a = await startHandoffNode("node-a", { handoffTimings: { sweepMs: 3_600_000 } });
		const b = await startHandoffNode("node-b", { handoffTimings: { sweepMs: 3_600_000 } });
		nodes.push(a, b);
		const workspace = (await api(a).post<{ id: string }>("/workspaces", { name: "Alpha" })).body;
		await pairIn(a, b, workspace.id);
		// B must also allow A to read handoffs (capabilities are checked on the receiving node).
		const aId = a.ctx.identity.nodeId;
		const current = (await peerOf(b, aId))?.grantedCapabilities ?? [];
		const patched = await api(b).patch(`/network/peers/${aId}`, { grantedCapabilities: [...new Set([...current, "handoff.receive"])] });
		expect(patched.status).toBe(200);
		await eventually(async () => (await peerOf(a, b.ctx.identity.nodeId))?.receivedCapabilities.includes("handoff.receive") || undefined, "A to see B's handoff.receive grant");
		return { a, b };
	}

	it("the target holds a valid ack the source never saw → the source persists it and releases", async () => {
		const { a, b } = await pair();
		const spy = spies(a);
		const id = newHandoffId();
		const subjectId = "tsk_reconcile_ack";
		const token = makeFencingToken({ taskId: subjectId, epoch: 2, handoffId: id, manifestSha256: SHA, sign: b.ctx.identity.sign });
		seed(b, { id, role: "target", state: "acked", subjectId, peerId: a.ctx.identity.nodeId, sourceNodeId: a.ctx.identity.nodeId, manifestSha256: SHA, fencingToken: token, ackAt: iso(-500), targetSessionId: "ses_new" });
		seed(a, { id, role: "source", state: "awaiting_ack", subjectId, peerId: b.ctx.identity.nodeId, targetNodeId: b.ctx.identity.nodeId, manifestSha256: SHA });
		await a.ctx.handoffs.recovery.reconcilePeer(b.ctx.identity.nodeId);
		const after = a.ctx.handoffs.store.get(id);
		expect(after.state).toBe("acked");
		expect(after.fencingToken).toBe(token);
		expect(after.targetSessionId).toBe("ses_new");
		expect(spy.finishRelease).toHaveBeenCalledWith(id);
	});

	it("a token that does not verify never releases", async () => {
		const { a, b } = await pair();
		const spy = spies(a);
		const id = newHandoffId();
		const subjectId = "tsk_reconcile_forged";
		// Signed by A itself, not by the pinned key of B.
		const forged = makeFencingToken({ taskId: subjectId, epoch: 2, handoffId: id, manifestSha256: SHA, sign: a.ctx.identity.sign });
		seed(b, { id, role: "target", state: "acked", subjectId, peerId: a.ctx.identity.nodeId, sourceNodeId: a.ctx.identity.nodeId, manifestSha256: SHA, fencingToken: forged, ackAt: iso(-500) });
		seed(a, { id, role: "source", state: "awaiting_ack", subjectId, peerId: b.ctx.identity.nodeId, targetNodeId: b.ctx.identity.nodeId, manifestSha256: SHA });
		await a.ctx.handoffs.recovery.reconcilePeer(b.ctx.identity.nodeId);
		expect(stateOf(a, id)).toBe("awaiting_ack");
		expect(spy.finishRelease).not.toHaveBeenCalled();
	});

	it("a retryable target failure keeps the source in awaiting_ack (the target's user may retry)", async () => {
		const { a, b } = await pair();
		const spy = spies(a);
		const id = newHandoffId();
		const subjectId = "tsk_reconcile_retryable";
		seed(b, { id, role: "target", state: "failed", subjectId, peerId: a.ctx.identity.nodeId, sourceNodeId: a.ctx.identity.nodeId, failureCode: "validation_failed", failureDetail: "tests fail", failureStep: 6 });
		seed(a, { id, role: "source", state: "awaiting_ack", subjectId, peerId: b.ctx.identity.nodeId, targetNodeId: b.ctx.identity.nodeId });
		await a.ctx.handoffs.recovery.reconcilePeer(b.ctx.identity.nodeId);
		expect(stateOf(a, id)).toBe("awaiting_ack");
		expect(spy.unfreeze).not.toHaveBeenCalled();
		// Past the deadline the normal timeout still applies.
		a.ctx.handoffs.store.update(id, { deadlineAt: iso(-1_000) });
		await a.ctx.handoffs.recovery.reconcilePeer(b.ctx.identity.nodeId);
		expect(stateOf(a, id)).toBe("ack_timeout");
	});

	it("a non-retryable target failure → the source fails the handoff with the target's reason and unfreezes", async () => {
		const { a, b } = await pair();
		const spy = spies(a);
		const id = newHandoffId();
		const subjectId = "tsk_reconcile_failed";
		seed(b, { id, role: "target", state: "failed", subjectId, peerId: a.ctx.identity.nodeId, sourceNodeId: a.ctx.identity.nodeId, failureCode: "superseded", failureDetail: "reclaimed", failureStep: 6 });
		seed(a, { id, role: "source", state: "awaiting_ack", subjectId, peerId: b.ctx.identity.nodeId, targetNodeId: b.ctx.identity.nodeId });
		await a.ctx.handoffs.recovery.reconcilePeer(b.ctx.identity.nodeId);
		const after = a.ctx.handoffs.store.get(id);
		expect(after.state).toBe("failed");
		expect(after.failureCode).toBe("superseded");
		expect(after.failureStep).toBe(6);
		expect(spy.unfreeze).toHaveBeenCalledWith(subjectId, id);
		expect(spy.finishRelease).not.toHaveBeenCalled();
	});

	it("ack_timeout is never auto-resolved by a reconcile that finds the target failed (the user decides)", async () => {
		const { a, b } = await pair();
		spies(a);
		const id = newHandoffId();
		const subjectId = "tsk_reconcile_online";
		seed(b, { id, role: "target", state: "failed", subjectId, peerId: a.ctx.identity.nodeId, sourceNodeId: a.ctx.identity.nodeId, failureCode: "cancelled", failureDetail: "stopped" });
		seed(a, { id, role: "source", state: "ack_timeout", subjectId, peerId: b.ctx.identity.nodeId, targetNodeId: b.ctx.identity.nodeId, deadlineAt: iso(-1_000) });
		// ack_timeout waits for the user even though the target failed: the reconcile only releases on a verified ack.
		await a.ctx.handoffs.recovery.reconcilePeer(b.ctx.identity.nodeId);
		expect(stateOf(a, id)).toBe("ack_timeout");
	});
});
