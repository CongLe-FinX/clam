import type { wire } from "@clam/agent-network";
import type { AgentSession, SessionLiveState, UiMessage } from "@clam/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { api, connectWs, type FullHarness } from "./full-harness.ts";
import { eventually } from "./net-helpers.ts";
import {
	isolateGitConfig,
	promptAndWait,
	sessionOn,
	startSharedPair,
	textOf,
	transcript,
	waitForShared,
	whenSettled,
	type GitConfigIsolation,
	type SharedPair,
} from "./shared-fixtures.ts";

/**
 * The live mirror of the driver's conversation on a participant node: streamed while the driver works, read-only, kept
 * when the driver goes away, brought up to date by a full sync when the participant was away, chunked when it is long.
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

/** Let the nodes' own real timers (reconcile tick 1 s, retries 150 ms) run: the point of the test is that they leave the mirror alone. */
function realTime(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

async function stateOf(node: FullHarness, sessionId: string): Promise<SessionLiveState> {
	const res = await api(node).get<SessionLiveState>(`/sessions/${sessionId}/state`);
	if (res.status !== 200) throw new Error(`state ${res.status}: ${JSON.stringify(res.body)}`);
	return res.body;
}

/** Shape of a transcript that two nodes must agree on: ids, roles and text, in order. */
function shape(messages: UiMessage[]): Array<[string, string, string]> {
	return messages.map((m) => [m.id, m.role, textOf(m)]);
}

async function mirrorEquals(node: FullHarness, mirrorId: string, driver: FullHarness, driverSessionId: string): Promise<boolean> {
	const [mine, theirs] = await Promise.all([transcript(node, mirrorId), transcript(driver, driverSessionId)]);
	return mine.length > 0 && JSON.stringify(shape(mine)) === JSON.stringify(shape(theirs));
}

/** A shared session whose mirror on B already shows the first exchange. */
async function mirrored() {
	pair = await startSharedPair();
	const joined = await pair.shareAndJoin({ firstPrompt: "start" });
	const mirrorId = joined.onB.mirrorSessionId as string;
	await eventually(() => mirrorEquals(pair.b, mirrorId, pair.a, joined.sessionId), "the mirror to show A's first exchange");
	return { ...joined, mirrorId };
}

describe("live streaming", () => {
	it("shows what the driver does on B as it happens: message events and state over the mirror's WebSocket topic, the transcript by polling", async () => {
		const { sessionId, mirrorId } = await mirrored();
		const ws = await connectWs(pair.b);
		ws.send({ type: "subscribe", topics: [`session:${mirrorId}`] });
		await ws.waitFor((f) => f.type === "subscribed" && f.topics.includes(`session:${mirrorId}`), "subscribed to the mirror topic");

		// a turn that keeps the driver busy for a while, polled on B all along
		const turn = promptAndWait(pair.a, sessionId, "@@fake-sh sleep 1 && echo mirrored-output");
		const states: string[] = [];
		await eventually(
			async () => {
				const state = await stateOf(pair.b, mirrorId);
				states.push(state.runtime.state);
				return state.runtime.state === "busy" && state.isStreaming === false ? undefined : state.runtime.state === "busy";
			},
			"B's mirror to show the driver busy",
			15_000,
		);
		expect((await sessionOn(pair.b, mirrorId)).status).toBe("running");
		await turn;
		await eventually(() => mirrorEquals(pair.b, mirrorId, pair.a, sessionId), "B's transcript to equal A's after the turn");
		await eventually(async () => {
			const state = await stateOf(pair.b, mirrorId);
			states.push(state.runtime.state);
			return state.runtime.state === "ready" && state.isSettled;
		}, "B's mirror to be ready again");
		// never crashed, never stopped: only ready or busy
		expect(new Set(states)).toEqual(new Set(["busy", "ready"]));
		expect((await sessionOn(pair.b, mirrorId)).status).toBe("idle");

		const answer = (await transcript(pair.b, mirrorId)).filter((m) => m.role === "assistant").map(textOf).join("\n");
		expect(answer).toContain("mirrored-output");
		const onTopic = ws.frames.filter((f) => f.type === "event" && f.topic === `session:${mirrorId}`).map((f) => f.event);
		const types = new Set(onTopic.map((e) => e.type));
		expect(types).toContain("message_start");
		expect(types).toContain("message_delta");
		expect(types).toContain("message_end");
		expect(types).toContain("state");
		expect(onTopic.some((e) => e.type === "state" && e.state.sessionId === mirrorId && e.state.runtime.state === "busy")).toBe(true);
		expect(onTopic.some((e) => e.type === "state" && e.state.runtime.state === "ready")).toBe(true);
		// the events the viewer sees carry B's mirror id, never the driver's session id
		expect(JSON.stringify(onTopic)).not.toContain(sessionId);
		ws.close();
	});

	it("keeps following turn after turn (batches in order, one per flush) and reports the mirrored session as a mirror", async () => {
		const { sessionId, mirrorId } = await mirrored();
		for (const text of ["second turn", "third turn", "fourth turn"]) await promptAndWait(pair.a, sessionId, text);
		await eventually(() => mirrorEquals(pair.b, mirrorId, pair.a, sessionId), "B's mirror to follow three more turns");
		const texts = (await transcript(pair.b, mirrorId)).map(textOf);
		expect(texts).toEqual(expect.arrayContaining(["second turn", "FAKE: second turn", "third turn", "FAKE: third turn", "fourth turn", "FAKE: fourth turn"]));
		expect(texts.indexOf("third turn")).toBeGreaterThan(texts.indexOf("FAKE: second turn"));
		expect(await sessionOn(pair.b, mirrorId)).toMatchObject({ kind: "mirror", sharedSessionId: expect.any(String), movedTo: null, archived: false });
		const lastSeq = pair.b.ctx.shared.store.mirrorState(mirrorId)?.lastSeq ?? 0;
		expect(lastSeq).toBeGreaterThan(3);
	});
});

describe("read-only", () => {
	it("every write to the mirror is refused: prompt, abort, model, thinking, restart, answering a request", async () => {
		const { mirrorId } = await mirrored();
		const before = shape(await transcript(pair.b, mirrorId));
		const refused: Array<[string, { status: number; body: { error: { code: string } } }]> = [
			["prompt", await api(pair.b).post(`/sessions/${mirrorId}/prompt`, { message: "hello?", clientId: "ro-1" })],
			["prompt that steers", await api(pair.b).post(`/sessions/${mirrorId}/prompt`, { message: "hello?", clientId: "ro-2", streamingBehavior: "steer" })],
			["abort", await api(pair.b).post(`/sessions/${mirrorId}/abort`)],
			["model", await api(pair.b).post(`/sessions/${mirrorId}/model`, { selector: "anthropic/claude-sonnet" })],
			["thinking", await api(pair.b).post(`/sessions/${mirrorId}/thinking`, { level: "high" })],
			["restart", await api(pair.b).post(`/runtime/${mirrorId}/restart`)],
			["ui response", await api(pair.b).post(`/sessions/${mirrorId}/ui-response`, { requestId: "ui-1", value: true })],
		];
		for (const [what, res] of refused) {
			expect(res.status, what).toBe(409);
			expect(res.body.error.code, what).toBe("session_read_only");
		}
		// nothing was sent to a runtime, nothing was added, nothing was started
		expect(shape(await transcript(pair.b, mirrorId))).toEqual(before);
		expect((await api(pair.b).get<Array<{ sessionId: string }>>("/runtime")).body.some((r) => r.sessionId === mirrorId)).toBe(false);
		expect((await sessionOn(pair.b, mirrorId)).kind).toBe("mirror");
	});
});

describe("when the driver goes away", () => {
	it("the mirror survives A going offline: transcript and state are still served, the status is never an error", async () => {
		const { shared, mirrorId, sessionId } = await mirrored();
		await promptAndWait(pair.a, sessionId, "last words before the lights go out");
		await eventually(() => mirrorEquals(pair.b, mirrorId, pair.a, sessionId), "B to hold the last words");
		const held = shape(await transcript(pair.b, mirrorId));

		await pair.stop("a");
		await waitForShared(pair.b, shared.id, (s) => s.participants.find((p) => p.role === "driver")?.nodeStatus === "offline", "B to see A offline", 20_000);

		for (let round = 0; round < 3; round++) {
			const session = await sessionOn(pair.b, mirrorId);
			expect(session.kind).toBe("mirror");
			expect(session.status).not.toBe("error");
			expect(session.archived).toBe(false);
			const state = await stateOf(pair.b, mirrorId);
			expect(["ready", "busy"]).toContain(state.runtime.state);
			expect(state.runtime.lastError).toBeNull();
			expect(shape(await transcript(pair.b, mirrorId))).toEqual(held);
			// still read-only, and still no runtime
			expect((await api(pair.b).post<{ error: { code: string } }>(`/sessions/${mirrorId}/prompt`, { message: "anyone?", clientId: `off-${round}` })).body.error.code).toBe("session_read_only");
			await realTime(400);
		}
		expect((await api(pair.b).get<Array<{ sessionId: string }>>("/runtime")).body.some((r) => r.sessionId === mirrorId)).toBe(false);
		// the node itself restarted: the mirror is read from the database, so it is still there
		await pair.stop("b");
		await pair.start("b");
		expect(shape(await transcript(pair.b, mirrorId))).toEqual(held);
		expect((await sessionOn(pair.b, mirrorId)).status).not.toBe("error");
	});

	it("a participant that was offline catches up with a full sync when it returns", async () => {
		const { shared, mirrorId, sessionId } = await mirrored();
		await pair.stop("b");
		await waitForShared(pair.a, shared.id, (s) => s.participants.find((p) => p.nodeId === pair.bId)?.nodeStatus === "offline", "A to see B offline", 20_000);
		for (const text of ["work while B is away one", "work while B is away two"]) await promptAndWait(pair.a, sessionId, text);
		await whenSettled(pair.a, sessionId);
		const expected = shape(await transcript(pair.a, sessionId));
		expect(expected.map((m) => m[2])).toEqual(expect.arrayContaining(["FAKE: work while B is away two"]));

		await pair.start("b");
		await eventually(() => mirrorEquals(pair.b, mirrorId, pair.a, sessionId), "B's mirror to equal A's transcript after coming back", 30_000);
		expect(shape(await transcript(pair.b, mirrorId))).toEqual(expected);
		// and live following resumes after the sync
		await promptAndWait(pair.a, sessionId, "back together");
		await eventually(() => mirrorEquals(pair.b, mirrorId, pair.a, sessionId), "B to follow live again");
		await eventually(async () => (await stateOf(pair.b, mirrorId)).runtime.state === "ready", "B's mirror to be ready after the turn");
	});
});

describe("long conversations", () => {
	it("a transcript of 60+ large messages is replayed in several sync chunks, in order, and ends up equal on B", async () => {
		const { shared, mirrorId, sessionId } = await mirrored();
		const big = "@@fake-sh head -c 40000 /dev/zero | tr '\\0' x";
		let count = (await transcript(pair.a, sessionId)).length;
		while (count < 60) {
			await promptAndWait(pair.a, sessionId, big, 30_000);
			count = (await transcript(pair.a, sessionId)).length;
		}
		await eventually(() => mirrorEquals(pair.b, mirrorId, pair.a, sessionId), "B to follow the long conversation live", 30_000);

		// observe what B receives from now on (the real receive runs unchanged)
		const mirror = pair.b.ctx.shared.mirror;
		const original = mirror.receive.bind(mirror);
		const seen: wire.SharedMirrorRequest[] = [];
		mirror.receive = (peerId, sharedId, request) => {
			seen.push(request);
			return original(peerId, sharedId, request);
		};
		await whenSettled(pair.a, sessionId);
		pair.a.ctx.shared.mirror.syncPeer(shared.id, pair.bId);
		await eventually(() => seen.some((r) => r.type === "sync" && r.final), "the final sync chunk");
		await eventually(() => mirrorEquals(pair.b, mirrorId, pair.a, sessionId), "B to equal A after the chunked sync", 30_000);

		const chunks = seen.filter((r): r is Extract<wire.SharedMirrorRequest, { type: "sync" }> => r.type === "sync");
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
		expect(chunks.map((c) => c.final)).toEqual(chunks.map((_, i) => i === chunks.length - 1));
		expect(new Set(chunks.map((c) => c.streamId)).size).toBe(1);
		for (const chunk of chunks) expect(JSON.stringify(chunk).length).toBeLessThan(1024 * 1024);
		const total = chunks.reduce((sum, c) => sum + c.messages.length, 0);
		expect(total).toBe((await transcript(pair.a, sessionId)).length);
		expect(total).toBeGreaterThanOrEqual(60);
		expect(chunks.at(-1)?.state).toBeDefined();
		const a = await transcript(pair.a, sessionId);
		expect(shape(await transcript(pair.b, mirrorId))).toEqual(shape(a));
		expect(textOf(a.filter((m) => m.role === "toolResult")[0] as UiMessage).length).toBeGreaterThan(30_000);
		const session: AgentSession = await sessionOn(pair.b, mirrorId);
		expect(session.status).not.toBe("error");
	});
});
