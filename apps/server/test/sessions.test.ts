import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession, MeshUsage, MessagesPage, Project, RuntimeStatus, SessionLiveState, Workspace } from "@clam/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api, connectWs, createFullHarness, type FullHarness, type WsClient } from "./full-harness.ts";

let full: FullHarness;
let http: ReturnType<typeof api>;
let project: Project;
const sockets: WsClient[] = [];

beforeEach(async () => {
	full = await createFullHarness();
	http = api(full);
	const workspace = (await http.post<Workspace>("/workspaces", { name: "W" })).body;
	project = (await http.post<Project>("/projects", { workspaceId: workspace.id, name: "P", path: full.projectDir })).body;
});

afterEach(async () => {
	for (const ws of sockets.splice(0)) ws.close();
	await full.cleanup();
});

async function createSession(extra: Record<string, unknown> = {}): Promise<AgentSession> {
	const res = await http.post<AgentSession>("/sessions", { projectId: project.id, ...extra });
	expect(res.status).toBe(201);
	return res.body;
}

async function subscribe(...topics: string[]): Promise<WsClient> {
	const ws = await connectWs(full);
	sockets.push(ws);
	ws.send({ type: "subscribe", topics });
	await ws.waitFor((f) => f.type === "subscribed", "subscribed");
	return ws;
}

function sessionEvents(ws: WsClient, sessionId: string) {
	return ws.frames.filter((f) => f.type === "event" && f.topic === `session:${sessionId}`).map((f) => f.event as { type: string; [k: string]: any });
}

function fakeCommands(type: string): Array<Record<string, any>> {
	if (!existsSync(full.fakeLog)) return [];
	return readFileSync(full.fakeLog, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { kind: string; frame?: Record<string, any> })
		.filter((r) => r.kind === "command" && r.frame?.type === type)
		.map((r) => r.frame as Record<string, any>);
}

describe("sessions", () => {
	it("creates, lists, renames, archives and deletes sessions with bus notifications", async () => {
		const ws = await subscribe("sessions");
		const session = await createSession({ title: "First" });
		expect(session).toMatchObject({ title: "First", status: "stopped", archived: false, model: null, runtimeSessionId: null });
		await ws.waitFor((f) => f.topic === "sessions" && f.event.type === "upsert" && f.event.session.id === session.id, "upsert");

		expect((await http.get<AgentSession[]>(`/sessions?projectId=${project.id}`)).body.map((s) => s.id)).toEqual([session.id]);
		expect((await http.get<AgentSession[]>("/sessions?archived=true")).body).toEqual([]);
		expect((await http.get<AgentSession>(`/sessions/${session.id}`)).body.title).toBe("First");

		const renamed = await http.patch<AgentSession>(`/sessions/${session.id}`, { title: "Renamed" });
		expect(renamed.body.title).toBe("Renamed");
		const archived = await http.patch<AgentSession>(`/sessions/${session.id}`, { archived: true });
		expect(archived.body.archived).toBe(true);
		expect((await http.get<AgentSession[]>("/sessions")).body).toEqual([]);
		expect((await http.get<AgentSession[]>("/sessions?archived=true")).body).toHaveLength(1);

		expect((await http.del(`/sessions/${session.id}`)).status).toBe(204);
		await ws.waitFor((f) => f.topic === "sessions" && f.event.type === "remove" && f.event.sessionId === session.id, "remove");
		expect((await http.get(`/sessions/${session.id}`)).status).toBe(404);
	});

	it("validates input and reports unknown ids as 404 in the error envelope", async () => {
		expect((await http.post("/sessions", { projectId: "" })).status).toBe(400);
		const missingProject = await http.post<{ error: { code: string } }>("/sessions", { projectId: "prj_nope" });
		expect(missingProject.status).toBe(404);
		expect(missingProject.body.error.code).toBe("not_found");
		expect((await http.get("/sessions/ses_nope/messages")).status).toBe(404);
		expect((await http.post("/sessions/ses_nope/prompt", { message: "x", clientId: "c" })).status).toBe(404);
		const session = await createSession();
		expect((await http.post(`/sessions/${session.id}/prompt`, { message: "", clientId: "c" })).status).toBe(400);
		expect((await http.get(`/sessions/${session.id}/messages?limit=0`)).status).toBe(400);
	});

	it("runs a prompt end to end: streamed events, clientId correlation, transcript, stats and mesh usage", async () => {
		const session = await createSession();
		const ws = await subscribe(`session:${session.id}`, "runtime", "sessions");

		const accepted = await http.post<{ promptId: string; clientId: string }>(`/sessions/${session.id}/prompt`, { message: "Reply with exactly: OK", clientId: "cid-1" });
		expect(accepted.status).toBe(202);
		expect(accepted.body.clientId).toBe("cid-1");

		await ws.waitFor((f) => f.topic === `session:${session.id}` && f.event.type === "settled", "settled");
		const events = sessionEvents(ws, session.id);
		const types = events.map((e) => e.type);
		expect(types).toEqual(expect.arrayContaining(["agent_start", "message_start", "message_delta", "message_end", "agent_end", "prompt_result", "settled"]));
		expect(events.find((e) => e.type === "prompt_result")).toMatchObject({ promptId: accepted.body.promptId, clientId: "cid-1", status: "completed" });
		expect(events.find((e) => e.type === "message_start" && e.message.role === "user")?.message.clientId).toBe("cid-1");
		const seqs = ws.frames.filter((f) => f.topic === `session:${session.id}`).map((f) => f.seq as number);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
		expect(new Set(seqs).size).toBe(seqs.length);
		expect(ws.frames.some((f) => f.topic === "runtime" && f.event.status.state === "busy")).toBe(true);

		const page = (await http.get<MessagesPage>(`/sessions/${session.id}/messages`)).body;
		expect(page.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(page.messages[1]?.content).toEqual([{ type: "text", text: "FAKE: Reply with exactly: OK" }]);
		expect(page.total).toBe(2);

		// Title comes from the first prompt; binding and stats are persisted after the run settles.
		await ws.waitFor((f) => f.topic === "sessions" && f.event.type === "upsert" && f.event.session.stats !== null, "stats persisted");
		const stored = (await http.get<AgentSession>(`/sessions/${session.id}`)).body;
		expect(stored.title).toBe("Reply with exactly: OK");
		expect(stored.runtimeSessionId).toBeTruthy();
		expect(stored.runtimeSessionFile).toBeTruthy();
		expect(stored.stats).toMatchObject({ userMessages: 1, assistantMessages: 1 });
		expect(stored.stats?.tokens.total).toBeGreaterThan(0);

		const mesh = (await http.get<MeshUsage>("/usage/mesh")).body;
		expect(mesh.byProject).toHaveLength(1);
		expect(mesh.byProject[0]).toMatchObject({ key: project.id, label: "P", sessions: 1, source: "omp-recorded" });
		expect(mesh.byProject[0]?.tokens.total).toBe(stored.stats?.tokens.total);
		expect(mesh.byAgent[0]).toMatchObject({ label: "OMP Agent", sessions: 1 });
	});

	it("is idempotent per clientId: a retried prompt is sent once and returns the same promptId", async () => {
		const session = await createSession();
		const ws = await subscribe(`session:${session.id}`);
		const body = { message: "once only", clientId: "dup-1" };
		const [a, b] = await Promise.all([http.post<{ promptId: string }>(`/sessions/${session.id}/prompt`, body), http.post<{ promptId: string }>(`/sessions/${session.id}/prompt`, body)]);
		expect(a.body.promptId).toBe(b.body.promptId);
		await ws.waitFor((f) => f.event?.type === "settled", "settled");
		const again = await http.post<{ promptId: string }>(`/sessions/${session.id}/prompt`, body);
		expect(again.body.promptId).toBe(a.body.promptId);
		expect(fakeCommands("prompt")).toHaveLength(1);
		expect((await http.get<MessagesPage>(`/sessions/${session.id}/messages`)).body.messages.filter((m) => m.role === "user")).toHaveLength(1);
	});

	it("persists usage once per settled run and never double counts across runs", async () => {
		const session = await createSession();
		const ws = await subscribe(`session:${session.id}`);
		for (const n of [1, 2]) {
			await http.post(`/sessions/${session.id}/prompt`, { message: `turn ${n}`, clientId: `u${n}` });
			await ws.waitFor((f) => f.event?.type === "settled" && sessionEvents(ws, session.id).filter((e) => e.type === "settled").length === n, `settled ${n}`);
		}
		await full.ctx.runtime.get(session.id)?.getStats();
		const deadline = Date.now() + 5000;
		let total = 0;
		for (;;) {
			const mesh = (await http.get<MeshUsage>("/usage/mesh")).body;
			const stats = (await http.get<AgentSession>(`/sessions/${session.id}`)).body.stats;
			total = mesh.byProject[0]?.tokens.total ?? 0;
			if (stats && total === stats.tokens.total && stats.assistantMessages === 2) break;
			if (Date.now() > deadline) throw new Error(`usage never converged: mesh ${total} vs stats ${JSON.stringify(stats)}`);
			await new Promise((r) => setTimeout(r, 50));
		}
		const rows = full.ctx.db.$client.prepare("select provider, model, source from provider_usage").all() as Array<{ provider: string; model: string; source: string }>;
		expect(rows.length).toBeGreaterThanOrEqual(2);
		expect(rows.every((r) => r.source === "omp-recorded" && r.provider === "fake")).toBe(true);
	});

	it("keeps usage history when the project is deleted", async () => {
		const session = await createSession();
		const ws = await subscribe(`session:${session.id}`);
		await http.post(`/sessions/${session.id}/prompt`, { message: "spend", clientId: "s1" });
		await ws.waitFor((f) => f.event?.type === "settled", "settled");
		await full.app.ready();
		const deadline = Date.now() + 5000;
		while ((await http.get<MeshUsage>("/usage/mesh")).body.byProject.length === 0) {
			if (Date.now() > deadline) throw new Error("usage never recorded");
			await new Promise((r) => setTimeout(r, 50));
		}
		expect((await http.del(`/projects/${project.id}`)).status).toBe(204);
		const mesh = (await http.get<MeshUsage>("/usage/mesh")).body;
		expect(mesh.byProject).toHaveLength(1);
		expect(mesh.byProject[0]).toMatchObject({ key: "deleted", label: "Deleted project", sessions: 0 });
		expect(mesh.byProject[0]?.tokens.total).toBeGreaterThan(0);
	});

	it("pages messages newest first and serves state, model and thinking changes", async () => {
		const session = await createSession();
		const ws = await subscribe(`session:${session.id}`);
		for (let i = 0; i < 3; i++) {
			await http.post(`/sessions/${session.id}/prompt`, { message: `t${i}`, clientId: `p${i}` });
			await ws.waitFor(() => sessionEvents(ws, session.id).filter((e) => e.type === "settled").length === i + 1, `settled ${i}`);
		}
		const first = (await http.get<MessagesPage>(`/sessions/${session.id}/messages?limit=4`)).body;
		expect(first.messages).toHaveLength(4);
		expect(first.messages.at(-1)?.content).toEqual([{ type: "text", text: "FAKE: t2" }]);
		const older = (await http.get<MessagesPage>(`/sessions/${session.id}/messages?limit=4&cursor=${encodeURIComponent(first.nextCursor ?? "")}`)).body;
		expect(older.messages).toHaveLength(2);
		expect(older.nextCursor).toBeNull();

		const state = (await http.get<SessionLiveState>(`/sessions/${session.id}/state`)).body;
		expect(state).toMatchObject({ sessionId: session.id, isStreaming: false, isSettled: true, model: { provider: "fake", id: "alpha" } });
		expect(state.availableThinkingLevels.length).toBeGreaterThan(0);

		const switched = await http.post<SessionLiveState>(`/sessions/${session.id}/model`, { selector: "fake/beta" });
		expect(switched.body.model?.id).toBe("beta");
		expect((await http.get<AgentSession>(`/sessions/${session.id}`)).body.model).toBe("fake/beta");
		const bad = await http.post<{ error: { code: string } }>(`/sessions/${session.id}/model`, { selector: "fake/missing" });
		expect(bad.status).toBe(409);
		expect(bad.body.error.code).toBe("runtime_rejected");
		const thinking = await http.post<SessionLiveState>(`/sessions/${session.id}/thinking`, { level: "low" });
		expect(thinking.body.thinkingLevel).toBe("low");
		expect((await http.post(`/sessions/${session.id}/model`, { selector: "" })).status).toBe(400);
	});

	it("aborts a running prompt", async () => {
		const session = await createSession();
		const ws = await subscribe(`session:${session.id}`);
		await http.post(`/sessions/${session.id}/prompt`, { message: "__slow__", clientId: "slow" });
		await ws.waitFor((f) => f.event?.type === "message_delta", "streaming");
		expect((await http.post(`/sessions/${session.id}/abort`)).status).toBe(204);
		await ws.waitFor((f) => f.event?.type === "settled", "settled");
		expect(sessionEvents(ws, session.id).find((e) => e.type === "prompt_result")).toMatchObject({ clientId: "slow", status: "aborted" });
		const idle = await createSession();
		expect((await http.post(`/sessions/${idle.id}/abort`)).status).toBe(204); // nothing running: no-op, no process started
		expect(full.ctx.runtime.get(idle.id)).toBeUndefined();
	});

	it("sends the optional first prompt of a new session once the runtime is ready", async () => {
		const ws = await subscribe("sessions");
		const session = await createSession({ prompt: "hello from create" });
		await ws.waitFor((f) => f.topic === "sessions" && f.event.type === "upsert" && f.event.session.id === session.id && f.event.session.stats !== null, "first run recorded");
		const page = (await http.get<MessagesPage>(`/sessions/${session.id}/messages`)).body;
		expect(page.messages[0]?.content).toEqual([{ type: "text", text: "hello from create" }]);
		expect(page.messages).toHaveLength(2);
	});

	it("exposes runtime status and stop/restart, resuming the same conversation", async () => {
		const session = await createSession();
		expect((await http.get<RuntimeStatus[]>("/runtime")).body).toEqual([]);
		const ws = await subscribe(`session:${session.id}`, "runtime");
		await http.post(`/sessions/${session.id}/prompt`, { message: "remember", clientId: "r1" });
		await ws.waitFor((f) => f.event?.type === "settled", "settled");
		const [status] = (await http.get<RuntimeStatus[]>("/runtime")).body;
		expect(status).toMatchObject({ sessionId: session.id, restarts: 0, lastError: null });
		expect(["ready", "busy"]).toContain(status?.state);
		const runtimeSessionId = (await http.get<AgentSession>(`/sessions/${session.id}`)).body.runtimeSessionId;

		expect((await http.post(`/runtime/${session.id}/stop`)).status).toBe(204);
		expect((await http.get<RuntimeStatus[]>("/runtime")).body).toEqual([]);
		expect((await http.get<AgentSession>(`/sessions/${session.id}`)).body.status).toBe("stopped");
		expect((await http.post(`/runtime/ses_nope/stop`)).status).toBe(404);

		// Restarting a stopped runtime opens it again on the same OMP conversation.
		const restarted = await http.post<RuntimeStatus>(`/runtime/${session.id}/restart`);
		expect(restarted.body.state).toBe("ready");
		const resumed = (await http.get<AgentSession>(`/sessions/${session.id}`)).body;
		expect(resumed.runtimeSessionId).toBe(runtimeSessionId);
		expect((await http.get<MessagesPage>(`/sessions/${session.id}/messages`)).body.messages).toHaveLength(2);
		const again = await http.post<RuntimeStatus>(`/runtime/${session.id}/restart`);
		expect(again.body).toMatchObject({ state: "ready", restarts: 1 });
	});

	it("survives a runtime crash: crashed -> restarting -> ready on the runtime topic, session still usable", async () => {
		const session = await createSession();
		const ws = await subscribe(`session:${session.id}`, "runtime");
		await http.post(`/sessions/${session.id}/prompt`, { message: "first", clientId: "k1" });
		await ws.waitFor((f) => f.event?.type === "settled", "settled");
		const pid = full.ctx.runtime.get(session.id)?.status().pid;
		expect(pid).toBeTruthy();
		process.kill(pid as number, "SIGKILL");
		const states = () => ws.frames.filter((f) => f.topic === "runtime").map((f) => f.event.status.state as string);
		await ws.waitFor(() => states().lastIndexOf("ready") > states().indexOf("crashed") && states().includes("crashed"), "crashed then ready");
		expect(states()).toContain("restarting");

		await http.post(`/sessions/${session.id}/prompt`, { message: "second", clientId: "k2" });
		await ws.waitFor(() => sessionEvents(ws, session.id).filter((e) => e.type === "settled").length === 2, "second run settled");
		const page = (await http.get<MessagesPage>(`/sessions/${session.id}/messages`)).body;
		expect(page.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
		expect(full.ctx.db.$client.prepare("select count(*) as n from node_events where type = 'runtime.crashed'").get()).toEqual({ n: 1 });
	});

	it("answers approvals through ui-response when the approval mode keeps the UI", async () => {
		expect((await http.patch("/settings", { approvalMode: "always-ask" })).status).toBe(200);
		const session = await createSession();
		const ws = await subscribe(`session:${session.id}`);
		await http.post(`/sessions/${session.id}/prompt`, { message: "__approve__", clientId: "a1" });
		const request = await ws.waitFor((f) => f.event?.type === "ui_request", "ui_request");
		expect(request.event).toMatchObject({ method: "select", options: expect.arrayContaining(["Approve", "Deny"]) });
		expect((await http.get<unknown[]>(`/sessions/${session.id}/ui-requests`)).body).toHaveLength(1);
		const bad = await http.post(`/sessions/${session.id}/ui-response`, { requestId: request.event.requestId, value: "Maybe" });
		expect(bad.status).toBe(400);
		expect((await http.post(`/sessions/${session.id}/ui-response`, { requestId: request.event.requestId, value: "Approve" })).status).toBe(204);
		await ws.waitFor((f) => f.event?.type === "settled", "settled");
		expect(sessionEvents(ws, session.id).map((e) => e.type)).toContain("ui_request_resolved");
		expect((await http.post(`/sessions/${session.id}/ui-response`, { requestId: "ghost", value: "Approve" })).status).toBe(409);
		const args = readFileSync(full.fakeLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.kind === "spawn");
		expect(args.argv).not.toContain("--no-ui");
		expect(args.argv).toEqual(expect.arrayContaining(["--approval-mode", "always-ask"]));
	});

	it("removes the session directory on delete but never anything outside the data dir", async () => {
		const session = await createSession();
		const ws = await subscribe(`session:${session.id}`);
		await http.post(`/sessions/${session.id}/prompt`, { message: "hi", clientId: "d1" });
		await ws.waitFor((f) => f.event?.type === "settled", "settled");
		const dir = join(full.dataDir, "sessions", session.id);
		expect(existsSync(dir)).toBe(true);
		expect((await http.del(`/sessions/${session.id}`)).status).toBe(204);
		expect(existsSync(dir)).toBe(false);
		expect(full.ctx.runtime.get(session.id)).toBeUndefined();
		expect(existsSync(full.projectDir)).toBe(true);
	});
});
