import type { HostToolResult } from "@clam/agent-runtime";
import type { AgentSession, SharedInvite, SharedSession, SharedSessionDetail } from "@clam/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { api, connectWs, type FullHarness } from "./full-harness.ts";
import { eventually } from "./net-helpers.ts";
import {
	detailOn,
	isolateGitConfig,
	promptsOf,
	sessionOn,
	sharedOn,
	startSharedPair,
	transcriptTexts,
	waitForShared,
	whenSettled,
	type GitConfigIsolation,
	type SharedPair,
} from "./shared-fixtures.ts";

/**
 * What sessions may do with a shared session: the host tools `mesh_team` / `mesh_say`, the protection against deleting a
 * session that is part of an active shared session, the list of active shared sessions, and the WebSocket topics.
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

let callCounter = 0;

/** Run a host tool exactly as the runtime does when an agent calls it. */
function tool(node: FullHarness, sessionId: string, toolName: string, args: unknown, signal = new AbortController().signal): Promise<HostToolResult> {
	return node.ctx.hostTools.execute({ sessionId, toolCallId: `call_${++callCounter}`, toolName, arguments: args, signal, update() {} });
}

/** A shared session with B joined, the first snapshot held by B, and the ids of every session involved. */
async function joined() {
	pair = await startSharedPair();
	const result = await pair.shareAndJoin({ firstPrompt: "start" });
	const { shared, onB } = result;
	await waitForShared(pair.a, shared.id, (s) => s.lastCheckpoint?.deliveredTo.includes(pair.bId) === true, "the first snapshot reached B");
	return { ...result, mirrorId: onB.mirrorSessionId as string, participantSessionId: onB.participants.find((p) => p.nodeId === pair.bId)?.agentSessionId as string };
}

describe("mesh_team and mesh_say outside a shared session", () => {
	it("answer a plain session with an error that says what to do, and never post anything", async () => {
		pair = await startSharedPair();
		const plain = await api(pair.a).post<AgentSession>("/sessions", { projectId: pair.projectA.id, title: "Just me" });
		const team = await tool(pair.a, plain.body.id, "mesh_team", {});
		expect(team.isError).toBe(true);
		expect(team.text).toContain("does not belong to a shared session");
		expect(team.text).toContain("add a participant");
		const say = await tool(pair.a, plain.body.id, "mesh_say", { text: "anyone?", kind: "question" });
		expect(say.isError).toBe(true);
		expect(say.text).toContain("does not belong to a shared session");
		// a session id this node has never heard of is no different
		expect((await tool(pair.a, "ses_nope", "mesh_team", {})).text).toContain("does not belong to a shared session");
		expect((await api(pair.a).get<SharedSession[]>("/shared")).body).toEqual([]);
	});

	it("validate their arguments before anything else, and honour a cancelled call", async () => {
		const { sessionId, shared } = await joined();
		const badKind = await tool(pair.a, sessionId, "mesh_say", { text: "hi", kind: "shout" });
		expect(badKind).toMatchObject({ isError: true, text: expect.stringContaining("kind must be one of") });
		const empty = await tool(pair.a, sessionId, "mesh_say", { text: "" });
		expect(empty.isError).toBe(true);
		const extra = await tool(pair.a, sessionId, "mesh_team", { surprise: true });
		expect(extra.isError).toBe(true);
		const cancelled = new AbortController();
		cancelled.abort();
		expect(await tool(pair.a, sessionId, "mesh_say", { text: "never sent" }, cancelled.signal)).toEqual({ text: "the call was cancelled", isError: true });
		expect((await detailOn(pair.a, shared.id)).messages.filter((m) => m.author.kind !== "system")).toEqual([]);
	});

	it("the read-only mirror is not a place to talk from: the error points at the participant agent session", async () => {
		const { mirrorId } = await joined();
		const say = await tool(pair.b, mirrorId, "mesh_say", { text: "from the mirror" });
		expect(say.isError).toBe(true);
		expect(say.text).toContain("read-only live copy");
		expect((await tool(pair.b, mirrorId, "mesh_team", {})).isError).toBe(true);
	});

	it("a plain session on a node that takes part in a shared session is still just a plain session", async () => {
		await joined();
		const plain = await api(pair.b).post<AgentSession>("/sessions", { projectId: pair.projectB.id, title: "B's own work" });
		const result = await tool(pair.b, plain.body.id, "mesh_team", {});
		expect(result.isError).toBe(true);
		expect(result.text).toContain("does not belong to a shared session");
	});
});

describe("mesh_team and mesh_say inside a shared session", () => {
	it("mesh_team in the driving session reports the team: shared id, lead, participants with node status, last checkpoint", async () => {
		const { sessionId, shared } = await joined();
		const result = await tool(pair.a, sessionId, "mesh_team", {});
		expect(result.isError).toBeUndefined();
		const lines = result.text.split("\n");
		const checkpoint = (await sharedOn(pair.a, shared.id)).lastCheckpoint;
		expect(lines[0]).toContain(`Shared session ${shared.id} · "Add notes" (a group chat`);
		expect(result.text).toContain(`Epoch 1; shared branch ${shared.repo.branch} (${shared.repo.url})`);
		expect(result.text).toContain("This node: node-a — you are the LEAD (driving session)");
		expect(result.text).toMatch(/Driver: .*node-a.* \(self\)/);
		expect(lines).toContain("Participants:");
		expect(lines.some((l) => l.startsWith("- OMP Agent@node-a: lead (driver), active, node self"))).toBe(true);
		expect(lines.some((l) => l.startsWith("- OMP Agent@node-b: participant, active, node online"))).toBe(true);
		expect(result.text).toContain(`Last checkpoint: #${checkpoint?.seq} commit ${checkpoint?.commit?.slice(0, 12)} (pushed), session snapshot held by 1 participant(s)`);
		expect(result.text).toContain("Messages your node's agents may still post that wake another agent: 12");
	});

	it("mesh_team in B's participant session reports the same team from B's side, with the driver's reachability", async () => {
		const { shared, participantSessionId } = await joined();
		const result = await tool(pair.b, participantSessionId, "mesh_team", {});
		expect(result.isError).toBeUndefined();
		expect(result.text.split("\n")[0]).toContain(`Shared session ${shared.id} · "Add notes"`);
		expect(result.text).toContain("This node: node-b — you are a participant agent");
		expect(result.text).toMatch(/Driver: .*node-a.* \(online\)/);
		expect(result.text).toContain("- OMP Agent@node-a: lead (driver), active, node online");
		expect(result.text).toContain("- OMP Agent@node-b: participant, active, node self");
		expect(result.text).toMatch(/Last checkpoint: #1 commit [0-9a-f]{12} \(pushed\), session snapshot held by 1 participant\(s\)/);
		// the group log shows up once someone wrote in it
		await tool(pair.a, shared.localSessionId as string, "mesh_say", { text: "Plan: write the notes first", kind: "note" });
		await eventually(async () => (await tool(pair.b, participantSessionId, "mesh_team", {})).text.includes("Plan: write the notes first"), "B's team report to show the group log");
		expect((await tool(pair.b, participantSessionId, "mesh_team", {})).text).toContain("Last 1 message(s) in the group chat:");
	});

	it("the team report follows reality: a node that went offline shows as offline", async () => {
		const { sessionId, shared } = await joined();
		await pair.stop("b");
		await waitForShared(pair.a, shared.id, (s) => s.participants.find((p) => p.nodeId === pair.bId)?.nodeStatus === "offline", "A to see B offline", 20_000);
		const result = await tool(pair.a, sessionId, "mesh_team", {});
		expect(result.text.split("\n").some((line) => line.startsWith("- OMP Agent@node-b: participant, active, node offline"))).toBe(true);
		await pair.start("b");
	});

	it("mesh_say from the lead mentioning B wakes B's participant agent, and B's answer mentioning A reaches the driving session; the budget counts down", async () => {
		const { sessionId, shared, participantSessionId } = await joined();
		const posted = await tool(pair.a, sessionId, "mesh_say", { text: "@node-b Which file holds the notes?", kind: "question" });
		expect(posted.isError).toBeUndefined();
		expect(posted.text).toMatch(/^Posted to the group chat \(id shm_[A-Z0-9]+, kind question\); every member node keeps it\. Woken: OMP Agent@node-b\. You can post 11 more waking messages/);
		expect(posted.text).toContain('End your turn now; the answer arrives as a message starting "[CL Agent Mesh]".');
		await eventually(async () => (await transcriptTexts(pair.b, participantSessionId)).some((t) => t.startsWith(`[CL Agent Mesh] shared session ${shared.id}`) && t.includes("Which file holds the notes?") && t.includes("kind question")), "the question in B's participant session");
		const answered = await tool(pair.b, participantSessionId, "mesh_say", { text: "@node-a SHARED_NOTES.md", kind: "answer" });
		expect(answered.isError).toBeUndefined();
		expect(answered.text).toContain("Woken: OMP Agent@node-a");
		await eventually(async () => (await transcriptTexts(pair.a, sessionId)).some((t) => t.includes("from OMP Agent@node-b") && t.includes("kind answer") && t.includes("SHARED_NOTES.md")), "the answer in A's driving session");
		// the budget is 12 minus the waking messages of the node in the log (the fake agent also quotes what it is shown, mentions included, so it may add some)
		await whenSettled(pair.a, sessionId);
		await whenSettled(pair.b, participantSessionId);
		const wakes = (nodeId: string) => pair.a.ctx.shared.store.messages(shared.id).filter((m) => m.authorKind === "agent" && m.authorNodeId === nodeId && (m.to.mode === "all" || m.to.agents.length > 0)).length;
		expect(wakes(pair.aId)).toBeGreaterThanOrEqual(1);
		expect(wakes(pair.bId)).toBeGreaterThanOrEqual(1);
		await eventually(async () => (await sharedOn(pair.a, shared.id)).agentMessageBudget === 12 - wakes(pair.aId), "A's budget to match its waking messages");
		await eventually(async () => (await sharedOn(pair.b, shared.id)).agentMessageBudget === 12 - wakes(pair.bId), "B's budget to match its waking messages");
		// an agent's own words are never injected into its own session (their text may come back quoted in a "since your last turn" block)
		const headers = (node: SharedPair["a"]) => promptsOf(node).map((p) => p.message.split("\n")[0] ?? "");
		expect(headers(pair.a).filter((h) => h.includes("from OMP Agent@node-a"))).toEqual([]);
		expect(headers(pair.b).filter((h) => h.includes("from OMP Agent@node-b"))).toEqual([]);
	});

	it("an instruction from a participant agent is refused with the reason, and nothing reaches the group", async () => {
		const { sessionId, shared, participantSessionId } = await joined();
		const refused = await tool(pair.b, participantSessionId, "mesh_say", { text: "Stop what you are doing", kind: "instruction" });
		expect(refused.isError).toBe(true);
		expect(refused.text).toContain("only the lead's agent may send an instruction");
		expect((await detailOn(pair.b, shared.id)).messages.filter((m) => m.kind === "instruction")).toEqual([]);
		await whenSettled(pair.a, sessionId);
		expect(promptsOf(pair.a).filter((p) => p.message.includes("Stop what you are doing"))).toEqual([]);
		expect((await sharedOn(pair.b, shared.id)).agentMessageBudget).toBe(12);
		// the lead's agent may
		const allowed = await tool(pair.a, sessionId, "mesh_say", { text: "@node-b Please review SHARED_NOTES.md", kind: "instruction" });
		expect(allowed.isError).toBeUndefined();
		await eventually(async () => (await transcriptTexts(pair.b, participantSessionId)).some((t) => t.includes("Please review SHARED_NOTES.md") && t.includes("kind instruction")), "the instruction in B's participant session");
	});

	it("mesh_say fails cleanly once the loop guard is exhausted, and a human message on the node resets it", async () => {
		const { sessionId, shared } = await joined();
		// only messages that wake another agent count: ten quiet notes cost nothing
		for (let i = 0; i < 10; i++) expect((await tool(pair.a, sessionId, "mesh_say", { text: `quiet ${i}` })).isError).toBeUndefined();
		expect((await sharedOn(pair.a, shared.id)).agentMessageBudget).toBe(12);
		for (let i = 0; i < 12; i++) expect((await tool(pair.a, sessionId, "mesh_say", { text: `@node-b note ${i}` })).isError).toBeUndefined();
		const blocked = await tool(pair.a, sessionId, "mesh_say", { text: "@node-b note 13" });
		expect(blocked.isError).toBe(true);
		expect(blocked.text).toContain("Agent message limit reached");
		// a quiet note is still fine: it cannot start a loop
		expect((await tool(pair.a, sessionId, "mesh_say", { text: "still quiet" })).isError).toBeUndefined();
		expect((await tool(pair.a, sessionId, "mesh_team", {})).text).toContain("Messages your node's agents may still post that wake another agent: 0");
		// B's agents have their own budget
		expect((await sharedOn(pair.b, shared.id)).agentMessageBudget).toBe(12);
		await api(pair.a).post(`/shared/${shared.id}/messages`, { text: "carry on", kind: "note" });
		expect((await tool(pair.a, sessionId, "mesh_say", { text: "@node-b after the human" })).isError).toBeUndefined();
	});

	it("after leaving, the participant session is no longer part of the team: the tools say so", async () => {
		const { participantSessionId, shared } = await joined();
		expect((await api(pair.b).post(`/shared/${shared.id}/leave`)).status).toBe(200);
		const result = await tool(pair.b, participantSessionId, "mesh_team", {});
		expect(result.isError).toBe(true);
		expect(result.text).toContain("does not belong to a shared session");
	});
});

describe("deleting sessions of a shared session", () => {
	it("refuses to delete the driving, mirror and participant sessions of an active shared session (409 shared_session_active)", async () => {
		const { sessionId, shared, mirrorId, participantSessionId } = await joined();
		for (const [node, id, what] of [
			[pair.a, sessionId, "the driving session"],
			[pair.b, mirrorId, "the mirror"],
			[pair.b, participantSessionId, "the participant session"],
		] as const) {
			const res = await api(node).del<{ error: { code: string; details: { sharedSessionId: string } } }>(`/sessions/${id}`);
			expect(res.status, what).toBe(409);
			expect(res.body.error.code, what).toBe("shared_session_active");
			expect(res.body.error.details.sharedSessionId, what).toBe(shared.id);
			expect((await api(node).get(`/sessions/${id}`)).status, what).toBe(200);
		}
		// an unrelated session is deleted as usual
		const plain = await api(pair.b).post<AgentSession>("/sessions", { projectId: pair.projectB.id, title: "scratch" });
		expect((await api(pair.b).del(`/sessions/${plain.body.id}`)).status).toBe(204);
	});

	it("after leaving, B can delete its (archived) mirror and participant session; the driver still cannot delete the driving session", async () => {
		const { sessionId, shared, mirrorId, participantSessionId } = await joined();
		expect((await api(pair.b).post(`/shared/${shared.id}/leave`)).status).toBe(200);
		expect((await sessionOn(pair.b, mirrorId)).archived).toBe(true);
		expect((await api(pair.b).del(`/sessions/${mirrorId}`)).status).toBe(204);
		expect((await api(pair.b).del(`/sessions/${participantSessionId}`)).status).toBe(204);
		expect((await api(pair.b).get(`/sessions/${mirrorId}`)).status).toBe(404);
		await waitForShared(pair.a, shared.id, (s) => s.participants.find((p) => p.nodeId === pair.bId)?.state === "left", "A sees B left");
		expect((await api(pair.a).del(`/sessions/${sessionId}`)).status).toBe(409);
	});
});

describe("the list of shared sessions", () => {
	it("lists only the ones this node still takes part in; the detail of one it left is still readable", async () => {
		pair = await startSharedPair();
		const first = await pair.shareAndJoin({ title: "First piece", firstPrompt: "one" });
		const second = await pair.shareAndJoin({ title: "Second piece", firstPrompt: "two" });
		expect(first.shared.id).not.toBe(second.shared.id);
		const ids = async (node: FullHarness) => (await api(node).get<SharedSession[]>("/shared")).body.map((s) => s.id).sort();
		expect(await ids(pair.a)).toEqual([first.shared.id, second.shared.id].sort());
		expect(await ids(pair.b)).toEqual([first.shared.id, second.shared.id].sort());

		expect((await api(pair.b).post(`/shared/${first.shared.id}/leave`)).status).toBe(200);
		expect(await ids(pair.b)).toEqual([second.shared.id]);
		const left = await api(pair.b).get<SharedSessionDetail>(`/shared/${first.shared.id}`);
		expect(left.status).toBe(200);
		expect(left.body.shared.participants.find((p) => p.nodeId === pair.bId)?.state).toBe("left");
		// the driver's list is unchanged: it still drives both, with one participant fewer on the first
		expect(await ids(pair.a)).toEqual([first.shared.id, second.shared.id].sort());
		await waitForShared(pair.a, first.shared.id, (s) => s.participants.find((p) => p.nodeId === pair.bId)?.state === "left", "A sees B left the first");
		expect((await sharedOn(pair.a, second.shared.id)).participants.find((p) => p.nodeId === pair.bId)?.state).toBe("active");
		// an unknown id is a plain 404
		expect((await api(pair.b).get("/shared/shs_unknown")).status).toBe(404);
	});

	it("a session that was only invited (not accepted) is not listed on the invited node, and a declined invitation never becomes one", async () => {
		pair = await startSharedPair();
		const created = await api(pair.a).post<AgentSession>("/sessions", { projectId: pair.projectA.id, title: "Maybe" });
		const added = await api(pair.a).post<SharedSession>(`/sessions/${created.body.id}/participants`, { nodeId: pair.bId });
		expect(added.status).toBe(201);
		const invite = await eventually(async () => (await api(pair.b).get<SharedInvite[]>("/shared/invites")).body.find((i) => i.sharedSessionId === added.body.id), "the invitation on B");
		expect((await api(pair.b).get<SharedSession[]>("/shared")).body).toEqual([]);
		expect((await api(pair.b).post(`/shared/invites/${invite.id}/decide`, { decision: "decline", reason: "not now" })).status).toBe(200);
		await waitForShared(pair.a, added.body.id, (s) => s.participants.find((p) => p.nodeId === pair.bId)?.state === "declined", "A sees the decline");
		expect((await api(pair.b).get<SharedSession[]>("/shared")).body).toEqual([]);
		expect((await api(pair.a).get<SharedSession[]>("/shared")).body).toHaveLength(1);
	});
});

describe("WebSocket topics", () => {
	it("`shared` and `shared:<id>` deliver invite, shared, message and checkpoint events as they happen", async () => {
		pair = await startSharedPair();
		const wsB = await connectWs(pair.b);
		wsB.send({ type: "subscribe", topics: ["shared"] });
		await wsB.waitFor((f) => f.type === "subscribed", "subscribed to the shared list");

		const created = await api(pair.a).post<AgentSession>("/sessions", { projectId: pair.projectA.id, title: "Watch me" });
		const added = await api(pair.a).post<SharedSession>(`/sessions/${created.body.id}/participants`, { nodeId: pair.bId });
		expect(added.status).toBe(201);
		const id = added.body.id;

		// the invitation arrives on the list topic
		const invited = await wsB.waitFor((f) => f.type === "event" && f.topic === "shared" && f.event.type === "invite" && f.event.invite.sharedSessionId === id, "the invite event");
		expect(invited.event.invite).toMatchObject({ state: "pending", title: "Watch me", from: { nodeName: "node-a" }, candidateProjectIds: [pair.projectB.id] });
		const invite = invited.event.invite as SharedInvite;

		const wsDetail = await connectWs(pair.b);
		wsDetail.send({ type: "subscribe", topics: [`shared:${id}`] });
		await wsDetail.waitFor((f) => f.type === "subscribed", "subscribed to the detail topic");

		expect((await api(pair.b).post(`/shared/invites/${invite.id}/decide`, { decision: "accept" })).status).toBe(200);
		// the invitation is announced again as accepted, and the shared session itself shows up
		await wsB.waitFor((f) => f.type === "event" && f.topic === "shared" && f.event.type === "invite" && f.event.invite.id === invite.id && f.event.invite.state === "accepted", "the accepted invite event");
		const joinedEvent = await wsB.waitFor((f) => f.type === "event" && f.topic === "shared" && f.event.type === "shared" && f.event.shared.id === id && f.event.shared.localRole === "participant", "the shared event on the list topic");
		expect(joinedEvent.event.shared.title).toBe("Watch me");
		await wsDetail.waitFor((f) => f.type === "event" && f.topic === `shared:${id}` && f.event.type === "shared" && f.event.shared.mirrorSessionId !== null, "the shared event on the detail topic");
		await waitForShared(pair.a, id, (s) => s.participants.some((p) => p.nodeId === pair.bId && p.state === "active"), "A sees B active");

		// a message typed on A: B's detail topic gets it
		const posted = await api(pair.a).post<{ id: string }>(`/shared/${id}/messages`, { text: "welcome aboard", kind: "note" });
		expect(posted.status).toBe(201);
		const message = await wsDetail.waitFor((f) => f.type === "event" && f.topic === `shared:${id}` && f.event.type === "message" && f.event.message.id === posted.body.id, "the message event");
		expect(message.event).toMatchObject({ sharedSessionId: id, message: { text: "welcome aboard", kind: "note", author: { kind: "human", nodeName: "node-a" } } });
		// ... and not the list topic (only the shared session's own events travel there)
		expect(wsB.frames.some((f) => f.type === "event" && f.topic === "shared" && f.event.type === "message")).toBe(false);

		// a checkpoint: the detail topic carries the checkpoint, the session event follows
		await waitForShared(pair.b, id, (s) => s.lastCheckpoint?.snapshot != null && s.lastCheckpoint.deliveredTo.includes(pair.bId), "B holds the first snapshot");
		const manual = await api(pair.a).post<{ seq: number }>(`/shared/${id}/checkpoint`, { note: "watch this" });
		expect(manual.status).toBe(200);
		const checkpoint = await wsDetail.waitFor((f) => f.type === "event" && f.topic === `shared:${id}` && f.event.type === "checkpoint" && f.event.checkpoint.seq === manual.body.seq, "the checkpoint event");
		expect(checkpoint.event).toMatchObject({ sharedSessionId: id, checkpoint: { seq: manual.body.seq, epoch: 1, pushed: true, note: expect.stringContaining("watch this") } });
		await wsDetail.waitFor((f) => f.type === "event" && f.topic === `shared:${id}` && f.event.type === "checkpoint" && f.event.checkpoint.seq === manual.body.seq && f.event.checkpoint.deliveredTo.includes(pair.bId), "the checkpoint held by B");
		expect(wsB.frames.some((f) => f.type === "event" && f.topic === "shared" && f.event.type === "checkpoint")).toBe(false);

		// the driver's own sockets see the same stories from its side
		const wsA = await connectWs(pair.a);
		wsA.send({ type: "subscribe", topics: ["shared", `shared:${id}`] });
		await wsA.waitFor((f) => f.type === "subscribed", "A subscribed");
		const answer = await api(pair.b).post<{ id: string }>(`/shared/${id}/messages`, { text: "thanks", kind: "note" });
		await wsA.waitFor((f) => f.type === "event" && f.topic === `shared:${id}` && f.event.type === "message" && f.event.message.id === answer.body.id, "B's message on A's detail topic");
		await wsA.waitFor((f) => f.type === "event" && f.topic === "shared" && f.event.type === "shared" && f.event.shared.id === id && f.event.shared.unreadMessages > 0, "A's list topic shows the unread message");
		for (const ws of [wsA, wsB, wsDetail]) ws.close();
	});

	it("refuses to subscribe to a malformed shared topic", async () => {
		pair = await startSharedPair();
		const ws = await connectWs(pair.a);
		ws.send({ type: "subscribe", topics: ["shared:../../etc", "shared:", "shared", "shared:ok_id"] });
		const ack = await ws.waitFor((f) => f.type === "subscribed", "subscribed");
		expect(ack.topics).toEqual(["shared", "shared:ok_id"]);
		ws.close();
	});
});
