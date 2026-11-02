import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { AgentSession, Checkpoint, SharedInvite, SharedSession } from "@clam/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { api } from "./full-harness.ts";
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
	transcriptTexts,
	waitForShared,
	whenSettled,
	worktreeOf,
	type GitConfigIsolation,
	type SharedPair,
} from "./shared-fixtures.ts";

/**
 * Shared sessions between two real in-process nodes: real server, real git against a local bare origin, fake omp (its
 * `pack`/`unpack`/`moved` emulation included). Nothing in the shared-session feature is replaced.
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

describe("sharing a session and joining it", () => {
	it("creates the shared branch, invites B, and B accepts by hand: mirror + participant sessions, snapshot delivered", async () => {
		pair = await startSharedPair();
		const { sessionId, shared, onB } = await pair.shareAndJoin({ title: "Add notes", firstPrompt: "write the notes" });

		// A: a SharedSession with this node as driver, epoch 1 and a shared branch created from main and pushed
		expect(shared).toMatchObject({ epoch: 1, localRole: "driver", localSessionId: sessionId, localProjectId: pair.projectA.id, driverNodeId: pair.aId, title: "Add notes" });
		expect(shared.repo).toEqual({ url: "https://github.com/acme/demo", branch: expect.stringMatching(/^clam\/shared\/add-notes-[a-z0-9]{6}$/) });
		expect(remoteBranches(pair.origin)).toContain(shared.repo?.branch);
		// the project folder keeps its branch; the shared branch lives in the session's own worktree
		expect(git(pair.workA, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
		expect(git(worktreeOf(pair.a, shared.id), "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(shared.repo?.branch);
		expect((await sessionOn(pair.a, sessionId)).sharedSessionId).toBe(shared.id);

		// B: participant, with a read-only mirror and its own briefed participant session in its clone
		expect(onB).toMatchObject({ epoch: 1, localRole: "participant", localProjectId: pair.projectB.id, driverNodeId: pair.aId });
		const mirror = await sessionOn(pair.b, onB.mirrorSessionId as string);
		expect(mirror).toMatchObject({ kind: "mirror", sharedSessionId: shared.id, movedTo: null });
		const self = onB.participants.find((p) => p.nodeId === pair.bId);
		expect(self).toMatchObject({ role: "participant", state: "active", nodeStatus: "self" });
		const participantSession = await sessionOn(pair.b, self?.agentSessionId as string);
		expect(participantSession).toMatchObject({ kind: "local", sharedSessionId: shared.id, projectId: pair.projectB.id });
		await eventually(async () => (await transcriptTexts(pair.b, participantSession.id)).some((t) => t.includes("# Shared session: Add notes")), "the briefing in B's participant session");

		// the first checkpoint: committed + pushed by A (nothing to commit but the session), snapshot delivered to B
		const onA = await waitForShared(pair.a, shared.id, (s) => s.lastCheckpoint?.snapshot != null && s.lastCheckpoint.deliveredTo.includes(pair.bId), "the snapshot reached B");
		expect(onA.lastCheckpoint).toMatchObject({ seq: 1, epoch: 1, nodeId: pair.aId, branch: shared.repo?.branch, pushed: true });
		const onBLater = await waitForShared(pair.b, shared.id, (s) => s.lastCheckpoint?.snapshot != null && s.takeoverBlockedReason !== "No session snapshot has been received yet", "B holds the snapshot");
		expect(onBLater.lastCheckpoint?.snapshot?.sha256).toBe(onA.lastCheckpoint?.snapshot?.sha256);
		const stored = path.join(pair.b.dataDir, "shared", shared.id, "snapshots", "1.tar");
		expect(existsSync(stored)).toBe(true);
		expect(statSync(stored).mode & 0o777).toBe(0o600);
	});

	it("auto-accepts when B's policy allows it and exactly one local project matches", async () => {
		pair = await startSharedPair();
		const { shared, onB } = await pair.shareAndJoin({ autoAccept: true });
		expect(onB.localRole).toBe("participant");
		const invites = (await api(pair.b).get<SharedInvite[]>("/shared/invites")).body;
		expect(invites).toEqual([expect.objectContaining({ sharedSessionId: shared.id, state: "accepted", candidateProjectIds: [pair.projectB.id] })]);
	});

	it("tells the user clearly when a capability is missing, and does not create anything", async () => {
		pair = await startSharedPair();
		const peerB = (await api(pair.a).get<Array<{ id: string; grantedCapabilities: string[] }>>("/network/peers")).body.find((p) => p.id === pair.bId);
		await api(pair.a).patch(`/network/peers/${pair.bId}`, { grantedCapabilities: (peerB?.grantedCapabilities ?? []).filter((c) => c !== "sessions.share") });
		const created = await api(pair.a).post<AgentSession>("/sessions", { projectId: pair.projectA.id, title: "X" });
		const res = await api(pair.a).post<{ error: { code: string; message: string } }>(`/sessions/${created.body.id}/participants`, { nodeId: pair.bId });
		expect(res.status).toBe(409);
		expect(res.body.error).toMatchObject({ code: "capability_missing", message: expect.stringContaining("has not granted") });
		expect((await api(pair.a).get<SharedSession[]>("/shared")).body).toEqual([]);
		expect(remoteBranches(pair.origin)).toEqual(["main"]);
	});
});

describe("the discussion", () => {
	it("a question from A's agent mentioning B's agent wakes it, B answers mentioning A, and both messages are injected on the other side", async () => {
		pair = await startSharedPair();
		const { sessionId, shared, onB } = await pair.shareAndJoin({ firstPrompt: "start" });
		const bAgentSession = onB.participants.find((p) => p.nodeId === pair.bId)?.agentSessionId as string;
		// A's agent asks; B's agent (woken by the injected message, which carries the directive) answers with mesh_say
		const answer = '@@fake-tool mesh_say {"text":"@node-a The notes live in SHARED_NOTES.md","kind":"answer"}';
		await promptAndWait(pair.a, sessionId, `@@fake-tool mesh_say ${JSON.stringify({ text: `@node-b Which file holds the notes?\n${answer}`, kind: "question" })}`);

		const detailA = await eventually(
			async () => {
				const d = await detailOn(pair.a, shared.id);
				return d.messages.some((m) => m.kind === "answer") ? d : undefined;
			},
			"B's answer in A's group log",
		);
		const question = detailA.messages.find((m) => m.kind === "question");
		const reply = detailA.messages.find((m) => m.kind === "answer");
		expect(question).toMatchObject({ author: { kind: "agent", nodeId: pair.aId, agentName: "OMP Agent" }, originNodeId: pair.aId, delivery: "delivered", to: { mode: "agents", agents: [{ nodeId: pair.bId }] } });
		expect(reply).toMatchObject({ author: { kind: "agent", nodeId: pair.bId }, originNodeId: pair.bId, text: "@node-a The notes live in SHARED_NOTES.md", to: { mode: "agents", agents: [{ nodeId: pair.aId }] } });
		await eventually(async () => (await detailOn(pair.a, shared.id)).messages.find((m) => m.kind === "answer")?.injectedIntoSession === true, "the answer handed to A's agent");

		// B's participant session saw the framed question; A's driving session saw the framed answer
		const bTexts = await transcriptTexts(pair.b, bAgentSession);
		expect(bTexts.some((t) => t.startsWith(`[CL Agent Mesh] shared session ${shared.id} · "Add notes" · from OMP Agent@node-a · kind question`))).toBe(true);
		const aTexts = await transcriptTexts(pair.a, sessionId);
		expect(aTexts.some((t) => t.startsWith(`[CL Agent Mesh] shared session ${shared.id} · "Add notes" · from OMP Agent@node-b · kind answer`) && t.includes("SHARED_NOTES.md"))).toBe(true);
		// an agent's own words are never injected into its own session
		expect(promptsOf(pair.a).filter((p) => (p.message.split("\n")[0] ?? "").includes("kind question"))).toEqual([]);
	});

	it("a human message without a mention goes to the lead only; the other agent keeps it for its next addressed turn", async () => {
		pair = await startSharedPair();
		const { sessionId, shared, onB } = await pair.shareAndJoin({ firstPrompt: "start" });
		const bAgentSession = onB.participants.find((p) => p.nodeId === pair.bId)?.agentSessionId as string;
		const posted = await api(pair.b).post<{ id: string; to: unknown }>(`/shared/${shared.id}/messages`, { text: "Please keep commits small", kind: "note" });
		expect(posted.status).toBe(201);
		expect(posted.body.to).toEqual({ mode: "lead", agents: [] });
		await eventually(async () => (await transcriptTexts(pair.a, sessionId)).some((t) => t.includes("Please keep commits small") && t.includes("from human@node-b")), "A's driving session got B's human message");
		await whenSettled(pair.a, sessionId);
		// B's agent was not addressed: it has not been bothered with it
		expect((await transcriptTexts(pair.b, bAgentSession)).some((t) => t.includes("Please keep commits small"))).toBe(false);
		const detail = await eventually(async () => {
			const d = await detailOn(pair.b, shared.id);
			return d.messages.find((m) => m.id === posted.body.id)?.delivery === "delivered" ? d : undefined;
		}, "delivery state of the message on B");
		expect(detail.messages.find((m) => m.id === posted.body.id)).toMatchObject({ author: { kind: "human", nodeId: pair.bId }, injectedIntoSession: false });
		// A shows it unread until it marks the thread read
		const onA = await waitForShared(pair.a, shared.id, (s) => s.unreadMessages > 0, "unread on A");
		expect(onA.unreadMessages).toBeGreaterThan(0);
		expect((await api(pair.a).post(`/shared/${shared.id}/read`)).status).toBe(204);
		expect((await sharedOn(pair.a, shared.id)).unreadMessages).toBe(0);
	});

	it("the loop guard stops an agent after the configured number of waking messages until a human writes", async () => {
		pair = await startSharedPair();
		const { sessionId, shared } = await pair.shareAndJoin({ firstPrompt: "start" });
		const say = (n: number) => `@@fake-tool mesh_say ${JSON.stringify({ text: `@node-b note ${n}`, kind: "note" })}`;
		const lines = Array.from({ length: 13 }, (_, i) => say(i + 1)).join("\n");
		await promptAndWait(pair.a, sessionId, lines, 30_000);
		// 12 got through, the 13th was refused with the guard's message (the tool error is part of the fake's answer; `promptAndWait` returns at the first, still streaming, assistant message)
		await eventually(async () => (await transcriptTexts(pair.a, sessionId)).some((t) => t.includes("Agent message limit reached")), "the guard's refusal in the answer", 30_000);
		const notes = (await detailOn(pair.a, shared.id)).messages.filter((m) => m.author.kind === "agent" && m.kind === "note");
		expect(notes).toHaveLength(12);
		expect((await sharedOn(pair.a, shared.id)).agentMessageBudget).toBe(0);
		// a human message resets the budget
		await api(pair.a).post(`/shared/${shared.id}/messages`, { text: "carry on", kind: "note" });
		expect((await sharedOn(pair.a, shared.id)).agentMessageBudget).toBe(12);
	});
});

describe("checkpoints", () => {
	it("a manual checkpoint commits the working tree to the shared branch with trailers, pushes it and delivers the snapshot", async () => {
		pair = await startSharedPair();
		const { sessionId, shared } = await pair.shareAndJoin({ firstPrompt: "start" });
		await waitForShared(pair.a, shared.id, (s) => s.lastCheckpoint?.snapshot != null, "the first checkpoint");
		await promptAndWait(pair.a, sessionId, "@@fake-sh echo 'line one' > SHARED_NOTES.md");
		// the automatic checkpoint after the settled turn picks the file up (debounce is 150 ms in the harness)
		const next = await waitForShared(pair.a, shared.id, (s) => (s.lastCheckpoint?.seq ?? 0) >= 2 && s.lastCheckpoint?.deliveredTo.includes(pair.bId) === true, "an automatic checkpoint with the file");
		const checkpoint = next.lastCheckpoint as Checkpoint;
		expect(checkpoint.pushed).toBe(true);
		expect(git(pair.origin, "show", `${shared.repo?.branch}:SHARED_NOTES.md`)).toBe("line one\n");
		const message = git(pair.origin, "log", "-1", "--format=%B", shared.repo?.branch as string);
		expect(message).toContain(`Session: ${shared.id}`);
		expect(message).toContain("Epoch: 1");
		expect(message).toContain("Agent: OMP Agent@node-a");
		expect(git(pair.origin, "rev-parse", shared.repo?.branch as string).trim()).toBe(checkpoint.commit);

		// a manual checkpoint with nothing new: no new commit, a new snapshot
		const manual = await api(pair.a).post<Checkpoint>(`/shared/${shared.id}/checkpoint`, { note: "before lunch" });
		expect(manual.status).toBe(200);
		expect(manual.body).toMatchObject({ seq: checkpoint.seq + 1, commit: checkpoint.commit, pushed: true, note: expect.stringContaining("before lunch") });
		expect(manual.body.snapshot?.messageCount).toBeGreaterThan(0);
		await waitForShared(pair.b, shared.id, (s) => s.lastCheckpoint?.seq === manual.body.seq && s.lastCheckpoint.deliveredTo.includes(pair.bId), "B holds the manual checkpoint");
		// only the driver takes checkpoints
		const refused = await api(pair.b).post<{ error: { code: string } }>(`/shared/${shared.id}/checkpoint`, {});
		expect(refused.status).toBe(409);
		expect(refused.body.error.code).toBe("not_driver");
	});

	it("keeps the session usable: a prompt sent while the snapshot cycle runs is answered", async () => {
		pair = await startSharedPair();
		const { sessionId, shared } = await pair.shareAndJoin({ firstPrompt: "start" });
		await waitForShared(pair.a, shared.id, (s) => s.lastCheckpoint?.snapshot != null, "the first checkpoint");
		const taking = api(pair.a).post<Checkpoint>(`/shared/${shared.id}/checkpoint`, {});
		await promptAndWait(pair.a, sessionId, "during the cycle");
		// `promptAndWait` returns at the first (still streaming) assistant message
		await eventually(async () => (await transcriptTexts(pair.a, sessionId)).some((t) => t.includes("FAKE: during the cycle")), "the complete answer to the prompt sent during the cycle");
		expect((await taking).status).toBe(200);
		expect((await sessionsOn(pair.a)).find((s) => s.id === sessionId)).toBeDefined();
	});

	it("a turn that settles while a checkpoint runs is covered by the next checkpoint, not followed by an empty extra one", async () => {
		pair = await startSharedPair();
		const { sessionId, shared } = await pair.shareAndJoin({ firstPrompt: "start" });
		// no waiting for the initial checkpoint: this turn settles while it runs, which used to leave a second, empty automatic checkpoint queued behind the one that covers the turn
		await promptAndWait(pair.a, sessionId, "@@fake-sh echo 'line one' > SHARED_NOTES.md");
		const covering = await waitForShared(pair.a, shared.id, (s) => (s.lastCheckpoint?.seq ?? 0) >= 2 && s.lastCheckpoint?.deliveredTo.includes(pair.bId) === true, "the automatic checkpoint with the file");
		// a manual checkpoint queues behind every automatic one that is still waiting: it is the very next one only when none is
		const manual = await api(pair.a).post<Checkpoint>(`/shared/${shared.id}/checkpoint`, {});
		expect(manual.status).toBe(200);
		expect(manual.body.seq).toBe((covering.lastCheckpoint as Checkpoint).seq + 1);
	});
});
