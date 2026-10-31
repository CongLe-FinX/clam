import { existsSync, readFileSync } from "node:fs";
import type { AskAnswer, PendingUiRequest, SessionLiveState } from "@clam/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { api, connectWs, type FullHarness, type WsClient } from "./full-harness.ts";
import { eventually, signedRequest } from "./net-helpers.ts";
import { detailOn, isolateGitConfig, sharedOn, startSharedPair, textOf, transcript, waitForShared, type GitConfigIsolation, type SharedPair } from "./shared-fixtures.ts";

/**
 * Questions (`ask`) and approvals of the driver's agent, answered from any member machine: the pending request is replicated to
 * the participants inside the mirrored state, a participant's answer travels to the driver as `POST /shared/:id/answer`, the
 * driver's runtime applies the first one, and the resolution (with who answered) is replicated back to everybody.
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

const ANSWERS: AskAnswer[] = [
	{ id: "db", selectedOptions: ["SQLite"] },
	{ id: "features", selectedOptions: ["Auth", "Search"] },
];
const OTHER_ANSWERS: AskAnswer[] = [
	{ id: "db", selectedOptions: ["Postgres"] },
	{ id: "features", selectedOptions: ["Billing"] },
];

/** An `extension_ui_response` frame as the fake omp recorded it (the agent's side of an answer). */
interface UiResponseFrame {
	id: string;
	answers?: AskAnswer[];
	value?: string;
	cancelled?: boolean;
}

function uiResponses(node: FullHarness): UiResponseFrame[] {
	if (!existsSync(node.fakeLog)) return [];
	return readFileSync(node.fakeLog, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { kind: string; frame?: UiResponseFrame & { type: string } })
		.filter((r) => r.kind === "command" && r.frame?.type === "extension_ui_response")
		.map((r) => r.frame as UiResponseFrame);
}

async function pendingOn(node: FullHarness, sessionId: string): Promise<PendingUiRequest[]> {
	const res = await api(node).get<PendingUiRequest[]>(`/sessions/${sessionId}/ui-requests`);
	if (res.status !== 200) throw new Error(`ui-requests ${res.status}: ${JSON.stringify(res.body)}`);
	return res.body;
}

interface ErrorBody {
	error: { code: string; message: string; details?: Record<string, unknown> };
}

/** A shared session driven by A (B is a participant) whose agent was prompted with `message`; resolves once the request is pending on BOTH nodes. */
async function asking(message: "__ask__" | "__approve__", options: { approvalMode?: string } = {}) {
	pair = await startSharedPair();
	if (options.approvalMode) {
		for (const node of [pair.a, pair.b]) expect((await api(node).patch("/settings", { approvalMode: options.approvalMode })).status).toBe(200);
	}
	const joined = await pair.shareAndJoin({ firstPrompt: "start" });
	const mirrorId = joined.onB.mirrorSessionId as string;
	const prompted = await api(pair.a).post(`/sessions/${joined.sessionId}/prompt`, { message, clientId: `ask-${Date.now()}` });
	expect(prompted.status).toBe(202);
	const request = await eventually(async () => (await pendingOn(pair.a, joined.sessionId))[0], "the request on the driver");
	const onB = await eventually(async () => (await pendingOn(pair.b, mirrorId))[0], "the request replicated to B");
	expect(onB.requestId).toBe(request.requestId);
	return { ...joined, mirrorId, request };
}

const answerOnB = (mirrorId: string, body: unknown) => api(pair.b).post<ErrorBody | undefined>(`/sessions/${mirrorId}/ui-response`, body);
const answerOnA = (sessionId: string, body: unknown) => api(pair.a).post<ErrorBody | undefined>(`/sessions/${sessionId}/ui-response`, body);

/** The system lines of a node's copy of the group chat. */
async function systemLines(node: FullHarness, sharedId: string): Promise<string[]> {
	return (await detailOn(node, sharedId)).messages.filter((m) => m.author.kind === "system").map((m) => m.text);
}

async function agentSaid(node: FullHarness, sessionId: string, fragment: string): Promise<boolean> {
	return (await transcript(node, sessionId)).map(textOf).some((t) => t.includes(fragment));
}

async function subscribed(node: FullHarness, topic: string): Promise<WsClient> {
	const ws = await connectWs(node);
	ws.send({ type: "subscribe", topics: [topic] });
	await ws.waitFor((f) => f.type === "subscribed" && f.topics.includes(topic), `subscribed to ${topic}`);
	return ws;
}

describe("an ask answered from the participant machine", () => {
	it("replicates the question, the answer reaches the driver's agent, and every member's card resolves with who answered", async () => {
		const { sessionId, mirrorId, shared, request } = await asking("__ask__");
		// the participant sees the very same two questions
		expect(request).toMatchObject({ method: "ask", questions: [{ id: "db" }, { id: "features", multi: true }] });
		expect(await pendingOn(pair.b, mirrorId)).toEqual([expect.objectContaining({ requestId: request.requestId, method: "ask", questions: request.questions })]);
		// the sessions list badge and the state of the mirror say somebody has to answer
		expect((await api(pair.b).get<{ pendingRequests: number }>(`/sessions/${mirrorId}`)).body.pendingRequests).toBe(1);
		const state = (await api(pair.b).get<SessionLiveState>(`/sessions/${mirrorId}/state`)).body;
		expect(state.requests?.pending.map((r) => r.requestId)).toEqual([request.requestId]);

		const wsA = await subscribed(pair.a, `session:${sessionId}`);
		const wsB = await subscribed(pair.b, `session:${mirrorId}`);
		const answered = await answerOnB(mirrorId, { requestId: request.requestId, answers: ANSWERS });
		expect(answered.status, JSON.stringify(answered.body)).toBe(204);

		// the agent on A got exactly this answer and carried on with it
		await eventually(() => uiResponses(pair.a).length === 1, "the fake agent to receive the answer");
		expect(uiResponses(pair.a)[0]).toMatchObject({ id: request.requestId, answers: ANSWERS });
		await eventually(() => agentSaid(pair.a, sessionId, "SQLite"), "the agent to continue with the answers");

		// both sides resolved, and each side's viewers learnt who answered (B's person)
		const by = { nodeId: pair.bId, machine: pair.b.ctx.shared.nodeName() };
		const resolution = (ws: WsClient, topic: string) => ws.waitFor((f) => f.topic === topic && f.event?.type === "ui_request_resolved" && f.event.answeredBy, `the resolution with its author on ${topic}`, 10_000);
		expect((await resolution(wsA, `session:${sessionId}`)).event).toMatchObject({ requestId: request.requestId, outcome: "answered", answers: ANSWERS, answeredBy: by });
		expect((await resolution(wsB, `session:${mirrorId}`)).event).toMatchObject({ requestId: request.requestId, outcome: "answered", answers: ANSWERS, answeredBy: by });
		await eventually(async () => (await pendingOn(pair.a, sessionId)).length === 0 && (await pendingOn(pair.b, mirrorId)).length === 0, "no request pending on either node");
		expect(pair.b.ctx.shared.store.mirrorState(mirrorId)?.state?.requests?.resolved).toEqual([expect.objectContaining({ requestId: request.requestId, outcome: "answered", answeredBy: by })]);

		// one compact line in the group chat, on both machines
		const agentName = (await sharedOn(pair.a, shared.id)).participants.find((p) => p.nodeId === pair.aId)?.agentName;
		const line = `${by.machine} answered ${agentName}'s question`;
		await eventually(async () => (await systemLines(pair.a, shared.id)).some((l) => l.includes(line)), "the group line on A");
		await eventually(async () => (await systemLines(pair.b, shared.id)).some((l) => l.includes(line)), "the group line on B");
		wsA.close();
		wsB.close();
	});

	it("a second answer is refused 409 already_answered naming who answered; the agent got the first one only", async () => {
		const { sessionId, mirrorId, request } = await asking("__ask__");
		expect((await answerOnB(mirrorId, { requestId: request.requestId, answers: ANSWERS })).status).toBe(204);

		// B again (it may not even have heard of the resolution yet), then the person on A
		const again = await answerOnB(mirrorId, { requestId: request.requestId, answers: OTHER_ANSWERS });
		expect(again.status).toBe(409);
		expect(again.body?.error).toMatchObject({ code: "already_answered", details: { outcome: "answered", answeredBy: { nodeId: pair.bId, machine: pair.b.ctx.shared.nodeName() } } });
		expect((await answerOnA(sessionId, { requestId: request.requestId, answers: OTHER_ANSWERS })).status).toBe(409);

		await eventually(() => agentSaid(pair.a, sessionId, "SQLite"), "the agent to continue with the first answer");
		expect(uiResponses(pair.a)).toEqual([expect.objectContaining({ id: request.requestId, answers: ANSWERS })]);
	});

	it("two people answering at once: exactly one wins, the agent hears one answer, the other is told", async () => {
		const { sessionId, mirrorId, request } = await asking("__ask__");
		const [fromB, fromA] = await Promise.all([answerOnB(mirrorId, { requestId: request.requestId, answers: ANSWERS }), answerOnA(sessionId, { requestId: request.requestId, answers: OTHER_ANSWERS })]);
		expect([fromA.status, fromB.status].sort()).toEqual([204, 409]);
		await eventually(() => agentSaid(pair.a, sessionId, "User answers"), "the agent to continue");
		const heard = uiResponses(pair.a);
		expect(heard).toHaveLength(1);
		const bWon = heard[0]?.answers?.[0]?.selectedOptions[0] === "SQLite";
		expect(bWon ? fromB.status : fromA.status).toBe(204);
		if (!bWon) expect(fromB.body?.error).toMatchObject({ code: "already_answered", details: { answeredBy: { nodeId: pair.aId } } });
	});

	it("the driver's own validation applies to the participant's answer: a wrong option is a 400 and the question stays open", async () => {
		const { mirrorId, request } = await asking("__ask__");
		const bad = await answerOnB(mirrorId, { requestId: request.requestId, answers: [{ id: "db", selectedOptions: ["Mongo"] }, { id: "features", selectedOptions: [] }] });
		expect(bad.status).toBe(400);
		expect(uiResponses(pair.a)).toHaveLength(0);
		expect((await pendingOn(pair.b, mirrorId)).map((r) => r.requestId)).toEqual([request.requestId]);
		// the body carries exactly one of value / answers, and the request must exist
		expect((await answerOnB(mirrorId, { requestId: request.requestId })).status).toBe(400);
		const ghost = await answerOnB(mirrorId, { requestId: "ui-ghost", value: true });
		expect(ghost.status).toBe(409);
		expect(ghost.body?.error.code).toBe("request_closed");
		expect((await answerOnB(mirrorId, { requestId: request.requestId, answers: ANSWERS })).status).toBe(204);
	});
});

describe("approvals", () => {
	it("a tool approval of the driver's agent is answered from B (select); an invalid choice is refused", async () => {
		const { sessionId, mirrorId, shared, request } = await asking("__approve__", { approvalMode: "always-ask" });
		expect(request).toMatchObject({ method: "select", options: expect.arrayContaining(["Approve", "Deny"]) });
		expect(await pendingOn(pair.b, mirrorId)).toEqual([expect.objectContaining({ requestId: request.requestId, method: "select", options: request.options })]);
		expect((await answerOnB(mirrorId, { requestId: request.requestId, value: "Maybe" })).status).toBe(400);
		expect((await answerOnB(mirrorId, { requestId: request.requestId, value: "Approve" })).status).toBe(204);
		await eventually(() => agentSaid(pair.a, sessionId, "approval Approve"), "the agent to continue with the approval");
		expect(uiResponses(pair.a)).toEqual([expect.objectContaining({ id: request.requestId, value: "Approve" })]);
		await eventually(async () => (await pendingOn(pair.b, mirrorId)).length === 0, "the approval to resolve on B");
		await eventually(async () => (await systemLines(pair.b, shared.id)).some((l) => / answered .+'s approval request$/.test(l)), "the group line for the approval on B");
	});

	it("a participant can decline (cancel) an approval too", async () => {
		const { sessionId, mirrorId, request } = await asking("__approve__", { approvalMode: "always-ask" });
		expect((await answerOnB(mirrorId, { requestId: request.requestId, value: null })).status).toBe(204);
		await eventually(() => uiResponses(pair.a)[0]?.cancelled === true, "the agent to receive the cancel");
		await eventually(() => agentSaid(pair.a, sessionId, "approval cancelled"), "the agent to carry on after the cancel");
	});
});

describe("epochs and driver changes", () => {
	it("an answer carrying an older epoch is refused 409 stale_epoch, a newer one 409 epoch_unknown; the signed route is idempotent per key", async () => {
		const { shared, sessionId, request, mirrorId } = await asking("__ask__");
		const send = (body: unknown, idempotencyKey?: string) => signedRequest(pair.b, pair.a.netUrl, { method: "POST", path: `/shared/${shared.id}/answer`, body, ...(idempotencyKey ? { idempotencyKey } : {}) });
		const answers = { requestId: request.requestId, answers: ANSWERS };
		// the driver is at epoch 2 now (as after a hand-over): what B saw at epoch 1 belongs to a runtime that no longer drives
		pair.a.ctx.shared.store.update(shared.id, { epoch: 2 });
		const stale = await send({ epoch: 1, ...answers });
		expect(stale.status).toBe(409);
		expect(stale.body.error).toMatchObject({ code: "stale_epoch", details: { currentEpoch: 2, driverNodeId: pair.aId } });
		const ahead = await send({ epoch: 3, ...answers });
		expect(ahead.status).toBe(409);
		expect(ahead.body.error.code).toBe("epoch_unknown");
		expect(uiResponses(pair.a)).toHaveLength(0);
		pair.a.ctx.shared.store.update(shared.id, { epoch: 1 });
		expect((await pendingOn(pair.a, sessionId)).map((r) => r.requestId)).toEqual([request.requestId]);

		// the wire body itself is validated: epoch ≥ 1, exactly one of value / answers
		for (const body of [{ epoch: 0, ...answers }, { epoch: 1, requestId: request.requestId }, { epoch: 1, ...answers, value: true }]) {
			expect((await send(body)).status, JSON.stringify(body)).toBe(400);
		}
		// with the right epoch the call goes through; a retry with the same key replays the 200, a new key learns it was answered
		const key = `answer-${Date.now()}`;
		const first = await send({ epoch: 1, ...answers }, key);
		expect(first.status).toBe(200);
		expect(first.body).toEqual({ ok: true, outcome: "answered" });
		const retry = await send({ epoch: 1, ...answers }, key);
		expect(retry.status).toBe(200);
		expect(retry.headers.get("idempotent-replay")).toBe("true");
		const other = await send({ epoch: 1, ...answers });
		expect(other.status).toBe(409);
		expect(other.body.error.code).toBe("already_answered");
		expect(uiResponses(pair.a)).toHaveLength(1);
		await eventually(async () => (await pendingOn(pair.b, mirrorId)).length === 0, "B to see it resolved");
	});

	it("when the driver changes while a question is pending, the card is withdrawn on the participant (the new driver's runtime is a new session)", async () => {
		pair = await startSharedPair();
		const joined = await pair.shareAndJoin({ firstPrompt: "start" });
		const mirrorId = joined.onB.mirrorSessionId as string;
		await waitForShared(pair.a, joined.shared.id, (s) => s.lastCheckpoint?.deliveredTo.includes(pair.bId) === true, "the first checkpoint to reach B");
		const prompted = await api(pair.a).post(`/sessions/${joined.sessionId}/prompt`, { message: "__ask__", clientId: "ask-change" });
		expect(prompted.status).toBe(202);
		const request = await eventually(async () => (await pendingOn(pair.b, mirrorId))[0], "the question on B");

		const ws = await subscribed(pair.b, `session:${mirrorId}`);
		await pair.stop("a");
		await waitForShared(pair.b, joined.shared.id, (s) => s.takeoverAvailable, "takeover available once A is offline", 20_000);
		// the driver is gone: the answer cannot be delivered, and says so
		const offline = await answerOnB(mirrorId, { requestId: request.requestId, answers: ANSWERS });
		expect(offline.status).toBe(503);
		expect(offline.body?.error.code).toBe("driver_unreachable");
		expect((await pendingOn(pair.b, mirrorId)).map((r) => r.requestId)).toEqual([request.requestId]);

		const took = await api(pair.b).post<{ localSessionId: string; epoch: number }>(`/shared/${joined.shared.id}/takeover`, {});
		expect(took.status, JSON.stringify(took.body)).toBe(200);
		expect(took.body.epoch).toBe(2);
		await ws.waitFor((f) => f.topic === `session:${mirrorId}` && f.event?.type === "ui_request_resolved" && f.event.requestId === request.requestId && f.event.outcome === "abandoned", "the card to be withdrawn on the old mirror");
		expect(await pendingOn(pair.b, mirrorId)).toEqual([]);
		// nothing of the old runtime is pending on the new driver's session
		expect(await pendingOn(pair.b, took.body.localSessionId)).toEqual([]);
		ws.close();
	});
});
