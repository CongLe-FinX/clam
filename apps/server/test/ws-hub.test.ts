import { afterEach, describe, expect, it } from "vitest";
import { connectWs, createFullHarness, type FullHarness } from "./full-harness.ts";

let full: FullHarness | undefined;
afterEach(async () => {
	await full?.cleanup();
	full = undefined;
});

describe("WebSocket hub", () => {
	it("acknowledges subscriptions, answers ping and delivers per-topic ordered events with seq", async () => {
		full = await createFullHarness();
		const ws = await connectWs(full);
		ws.send({ type: "ping", t: 41 });
		expect(await ws.waitFor((f) => f.type === "pong", "pong")).toEqual({ type: "pong", t: 41 });

		ws.send({ type: "subscribe", topics: ["sessions", "session:abc"] });
		expect(await ws.waitFor((f) => f.type === "subscribed", "subscribed")).toEqual({ type: "subscribed", topics: ["sessions", "session:abc"] });

		full.ctx.bus.publish("session:abc", { type: "agent_start" });
		full.ctx.bus.publish("session:abc", { type: "agent_end" });
		full.ctx.bus.publish("session:other", { type: "agent_start" });
		await ws.waitFor((f) => f.type === "event" && f.event.type === "agent_end", "second event");
		const events = ws.frames.filter((f) => f.type === "event");
		expect(events.map((f) => [f.topic, f.event.type, f.seq])).toEqual([
			["session:abc", "agent_start", 1],
			["session:abc", "agent_end", 2],
		]);

		ws.send({ type: "unsubscribe", topics: ["session:abc"] });
		ws.send({ type: "ping", t: 2 });
		await ws.waitFor((f) => f.type === "pong" && f.t === 2, "pong 2");
		full.ctx.bus.publish("session:abc", { type: "agent_start" });
		ws.send({ type: "ping", t: 3 });
		await ws.waitFor((f) => f.type === "pong" && f.t === 3, "pong 3");
		expect(ws.frames.filter((f) => f.type === "event")).toHaveLength(2);
		ws.close();
	});

	it("rejects malformed messages and unknown topics without dropping the socket", async () => {
		full = await createFullHarness();
		const ws = await connectWs(full);
		ws.send({ type: "nonsense" });
		await ws.waitFor((f) => f.type === "error", "error for bad message");
		ws.send({ type: "subscribe", topics: ["session:../../etc", "bogus", "node"] });
		const ack = await ws.waitFor((f) => f.type === "subscribed", "subscribed");
		expect(ack.topics).toEqual(["node"]);
		expect(ws.frames.filter((f) => f.type === "error")).toHaveLength(3);
		ws.send({ type: "ping", t: 1 });
		await ws.waitFor((f) => f.type === "pong", "still alive");
		ws.close();
	});

	it("replays the latest event of retained topics to late subscribers, after the ack", async () => {
		full = await createFullHarness();
		const flow = { flowId: "f1", providerId: "p", state: "awaiting_browser", url: "https://example.test/auth", updatedAt: new Date().toISOString() };
		full.ctx.bus.publish("login:f1", { type: "flow", flow: { ...flow, state: "starting" } });
		full.ctx.bus.publish("login:f1", { type: "flow", flow });
		const ws = await connectWs(full);
		ws.send({ type: "subscribe", topics: ["login:f1", "login:unknown"] });
		const replay = await ws.waitFor((f) => f.type === "event" && f.topic === "login:f1", "replayed flow");
		expect(replay).toMatchObject({ seq: 2, event: { type: "flow", flow: { state: "awaiting_browser" } } });
		expect(ws.frames.findIndex((f) => f.type === "subscribed")).toBeLessThan(ws.frames.indexOf(replay));
		expect(ws.frames.filter((f) => f.topic === "login:unknown")).toHaveLength(0);
		ws.close();
	});

	it("publishes node health on subscribe (retained) once the node plugin has run", async () => {
		full = await createFullHarness();
		const ws = await connectWs(full);
		ws.send({ type: "subscribe", topics: ["node"] });
		const frame = await ws.waitFor((f) => f.type === "event" && f.topic === "node", "node health");
		expect(frame.event).toMatchObject({ type: "health", health: { checks: expect.any(Array) } });
		ws.close();
	});

	it("accepts git:<project> and git-op:<id> topics, delivers git events, and replays the latest git-op event (retained)", async () => {
		full = await createFullHarness();
		const operation = { id: "gop_1", kind: "clone", state: "running", phase: "Receiving objects", percent: 40, error: null, projectId: null, startedAt: new Date().toISOString(), finishedAt: null };
		full.ctx.bus.publish("git-op:gop_1", { type: "operation", operation });
		full.ctx.bus.publish("git-op:gop_1", { type: "operation", operation: { ...operation, state: "succeeded", percent: 100 } });
		const ws = await connectWs(full);
		ws.send({ type: "subscribe", topics: ["git:prj_1", "git-op:gop_1", "git:../x"] });
		const ack = await ws.waitFor((f) => f.type === "subscribed", "subscribed");
		expect(ack.topics).toEqual(["git:prj_1", "git-op:gop_1"]);
		const replay = await ws.waitFor((f) => f.type === "event" && f.topic === "git-op:gop_1", "replayed operation");
		expect(replay).toMatchObject({ seq: 2, event: { type: "operation", operation: { state: "succeeded", percent: 100 } } });

		full.ctx.bus.publish("git:prj_1", { type: "operation", operation });
		await ws.waitFor((f) => f.type === "event" && f.topic === "git:prj_1", "git event");
		ws.close();
	});
});
