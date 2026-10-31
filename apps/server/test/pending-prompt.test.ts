import type { AgentSession, MessagesPage, Project, SessionLiveState, Workspace } from "@clam/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { api, connectWs, createFullHarness, type FullHarness, type WsClient } from "./full-harness.ts";

let full: FullHarness | undefined;
let ws: WsClient | undefined;
afterEach(async () => {
	ws?.close();
	await full?.cleanup();
	full = undefined;
	ws = undefined;
});

async function setup(options: Parameters<typeof createFullHarness>[0]) {
	full = await createFullHarness(options);
	const http = api(full);
	const workspace = (await http.post<Workspace>("/workspaces", { name: "W" })).body;
	const project = (await http.post<Project>("/projects", { workspaceId: workspace.id, name: "P", path: full.projectDir })).body;
	ws = await connectWs(full);
	return { http, project, ws };
}

const sessionEvents = (client: WsClient, sessionId: string) =>
	client.frames.filter((f) => f.type === "event" && f.topic === `session:${sessionId}`).map((f) => f.event as { type: string; [k: string]: any });

describe("first prompt before OMP echoes it", () => {
	it("is visible in GET /messages and as events while the session is busy, and the echo does not duplicate it", async () => {
		// The fake starts the run (and echoes the user message) 1.2 s after admitting the prompt, like omp on a cold first turn.
		const { http, project, ws: client } = await setup({ env: { FAKE_OMP_PRE_RUN_DELAY_MS: "1200" } });
		const created = await http.post<AgentSession>("/sessions", { projectId: project.id, prompt: "build me a thing" });
		expect(created.status).toBe(201);
		const id = created.body.id;
		client.send({ type: "subscribe", topics: [`session:${id}`] });

		// Poll until the runtime has admitted the prompt; the transcript must already contain it, with the run not started yet.
		const deadline = Date.now() + 6000;
		let early: MessagesPage | undefined;
		for (;;) {
			const page = (await http.get<MessagesPage>(`/sessions/${id}/messages`)).body;
			if (page.total > 0) {
				early = page;
				break;
			}
			if (Date.now() > deadline) throw new Error("the pending prompt never appeared");
			await new Promise((r) => setTimeout(r, 20));
		}
		expect(early.messages.map((m) => [m.id, m.role, m.clientId])).toEqual([["m1", "user", `init_${id}`]]);
		expect(early.messages[0]?.content).toEqual([{ type: "text", text: "build me a thing" }]);
		const state = (await http.get<SessionLiveState>(`/sessions/${id}/state`)).body;
		expect(state.runtime.state).toBe("busy");
		expect(sessionEvents(client, id).some((e) => e.type === "agent_start")).toBe(false);

		await client.waitFor((f) => f.topic === `session:${id}` && f.event.type === "settled", "settled", 10000);
		const events = sessionEvents(client, id);
		const userStarts = events.filter((e) => e.type === "message_start" && e.message.role === "user");
		expect(userStarts).toHaveLength(1);
		expect(userStarts[0]?.message).toMatchObject({ id: "m1", clientId: `init_${id}` });
		expect(events.findIndex((e) => e.type === "message_start")).toBeLessThan(events.findIndex((e) => e.type === "agent_start"));
		expect(events.find((e) => e.type === "prompt_result")).toMatchObject({ clientId: `init_${id}`, status: "completed" });

		const final = (await http.get<MessagesPage>(`/sessions/${id}/messages`)).body;
		expect(final.messages.map((m) => `${m.id}:${m.role}`)).toEqual(["m1:user", "m2:assistant"]);
		expect(final.messages[0]?.clientId).toBe(`init_${id}`);
	});

	it("shows an ordinary POST /prompt the same way and attaches clientId to the single user message", async () => {
		const { http, project, ws: client } = await setup({ env: { FAKE_OMP_PRE_RUN_DELAY_MS: "600" } });
		const session = (await http.post<AgentSession>("/sessions", { projectId: project.id })).body;
		client.send({ type: "subscribe", topics: [`session:${session.id}`] });
		await client.waitFor((f) => f.type === "subscribed", "subscribed");
		const accepted = await http.post(`/sessions/${session.id}/prompt`, { message: "second tab check", clientId: "tab-1" });
		expect(accepted.status).toBe(202);
		const early = (await http.get<MessagesPage>(`/sessions/${session.id}/messages`)).body;
		expect(early.messages.map((m) => [m.role, m.clientId])).toEqual([["user", "tab-1"]]);
		await client.waitFor((f) => f.event?.type === "settled", "settled", 10000);
		const final = (await http.get<MessagesPage>(`/sessions/${session.id}/messages`)).body;
		expect(final.messages.filter((m) => m.role === "user")).toHaveLength(1);
	});

	it("withdraws the pending message and reports an error when the prompt is never acknowledged", async () => {
		const { http, project, ws: client } = await setup({ requestTimeoutMs: 400 });
		const session = (await http.post<AgentSession>("/sessions", { projectId: project.id })).body;
		client.send({ type: "subscribe", topics: [`session:${session.id}`] });
		await client.waitFor((f) => f.type === "subscribed", "subscribed");
		const res = await http.post<{ error: { code: string } }>(`/sessions/${session.id}/prompt`, { message: "__noack__", clientId: "doomed" });
		expect(res.status).toBe(504);
		expect(res.body.error.code).toBe("runtime_timeout");
		const types = sessionEvents(client, session.id)
			.filter((e) => e.type !== "state")
			.map((e) => e.type);
		expect(types).toEqual(["message_start", "message_end", "message_removed", "prompt_result"]);
		expect(sessionEvents(client, session.id).find((e) => e.type === "prompt_result")).toMatchObject({ clientId: "doomed", status: "error" });
		expect((await http.get<MessagesPage>(`/sessions/${session.id}/messages`)).body.total).toBe(0);
		// The same clientId can be retried after a failure.
		const retry = await http.post(`/sessions/${session.id}/prompt`, { message: "recovered", clientId: "doomed" });
		expect(retry.status).toBe(202);
	});
});
