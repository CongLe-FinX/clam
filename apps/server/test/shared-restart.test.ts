import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { idempotencyRecords, openDatabase, outbox, type ClamDb } from "@clam/database";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SharedStore } from "../src/shared/store.ts";
import { api, type FullHarness } from "./full-harness.ts";
import { eventually } from "./net-helpers.ts";
import {
	detailOn,
	git,
	isolateGitConfig,
	promptAndWait,
	promptsOf,
	remoteBranches,
	sessionOn,
	sessionsOn,
	sharedOn,
	startSharedPair,
	textOf,
	transcript,
	transcriptTexts,
	waitForShared,
	whenSettled,
	worktreeOf,
	type GitConfigIsolation,
	type SharedPair,
} from "./shared-fixtures.ts";
import type { SharedSession } from "@clam/contracts";

/**
 * A node that dies and comes back (same data directory, same ports, a new process) in the middle of a shared session:
 * queued messages and checkpoint notices are delivered once after the return, a driver that restarts keeps driving and
 * publishes its conversation again, half-finished former-driver work is completed at boot, a new driver stays the driver.
 */

let gitConfig: GitConfigIsolation;
beforeAll(() => {
	gitConfig = isolateGitConfig();
});
afterAll(() => gitConfig.restore());

let pair: SharedPair;
afterEach(async () => {
	await pair?.cleanup();
});

function calls(node: FullHarness): string[][] {
	const file = path.join(node.dataDir, "fake-home", "calls.jsonl");
	return existsSync(file)
		? readFileSync(file, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as string[])
		: [];
}

/** Run `work` against the database of a STOPPED node (what it persisted when it died), through the node's own store. */
function whileStopped<T>(node: FullHarness, work: (store: SharedStore, db: ClamDb) => T): T {
	const db = openDatabase({ file: path.join(node.dataDir, "clam.db") });
	try {
		return work(new SharedStore(db, { nodeId: node.ctx.identity.nodeId }), db);
	} finally {
		db.$client.close();
	}
}

async function seesOffline(node: FullHarness, sharedId: string, peerId: string): Promise<void> {
	await waitForShared(node, sharedId, (s) => s.participants.find((p) => p.nodeId === peerId)?.nodeStatus === "offline", "the peer to look offline", 20_000);
}

/** A shared session with B joined and the first snapshot held by B. */
async function joined() {
	pair = await startSharedPair();
	const result = await pair.shareAndJoin({ firstPrompt: "start" });
	await waitForShared(pair.a, result.shared.id, (s) => s.lastCheckpoint?.deliveredTo.includes(pair.bId) === true, "the first snapshot reached B");
	return { ...result, mirrorId: result.onB.mirrorSessionId as string, participantSessionId: result.onB.participants.find((p) => p.nodeId === pair.bId)?.agentSessionId as string };
}

/** A is the driver and has written SHARED_NOTES.md (checkpointed, pushed, held by B). */
async function joinedWithNotes() {
	const result = await joined();
	await promptAndWait(pair.a, result.sessionId, "@@fake-sh echo 'line one' > SHARED_NOTES.md");
	await waitForShared(pair.a, result.shared.id, (s) => (s.lastCheckpoint?.seq ?? 0) >= 2 && s.lastCheckpoint?.deliveredTo.includes(pair.bId) === true, "the checkpoint with the file reached B");
	return result;
}

const injections = (node: FullHarness, needle: string) => promptsOf(node).filter((p) => p.message.includes(needle));

describe("B restarts", () => {
	it("a message queued while B is down is delivered once and in order after B comes back, and injected once", async () => {
		const { shared, participantSessionId } = await joined();
		await pair.stop("b");
		await seesOffline(pair.a, shared.id, pair.bId);
		const texts = ["queued-one", "queued-two", "queued-three"];
		const ids: string[] = [];
		for (const text of texts) {
			const res = await api(pair.a).post<{ id: string }>(`/shared/${shared.id}/messages`, { text: `@node-b ${text}`, kind: "note" });
			expect(res.status).toBe(201);
			ids.push(res.body.id);
		}
		// held in A's outbox, in order, for the node that is not there
		const queued = pair.a.ctx.tasks.store.pendingOutbox(pair.bId).filter((item) => item.kind === "shared.message");
		expect(queued.map((item) => item.refId)).toEqual(ids);
		expect((await detailOn(pair.a, shared.id)).messages.filter((m) => ids.includes(m.id)).map((m) => m.delivery)).toEqual(["pending", "pending", "pending"]);

		await pair.start("b");
		await eventually(async () => {
			const seen = await transcriptTexts(pair.b, participantSessionId);
			return texts.every((text) => seen.some((t) => t.includes(text)));
		}, "the three messages in B's participant session", 30_000);
		await waitForShared(pair.a, shared.id, () => pair.a.ctx.shared.store.messages(shared.id).filter((m) => ids.includes(m.id)).every((m) => m.delivery === "delivered"), "A to see all three delivered", 30_000);
		await whenSettled(pair.b, participantSessionId);

		// each message reaches the agent exactly once and in the order it was written: either as a prompt of its own or inside the
		// "since your last turn" block of a later one (messages that arrive together are handed over in ONE prompt)
		const prompts = promptsOf(pair.b).filter((p) => texts.some((text) => p.message.includes(text)));
		const joinedPrompts = prompts.map((p) => p.message).join("\n=====\n");
		const positions = texts.map((text) => joinedPrompts.indexOf(`@node-b ${text}`));
		expect(positions.every((position) => position >= 0)).toBe(true);
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
		for (const text of texts) expect(joinedPrompts.split(`@node-b ${text}`), text).toHaveLength(2);
		const userMessages = (await transcript(pair.b, participantSessionId)).filter((m) => m.role === "user" && texts.some((text) => textOf(m).includes(text)));
		for (const text of texts) expect(userMessages.filter((m) => textOf(m).includes(text)), text).toHaveLength(1);
		const onB = pair.b.ctx.shared.store.messages(shared.id).filter((m) => ids.includes(m.id));
		expect(onB.map((m) => m.id)).toEqual(ids);
		expect(onB.every((m) => m.injectedSessionId === participantSessionId)).toBe(true);
		// nothing is delivered a second time: the outbox is drained and a later retry pass injects nothing new
		expect(pair.a.ctx.tasks.store.pendingOutbox(pair.bId)).toEqual([]);
		const promptsBefore = promptsOf(pair.b).length;
		await pair.b.ctx.shared.discussion.retryPending();
		await whenSettled(pair.b, participantSessionId);
		expect(promptsOf(pair.b)).toHaveLength(promptsBefore);
	});

	it("a checkpoint announced while B is down is downloaded when B returns, verified, stored and acknowledged", async () => {
		const { shared } = await joined();
		await pair.stop("b");
		await seesOffline(pair.a, shared.id, pair.bId);
		const manual = await api(pair.a).post<{ seq: number; snapshot: { sha256: string } | null }>(`/shared/${shared.id}/checkpoint`, { note: "while B was away" });
		expect(manual.status).toBe(200);
		const seq = manual.body.seq;
		expect(seq).toBeGreaterThan(1);
		expect((await sharedOn(pair.a, shared.id)).lastCheckpoint?.deliveredTo).not.toContain(pair.bId);
		expect(pair.a.ctx.tasks.store.pendingOutbox(pair.bId).some((item) => item.kind === "shared.checkpoint" && item.refId === `${shared.id}:${seq}`)).toBe(true);

		await pair.start("b");
		const onA = await waitForShared(pair.a, shared.id, (s) => s.lastCheckpoint?.seq === seq && s.lastCheckpoint.deliveredTo.includes(pair.bId), "A to see B's acknowledgement", 30_000);
		expect(onA.lastCheckpoint?.deliveredTo.filter((id) => id === pair.bId)).toHaveLength(1);
		const held = pair.b.ctx.shared.store.checkpoint(shared.id, seq);
		expect(held?.snapshotPath).toBeTruthy();
		expect(held?.snapshotSha256).toBe(manual.body.snapshot?.sha256);
		expect(readFileSync(path.join(pair.b.dataDir, "shared", shared.id, "snapshots", `${seq}.tar`))).toEqual(readFileSync(path.join(pair.a.dataDir, "shared", shared.id, "snapshots", `${seq}.tar`)));
		expect((await sharedOn(pair.b, shared.id)).lastCheckpoint).toMatchObject({ seq, deliveredTo: [pair.bId] });
	});

	it("a snapshot that was announced but never downloaded before B died is fetched at boot, and the lost acknowledgement is sent again", async () => {
		const { shared } = await joined();
		const seq = 1;
		// B had recorded the notice but not stored the file, and never got its acknowledgement out; A does not list B as holder
		const onDisk = path.join(pair.b.dataDir, "shared", shared.id, "snapshots", `${seq}.tar`);
		expect(existsSync(onDisk)).toBe(true);
		const original = readFileSync(onDisk);
		pair.a.ctx.shared.store.updateCheckpoint(shared.id, seq, { deliveredTo: [] });
		pair.a.ctx.shared.store.updateParticipant(shared.id, pair.bId, { snapshotSeq: 0 });
		// ... and A never recorded that acknowledgement (its response store has no trace of it either)
		pair.a.ctx.db.delete(idempotencyRecords).where(and(eq(idempotencyRecords.peerId, pair.bId), eq(idempotencyRecords.key, `shared.snapshot_ack:${shared.id}:${seq}`))).run();
		await pair.stop("b");
		whileStopped(pair.b, (store, db) => {
			store.updateCheckpoint(shared.id, seq, { snapshotPath: null });
			db.delete(outbox).where(and(eq(outbox.kind, "shared.snapshot_ack"), eq(outbox.refId, `${shared.id}:${seq}`))).run();
		});
		rmSync(onDisk);
		expect((await sharedOn(pair.a, shared.id)).lastCheckpoint?.deliveredTo).toEqual([]);

		await pair.start("b");
		await waitForShared(pair.a, shared.id, (s) => s.lastCheckpoint?.seq === seq && s.lastCheckpoint.deliveredTo.includes(pair.bId), "A to hear B's acknowledgement again", 30_000);
		expect(readFileSync(onDisk)).toEqual(original);
		expect(pair.b.ctx.shared.store.checkpoint(shared.id, seq)?.snapshotPath).toBeTruthy();
		expect(pair.b.ctx.shared.store.outboxOfRef("shared.snapshot_ack", `${shared.id}:${seq}`)).toHaveLength(1);
		// no stray temporary files are left behind
		expect((await sharedOn(pair.b, shared.id)).takeoverBlockedReason).toContain("online");
	});

	it("B restarted after its takeover is still the driver (epoch 2) with a session that resumes, and A learns it when it returns", async () => {
		const { sessionId, shared } = await joinedWithNotes();
		await pair.stop("a");
		await waitForShared(pair.b, shared.id, (s) => s.takeoverAvailable, "takeover available", 20_000);
		const took = await api(pair.b).post<SharedSession>(`/shared/${shared.id}/takeover`, {});
		expect(took.status, JSON.stringify(took.body)).toBe(200);
		const newSessionId = took.body.localSessionId as string;
		await promptAndWait(pair.b, newSessionId, "b works before the restart");

		await pair.stop("b");
		await pair.start("b");
		const back = await sharedOn(pair.b, shared.id);
		expect(back).toMatchObject({ localRole: "driver", epoch: 2, driverNodeId: pair.bId, localSessionId: newSessionId, mirrorSessionId: null });
		expect((await api(pair.b).post<{ error: { code: string } }>(`/shared/${shared.id}/takeover`, {})).body.error.code).toBe("already_driver");
		// the session resumes: its conversation is there and it answers
		const before = await transcriptTexts(pair.b, newSessionId);
		expect(before).toEqual(expect.arrayContaining(["start", "FAKE: start", "b works before the restart", "FAKE: b works before the restart"]));
		await promptAndWait(pair.b, newSessionId, "b works after the restart");
		await eventually(async () => (await transcriptTexts(pair.b, newSessionId)).includes("FAKE: b works after the restart"), "the resumed session's answer");
		expect((await sessionOn(pair.b, newSessionId)).kind).toBe("local");
		expect(git(worktreeOf(pair.b, shared.id), "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(shared.repo?.branch);
		expect(git(pair.workB, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");

		// A returns: it learns the change from B (queued before the restart, or by asking) and mirrors the restarted driver
		await pair.start("a");
		const former = await waitForShared(pair.a, shared.id, (s) => s.localRole === "former_driver" && s.epoch === 2 && s.mirrorSessionId !== null, "A to follow B", 30_000);
		await eventually(() => !pair.a.ctx.shared.store.get(shared.id).meta.pendingFormerDriver, "A to finish the former-driver steps", 30_000);
		expect(former.driverNodeId).toBe(pair.bId);
		await eventually(async () => (await transcriptTexts(pair.a, former.mirrorSessionId as string)).includes("FAKE: b works after the restart"), "B's conversation, restarts included, in A's mirror", 30_000);
		expect((await sessionOn(pair.a, sessionId)).movedTo).toMatchObject({ nodeId: pair.bId, sessionId: newSessionId });
		// B keeps publishing to the returned node
		await promptAndWait(pair.b, newSessionId, "one more from b");
		await eventually(async () => (await transcriptTexts(pair.a, former.mirrorSessionId as string)).includes("FAKE: one more from b"), "B's next turn in A's mirror", 20_000);
		expect((await sharedOn(pair.b, shared.id)).epoch).toBe(2);
	});
});

describe("A restarts", () => {
	// Two lives of node A, a restart and real git pushes: the 30 s default hid which step stalled (the waits inside run up to 30 s each).
	it("keeps driving, publishes its conversation again so B catches up, and injects the messages it had not injected yet exactly once", async () => {
		const { sessionId, shared, mirrorId } = await joined();
		// one message that was injected before the restart, one that was stored but not injected when the node died
		const early = await api(pair.b).post<{ id: string }>(`/shared/${shared.id}/messages`, { text: "injected before the restart", kind: "note" });
		expect(early.status).toBe(201);
		await eventually(() => pair.a.ctx.shared.store.message(early.body.id)?.injectedSessionId === sessionId, "the first message injected on A");
		await whenSettled(pair.a, sessionId);
		pair.a.ctx.shared.store.insertReceived({
			id: "shm_crashed_before_inject",
			sharedSessionId: shared.id,
			authorKind: "human",
			authorNodeId: pair.bId,
			authorNodeName: "node-b",
			authorAgentId: null,
			authorAgentName: null,
			kind: "chat",
			to: { mode: "lead", agents: [] },
			text: "stored but never injected",
			epoch: 1,
			createdAt: new Date().toISOString(),
			hlc: `${String(Date.now()).padStart(15, "0")}-00000`,
			originSeq: 1000,
			delivery: "local",
		});
		const streamBefore = pair.b.ctx.shared.store.mirrorState(mirrorId)?.streamId;
		expect(streamBefore).toBeTruthy();

		await pair.stop("a");
		await seesOffline(pair.b, shared.id, pair.aId);
		// explicitly for the lead: it waits for it (an unmentioned human message would go to B's agent while the lead is offline)
		const whileDown = await api(pair.b).post<{ id: string }>(`/shared/${shared.id}/messages`, { text: "written while A is down", kind: "note", to: { mode: "lead", agents: [] } });
		expect(whileDown.status).toBe(201);
		expect(pair.b.ctx.tasks.store.pendingOutbox(pair.aId).some((item) => item.refId === whileDown.body.id)).toBe(true);
		// B may take over now, but nothing does it behind the user's back
		await waitForShared(pair.b, shared.id, (s) => s.takeoverAvailable, "takeover offered while A is down", 20_000);
		expect((await sharedOn(pair.b, shared.id)).localRole).toBe("participant");

		await pair.start("a");
		await eventually(async () => {
			const seen = await transcriptTexts(pair.a, sessionId);
			return seen.some((t) => t.includes("stored but never injected")) && seen.some((t) => t.includes("written while A is down"));
		}, "the pending messages in A's driving session after the restart", 30_000);
		await whenSettled(pair.a, sessionId);
		for (const text of ["injected before the restart", "stored but never injected", "written while A is down"]) expect(injections(pair.a, text), text).toHaveLength(1);
		expect(pair.a.ctx.shared.store.message("shm_crashed_before_inject")?.injectedSessionId).toBe(sessionId);

		// still the driver at the same epoch, with the same session, and nobody took over
		expect(await sharedOn(pair.a, shared.id)).toMatchObject({ localRole: "driver", epoch: 1, driverNodeId: pair.aId, localSessionId: sessionId });
		expect(await sharedOn(pair.b, shared.id)).toMatchObject({ localRole: "participant", epoch: 1, driverNodeId: pair.aId });
		expect((await sessionOn(pair.a, sessionId)).movedTo).toBeNull();

		// the mirror is published again (a new publisher run) and B equals A, then follows live
		await eventually(() => pair.b.ctx.shared.store.mirrorState(mirrorId)?.streamId !== streamBefore, "a new mirror stream from the restarted driver", 30_000);
		await promptAndWait(pair.a, sessionId, "back in business");
		await eventually(async () => (await transcriptTexts(pair.a, sessionId)).includes("FAKE: back in business"), "the restarted driver's answer");
		await eventually(async () => {
			const [mine, theirs] = await Promise.all([transcript(pair.b, mirrorId), transcript(pair.a, sessionId)]);
			return JSON.stringify(mine.map((m) => [m.id, textOf(m)])) === JSON.stringify(theirs.map((m) => [m.id, textOf(m)]));
		}, "B's mirror to equal A's transcript", 30_000);
		expect((await transcriptTexts(pair.b, mirrorId)).includes("FAKE: back in business")).toBe(true);
		// the driver keeps taking checkpoints after the restart
		const manual = await api(pair.a).post<{ seq: number }>(`/shared/${shared.id}/checkpoint`, {});
		expect(manual.status).toBe(200);
		await waitForShared(pair.b, shared.id, (s) => s.lastCheckpoint?.seq === manual.body.seq && s.lastCheckpoint.snapshot !== null && s.takeoverBlockedReason !== "No session snapshot has been received yet", "B to hold the post-restart checkpoint", 30_000);
		// B's answer still reaches the restarted driver
		await api(pair.b).post(`/shared/${shared.id}/messages`, { text: "welcome back", kind: "note" });
		await eventually(async () => (await transcriptTexts(pair.a, sessionId)).some((t) => t.includes("welcome back")), "B's message after the restart", 20_000);
	}, 90_000);
});

describe("former-driver work is finished at boot", () => {
	/** A has an unpushed commit and an uncommitted file, dies, B takes over (A offline), and what B queued for A is dropped. */
	async function aDiedAndBTookOver() {
		const joinedSession = await joinedWithNotes();
		const { shared, sessionId } = joinedSession;
		const worktreeA = worktreeOf(pair.a, shared.id);
		writeFileSync(path.join(worktreeA, "LOCAL_COMMIT.md"), "committed on A, never pushed\n");
		git(worktreeA, "add", "LOCAL_COMMIT.md");
		git(worktreeA, "commit", "-m", "local only");
		writeFileSync(path.join(worktreeA, "UNSAVED.md"), "uncommitted on A\n");
		await pair.stop("a");
		await waitForShared(pair.b, shared.id, (s) => s.takeoverAvailable, "takeover available", 20_000);
		const took = await api(pair.b).post<SharedSession>(`/shared/${shared.id}/takeover`, {});
		expect(took.status, JSON.stringify(took.body)).toBe(200);
		const newSessionId = took.body.localSessionId as string;
		await promptAndWait(pair.b, newSessionId, "b carries on");
		// only the journal of A can tell it from now on
		for (const item of pair.b.ctx.tasks.store.pendingOutbox(pair.aId)) pair.b.ctx.tasks.store.updateOutbox(item.id, { state: "cancelled" });
		return { shared, sessionId, newSessionId };
	}

	async function finished(sharedId: string) {
		await eventually(() => !pair.a.ctx.shared.store.get(sharedId).meta.pendingFormerDriver, "A to finish the former-driver steps", 30_000);
		return sharedOn(pair.a, sharedId);
	}

	it("a node that died right after learning it lost the driver role (journal written, nothing done yet) completes everything at the next boot", async () => {
		const { shared, sessionId, newSessionId } = await aDiedAndBTookOver();
		// the state the node was in when it crashed: the driver change applied (one transaction), the rest only journaled
		whileStopped(pair.a, (store) => {
			const row = store.get(shared.id);
			expect(row.localRole).toBe("driver");
			store.updateParticipant(shared.id, pair.aId, { role: "participant" });
			store.updateParticipant(shared.id, pair.bId, { role: "driver", agentSessionId: newSessionId });
			store.update(shared.id, {
				driverNodeId: pair.bId,
				driverNodeName: "node-b",
				epoch: 2,
				localRole: "former_driver",
				mirrorSessionId: null,
				meta: { ...row.meta, pendingFormerDriver: { epoch: 2, driverNodeId: pair.bId, driverNodeName: "node-b", reason: "takeover", sessionId: newSessionId, uiUrl: null } },
			});
		});

		await pair.start("a");
		const former = await finished(shared.id);
		expect(former).toMatchObject({ localRole: "former_driver", epoch: 2, driverNodeId: pair.bId, localSessionId: sessionId });
		// moved, frozen and readable
		const moved = await sessionOn(pair.a, sessionId);
		expect(moved.movedTo).toMatchObject({ nodeId: pair.bId, nodeName: "node-b", sessionId: newSessionId });
		expect(await transcriptTexts(pair.a, sessionId)).toEqual(expect.arrayContaining(["start", "FAKE: start"]));
		const refused = await api(pair.a).post<{ error: { code: string } }>(`/sessions/${sessionId}/prompt`, { message: "still driving?", clientId: "boot-1" });
		expect(refused.body.error.code).toBe("session_moved");
		expect(calls(pair.a).filter((argv) => argv.includes("moved") && argv.includes("node-b"))).toHaveLength(1);
		// the work that was not on the shared branch is on the rescue branch, nothing was lost
		const rescue = `clam/rescue/${shared.id}-node-a`;
		expect(former.rescueBranch).toBe(rescue);
		expect(remoteBranches(pair.origin)).toContain(rescue);
		expect(git(pair.origin, "show", `${rescue}:UNSAVED.md`)).toBe("uncommitted on A\n");
		expect(git(pair.origin, "show", `${rescue}:LOCAL_COMMIT.md`)).toBe("committed on A, never pushed\n");
		expect(() => git(pair.origin, "show", `${shared.repo?.branch}:UNSAVED.md`)).toThrow();
		// a participant again: a mirror of B (which fills up) and its own agent session
		const mirror = await sessionOn(pair.a, former.mirrorSessionId as string);
		expect(mirror).toMatchObject({ kind: "mirror", archived: false });
		await eventually(async () => (await transcriptTexts(pair.a, mirror.id)).some((t) => t.includes("b carries on")), "B's conversation in A's mirror", 30_000);
		const self = former.participants.find((p) => p.nodeId === pair.aId);
		expect(self).toMatchObject({ role: "participant", state: "active" });
		expect(self?.agentSessionId).not.toBe(sessionId);
		expect(await sessionOn(pair.a, self?.agentSessionId as string)).toMatchObject({ kind: "local", archived: false });
		expect(former.participants.find((p) => p.nodeId === pair.bId)).toMatchObject({ role: "driver", state: "active" });
	});

	it("finishing is idempotent: a journal that is found again (crash while finishing) re-runs without a second move, mirror, agent session or commit", async () => {
		const { shared, sessionId, newSessionId } = await aDiedAndBTookOver();
		whileStopped(pair.a, (store) => {
			const row = store.get(shared.id);
			store.updateParticipant(shared.id, pair.aId, { role: "participant" });
			store.updateParticipant(shared.id, pair.bId, { role: "driver", agentSessionId: newSessionId });
			store.update(shared.id, { driverNodeId: pair.bId, driverNodeName: "node-b", epoch: 2, localRole: "former_driver", mirrorSessionId: null, meta: { ...row.meta, pendingFormerDriver: { epoch: 2, driverNodeId: pair.bId, driverNodeName: "node-b", reason: "takeover", sessionId: newSessionId, uiUrl: null } } });
		});
		await pair.start("a");
		const first = await finished(shared.id);
		const rescue = `clam/rescue/${shared.id}-node-a`;
		const commitsBefore = git(pair.origin, "rev-list", "--count", rescue).trim();
		const sessionsBefore = (await sessionsOn(pair.a)).map((s) => s.id).sort();
		const movedCalls = calls(pair.a).filter((argv) => argv.includes("moved")).length;
		expect(movedCalls).toBe(1);

		// the node dies again "in the middle of finishing": the journal is still there at the next boot
		await pair.stop("a");
		whileStopped(pair.a, (store) => {
			store.patchMeta(shared.id, { pendingFormerDriver: { epoch: 2, driverNodeId: pair.bId, driverNodeName: "node-b", reason: "takeover", sessionId: newSessionId, uiUrl: null } });
		});
		await pair.start("a");
		const again = await finished(shared.id);

		expect(again.mirrorSessionId).toBe(first.mirrorSessionId);
		expect(again.participants.find((p) => p.nodeId === pair.aId)?.agentSessionId).toBe(first.participants.find((p) => p.nodeId === pair.aId)?.agentSessionId);
		expect(again.rescueBranch).toBe(rescue);
		expect((await sessionsOn(pair.a)).map((s) => s.id).sort()).toEqual(sessionsBefore);
		expect(calls(pair.a).filter((argv) => argv.includes("moved"))).toHaveLength(movedCalls);
		expect(git(pair.origin, "rev-list", "--count", rescue).trim()).toBe(commitsBefore);
		expect((await sessionOn(pair.a, sessionId)).movedTo).toMatchObject({ nodeId: pair.bId, sessionId: newSessionId });
		expect(git(worktreeOf(pair.a, shared.id), "status", "--porcelain").trim()).toBe("");
		expect(git(pair.origin, "show", `${rescue}:UNSAVED.md`)).toBe("uncommitted on A\n");
	});

	it("a node that comes back after B's takeover and was never told finishes the whole change by asking B", async () => {
		const { shared, sessionId, newSessionId } = await aDiedAndBTookOver();
		await pair.start("a");
		const former = await waitForShared(pair.a, shared.id, (s) => s.localRole === "former_driver" && s.epoch === 2, "A to learn about B by asking", 30_000);
		expect(former.driverNodeId).toBe(pair.bId);
		await finished(shared.id);
		expect((await sessionOn(pair.a, sessionId)).movedTo).toMatchObject({ nodeId: pair.bId, sessionId: newSessionId });
		expect(remoteBranches(pair.origin)).toContain(`clam/rescue/${shared.id}-node-a`);
		expect((await sharedOn(pair.a, shared.id)).mirrorSessionId).not.toBeNull();
	});
});
