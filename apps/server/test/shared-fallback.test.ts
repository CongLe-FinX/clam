import { and, eq } from "drizzle-orm";
import { outbox } from "@clam/database";
import type { SharedMessage, SharedSession } from "@clam/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { api, type FullHarness } from "./full-harness.ts";
import { eventually } from "./net-helpers.ts";
import {
	git,
	isolateGitConfig,
	promptAndWait,
	promptsOf,
	remoteBranches,
	sharedOn,
	startSharedPair,
	transcriptTexts,
	waitForShared,
	whenSettled,
	type GitConfigIsolation,
	type SharedPair,
} from "./shared-fixtures.ts";

/**
 * "Only one of the two nodes needs to be online": a human's message without a mention goes to the lead; when the lead cannot take
 * it (its node is offline, or it is this node and its agent is gone) it goes to the agent of the node it was written on (else any
 * reachable member agent), the effective `to` is stored on the message so every replica shows the same routing, and a replicated
 * system line says so. The fallback agent is not made lead: it must not edit the shared branch.
 *
 * A woken agent is given a `@@fake-sh true` line so the fake's answer is not an echo of the prompt (which would mention people).
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

const QUIET = "\n@@fake-sh true";

async function joined() {
	pair = await startSharedPair();
	const result = await pair.shareAndJoin({ firstPrompt: "start" });
	await waitForShared(pair.a, result.shared.id, (s) => s.lastCheckpoint?.deliveredTo.includes(pair.bId) === true, "the first snapshot reached B");
	const bSession = result.onB.participants.find((p) => p.nodeId === pair.bId)?.agentSessionId as string;
	await eventually(async () => (await transcriptTexts(pair.b, bSession)).some((t) => t.startsWith("FAKE: # Shared session")), "B's agent to acknowledge the briefing");
	await whenSettled(pair.b, bSession);
	await whenSettled(pair.a, result.sessionId);
	return { ...result, bSession };
}

async function say(node: FullHarness, sharedId: string, text: string): Promise<SharedMessage> {
	const res = await api(node).post<SharedMessage>(`/shared/${sharedId}/messages`, { text });
	if (res.status !== 201) throw new Error(`post ${res.status}: ${JSON.stringify(res.body)}`);
	return res.body;
}

const promptsWith = (node: FullHarness, needle: string) => promptsOf(node).filter((p) => p.message.includes(needle));
const systemLines = (node: FullHarness, sharedId: string) => node.ctx.shared.store.messages(sharedId).filter((m) => m.kind === "system" && m.text.includes("(lead)"));

async function waitForLeadOffline(sharedId: string): Promise<void> {
	await waitForShared(pair.b, sharedId, (s) => s.participants.find((p) => p.nodeId === pair.aId)?.nodeStatus === "offline", "B to see A offline", 20_000);
}

describe("an unmentioned human message while the lead is reachable", () => {
	it("goes to the lead only: nothing changes, no routing line", async () => {
		const { shared, bSession } = await joined();
		const bPrompts = promptsOf(pair.b).length;
		const message = await say(pair.b, shared.id, `status please${QUIET}`);
		expect(message.to).toEqual({ mode: "lead", agents: [] });
		await eventually(() => promptsWith(pair.a, "status please").length > 0, "the lead's agent woken", 20_000);
		await whenSettled(pair.b, bSession);
		expect(promptsOf(pair.b)).toHaveLength(bPrompts);
		expect(promptsWith(pair.a, "status please")[0]?.message).not.toContain("is offline right now");
		expect(systemLines(pair.b, shared.id)).toEqual([]);
		expect(systemLines(pair.a, shared.id)).toEqual([]);
	});
});

describe("the lead's node is offline", () => {
	it("an unmentioned human message on B wakes B's agent, the effective routing and a system line are replicated, and the lead's node sees both after it returns without waking its agent", async () => {
		const { shared, sessionId, bSession } = await joined();
		await pair.stop("a");
		await waitForLeadOffline(shared.id);

		const message = await say(pair.b, shared.id, `can somebody review the plan?${QUIET}`);
		// the effective routing is stored on the message itself
		expect(message.to).toEqual({ mode: "agents", agents: [{ nodeId: pair.bId, agentId: expect.any(String) }] });
		const stored = pair.b.ctx.shared.store.message(message.id);
		expect(stored?.to).toEqual(message.to);

		await eventually(() => promptsWith(pair.b, "can somebody review the plan?").length > 0, "B's agent woken although the lead is offline", 20_000);
		await whenSettled(pair.b, bSession);
		// it is told it is not the lead
		const prompt = promptsWith(pair.b, "can somebody review the plan?")[0]?.message ?? "";
		expect(prompt).toContain("The lead (node-a) is offline right now");
		expect(prompt).toContain("do NOT edit, commit or push code on the shared branch");

		const [line] = systemLines(pair.b, shared.id);
		expect(line?.text).toMatch(/^node-a \(lead\) is offline — sent to .+@node-b$/);
		expect(line?.kind).toBe("system");
		expect(line?.originSeq).not.toBeNull(); // replicated, not a local note

		// A returns: same message, same `to`, same line; its agent is not woken by a message that was for B's agent
		pair.b.ctx.db.delete(outbox).where(and(eq(outbox.kind, "shared.message"), eq(outbox.peerId, pair.aId))).run();
		const aPrompts = promptsOf(pair.a).length;
		await pair.start("a");
		await eventually(() => pair.a.ctx.shared.store.message(message.id) !== undefined && line !== undefined && pair.a.ctx.shared.store.message(line.id) !== undefined, "A to catch up with the message and the routing line", 30_000);
		expect(pair.a.ctx.shared.store.message(message.id)?.to).toEqual(message.to);
		expect(pair.a.ctx.shared.store.message(line?.id ?? "")?.text).toBe(line?.text);
		await whenSettled(pair.a, sessionId);
		expect(promptsWith(pair.a, "can somebody review the plan?")).toEqual([]);
		expect(promptsOf(pair.a)).toHaveLength(aPrompts);
	});

	it("an explicit address to the lead is kept: it waits for the lead", async () => {
		const { shared } = await joined();
		await pair.stop("a");
		await waitForLeadOffline(shared.id);
		const bPrompts = promptsOf(pair.b).length;
		const res = await api(pair.b).post<SharedMessage>(`/shared/${shared.id}/messages`, { text: `for the lead only${QUIET}`, to: { mode: "lead", agents: [] } });
		expect(res.status).toBe(201);
		expect(res.body.to).toEqual({ mode: "lead", agents: [] });
		expect(systemLines(pair.b, shared.id)).toEqual([]);
		await pair.b.ctx.shared.discussion.retryPending(); // routing of the stored message is complete once this returns
		expect(promptsOf(pair.b)).toHaveLength(bPrompts);
	});

	it("the fallback agent is not the lead: its edits are never committed to the shared branch, it cannot checkpoint, and the lead's next checkpoint does not contain them", async () => {
		const { shared, bSession } = await joined();
		const before = await sharedOn(pair.b, shared.id);
		const headBefore = git(pair.workB, "rev-parse", "HEAD").trim();
		await pair.stop("a");
		await waitForLeadOffline(shared.id);

		await say(pair.b, shared.id, "@@fake-sh echo nonlead > NONLEAD.md");
		await eventually(() => git(pair.workB, "status", "--porcelain").includes("NONLEAD.md"), "B's agent to write the file in its clone", 20_000);

		// not the lead: no checkpoint, nothing committed or pushed on B's behalf (the automatic checkpoint is the lead's alone)
		const refused = await api(pair.b).post<{ error: { code: string } }>(`/shared/${shared.id}/checkpoint`, {});
		expect(refused.status).toBe(409);
		expect(refused.body.error.code).toBe("not_driver");
		// B's turn is over and its reply is in the group: had anything checkpointed on its behalf it would have by now (the automatic checkpoint is the lead's alone)
		await whenSettled(pair.b, bSession);
		await eventually(() => pair.b.ctx.shared.store.messages(shared.id).some((m) => m.kind === "reply" && m.authorNodeId === pair.bId && m.text.includes("exit=0")), "B's reply to the edit request", 20_000);
		const after = await sharedOn(pair.b, shared.id);
		expect(after.lastCheckpoint?.seq).toBe(before.lastCheckpoint?.seq);
		expect(git(pair.workB, "rev-parse", "HEAD").trim()).toBe(headBefore);
		expect(git(pair.workB, "status", "--porcelain")).toContain("?? NONLEAD.md");
		expect(git(pair.origin, "ls-tree", "-r", "--name-only", shared.repo?.branch as string)).not.toContain("NONLEAD.md");
		expect(remoteBranches(pair.origin).filter((b) => b.startsWith("clam/") && b !== shared.repo?.branch)).toEqual([]);

		// the lead returns and checkpoints: its commit has nothing of B's edit
		await pair.start("a");
		const driver = await waitForShared(pair.a, shared.id, (s) => s.localRole === "driver", "A is still the lead");
		expect(driver.epoch).toBe(1);
		await promptAndWait(pair.a, shared.localSessionId ?? driver.localSessionId ?? "", "@@fake-sh echo lead-work > LEAD.md");
		const checkpoint = await api(pair.a).post<{ commit: string; pushed: boolean }>(`/shared/${shared.id}/checkpoint`, {});
		expect(checkpoint.status, JSON.stringify(checkpoint.body)).toBe(200);
		expect(checkpoint.body.pushed).toBe(true);
		const tree = git(pair.origin, "ls-tree", "-r", "--name-only", shared.repo?.branch as string);
		expect(tree).toContain("LEAD.md");
		expect(tree).not.toContain("NONLEAD.md");
	});
});

describe("the lead is this node but its agent is gone", () => {
	it("an unmentioned human message on the lead's node goes to a reachable member agent, with its own wording", async () => {
		const { shared, sessionId, bSession } = await joined();
		const archived = await api(pair.a).patch<unknown>(`/sessions/${sessionId}`, { archived: true });
		expect(archived.status, JSON.stringify(archived.body)).toBe(200);

		const message = await say(pair.a, shared.id, `anybody there?${QUIET}`);
		expect(message.to).toEqual({ mode: "agents", agents: [{ nodeId: pair.bId, agentId: expect.any(String) }] });
		await eventually(() => promptsWith(pair.b, "anybody there?").length > 0, "B's agent woken by the message of the lead's node", 20_000);
		await whenSettled(pair.b, bSession);
		await eventually(() => systemLines(pair.a, shared.id).some((m) => /^node-a \(lead\) cannot run its agent right now — sent to .+@node-b$/.test(m.text)), "the routing line on A");
		await eventually(() => systemLines(pair.b, shared.id).some((m) => m.text.includes("cannot run its agent right now")), "the routing line replicated to B", 20_000);
		const detail = (await api(pair.b).get<{ shared: SharedSession; messages: SharedMessage[] }>(`/shared/${shared.id}`)).body;
		expect(detail.messages.find((m) => m.id === message.id)?.to).toEqual(message.to);
	});
});
