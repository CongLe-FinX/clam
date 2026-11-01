import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { standardizeProjectDir } from "@clam/agent-runtime/omp";
import path from "node:path";
import type { AgentSession, Checkpoint, SharedSession } from "@clam/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { api } from "./full-harness.ts";
import { expectI18nMatches, expectTransferLocalised } from "./i18n-helpers.ts";
import { eventually, signedRequest } from "./net-helpers.ts";
import {
	detailOn,
	git,
	isolateGitConfig,
	promptAndWait,
	promptsOf,
	readIn,
	remoteBranches,
	sessionOn,
	sessionsOn,
	sharedOn,
	startSharedPair,
	transcript,
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

/** A is the driver, has written SHARED_NOTES.md (checkpointed and pushed), and both nodes are up. */
async function sharedWithNotes() {
	pair = await startSharedPair();
	const joined = await pair.shareAndJoin({ title: "Add notes", firstPrompt: "write the notes" });
	await promptAndWait(pair.a, joined.sessionId, "@@fake-sh echo 'line one' > SHARED_NOTES.md");
	const checkpointed = await waitForShared(pair.a, joined.shared.id, (s) => (s.lastCheckpoint?.seq ?? 0) >= 2 && s.lastCheckpoint?.deliveredTo.includes(pair.bId) === true, "the checkpoint with the file reached B");
	return { ...joined, checkpoint: checkpointed.lastCheckpoint as Checkpoint };
}

function calls(node: SharedPair["a"]): string[][] {
	const file = path.join(node.dataDir, "fake-home", "calls.jsonl");
	return existsSync(file)
		? readFileSync(file, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l) as string[])
		: [];
}

describe("manual takeover on B", () => {
	it("is refused while the driver is online (unless forced), and offered once A is offline", async () => {
		const { shared } = await sharedWithNotes();
		const blocked = await sharedOn(pair.b, shared.id);
		expect(blocked.takeoverAvailable).toBe(false);
		expect(blocked.takeoverBlockedReason).toContain("is online");
		expectI18nMatches({ i18n: blocked.takeoverBlockedI18n }, blocked.takeoverBlockedReason as string);
		expect(blocked.takeoverBlockedI18n).toEqual({ key: "{name} (the driver) is online; ask it to transfer, or continue here anyway", params: { name: "node-a" } });
		const refused = await api(pair.b).post<{ error: { code: string } }>(`/shared/${shared.id}/takeover`, {});
		expect(refused.status).toBe(409);
		expect(refused.body.error.code).toBe("driver_online");
		expect((await sharedOn(pair.b, shared.id)).localRole).toBe("participant");

		await pair.stop("a");
		const offered = await waitForShared(pair.b, shared.id, (s) => s.takeoverAvailable, "takeover available once A is offline", 20_000);
		expect(offered.takeoverBlockedReason).toBeNull();
	});

	it("continues A's conversation in a NEW local session on B: snapshot unpacked, branch at the checkpoint, epoch + 1, A announced to", async () => {
		const { sessionId, shared, checkpoint } = await sharedWithNotes();
		await pair.stop("a");
		await waitForShared(pair.b, shared.id, (s) => s.takeoverAvailable, "takeover available", 20_000);
		const before = await sessionsOn(pair.b);

		const took = await api(pair.b).post<SharedSession>(`/shared/${shared.id}/takeover`, {});
		expect(took.status, JSON.stringify(took.body)).toBe(200);
		expect(took.body).toMatchObject({ localRole: "driver", epoch: 2, driverNodeId: pair.bId, mirrorSessionId: null });
		const newSessionId = took.body.localSessionId as string;
		expect(newSessionId).not.toBe(sessionId);
		const fresh = await sessionOn(pair.b, newSessionId);
		expect(fresh).toMatchObject({ kind: "local", sharedSessionId: shared.id, projectId: pair.projectB.id, movedTo: null });
		expect(before.map((s) => s.id)).not.toContain(newSessionId);

		// the new session carries A's earlier conversation, then the continuation note (answered by the resumed agent)
		await eventually(async () => (await transcriptTexts(pair.b, newSessionId)).some((t) => t.includes("driver changed (epoch 2)")), "the continuation note in the new session", 20_000);
		const texts = await transcriptTexts(pair.b, newSessionId);
		expect(texts).toEqual(expect.arrayContaining(["write the notes", "FAKE: write the notes", expect.stringContaining("@@fake-sh echo 'line one'")]));
		const note = texts.find((t) => t.includes("driver changed (epoch 2)")) as string;
		expect(note).toContain(`checkpoint ${checkpoint.seq}`);
		expect(note).toContain("may be missing");
		expect(note).toContain("DRIVER");

		// B's clone is on the shared branch at the checkpoint commit, with A's file
		expect(git(pair.workB, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(shared.repo?.branch);
		expect(git(pair.workB, "rev-parse", "HEAD").trim()).toBe(checkpoint.commit);
		expect(readIn(pair.workB, "SHARED_NOTES.md")).toBe("line one\n");
		// `omp session unpack <archive> --cwd <B's clone, spelled the way omp spells it>` ran on B
		const unpack = calls(pair.b).find((argv) => argv.includes("unpack"));
		expect(unpack).toBeDefined();
		expect(unpack?.slice(unpack.indexOf("--cwd"))).toEqual(["--cwd", standardizeProjectDir(pair.workB)]);

		// retired: B's mirror of A and its participant session are archived (history kept)
		const archived = (await api(pair.b).get<AgentSession[]>("/sessions?archived=true")).body.filter((s) => s.sharedSessionId === shared.id);
		expect(archived.map((s) => s.kind).sort()).toEqual(["local", "mirror"]);
		expect(archived.every((s) => s.archived)).toBe(true);
		const now = await sharedOn(pair.b, shared.id);
		expect(now.participants.find((p) => p.nodeId === pair.bId)).toMatchObject({ role: "driver", agentSessionId: newSessionId });
		expect(now.participants.find((p) => p.nodeId === pair.aId)).toMatchObject({ role: "participant", state: "active", nodeStatus: expect.stringMatching(/offline|degraded/) });
		expect((await detailOn(pair.b, shared.id)).messages.some((m) => m.author.kind === "system" && m.text.includes("continues as driver (epoch 2)"))).toBe(true);

		// A is told through the outbox the moment it returns
		const pending = pair.b.ctx.tasks.store.pendingOutbox(pair.aId).filter((o) => o.kind === "shared.driver");
		expect(pending).toHaveLength(1);
		expect(pending[0]?.body).toMatchObject({ epoch: 2, reason: "takeover", checkpointSeq: checkpoint.seq, commit: checkpoint.commit, sessionId: newSessionId });
	});

	it("refuses to touch overlapping local changes in B's clone and leaves everything as it was", async () => {
		const { shared } = await sharedWithNotes();
		await pair.stop("a");
		await waitForShared(pair.b, shared.id, (s) => s.takeoverAvailable, "takeover available", 20_000);
		writeFileSync(path.join(pair.workB, "SHARED_NOTES.md"), "B's own unsaved notes\n");
		const res = await api(pair.b).post<{ error: { code: string; message: string } }>(`/shared/${shared.id}/takeover`, {});
		expect(res.status).toBe(409);
		expect(readIn(pair.workB, "SHARED_NOTES.md")).toBe("B's own unsaved notes\n");
		expect((await sharedOn(pair.b, shared.id)).localRole).toBe("participant");
		expect((await sessionsOn(pair.b)).filter((s) => s.kind === "local" && s.sharedSessionId === shared.id && s.title === "Add notes")).toEqual([]);
	});

	it("forced takeover while the driver is online makes the driver a participant right away", async () => {
		const { sessionId, shared } = await sharedWithNotes();
		const took = await api(pair.b).post<SharedSession>(`/shared/${shared.id}/takeover`, { force: true });
		expect(took.status, JSON.stringify(took.body)).toBe(200);
		expect(took.body).toMatchObject({ localRole: "driver", epoch: 2 });
		const former = await waitForShared(pair.a, shared.id, (s) => s.localRole === "former_driver" && s.epoch === 2, "A learns it is not the driver any more", 20_000);
		expect(former).toMatchObject({ driverNodeId: pair.bId, localSessionId: sessionId });
		const moved = await eventually(async () => (await sessionOn(pair.a, sessionId)).movedTo, "A's driving session marked moved");
		expect(moved).toMatchObject({ nodeId: pair.bId, nodeName: "node-b", sessionId: took.body.localSessionId });
	});
});

describe("the former driver returns", () => {
	it("becomes read-only 'moved', saves its unpushed work on a rescue branch, mirrors B, and cannot act at the old epoch", async () => {
		const { sessionId, shared, checkpoint } = await sharedWithNotes();
		// work on A after its last checkpoint: an unpushed commit and an uncommitted file
		writeFileSync(path.join(pair.workA, "LOCAL_COMMIT.md"), "committed on A, never pushed\n");
		git(pair.workA, "add", "LOCAL_COMMIT.md");
		git(pair.workA, "commit", "-m", "local only");
		writeFileSync(path.join(pair.workA, "UNSAVED.md"), "uncommitted on A\n");
		await pair.stop("a");
		await waitForShared(pair.b, shared.id, (s) => s.takeoverAvailable, "takeover available", 20_000);
		const took = await api(pair.b).post<SharedSession>(`/shared/${shared.id}/takeover`, {});
		expect(took.status, JSON.stringify(took.body)).toBe(200);
		const newSessionId = took.body.localSessionId as string;
		await promptAndWait(pair.b, newSessionId, "append line two to the notes");

		// A comes back
		await pair.start("a");
		await waitForShared(pair.a, shared.id, (s) => s.localRole === "former_driver" && s.rescueBranch !== null, "A processed the driver change", 30_000);
		// the half-done part of losing the driver role is journaled; wait until it is finished (moved, rescued, mirrored)
		await eventually(() => !pair.a.ctx.shared.store.get(shared.id).meta.pendingFormerDriver, "A finished the former-driver steps", 30_000);
		const former = await sharedOn(pair.a, shared.id);
		expect(former).toMatchObject({ epoch: 2, driverNodeId: pair.bId, localSessionId: sessionId });

		// the rescue branch holds BOTH the unpushed commit and the uncommitted file; the shared branch has neither
		const rescue = `clam/rescue/${shared.id}-node-a`;
		expect(former.rescueBranch).toBe(rescue);
		expect(remoteBranches(pair.origin)).toContain(rescue);
		expect(git(pair.origin, "show", `${rescue}:UNSAVED.md`)).toBe("uncommitted on A\n");
		expect(git(pair.origin, "show", `${rescue}:LOCAL_COMMIT.md`)).toBe("committed on A, never pushed\n");
		expect(() => git(pair.origin, "show", `${shared.repo?.branch}:UNSAVED.md`)).toThrow();
		expect(() => git(pair.origin, "show", `${shared.repo?.branch}:LOCAL_COMMIT.md`)).toThrow();
		expect(git(pair.origin, "log", "-1", "--format=%B", rescue)).toContain(`Session: ${shared.id}`);
		expect(git(pair.workA, "status", "--porcelain").trim()).toBe("");
		expect(readIn(pair.workA, "UNSAVED.md")).toBe("uncommitted on A\n");

		// the driving session is a read-only moved copy with a link to B; its transcript is frozen and readable
		const moved = await sessionOn(pair.a, sessionId);
		expect(moved.movedTo).toMatchObject({ nodeId: pair.bId, nodeName: "node-b", sessionId: newSessionId });
		expect(await transcriptTexts(pair.a, sessionId)).toEqual(expect.arrayContaining(["write the notes", "FAKE: write the notes"]));
		const prompt = await api(pair.a).post<{ error: { code: string; message: string } }>(`/sessions/${sessionId}/prompt`, { message: "still me?", clientId: "late-1" });
		expect(prompt.status).toBe(409);
		expect(prompt.body.error).toMatchObject({ code: "session_moved", message: expect.stringContaining("node-b") });
		// `omp session moved` marked the OMP copy
		expect(calls(pair.a).some((argv) => argv.includes("moved") && argv.includes("node-b"))).toBe(true);

		// A carries on as a participant: a mirror of B's session (with B's continued conversation) and its participant session
		const mirror = await sessionOn(pair.a, former.mirrorSessionId as string);
		expect(mirror).toMatchObject({ kind: "mirror", sharedSessionId: shared.id, archived: false });
		await eventually(async () => (await transcriptTexts(pair.a, mirror.id)).some((t) => t.includes("append line two to the notes")), "B's conversation in A's mirror", 20_000);
		const self = former.participants.find((p) => p.nodeId === pair.aId);
		expect(self).toMatchObject({ role: "participant", state: "active" });
		expect(self?.agentSessionId).not.toBe(sessionId);

		// fenced: A cannot checkpoint, and a driver call at the old epoch is refused by B
		const checkpointAgain = await api(pair.a).post<{ error: { code: string } }>(`/shared/${shared.id}/checkpoint`, {});
		expect(checkpointAgain.status).toBe(409);
		expect(checkpointAgain.body.error.code).toBe("not_driver");
		const stale = await signedRequest(pair.a, pair.b.netUrl, {
			method: "POST",
			path: `/shared/${shared.id}/mirror`,
			body: { type: "events", epoch: 1, streamId: "str_old", seq: 1, events: [{ type: "agent_start" }] },
		});
		expect(stale.status).toBe(409);
		expect(stale.body.error).toMatchObject({ code: "stale_epoch", details: { currentEpoch: 2, driverNodeId: pair.bId } });
		const staleNotice = await signedRequest(pair.a, pair.b.netUrl, {
			method: "POST",
			path: `/shared/${shared.id}/checkpoints`,
			body: { seq: 99, epoch: 1, branch: shared.repo?.branch, pushed: true, at: new Date().toISOString() },
		});
		expect(staleNotice.status).toBe(409);
		expect(staleNotice.body.error.code).toBe("stale_epoch");
		expect(checkpoint.epoch).toBe(1);

		// the new driver keeps working and A's participant shows up as active on B
		const onB = await sharedOn(pair.b, shared.id);
		expect(onB.participants.find((p) => p.nodeId === pair.aId)).toMatchObject({ role: "participant", state: "active" });
		expect(promptsOf(pair.a).filter((p) => p.message.includes("still me?"))).toEqual([]);
	});

	it("learns of the change when it asks (reconcile) even if the announcement was never delivered", async () => {
		const { sessionId, shared } = await sharedWithNotes();
		await pair.stop("a");
		await waitForShared(pair.b, shared.id, (s) => s.takeoverAvailable, "takeover available", 20_000);
		await api(pair.b).post(`/shared/${shared.id}/takeover`, {});
		// drop what B queued for A: only the reconcile (GET /shared/:id) can tell A now
		for (const item of pair.b.ctx.tasks.store.pendingOutbox(pair.aId)) pair.b.ctx.tasks.store.updateOutbox(item.id, { state: "cancelled" });
		await pair.start("a");
		const former = await waitForShared(pair.a, shared.id, (s) => s.localRole === "former_driver" && s.epoch === 2, "A reconciled with B", 30_000);
		expect(former.driverNodeId).toBe(pair.bId);
		expect((await eventually(async () => (await sessionOn(pair.a, sessionId)).movedTo, "A's driving session marked moved"))?.nodeId).toBe(pair.bId);
	});
});

describe("transfer with both nodes online", () => {
	it("takes a fresh checkpoint, waits for B to hold it, B takes over, A's session is marked moved, nothing needs rescuing", async () => {
		const { sessionId, shared } = await sharedWithNotes();
		// the runtime restarts in the background after each snapshot; a hand-over started meanwhile is refused with session_busy
		await whenSettled(pair.a, sessionId);
		const started = await api(pair.a).post<SharedSession>(`/shared/${shared.id}/transfer`, { toNodeId: pair.bId });
		expect(started.status, JSON.stringify(started.body)).toBe(202);
		expect(started.body.transfer).toMatchObject({ toNodeId: pair.bId, toNodeName: "node-b" });
		const done = await waitForShared(pair.a, shared.id, (s) => s.transfer?.phase === "continuing" && s.localRole === "former_driver", "the hand-over finished", 30_000);
		expect(done).toMatchObject({ epoch: 2, driverNodeId: pair.bId, localSessionId: sessionId, transfer: { phase: "continuing", toNodeId: pair.bId } });
		// the progress sentence of the record renders from its twin
		expectTransferLocalised(done.transfer as NonNullable<SharedSession["transfer"]>);

		const onB = await waitForShared(pair.b, shared.id, (s) => s.localRole === "driver" && s.epoch === 2, "B is the driver");
		const fresh = await sessionOn(pair.b, onB.localSessionId as string);
		expect(fresh).toMatchObject({ kind: "local", sharedSessionId: shared.id });
		await eventually(async () => (await transcriptTexts(pair.b, fresh.id)).some((t) => t.includes("handed over to this node")), "the continuation note of a transfer", 20_000);
		const note = (await transcriptTexts(pair.b, fresh.id)).find((t) => t.includes("handed over to this node"));
		expect(note).not.toContain("may be missing");
		expect(note).toContain("Nothing is missing");
		// the transfer checkpoint is the one B continued from
		const last = onB.lastCheckpoint as Checkpoint;
		expect(last.note).toContain("Hand-over to node-b");
		expect(git(pair.workB, "rev-parse", "HEAD").trim()).toBe(last.commit);

		const former = await waitForShared(pair.a, shared.id, (s) => s.localRole === "former_driver" && s.mirrorSessionId !== null && s.rescueBranch === null, "A finished becoming a participant", 20_000);
		expect((await sessionOn(pair.a, sessionId)).movedTo).toMatchObject({ nodeId: pair.bId, sessionId: fresh.id });
		expect(remoteBranches(pair.origin).filter((b) => b.startsWith("clam/rescue/"))).toEqual([]);
		expect(calls(pair.a).some((argv) => argv.includes("moved") && argv.includes("node-b"))).toBe(true);
		expect(former.participants.find((p) => p.nodeId === pair.aId)).toMatchObject({ role: "participant" });
	});

	it("is refused for a target that is offline, a stranger, or by a node that does not drive", async () => {
		const { shared } = await sharedWithNotes();
		expect((await api(pair.b).post<{ error: { code: string } }>(`/shared/${shared.id}/transfer`, { toNodeId: pair.aId })).body.error.code).toBe("not_driver");
		expect((await api(pair.a).post<{ error: { code: string } }>(`/shared/${shared.id}/transfer`, { toNodeId: "nobody" })).status).toBe(404);
		expect((await api(pair.a).post<{ error: { code: string } }>(`/shared/${shared.id}/transfer`, { toNodeId: pair.aId })).body.error.code).toBe("invalid_target");
		await pair.stop("b");
		await eventually(async () => (await sharedOn(pair.a, shared.id)).participants.find((p) => p.nodeId === pair.bId)?.nodeStatus === "offline", "A sees B offline", 20_000);
		const offline = await api(pair.a).post<{ error: { code: string } }>(`/shared/${shared.id}/transfer`, { toNodeId: pair.bId });
		expect(offline.status).toBe(409);
		expect(offline.body.error.code).toBe("target_offline");
		expect((await sharedOn(pair.a, shared.id)).localRole).toBe("driver");
		await pair.start("b");
	});
});

describe("leaving and removing", () => {
	it("a participant leaves: its mirror and participant session are archived, the driver is told, and nothing more is sent to it", async () => {
		const { sessionId, shared, onB } = await sharedWithNotes();
		const bAgentSession = onB.participants.find((p) => p.nodeId === pair.bId)?.agentSessionId as string;
		const left = await api(pair.b).post<SharedSession>(`/shared/${shared.id}/leave`);
		expect(left.status).toBe(200);
		expect((await sessionOn(pair.b, onB.mirrorSessionId as string)).archived).toBe(true);
		expect((await sessionOn(pair.b, bAgentSession)).archived).toBe(true);
		await waitForShared(pair.a, shared.id, (s) => s.participants.find((p) => p.nodeId === pair.bId)?.state === "left", "A sees B left");
		expect((await api(pair.b).get<SharedSession[]>("/shared")).body).toEqual([]);
		// a later message is not delivered to B
		const posted = await api(pair.a).post<{ id: string }>(`/shared/${shared.id}/messages`, { text: "anyone there?", kind: "note" });
		expect(posted.status).toBe(201);
		await promptAndWait(pair.a, sessionId, "still working");
		expect((await detailOn(pair.b, shared.id)).messages.some((m) => m.text === "anyone there?")).toBe(false);
		// the session cannot be deleted while it is part of an active shared session; after leaving it can
		expect((await api(pair.a).del(`/sessions/${sessionId}`)).status).toBe(409);
	});

	it("the driver cannot leave, and can remove a participant, which tears it down on that node", async () => {
		const { shared, onB } = await sharedWithNotes();
		const leave = await api(pair.a).post<{ error: { code: string } }>(`/shared/${shared.id}/leave`);
		expect(leave.status).toBe(409);
		expect(leave.body.error.code).toBe("driver_cannot_leave");
		const removed = await api(pair.a).del<SharedSession>(`/shared/${shared.id}/participants/${pair.bId}`);
		expect(removed.status).toBe(200);
		expect(removed.body.participants.find((p) => p.nodeId === pair.bId)?.state).toBe("removed");
		await eventually(async () => (await sessionOn(pair.b, onB.mirrorSessionId as string)).archived, "B tore its mirror down", 20_000);
		expect((await api(pair.b).get<SharedSession[]>("/shared")).body).toEqual([]);
		expect((await detailOn(pair.b, shared.id)).shared.participants.find((p) => p.nodeId === pair.bId)?.state).toBe("left");
	});
});
