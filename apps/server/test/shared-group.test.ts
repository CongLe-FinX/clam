import { outbox } from "@clam/database";
import { wire } from "@clam/agent-network";
import type { Peer, SharedMessage, SharedSession } from "@clam/contracts";
import { compareGroupMessages, parseHlc } from "@clam/task-engine";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { api, type FullHarness } from "./full-harness.ts";
import { eventually, peerOf, signedRequest } from "./net-helpers.ts";
import {
	detailOn,
	isolateGitConfig,
	promptAndWait,
	promptsOf,
	sharedOn,
	startSharedPair,
	transcriptTexts,
	waitForShared,
	whenSettled,
	type GitConfigIsolation,
	type SharedPair,
} from "./shared-fixtures.ts";

/**
 * The group chat of a shared session: a leaderless log replicated on every member node, ordered by (hlc, origin, id),
 * caught up by pulling, with addressing (lead / @mentions / @all), a buffer for what an agent was not addressed with,
 * and the final text of every agent turn posted as its reply. Two real in-process nodes, fake omp.
 *
 * Agents are woken with a `@@fake-sh true` line in the message: the fake's answer is then only `FAKE_TOOL_RESULT sh: ...`
 * and never an echo of the prompt, so a woken agent does not mention anybody by accident.
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

const NOBODY = { mode: "agents", agents: [] } as const;
const QUIET = "\n@@fake-sh true";

/** A shared session with B joined, the first snapshot held by B and B's agent briefed. */
async function joined(options: Parameters<typeof startSharedPair>[0] = {}) {
	pair = await startSharedPair(options);
	const result = await pair.shareAndJoin({ firstPrompt: "start" });
	await waitForShared(pair.a, result.shared.id, (s) => s.lastCheckpoint?.deliveredTo.includes(pair.bId) === true, "the first snapshot reached B");
	const bSession = result.onB.participants.find((p) => p.nodeId === pair.bId)?.agentSessionId as string;
	await eventually(async () => (await transcriptTexts(pair.b, bSession)).some((t) => t.startsWith("FAKE: # Shared session")), "B's agent to acknowledge the briefing");
	await whenSettled(pair.b, bSession);
	await whenSettled(pair.a, result.sessionId);
	return { ...result, bSession };
}

async function say(node: FullHarness, sharedId: string, text: string, to?: unknown): Promise<SharedMessage> {
	const res = await api(node).post<SharedMessage>(`/shared/${sharedId}/messages`, { text, ...(to !== undefined && { to }) });
	if (res.status !== 201) throw new Error(`post ${res.status}: ${JSON.stringify(res.body)}`);
	return res.body;
}

/** The replicated part of a node's log (local-only notes are not part of it), in log order. */
const replicated = (node: FullHarness, sharedId: string) => node.ctx.shared.store.messages(sharedId).filter((m) => m.originSeq !== null);
const idsOf = (node: FullHarness, sharedId: string) => replicated(node, sharedId).map((m) => m.id);
const promptsWith = (node: FullHarness, needle: string) => promptsOf(node).filter((p) => p.message.includes(needle));

async function setCapabilities(node: FullHarness, peerId: string, capabilities: string[]): Promise<void> {
	const res = await api(node).patch<Peer>(`/network/peers/${peerId}`, { grantedCapabilities: capabilities });
	if (res.status !== 200) throw new Error(`patch failed: ${JSON.stringify(res.body)}`);
}

describe("a replicated log: any online member accepts, partitions heal, one order everywhere", () => {
	it("two nodes post concurrently while neither can reach the other: after the partition both logs are identical, in log order, without duplicates", async () => {
		const { shared } = await joined();
		const sharedId = shared.id;
		const before = idsOf(pair.a, sharedId).length;
		expect(idsOf(pair.b, sharedId)).toEqual(idsOf(pair.a, sharedId));

		// the partition: each node stops granting the other `sessions.share`, so every delivery between them is refused (and the outbox gives up)
		const grants = { a: (await peerOf(pair.a, pair.bId))?.grantedCapabilities ?? [], b: (await peerOf(pair.b, pair.aId))?.grantedCapabilities ?? [] };
		const without = (list: string[]) => list.filter((c) => c !== "sessions.share");
		await setCapabilities(pair.a, pair.bId, without(grants.a));
		await setCapabilities(pair.b, pair.aId, without(grants.b));

		const posted: SharedMessage[] = [];
		for (const [node, text] of [[pair.a, "a-1"], [pair.b, "b-1"], [pair.a, "a-2"], [pair.b, "b-2"], [pair.b, "b-3"]] as const) posted.push(await say(node, sharedId, text, NOBODY));
		await eventually(() => posted.every((m) => (m.author.nodeId === pair.aId ? pair.a : pair.b).ctx.shared.store.message(m.id)?.delivery === "failed"), "every delivery to be refused during the partition", 20_000);
		expect(idsOf(pair.a, sharedId)).toHaveLength(before + 2);
		expect(idsOf(pair.b, sharedId)).toHaveLength(before + 3);

		// healed: nobody retries the dead deliveries, the catch-up pull brings every message to the node that lacks it
		await setCapabilities(pair.a, pair.bId, grants.a);
		await setCapabilities(pair.b, pair.aId, grants.b);
		await eventually(() => idsOf(pair.a, sharedId).length === before + 5 && idsOf(pair.b, sharedId).length === before + 5, "both logs to hold all five messages", 30_000);

		const onA = replicated(pair.a, sharedId);
		const onB = replicated(pair.b, sharedId);
		expect(onB.map((m) => m.id)).toEqual(onA.map((m) => m.id));
		expect(new Set(onA.map((m) => m.id)).size).toBe(onA.length);
		expect(onA.map((m) => [m.hlc, m.authorNodeId, m.id])).toEqual(onA.toSorted(compareGroupMessages).map((m) => [m.hlc, m.authorNodeId, m.id]));
		for (const m of posted) expect(onA.some((x) => x.id === m.id), m.text).toBe(true);
		// the same position on both nodes, and the same per-origin sequence: nothing is missing and nothing is counted twice
		expect(pair.a.ctx.shared.store.cursor(sharedId)).toEqual(pair.b.ctx.shared.store.cursor(sharedId));
		for (const m of onA) expect(pair.b.ctx.shared.store.message(m.id)).toMatchObject({ hlc: m.hlc, originSeq: m.originSeq, authorNodeId: m.authorNodeId, text: m.text });
		// the views give the same order too
		expect((await detailOn(pair.b, sharedId)).messages.filter((m) => posted.some((p) => p.id === m.id)).map((m) => m.id)).toEqual((await detailOn(pair.a, sharedId)).messages.filter((m) => posted.some((p) => p.id === m.id)).map((m) => m.id));
	});

	it("works with the lead offline: a participant posts, its own agent is woken, and the lead's node catches up (and wakes its agent) when it returns", async () => {
		const { shared, sessionId, bSession } = await joined();
		await pair.stop("a");
		await waitForShared(pair.b, shared.id, (s) => s.participants.find((p) => p.nodeId === pair.aId)?.nodeStatus === "offline", "B to see A offline", 20_000);

		// the group still works on B alone: a human at B's UI talks to B's agent, which answers into the group
		const toB = await say(pair.b, shared.id, `@node-b check the README while A is away${QUIET}`);
		expect(toB.to).toMatchObject({ mode: "agents", agents: [{ nodeId: pair.bId }] });
		await eventually(() => promptsWith(pair.b, "check the README while A is away").length > 0, "B's agent woken while the lead is offline", 20_000);
		await whenSettled(pair.b, bSession);
		const reply = await eventually(() => pair.b.ctx.shared.store.messages(shared.id).find((m) => m.kind === "reply" && m.authorNodeId === pair.bId), "B's agent's reply in the group log");
		expect(reply.text).toBe("FAKE_TOOL_RESULT sh: exit=0");
		// a message the user explicitly addresses to the lead waits for it (an unmentioned one would go to B's agent: shared-fallback.test.ts)
		const toLead = await say(pair.b, shared.id, `please continue when you are back${QUIET}`, { mode: "lead", agents: [] });
		expect(toLead.to).toEqual({ mode: "lead", agents: [] });
		// the queue towards A is lost (as if the outbox gave up): only the pull can bring the messages
		pair.b.ctx.db.delete(outbox).where(and(eq(outbox.kind, "shared.message"), eq(outbox.peerId, pair.aId))).run();

		await pair.start("a");
		await eventually(() => [toB.id, toLead.id, reply.id].every((id) => pair.a.ctx.shared.store.message(id)), "A to catch up with B's messages", 30_000);
		expect(idsOf(pair.a, shared.id)).toEqual(idsOf(pair.b, shared.id));
		// the lead's agent is woken by what was for it; the one for B's agent is only history in its log
		await eventually(() => promptsWith(pair.a, "please continue when you are back").length > 0, "A's agent woken by the caught-up message for the lead", 30_000);
		await whenSettled(pair.a, sessionId);
		await eventually(() => pair.a.ctx.shared.store.message(toLead.id)?.injectedSessionId === sessionId, "the message for the lead marked as handed over");
		// what B's agent said and was asked while A was away comes along, in front of it
		const prompt = promptsWith(pair.a, "please continue when you are back")[0]?.message ?? "";
		expect(prompt).toContain("Since your last turn in the group:");
		expect(prompt).toContain("check the README while A is away");
	});

	it("system messages are replicated: B leaving is one line in both logs, not one per node", async () => {
		const { shared } = await joined();
		expect((await api(pair.b).post(`/shared/${shared.id}/leave`)).status).toBe(200);
		await waitForShared(pair.a, shared.id, (s) => s.participants.find((p) => p.nodeId === pair.bId)?.state === "left", "A sees B left");
		const lines = (node: FullHarness) => node.ctx.shared.store.messages(shared.id).filter((m) => m.kind === "system" && m.text.includes("left the shared session"));
		await eventually(() => lines(pair.a).length === 1, "the leave line on A");
		expect(lines(pair.b)).toHaveLength(1);
		expect(lines(pair.a)[0]?.id).toBe(lines(pair.b)[0]?.id);
		// joins and the creation line are in both logs from the start
		for (const node of [pair.a, pair.b]) expect(node.ctx.shared.store.messages(shared.id).filter((m) => m.kind === "system" && m.text.includes("joined the shared session"))).toHaveLength(1);
	});

	it("HLC stamps are strictly increasing, and survive a restart even when the wall clock is behind what the node has seen", async () => {
		const { shared } = await joined();
		const burst: SharedMessage[] = [];
		for (let i = 0; i < 5; i++) burst.push(await say(pair.a, shared.id, `burst ${i}`, NOBODY));
		expect(burst.map((m) => m.hlc)).toEqual(burst.map((m) => m.hlc).toSorted());
		expect(new Set(burst.map((m) => m.hlc)).size).toBe(5);
		const seqs = burst.map((m) => pair.a.ctx.shared.store.message(m.id)?.originSeq);
		expect(seqs.map((s, i) => (i === 0 ? 1 : (s ?? 0) - (seqs[i - 1] ?? 0)))).toEqual([1, 1, 1, 1, 1]);

		// B sees a message stamped a minute ahead of its clock (a node with a fast clock) ...
		const future = parseHlc(burst[4]?.hlc as string);
		const ahead = `${String((future?.wall ?? 0) + 60_000).padStart(15, "0")}-00007`;
		const res = await signedRequest(pair.a, pair.b.netUrl, {
			method: "POST",
			path: `/shared/${shared.id}/messages`,
			body: { messageId: "shm_from_the_future", epoch: 1, kind: "chat", body: "stamped ahead", author: { kind: "human" }, to: NOBODY, origin: { nodeId: pair.aId, nodeName: "node-a", seq: 900 }, hlc: ahead, createdAt: new Date().toISOString() },
		});
		expect(res.status).toBe(202);
		const afterIt = await say(pair.b, shared.id, "after the future message", NOBODY);
		expect(afterIt.hlc > ahead).toBe(true);

		// ... and then restarts: the clock is rebuilt from the log, not from the wall clock
		await pair.stop("b");
		await pair.start("b");
		const first = await say(pair.b, shared.id, "after the restart one", NOBODY);
		const second = await say(pair.b, shared.id, "after the restart two", NOBODY);
		expect(first.hlc > afterIt.hlc).toBe(true);
		expect(second.hlc > first.hlc).toBe(true);
		expect(parseHlc(first.hlc)?.wall).toBe(parseHlc(ahead)?.wall);
		// the log order on B puts them after the future message, where they causally belong
		const order = pair.b.ctx.shared.store.messages(shared.id).map((m) => m.id);
		expect(order.indexOf(first.id)).toBeGreaterThan(order.indexOf("shm_from_the_future"));
	});
});

describe("addressing", () => {
	it("a message without a mention goes to the lead only; @node-b to B's agent only; @all to both; the others only buffer", async () => {
		const { shared, sessionId, bSession } = await joined();
		const a = () => promptsOf(pair.a).length;
		const b = () => promptsOf(pair.b).length;

		const aBefore = a();
		const bBefore = b();
		const byDefault = await say(pair.b, shared.id, `route-default${QUIET}`);
		expect(byDefault.to).toEqual({ mode: "lead", agents: [] });
		await eventually(() => promptsWith(pair.a, "route-default").length === 1, "the lead's agent woken");
		await whenSettled(pair.a, sessionId);
		await eventually(() => pair.b.ctx.shared.store.messages(shared.id).some((m) => m.kind === "reply" && m.authorNodeId === pair.aId), "A's reply in B's log");
		expect(b()).toBe(bBefore);
		expect(pair.b.ctx.shared.store.message(byDefault.id)?.injectedSessionId).toBeNull();

		const aMid = a();
		const toB = await say(pair.a, shared.id, `@node-b route-b${QUIET}`);
		expect(toB.to).toEqual({ mode: "agents", agents: [{ nodeId: pair.bId, agentId: expect.any(String) }] });
		await eventually(() => promptsWith(pair.b, "route-b").length === 1, "B's agent woken by its mention");
		await whenSettled(pair.b, bSession);
		expect(a()).toBe(aMid);
		expect(promptsWith(pair.a, "route-b")).toHaveLength(0);

		const toAll = await say(pair.a, shared.id, `@ALL route-all${QUIET}`);
		expect(toAll.to).toEqual({ mode: "all", agents: [] });
		await eventually(() => promptsWith(pair.a, "route-all").length === 1 && promptsWith(pair.b, "route-all").length === 1, "both agents woken by @all");
		// every agent got every message exactly once, in a prompt of its own or in a "since your last turn" block
		await whenSettled(pair.a, sessionId);
		await whenSettled(pair.b, bSession);
		expect(a()).toBeGreaterThan(aBefore);
		// what A's agent was not addressed with (the message for B) came along in front of the @all message it was addressed with
		const aAll = promptsWith(pair.a, "route-all")[0]?.message ?? "";
		expect(aAll).toContain("Since your last turn in the group:");
		expect(aAll).toContain("@node-b route-b");
		expect(pair.a.ctx.shared.store.message(byDefault.id)?.injectedSessionId).toBe(sessionId);
		expect(pair.b.ctx.shared.store.message(toB.id)?.injectedSessionId).toBe(bSession);
	});

	it("an ambiguous agent name wakes every agent with that name; an unknown mention stays plain text and wakes the lead", async () => {
		const { shared } = await joined();
		// both nodes run an agent named "OMP Agent"
		const both = await say(pair.a, shared.id, `@omp agent hello both${QUIET}`);
		expect(both.to).toMatchObject({ mode: "agents", agents: [{ nodeId: expect.any(String) }, { nodeId: expect.any(String) }] });
		expect(new Set(both.to.agents.map((x) => x.nodeId))).toEqual(new Set([pair.aId, pair.bId]));
		await eventually(() => promptsWith(pair.a, "hello both").length === 1 && promptsWith(pair.b, "hello both").length === 1, "both agents woken by their shared name");
		const unknown = await say(pair.b, shared.id, "@nobody-here is not a member");
		expect(unknown.to).toEqual({ mode: "lead", agents: [] });
	});

	it("a qualified @agent@machine mention wakes exactly one of two agents with the same name (the picker's token)", async () => {
		const { shared } = await joined();
		// "OMP Agent" runs on both nodes: the bare name is ambiguous, the qualified token is not
		const aBefore = promptsOf(pair.a).length;
		const toB = await say(pair.a, shared.id, `@OMP Agent@node-b only-b${QUIET}`);
		expect(toB.to).toEqual({ mode: "agents", agents: [{ nodeId: pair.bId, agentId: expect.any(String) }] });
		await eventually(() => promptsWith(pair.b, "only-b").length === 1, "B's agent woken by the qualified mention");
		expect(promptsWith(pair.a, "only-b")).toHaveLength(0);
		expect(promptsOf(pair.a).length).toBe(aBefore);

		const toA = await say(pair.b, shared.id, `@omp-agent@NODE-A only-a${QUIET}`);
		expect(toA.to).toEqual({ mode: "agents", agents: [{ nodeId: pair.aId, agentId: expect.any(String) }] });
		await eventually(() => promptsWith(pair.a, "only-a").length === 1, "A's agent woken by the qualified mention");
		expect(promptsWith(pair.b, "only-a")).toHaveLength(0);

		// a qualifier that matches nobody must not fan out to every "OMP Agent"
		const typo = await say(pair.a, shared.id, "@OMP Agent@node-z is nobody");
		expect(typo.to).toEqual({ mode: "lead", agents: [] });
	});

	it("an explicit `to` wins over the mentions; unknown agents, human replies and system messages are refused", async () => {
		const { shared } = await joined();
		const explicit = await say(pair.a, shared.id, "@node-b but really for nobody", NOBODY);
		expect(explicit.to).toEqual({ mode: "agents", agents: [] });
		const unknownAgent = await api(pair.a).post<{ error: { code: string } }>(`/shared/${shared.id}/messages`, { text: "hi", to: { mode: "agents", agents: [{ nodeId: pair.bId, agentId: "agt_nobody" }] } });
		expect(unknownAgent.status).toBe(400);
		for (const kind of ["reply", "system", "shout"]) expect((await api(pair.a).post(`/shared/${shared.id}/messages`, { text: "hi", kind })).status, kind).toBe(400);
		expect((await api(pair.a).post(`/shared/${shared.id}/messages`, { text: "   " })).status).toBe(400);
		expect((await api(pair.a).post(`/shared/ghost/messages`, { text: "hi" })).status).toBe(404);
	});
});

describe("the buffer: what an agent was not addressed with", () => {
	it("is put in front of the agent's next addressed turn as 'Since your last turn in the group', once, and trimmed when it is long", async () => {
		const { shared, bSession } = await joined();
		await say(pair.a, shared.id, "unaddressed remark one", NOBODY);
		await say(pair.b, shared.id, "unaddressed remark two", NOBODY);
		await eventually(() => pair.b.ctx.shared.store.messages(shared.id).filter((m) => m.text.startsWith("unaddressed remark")).length === 2 && pair.a.ctx.shared.store.messages(shared.id).filter((m) => m.text.startsWith("unaddressed remark")).length === 2, "both remarks in both logs");
		expect(promptsWith(pair.b, "unaddressed remark")).toHaveLength(0);

		await say(pair.a, shared.id, `@node-b please answer${QUIET}`);
		const prompt = (await eventually(() => promptsWith(pair.b, "please answer")[0], "B's addressed prompt")).message;
		const at = (needle: string) => prompt.indexOf(needle);
		expect(prompt.split("\n")[0]).toMatch(/^\[CL Agent Mesh\] shared session shs_\S+ · ".*" · from human@node-a · kind chat$/);
		for (const needle of ["Since your last turn in the group:", "- human@node-a (chat): unaddressed remark one", "- human@node-b (chat): unaddressed remark two", "Addressed to you now:", "@node-b please answer"]) expect(at(needle), needle).toBeGreaterThan(0);
		expect(at("Since your last turn in the group:")).toBeLessThan(at("unaddressed remark one"));
		expect(at("unaddressed remark one")).toBeLessThan(at("unaddressed remark two"));
		expect(at("unaddressed remark two")).toBeLessThan(at("Addressed to you now:"));
		expect(at("Addressed to you now:")).toBeLessThan(at("@node-b please answer"));
		await whenSettled(pair.b, bSession);
		for (const m of pair.b.ctx.shared.store.messages(shared.id).filter((x) => x.text.startsWith("unaddressed remark"))) expect(m.injectedSessionId, m.text).toBe(bSession);

		// handed over once: the next addressed turn has nothing to catch up on
		await say(pair.a, shared.id, `@node-b second request${QUIET}`);
		const second = (await eventually(() => promptsWith(pair.b, "second request")[0], "B's second addressed prompt")).message;
		expect(second).not.toContain("Since your last turn");
		expect(second).not.toContain("unaddressed remark");
		await whenSettled(pair.b, bSession);

		// a long buffer keeps the newest messages within the cap and says how many it dropped
		for (let i = 0; i < 10; i++) await say(pair.a, shared.id, `chatter m${i} ${"x".repeat(1000)}`, NOBODY);
		await eventually(() => pair.b.ctx.shared.store.messages(shared.id).filter((m) => m.text.startsWith("chatter")).length === 10, "the chatter in B's log");
		await say(pair.a, shared.id, `@node-b after the chatter${QUIET}`);
		const trimmed = (await eventually(() => promptsWith(pair.b, "after the chatter")[0], "B's prompt after the chatter")).message;
		const dropped = /\((\d+) earlier messages omitted\)/.exec(trimmed);
		expect(dropped, "the note about dropped messages").not.toBeNull();
		expect(Number(dropped?.[1])).toBeGreaterThan(0);
		expect(trimmed).toContain("chatter m9 ");
		expect(trimmed).not.toContain("chatter m0 ");
		expect(trimmed.length).toBeLessThan(9_500);
		// everything was handed over, the dropped part included
		await whenSettled(pair.b, bSession);
		for (const m of pair.b.ctx.shared.store.messages(shared.id).filter((x) => x.text.startsWith("chatter"))) expect(m.injectedSessionId, m.text).toBe(bSession);
	});

	it("does not hold system messages or what was said before the node joined", async () => {
		pair = await startSharedPair();
		const created = await api(pair.a).post<{ id: string }>("/sessions", { projectId: pair.projectA.id, title: "History" });
		await promptAndWait(pair.a, created.body.id, "pre-group work");
		const added = await api(pair.a).post<{ id: string }>(`/sessions/${created.body.id}/participants`, { nodeId: pair.bId });
		expect(added.status).toBe(201);
		// say something in the group while B has not accepted yet: it is history for B, not news
		await say(pair.a, added.body.id, "said before B joined", NOBODY);
		const invite = await eventually(async () => (await api(pair.b).get<Array<{ id: string; sharedSessionId: string; state: string }>>("/shared/invites")).body.find((i) => i.sharedSessionId === added.body.id && i.state === "pending"), "the invitation on B");
		await api(pair.b).post(`/shared/invites/${invite.id}/decide`, { decision: "accept" });
		const onB = await waitForShared(pair.b, added.body.id, (s) => s.localRole === "participant" && s.mirrorSessionId !== null, "B joined");
		const bSession = onB.participants.find((p) => p.nodeId === pair.bId)?.agentSessionId as string;
		await eventually(() => pair.b.ctx.shared.store.messages(added.body.id).some((m) => m.text === "said before B joined"), "the old message in B's log");
		await eventually(async () => (await transcriptTexts(pair.b, bSession)).some((t) => t.startsWith("FAKE: # Shared session")), "B's briefing");
		await whenSettled(pair.b, bSession);
		await say(pair.a, added.body.id, `@node-b first work for you${QUIET}`);
		const prompt = (await eventually(() => promptsWith(pair.b, "first work for you")[0], "B's first addressed prompt")).message;
		expect(prompt).not.toContain("said before B joined");
		expect(prompt).not.toContain("joined the shared session");
		expect(prompt).not.toContain("Shared session created");
		await eventually(() => pair.b.ctx.shared.store.messages(added.body.id).find((m) => m.text === "said before B joined")?.injectedSessionId === "history", "the old message to be marked as history");
	});
});

describe("replies: the final text of every agent turn", () => {
	it("is posted to the group as the agent's reply on every node; only an @mention wakes the other agent, and only that counts against the budget", async () => {
		const { shared, sessionId, bSession } = await joined();
		const bPrompts = promptsOf(pair.b).length;

		// no mention: everyone sees it, nobody is woken, nothing is counted
		await promptAndWait(pair.a, sessionId, "tell the team hello");
		for (const node of [pair.a, pair.b]) {
			const reply = await eventually(() => node.ctx.shared.store.messages(shared.id).find((m) => m.kind === "reply" && m.text === "FAKE: tell the team hello"), "A's reply in the log");
			expect(reply).toMatchObject({ authorKind: "agent", authorNodeId: pair.aId, authorAgentName: "OMP Agent", to: { mode: "agents", agents: [] } });
		}
		const view = (await detailOn(pair.b, shared.id)).messages.find((m) => m.text === "FAKE: tell the team hello");
		expect(view).toMatchObject({ kind: "reply", author: { kind: "agent", nodeId: pair.aId, agentName: "OMP Agent" }, originNodeId: pair.aId, injectedIntoSession: false });
		expect(promptsOf(pair.b)).toHaveLength(bPrompts);
		expect((await sharedOn(pair.a, shared.id)).agentMessageBudget).toBe(12);

		// a mention wakes B (with the unaddressed reply in front) and costs A one of its messages
		await promptAndWait(pair.a, sessionId, "@node-b please review the notes");
		const woken = (await eventually(() => promptsWith(pair.b, "please review the notes")[0], "B's agent woken by A's reply")).message;
		expect(woken.split("\n")[0]).toMatch(/from OMP Agent@node-a · kind reply$/);
		expect(woken).toContain("- OMP Agent@node-a (reply): FAKE: tell the team hello");
		await whenSettled(pair.b, bSession);
		expect((await sharedOn(pair.a, shared.id)).agentMessageBudget).toBe(11);
		// B's own answer mentions only itself in the echo: it wakes nobody and costs nothing
		expect((await sharedOn(pair.b, shared.id)).agentMessageBudget).toBe(12);
		await eventually(() => pair.a.ctx.shared.store.messages(shared.id).some((m) => m.kind === "reply" && m.authorNodeId === pair.bId), "B's reply in A's log");
		expect(pair.a.ctx.shared.store.messages(shared.id).filter((m) => m.kind === "reply" && m.authorNodeId === pair.bId).every((m) => m.to.agents.length === 0)).toBe(true);
	});

	it("does not post the final text again when the agent already said exactly that through mesh_say during the turn; a different final text is still posted", async () => {
		const { shared, sessionId } = await joined();
		const fromA = (node: FullHarness) => node.ctx.shared.store.messages(shared.id).filter((m) => m.authorNodeId === pair.aId && m.authorKind === "agent");

		// the lead answers through the tool, then ends its turn with the same words (other whitespace): one line in the group, not two
		await promptAndWait(pair.a, sessionId, 'what is the answer?\n@@fake-tool mesh_say {"kind":"answer","text":"The answer\\nis  42"}\n@@fake-final The answer is 42');
		await whenSettled(pair.a, sessionId);

		// a turn with the tool post AND a different closing text posts both; its reply is the marker that the first turn's reply (if any) was already decided
		await promptAndWait(pair.a, sessionId, 'one more\n@@fake-tool mesh_say {"kind":"note","text":"Checked the logs"}\n@@fake-final All done here');
		const marker = await eventually(() => fromA(pair.a).find((m) => m.kind === "reply" && m.text === "All done here"), "the reply of the second turn");

		const lines = fromA(pair.a).map((m) => `${m.kind}: ${m.text.replace(/\s+/g, " ")}`);
		expect(lines).toEqual(["answer: The answer is 42", "note: Checked the logs", "reply: All done here"]);
		// …on the other node too
		await eventually(() => pair.b.ctx.shared.store.message(marker.id), "the closing reply on B");
		expect(fromA(pair.b).map((m) => m.kind)).toEqual(["answer", "note", "reply"]);
	});

	it("over the loop budget a reply is still posted, but wakes nobody, and the group is told; a human message gives the budget back", async () => {
		const { shared, sessionId, bSession } = await joined();
		pair.a.ctx.shared.store.update(shared.id, { agentMessageLimit: 1 });
		await promptAndWait(pair.a, sessionId, "@node-b first ping");
		await eventually(() => promptsWith(pair.b, "first ping").length === 1, "B woken by the first ping");
		await whenSettled(pair.b, bSession);
		expect((await sharedOn(pair.a, shared.id)).agentMessageBudget).toBe(0);
		const bPrompts = promptsOf(pair.b).length;

		await promptAndWait(pair.a, sessionId, "@node-b second ping");
		const second = await eventually(() => pair.a.ctx.shared.store.messages(shared.id).find((m) => m.kind === "reply" && m.text === "FAKE: @node-b second ping"), "the second reply is posted anyway");
		expect(second.to).toEqual({ mode: "agents", agents: [] });
		const notice = await eventually(() => pair.a.ctx.shared.store.messages(shared.id).find((m) => m.kind === "system" && m.text.includes("nobody was woken")), "the notice that nobody was woken");
		await eventually(() => pair.b.ctx.shared.store.message(notice.id), "the notice on B");
		expect(promptsOf(pair.b)).toHaveLength(bPrompts);

		await say(pair.b, shared.id, "carry on", NOBODY);
		await eventually(async () => (await sharedOn(pair.a, shared.id)).agentMessageBudget === 1, "the human message to give A's budget back");
	});

	it("never posts the answer to the briefing, and cuts a very long reply", async () => {
		const { shared, sessionId } = await joined();
		// B's agent answered the briefing (the helper waited for it): that turn is not part of the group
		const fromB = (node: FullHarness) => node.ctx.shared.store.messages(shared.id).filter((m) => m.authorNodeId === pair.bId && m.authorKind === "agent");
		expect(fromB(pair.b)).toEqual([]);
		expect(fromB(pair.a)).toEqual([]);
		expect(promptsOf(pair.a).some((p) => p.message.includes("Shared session id"))).toBe(false);

		// a reply longer than the wire allows is cut and says so
		await promptAndWait(pair.a, sessionId, "L".repeat(22_000), 40_000);
		const long = await eventually(() => pair.a.ctx.shared.store.messages(shared.id).find((m) => m.kind === "reply" && m.text.startsWith("FAKE: LLL")), "the long reply", 30_000);
		expect(long.text.length).toBeLessThanOrEqual(20_000);
		expect(long.text).toContain("reply cut at");
		await eventually(() => pair.b.ctx.shared.store.message(long.id), "the long reply on B", 30_000);
	});

	it("a takeover keeps the group going: the continuation turn is not posted, the new lead starts with an empty buffer, the old messages stay in the log", async () => {
		const { shared } = await joined();
		await say(pair.a, shared.id, "pre-takeover remark", NOBODY);
		await eventually(() => pair.b.ctx.shared.store.messages(shared.id).some((m) => m.text === "pre-takeover remark"), "the remark on B");
		await pair.stop("a");
		await waitForShared(pair.b, shared.id, (s) => s.takeoverAvailable, "takeover available", 20_000);
		const took = await api(pair.b).post<SharedSession>(`/shared/${shared.id}/takeover`, {});
		expect(took.status, JSON.stringify(took.body)).toBe(200);
		const lead = took.body.localSessionId as string;
		await eventually(async () => (await transcriptTexts(pair.b, lead)).some((t) => t.includes("Continuing on")), "the continuation note in the new lead session", 30_000);
		await whenSettled(pair.b, lead);
		// the answer to the continuation note is not a message to the group
		expect(pair.b.ctx.shared.store.messages(shared.id).filter((m) => m.kind === "reply")).toEqual([]);
		// B leads now: a human message without a mention reaches its new session, with nothing of the old buffer in front of it
		await say(pair.b, shared.id, `first request to the new lead${QUIET}`);
		const prompt = (await eventually(() => promptsWith(pair.b, "first request to the new lead")[0], "the new lead woken")).message;
		expect(prompt).not.toContain("pre-takeover remark");
		expect(prompt).not.toContain("Since your last turn");
		expect(pair.b.ctx.shared.store.messages(shared.id).some((m) => m.text === "pre-takeover remark")).toBe(true);
		// and its first reply of its own is posted like any other
		const reply = await eventually(() => pair.b.ctx.shared.store.messages(shared.id).find((m) => m.kind === "reply" && m.authorNodeId === pair.bId), "the new lead's reply");
		expect(reply.text).toBe("FAKE_TOOL_RESULT sh: exit=0");
	});
});

describe("catching up by pull (POST /shared/:id/messages/sync)", () => {
	it("serves pages by a per-origin cursor, in log order; a re-pull is idempotent; the end is a page with nothing", async () => {
		const { shared } = await joined();
		for (let i = 0; i < 6; i++) await say(pair.a, shared.id, `sync ${i}`, NOBODY);
		await say(pair.b, shared.id, "sync from b", NOBODY);
		await eventually(() => idsOf(pair.a, shared.id).length === idsOf(pair.b, shared.id).length, "both logs in step");
		pair.a.ctx.shared.discussion.note(shared.id, "a note for this node only", { local: true });
		const path_ = `/shared/${shared.id}/messages/sync`;
		const pull = async (cursor: Record<string, number>, limit?: number) => {
			const res = await signedRequest(pair.b, pair.a.netUrl, { method: "POST", path: path_, body: { cursor, ...(limit !== undefined && { limit }) } });
			expect(res.status).toBe(200);
			const parsed = wire.SharedMessagesSyncResponse.safeParse(res.body);
			expect(parsed.success, JSON.stringify(res.body).slice(0, 300)).toBe(true);
			return res.body as wire.SharedMessagesSyncResponse;
		};

		const all: wire.SharedMessageRequest[] = [];
		let cursor: Record<string, number> = {};
		let pages = 0;
		for (let more = true; more; pages++) {
			const page = await pull(cursor, 3);
			expect(page.messages.length).toBeLessThanOrEqual(3);
			all.push(...page.messages);
			cursor = page.cursor;
			more = page.hasMore;
			expect(pages).toBeLessThan(20);
		}
		expect(pages).toBeGreaterThanOrEqual(3);
		// everything exactly once, in log order, and nothing that is only this node's business
		expect(all.map((m) => m.messageId)).toEqual(idsOf(pair.a, shared.id));
		expect(all.some((m) => m.body === "a note for this node only")).toBe(false);
		expect(all.map((m) => `${m.hlc}|${m.origin.nodeId}|${m.messageId}`)).toEqual(all.map((m) => `${m.hlc}|${m.origin.nodeId}|${m.messageId}`).toSorted());
		expect(cursor).toEqual(pair.a.ctx.shared.store.cursor(shared.id));
		expect(all.find((m) => m.body === "sync from b")).toMatchObject({ origin: { nodeId: pair.bId, nodeName: "node-b" }, author: { kind: "human" }, kind: "chat", to: { mode: "agents", agents: [] } });

		// idempotent: the same cursor gives the same page, and the end of the log gives nothing
		const first = await pull({}, 3);
		expect(await pull({}, 3)).toEqual(first);
		const end = await pull(cursor, 3);
		expect(end).toEqual({ messages: [], cursor, hasMore: false });
		// a partial cursor serves only what is beyond it, per origin
		const partial = await pull({ [pair.aId]: 2 }, 200);
		const fromA = all.filter((m) => m.origin.nodeId === pair.aId);
		expect(partial.messages.filter((m) => m.origin.nodeId === pair.aId).map((m) => m.messageId)).toEqual(fromA.filter((m) => m.origin.seq > 2).map((m) => m.messageId));
		expect(partial.messages.filter((m) => m.origin.nodeId === pair.bId)).toHaveLength(all.filter((m) => m.origin.nodeId === pair.bId).length);
		expect(partial.hasMore).toBe(false);
		// the default page is 100 and a cursor ahead of the log serves nothing
		expect((await pull({ [pair.aId]: 10_000, [pair.bId]: 10_000 })).messages).toEqual([]);
	});

	it("pulling the same page twice into a node that has it changes nothing (no duplicates, no new wake-ups)", async () => {
		const { shared, bSession } = await joined();
		const replies = () => pair.b.ctx.shared.store.messages(shared.id).filter((m) => m.kind === "reply" && m.authorNodeId === pair.bId).length;
		const repliesBefore = replies();
		await say(pair.a, shared.id, `@node-b once only${QUIET}`);
		await eventually(() => promptsWith(pair.b, "once only").length === 1, "B woken");
		await whenSettled(pair.b, bSession);
		// B's agent posts its end-of-turn reply after the turn settles: let it land before taking the snapshot.
		await eventually(() => replies() === repliesBefore + 1, "B's reply to 'once only' in its log");
		const before = idsOf(pair.b, shared.id);
		const prompts = promptsOf(pair.b).length;
		await pair.b.ctx.shared.discussion.syncPeer(pair.aId);
		await pair.b.ctx.shared.discussion.syncPeer(pair.aId);
		expect(idsOf(pair.b, shared.id)).toEqual(before);
		expect(promptsOf(pair.b)).toHaveLength(prompts);
	});

	it("refuses a bad cursor or limit (400), a node that is not an active participant (403) and an unknown shared session (404)", async () => {
		const { shared } = await joined();
		const path_ = `/shared/${shared.id}/messages/sync`;
		const ask = (body: unknown, override?: string) => signedRequest(pair.b, pair.a.netUrl, { method: "POST", path: path_, body, ...(override !== undefined && { bodyOverride: override }) });
		const bad: Array<[string, unknown]> = [
			["no cursor", {}],
			["a cursor that is not an object", { cursor: [1, 2] }],
			["a cursor key that is not a node id", { cursor: { "bad key!": 1 } }],
			["a negative sequence", { cursor: { [pair.aId]: -1 } }],
			["a fractional sequence", { cursor: { [pair.aId]: 1.5 } }],
			["a limit of 0", { cursor: {}, limit: 0 }],
			["a limit over 200", { cursor: {}, limit: 201 }],
			["a limit that is not a number", { cursor: {}, limit: "ten" }],
		];
		for (const [what, body] of bad) expect((await ask(body)).status, what).toBe(400);
		expect((await ask(undefined, "{not json")).status).toBe(400);
		expect((await ask({ cursor: {} })).status).toBe(200);
		expect((await signedRequest(pair.b, pair.a.netUrl, { method: "POST", path: "/shared/shs_ghost/messages/sync", body: { cursor: {} } })).status).toBe(404);

		await api(pair.b).post(`/shared/${shared.id}/leave`);
		await waitForShared(pair.a, shared.id, (s) => s.participants.find((p) => p.nodeId === pair.bId)?.state === "left", "A sees B left");
		const gone = await ask({ cursor: {} });
		expect(gone.status).toBe(403);
		expect(gone.body.error.code).toBe("forbidden");
	});
});
