import type { AgentSession, SharedSession, SharedTransfer, TransferPhase } from "@clam/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { api } from "./full-harness.ts";
import { eventually } from "./net-helpers.ts";
import {
	git,
	isolateGitConfig,
	promptAndWait,
	readIn,
	remoteBranches,
	sessionOn,
	sharedOn,
	startSharedPair,
	transcriptTexts,
	waitForShared,
	whenSettled,
	type GitConfigIsolation,
	type SharedPair,
} from "./shared-fixtures.ts";

let gitConfig: GitConfigIsolation;
beforeAll(() => {
	gitConfig = isolateGitConfig();
});
afterAll(() => gitConfig.restore());

let pair: SharedPair;
afterEach(async () => {
	await pair?.cleanup();
});

type ErrorBody = { error: { code: string; message: string } };

/** Phases of the hand-over of `sharedId` as pushed on node A's `shared` topic, in order, without repeats. */
function recordPhases(node: SharedPair["a"], sharedId: string): { phases: TransferPhase[]; stop(): void } {
	const phases: TransferPhase[] = [];
	const stop = node.ctx.bus.subscribe("shared", (event) => {
		if (typeof event !== "object" || event === null || !("type" in event) || event.type !== "shared" || !("shared" in event)) return;
		const shared = event.shared as SharedSession;
		const phase = shared.id === sharedId ? shared.transfer?.phase : undefined;
		if (phase && phases.at(-1) !== phase) phases.push(phase);
	});
	return { phases, stop };
}

async function newSession(title: string): Promise<AgentSession> {
	const created = await api(pair.a).post<AgentSession>("/sessions", { projectId: pair.projectA.id, title });
	if (created.status !== 201) throw new Error(`session failed: ${JSON.stringify(created.body)}`);
	return created.body;
}

describe("hand-over to a node that is not a participant yet", () => {
	it("shares an UNSHARED session, B auto-accepts, everything A changed (even uncommitted) moves to B in one action, A follows as a participant with a live mirror", async () => {
		pair = await startSharedPair();
		await pair.autoAcceptOnB(true);
		const session = await newSession("Build the feature");
		await promptAndWait(pair.a, session.id, "@@fake-sh echo 'feature v1' > FEATURE.md && echo 'scratch' > SCRATCH.txt");
		await whenSettled(pair.a, session.id);

		// nothing of this is committed: it travels with the final checkpoint
		expect(git(pair.workA, "status", "--porcelain")).toContain("FEATURE.md");

		const started = await api(pair.a).post<SharedSession>(`/sessions/${session.id}/handover`, { toNodeId: pair.bId });
		expect(started.status, JSON.stringify(started.body)).toBe(202);
		const sharedId = started.body.id;
		expect(started.body.transfer).toMatchObject({ toNodeId: pair.bId, toNodeName: "node-b", stopRunning: false, error: null });
		const seen = recordPhases(pair.a, sharedId);

		const done = await waitForShared(pair.a, sharedId, (s) => s.transfer?.phase === "continuing", "the hand-over to finish", 60_000);
		seen.stop();
		expect(done).toMatchObject({ localRole: "former_driver", epoch: 2, driverNodeId: pair.bId });
		expect(done.transfer?.message).toContain("node-b is continuing");

		// progress went through the documented phases in order
		const order: TransferPhase[] = ["inviting", "waiting_accept", "stopping", "checkpointing", "delivering", "handing_over", "continuing"];
		const indexes = seen.phases.map((p) => order.indexOf(p));
		expect(indexes).toEqual([...indexes].sort((x, y) => x - y));
		expect(seen.phases).toEqual(expect.arrayContaining(["checkpointing", "delivering", "handing_over", "continuing"]));

		// B continues in a NEW local session cloned from A's snapshot, with the work in its clone
		const onB = await waitForShared(pair.b, sharedId, (s) => s.localRole === "driver" && s.epoch === 2, "B is the driver");
		const newSession_ = await sessionOn(pair.b, onB.localSessionId as string);
		expect(newSession_).toMatchObject({ kind: "local", sharedSessionId: sharedId });
		expect(done.transfer).toMatchObject({ newSessionId: newSession_.id, newSessionUrl: null });
		expect(readIn(pair.workB, "FEATURE.md")).toBe("feature v1\n");
		expect(readIn(pair.workB, "SCRATCH.txt")).toBe("scratch\n");
		expect(git(pair.workB, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(started.body.repo.branch);
		expect(remoteBranches(pair.origin)).toContain(started.body.repo.branch);
		expect(git(pair.origin, "show", `${started.body.repo.branch}:FEATURE.md`)).toBe("feature v1\n");

		// the continuation note wakes B's agent: everything was handed over, continue the same work
		await eventually(async () => (await transcriptTexts(pair.b, newSession_.id)).some((t) => t.includes("handed over to this node")), "the continuation note on B", 30_000);
		const note = (await transcriptTexts(pair.b, newSession_.id)).find((t) => t.includes("handed over to this node")) as string;
		expect(note).toContain("ALL of node-a's work");
		expect(note).toContain("Nothing is missing");
		expect(note).toContain("Continue the work the conversation above was doing");
		await eventually(async () => (await transcriptTexts(pair.b, newSession_.id)).some((t) => t.startsWith("FAKE:") && t.includes("handed over to this node")), "B's agent answering the continuation note", 30_000);

		// A: old session read-only and linked to B's session, live mirror of B's session, nothing rescued
		const former = await waitForShared(pair.a, sharedId, (s) => s.mirrorSessionId !== null && s.rescueBranch === null, "A follows B with a mirror", 30_000);
		expect((await sessionOn(pair.a, session.id)).movedTo).toMatchObject({ nodeId: pair.bId, nodeName: "node-b", sessionId: newSession_.id });
		const mirror = await sessionOn(pair.a, former.mirrorSessionId as string);
		expect(mirror.kind).toBe("mirror");
		await eventually(async () => (await transcriptTexts(pair.a, mirror.id)).some((t) => t.includes("Nothing is missing")), "B's continued session on A's mirror", 30_000);
		expect(former.participants.find((p) => p.nodeId === pair.aId)).toMatchObject({ role: "participant", state: "active" });
		expect(remoteBranches(pair.origin).filter((b) => b.startsWith("clam/rescue/"))).toEqual([]);
		const stale = await api(pair.a).post<ErrorBody>(`/sessions/${session.id}/prompt`, { message: "still there?", clientId: "late" });
		expect(stale.status).toBe(409);
		expect(stale.body.error.code).toBe("session_moved");
	});

	it("an already shared session hands over through POST /shared/:id/transfer too, and the finished record is dismissed with DELETE", async () => {
		pair = await startSharedPair();
		const { shared } = await pair.shareAndJoin({ title: "Notes", firstPrompt: "write the notes" });
		const started = await api(pair.a).post<SharedSession>(`/shared/${shared.id}/transfer`, { toNodeId: pair.bId });
		expect(started.status).toBe(202);
		await waitForShared(pair.a, shared.id, (s) => s.transfer?.phase === "continuing", "the hand-over to finish", 60_000);
		const dismissed = await api(pair.a).del<SharedSession>(`/shared/${shared.id}/transfer`);
		expect(dismissed.status).toBe(200);
		expect(dismissed.body.transfer).toBeNull();
		expect((await sharedOn(pair.a, shared.id)).transfer).toBeNull();
	});
});

describe("a driver that is mid-turn", () => {
	it("is refused with session_busy; with stopRunning the turn is aborted, ALL changes are committed and handed over, and B is told the last step was cut off", async () => {
		pair = await startSharedPair();
		const { sessionId, shared } = await pair.shareAndJoin({ title: "Notes", firstPrompt: "write the notes" });
		await promptAndWait(pair.a, sessionId, "@@fake-sh echo partial > PARTIAL.md");
		await whenSettled(pair.a, sessionId);
		const slow = await api(pair.a).post<unknown>(`/sessions/${sessionId}/prompt`, { message: "__slow__", clientId: "slow-turn" });
		expect(slow.status, JSON.stringify(slow.body)).toBe(202);
		await eventually(async () => (await api(pair.a).get<{ runtime: { state: string } }>(`/sessions/${sessionId}/state`)).body.runtime.state === "busy", "A's agent to be mid-turn");

		const refused = await api(pair.a).post<ErrorBody>(`/shared/${shared.id}/transfer`, { toNodeId: pair.bId });
		expect(refused.status).toBe(409);
		expect(refused.body.error.code).toBe("session_busy");
		expect((await sharedOn(pair.a, shared.id)).transfer).toBeNull();
		const refusedHandover = await api(pair.a).post<ErrorBody>(`/sessions/${sessionId}/handover`, { toNodeId: pair.bId });
		expect(refusedHandover.body.error.code).toBe("session_busy");

		const seen = recordPhases(pair.a, shared.id);
		const accepted = await api(pair.a).post<SharedSession>(`/shared/${shared.id}/transfer`, { toNodeId: pair.bId, stopRunning: true });
		expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
		expect(accepted.body.transfer?.stopRunning).toBe(true);
		const done = await waitForShared(pair.a, shared.id, (s) => s.transfer?.phase === "continuing", "the hand-over to finish", 60_000);
		seen.stop();
		expect(seen.phases).toEqual(expect.arrayContaining(["stopping", "checkpointing", "delivering", "handing_over", "continuing"]));
		expect(seen.phases.indexOf("stopping")).toBeLessThan(seen.phases.indexOf("checkpointing"));

		// the file written before the interrupted turn is in the checkpoint commit on the shared branch and on B
		expect(git(pair.origin, "show", `${shared.repo.branch}:PARTIAL.md`)).toBe("partial\n");
		expect(readIn(pair.workB, "PARTIAL.md")).toBe("partial\n");
		const onB = await waitForShared(pair.b, shared.id, (s) => s.localRole === "driver" && s.epoch === 2, "B is the driver");
		await eventually(async () => (await transcriptTexts(pair.b, onB.localSessionId as string)).some((t) => t.includes("handed over to this node")), "the continuation note", 30_000);
		const note = (await transcriptTexts(pair.b, onB.localSessionId as string)).find((t) => t.includes("handed over to this node")) as string;
		expect(note).toContain("stopped a running turn for the hand-over");
		expect(note).toContain("Nothing is missing");
		expect(done.transfer?.newSessionId).toBe(onB.localSessionId);
		expect((await sessionOn(pair.a, sessionId)).movedTo?.sessionId).toBe(onB.localSessionId);
	});

	it("takes no prompt while the final checkpoint is taken or the target is being asked to take over", async () => {
		pair = await startSharedPair();
		const { sessionId, shared } = await pair.shareAndJoin({ title: "Notes", firstPrompt: "write the notes" });
		const now = new Date().toISOString();
		const record: SharedTransfer = { id: "trf_test", toNodeId: pair.bId, toNodeName: "node-b", phase: "checkpointing", message: "Saving everything…", stopRunning: false, error: null, newSessionId: null, newSessionUrl: null, startedAt: now, updatedAt: now };
		pair.a.ctx.shared.store.patchMeta(shared.id, { transfer: record });
		const blocked = await api(pair.a).post<ErrorBody>(`/sessions/${sessionId}/prompt`, { message: "one more thing", clientId: "blocked-1" });
		expect(blocked.status).toBe(409);
		expect(blocked.body.error.code).toBe("transfer_in_progress");
		// while the invitation is only awaited, the session works as usual
		pair.a.ctx.shared.store.patchMeta(shared.id, { transfer: { ...record, phase: "waiting_accept" } });
		const allowed = await api(pair.a).post(`/sessions/${sessionId}/prompt`, { message: "one more thing", clientId: "allowed-1" });
		expect(allowed.status).toBe(202);
		pair.a.ctx.shared.store.patchMeta(shared.id, { transfer: null });
	});
});

describe("waiting for B to accept", () => {
	it("a human accepting on B (its own domain) lets the hand-over continue; cancelling earlier leaves the invitation open", async () => {
		pair = await startSharedPair();
		const session = await newSession("Manual accept");
		await promptAndWait(pair.a, session.id, "@@fake-sh echo one > ONE.md");
		await whenSettled(pair.a, session.id);
		const started = await api(pair.a).post<SharedSession>(`/sessions/${session.id}/handover`, { toNodeId: pair.bId });
		expect(started.status, JSON.stringify(started.body)).toBe(202);
		const sharedId = started.body.id;
		const waiting = await waitForShared(pair.a, sharedId, (s) => s.transfer?.phase === "waiting_accept", "A to wait for B");
		expect(waiting.transfer?.message).toContain("Waiting for node-b to accept");

		// a second request while one is running is refused
		const again = await api(pair.a).post<ErrorBody>(`/shared/${sharedId}/transfer`, { toNodeId: pair.bId });
		expect(again.body.error.code).toBe("transfer_in_progress");

		// cancel: nothing is handed over, the invitation stays pending on B
		const cancelled = await api(pair.a).del<SharedSession>(`/shared/${sharedId}/transfer`);
		expect(cancelled.status).toBe(200);
		expect(cancelled.body.transfer).toMatchObject({ phase: "cancelled" });
		const invite = await eventually(async () => (await api(pair.b).get<Array<{ id: string; sharedSessionId: string; state: string }>>("/shared/invites")).body.find((i) => i.sharedSessionId === sharedId && i.state === "pending"), "the invitation is still pending on B");
		expect((await sharedOn(pair.a, sharedId)).localRole).toBe("driver");

		// start again; this time B's human accepts
		const second = await api(pair.a).post<SharedSession>(`/shared/${sharedId}/transfer`, { toNodeId: pair.bId });
		expect(second.status, JSON.stringify(second.body)).toBe(202);
		await waitForShared(pair.a, sharedId, (s) => s.transfer?.phase === "waiting_accept" && s.transfer.id !== waiting.transfer?.id, "A waiting again");
		const accepted = await api(pair.b).post(`/shared/invites/${invite.id}/decide`, { decision: "accept" });
		expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
		const done = await waitForShared(pair.a, sharedId, (s) => s.transfer?.phase === "continuing", "the hand-over to finish after B accepted", 60_000);
		expect(done.localRole).toBe("former_driver");
		expect(readIn(pair.workB, "ONE.md")).toBe("one\n");
	});

	it("fails when B declines, and when nobody accepts in time (the invitation stays open)", async () => {
		pair = await startSharedPair({ nodeA: { sharedTimings: { transferAcceptTimeoutMs: 1_500 } } });
		const session = await newSession("Declined");
		await promptAndWait(pair.a, session.id, "@@fake-sh echo one > ONE.md");
		await whenSettled(pair.a, session.id);
		const started = await api(pair.a).post<SharedSession>(`/sessions/${session.id}/handover`, { toNodeId: pair.bId });
		const sharedId = started.body.id;
		const timedOut = await waitForShared(pair.a, sharedId, (s) => s.transfer?.phase === "failed", "the hand-over to time out", 20_000);
		expect(timedOut.transfer?.error?.code).toBe("accept_timeout");
		expect(timedOut.transfer?.error?.message).toContain("stays open");
		const invite = await eventually(async () => (await api(pair.b).get<Array<{ id: string; sharedSessionId: string; state: string }>>("/shared/invites")).body.find((i) => i.sharedSessionId === sharedId && i.state === "pending"), "the invitation is still pending on B");

		// retry, B declines
		const retry = await api(pair.a).post<SharedSession>(`/shared/${sharedId}/transfer`, { toNodeId: pair.bId });
		expect(retry.status).toBe(202);
		await waitForShared(pair.a, sharedId, (s) => s.transfer?.phase === "waiting_accept", "A waiting again");
		await api(pair.b).post(`/shared/invites/${invite.id}/decide`, { decision: "decline", reason: "busy" });
		const declined = await waitForShared(pair.a, sharedId, (s) => s.transfer?.phase === "failed" && s.transfer.error?.code === "invite_declined", "the hand-over to fail", 20_000);
		expect(declined.localRole).toBe("driver");
		expect(declined.epoch).toBe(1);
	});
});

describe("a hand-over that cannot complete loses nothing", () => {
	it("fails with push_failed when the shared branch cannot be pushed: A stays the driver and nothing is handed over", async () => {
		pair = await startSharedPair();
		const { sessionId, shared } = await pair.shareAndJoin({ title: "Notes", firstPrompt: "write the notes" });
		await promptAndWait(pair.a, sessionId, "@@fake-sh echo precious > PRECIOUS.md");
		git(pair.workA, "remote", "set-url", "origin", `${pair.root}/does-not-exist.git`);
		const started = await api(pair.a).post<SharedSession>(`/shared/${shared.id}/transfer`, { toNodeId: pair.bId });
		expect(started.status).toBe(202);
		const failed = await waitForShared(pair.a, shared.id, (s) => s.transfer?.phase === "failed", "the hand-over to fail", 30_000);
		expect(failed.transfer?.error?.code).toBe("push_failed");
		expect(failed.transfer?.error?.message).toContain("Nothing was handed over");
		expect(failed).toMatchObject({ localRole: "driver", epoch: 1 });
		expect(readIn(pair.workA, "PRECIOUS.md")).toBe("precious\n");
		// the failure is also in the thread, and a new attempt is possible once the remote works again
		const thread = (await api(pair.a).get<{ messages: Array<{ text: string }> }>(`/shared/${shared.id}`)).body.messages;
		expect(thread.some((m) => m.text.includes("hand-over to node-b failed"))).toBe(true);
		git(pair.workA, "remote", "set-url", "origin", pair.origin);
		const retry = await api(pair.a).post<SharedSession>(`/shared/${shared.id}/transfer`, { toNodeId: pair.bId });
		expect(retry.status).toBe(202);
		await waitForShared(pair.a, shared.id, (s) => s.transfer?.phase === "continuing", "the second attempt to finish", 60_000);
		expect(readIn(pair.workB, "PRECIOUS.md")).toBe("precious\n");
	});

	it("a node restart while a hand-over waits marks it failed (interrupted) and A keeps driving", async () => {
		pair = await startSharedPair();
		const session = await newSession("Restart");
		await promptAndWait(pair.a, session.id, "@@fake-sh echo one > ONE.md");
		await whenSettled(pair.a, session.id);
		const started = await api(pair.a).post<SharedSession>(`/sessions/${session.id}/handover`, { toNodeId: pair.bId });
		const sharedId = started.body.id;
		await waitForShared(pair.a, sharedId, (s) => s.transfer?.phase === "waiting_accept", "A to wait for B");
		await pair.stop("a");
		await pair.start("a");
		const after = await waitForShared(pair.a, sharedId, (s) => s.transfer?.phase === "failed", "the interrupted hand-over", 20_000);
		expect(after.transfer?.error?.code).toBe("interrupted");
		expect(after.localRole).toBe("driver");
	});
});
