import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, MessagesPage, Project } from "@clam/contracts";
import { MESH_HOST_TOOLS } from "@clam/contracts";
import { SHARED_HOST_TOOLS } from "@clam/task-engine";
import type { HostToolResult } from "@clam/agent-runtime";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api, createFullHarness, createMemorySecrets, type FullHarness } from "./full-harness.ts";
import { eventually, FAST, pair, startNode, type Paired } from "./net-helpers.ts";
import type { TaskTimings } from "../src/tasks/hub.ts";
import { newMessageId, type TaskInsert, type TaskMessageInsert, type TaskMessageRow, type TaskRow } from "../src/tasks/store.ts";

const REPO = { owner: "octo", name: "r", externalId: "1", htmlUrl: "https://github.com/octo/r", defaultBranch: "main", accountId: null };

let taskCounter = 0;
const nextTaskId = () => `tsk_TEST${String(++taskCounter).padStart(6, "0")}`;

async function createProject(h: FullHarness, workspaceId: string): Promise<Project> {
	const http = api(h);
	const project = (await http.post<Project>("/projects", { workspaceId, name: "P", path: h.projectDir })).body;
	const patched = await http.patch<Project>(`/projects/${project.id}`, { repository: REPO });
	if (patched.status !== 200) throw new Error(`linking the project failed: ${JSON.stringify(patched.body)}`);
	return patched.body;
}

async function createSession(h: FullHarness, projectId: string): Promise<string> {
	const created = await api(h).post<AgentSession>("/sessions", { projectId });
	if (created.status !== 201) throw new Error(`session creation failed: ${JSON.stringify(created.body)}`);
	return created.body.id;
}

/** A task row as a node would hold it; `outgoing` tasks default to this node as the sender. */
function insertTask(h: FullHarness, peerId: string, values: Partial<TaskInsert> = {}): TaskRow {
	const self = h.ctx.identity.nodeId;
	const outgoing = (values.direction ?? "outgoing") === "outgoing";
	return h.ctx.tasks.store.insert({
		id: nextTaskId(),
		direction: "outgoing",
		peerId,
		workspaceId: "ws_test",
		title: "Fix the flaky test",
		description: "details",
		status: "running",
		repoUrl: "https://github.com/octo/r",
		senderNodeId: outgoing ? self : peerId,
		senderNodeName: outgoing ? "Alpha" : "Beta",
		executorNodeId: outgoing ? peerId : self,
		executorNodeName: outgoing ? "Beta" : "Alpha",
		correlationId: "corr_test",
		...values,
	});
}

/** A message written by the other node's agent (what `receiveMessage` stores). */
function insertPeerMessage(h: FullHarness, task: TaskRow, text: string, extra: Partial<TaskMessageInsert> = {}): TaskMessageRow {
	return h.ctx.tasks.store.insertMessage({
		id: newMessageId(),
		taskId: task.id,
		authorKind: "agent",
		authorNodeId: task.peerId,
		authorNodeName: "Beta",
		authorAgentId: "ag_peer",
		authorAgentName: "Reviewer",
		kind: "note",
		text,
		createdAt: new Date().toISOString(),
		delivery: "local",
		...extra,
	}).row;
}

interface PromptFrame {
	message: string;
	streamingBehavior?: string;
}

/** Mesh prompts the fake omp received, in arrival order. */
function meshPrompts(h: FullHarness): PromptFrame[] {
	if (!existsSync(h.fakeLog)) return [];
	return readFileSync(h.fakeLog, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { kind: string; frame?: { type?: string } & PromptFrame })
		.filter((r) => r.kind === "command" && r.frame?.type === "prompt" && String(r.frame.message).startsWith("[CL Agent Mesh]"))
		.map((r) => r.frame as PromptFrame);
}

const message = (h: FullHarness, id: string) => h.ctx.tasks.store.message(id) as TaskMessageRow;

describe("TaskInjector", () => {
	let h: FullHarness | undefined;
	afterEach(async () => {
		vi.restoreAllMocks();
		await h?.cleanup();
		h = undefined;
	});

	async function setup(options: { taskTimings?: Partial<TaskTimings> } = {}) {
		h = await createFullHarness({ network: { nodeName: "Alpha", options: FAST }, taskTimings: options.taskTimings });
		const workspace = (await api(h).post<{ id: string }>("/workspaces", { name: "W" })).body;
		const project = await createProject(h, workspace.id);
		return { h, project };
	}

	it("wakes an idle session with a plain prompt and marks the message injected once", async () => {
		const { h, project } = await setup();
		const session = await createSession(h, project.id);
		const task = insertTask(h, "peer_b", { senderSessionId: session });
		const m = insertPeerMessage(h, task, "Which branch should I use?", { kind: "question" });

		expect(await h.ctx.tasks.injector.injectMessage(task, m)).toBe(true);
		expect(message(h, m.id).injectedSessionId).toBe(session);
		// Already injected: true again, nothing is sent twice (also not by the boot-time sweep).
		expect(await h.ctx.tasks.injector.injectMessage(task, message(h, m.id))).toBe(true);
		await h.ctx.tasks.injector.retryPending();

		const prompts = meshPrompts(h);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]?.message).toContain("Which branch");
		expect(prompts[0]?.streamingBehavior).toBeUndefined();
		expect(prompts[0]?.message).toContain(`[CL Agent Mesh] task ${task.id} · "Fix the flaky test" · from Reviewer@Beta · kind question`);
		expect(prompts[0]?.message).toContain("Which branch should I use?");
		expect(prompts[0]?.message).toContain("Answer or instruct with mesh_message");
	});

	it("injects into the executing session of an incoming task with the executor reminder", async () => {
		const { h, project } = await setup();
		const session = await createSession(h, project.id);
		const task = insertTask(h, "peer_b", { direction: "incoming", executorSessionId: session });
		const m = insertPeerMessage(h, task, "Also bump the changelog", { authorAgentName: "Planner", kind: "instruction" });
		expect(await h.ctx.tasks.injector.injectMessage(task, m)).toBe(true);
		const [prompt] = meshPrompts(h);
		expect(prompt?.message).toContain("from Planner@Beta · kind instruction");
		expect(prompt?.message).toContain(`Reply with mesh_message (taskId ${task.id}); finish with mesh_complete when done.`);
	});

	it("steers instructions and queues other kinds as follow-ups while the session is busy", async () => {
		const { h, project } = await setup();
		const session = await createSession(h, project.id);
		await api(h).post(`/sessions/${session}/prompt`, { message: "start\n@@fake-sh sleep 3", clientId: "busy-1" });
		await eventually(() => h.ctx.runtime.get(session)?.status().state === "busy", "the session to be busy");
		const task = insertTask(h, "peer_b", { senderSessionId: session });
		const instruction = insertPeerMessage(h, task, "change of plan", { kind: "instruction" });
		const note = insertPeerMessage(h, task, "fyi", { kind: "note", createdAt: new Date(Date.now() + 1000).toISOString() });

		expect(await h.ctx.tasks.injector.injectMessage(task, instruction)).toBe(true);
		expect(await h.ctx.tasks.injector.injectMessage(task, note)).toBe(true);
		const behavior = (text: string) => meshPrompts(h).find((p) => p.message.includes(text))?.streamingBehavior;
		expect(behavior("change of plan")).toBe("steer");
		expect(behavior("fyi")).toBe("followUp");
	});

	it("keeps messages for one session in the order they were handed over, even when an earlier one is slow", async () => {
		const { h, project } = await setup();
		const session = await createSession(h, project.id);
		const task = insertTask(h, "peer_b", { senderSessionId: session });
		const original = h.ctx.sessions.prompt.bind(h.ctx.sessions);
		const gate = Promise.withResolvers<void>();
		let calls = 0;
		vi.spyOn(h.ctx.sessions, "prompt").mockImplementation(async (id, input) => {
			if (++calls === 1) await gate.promise;
			return original(id, input);
		});
		const stamp = Date.now();
		const rows = ["first", "second", "third"].map((text, i) => insertPeerMessage(h, task, text, { createdAt: new Date(stamp + i).toISOString() }));
		const pending = rows.map((m) => h.ctx.tasks.injector.injectMessage(task, m));
		gate.resolve(); // the slow first injection ends only after all three were handed over
		const results = await Promise.all(pending);
		expect(results).toEqual([true, true, true]);
		const texts = meshPrompts(h).map((p) => ["first", "second", "third"].find((t) => p.message.includes(`\n\n${t}\n\n`)));
		expect(texts).toEqual(["first", "second", "third"]);
	});

	it("does not let one failing injection block the session's chain", async () => {
		const { h, project } = await setup({});
		const session = await createSession(h, project.id);
		const task = insertTask(h, "peer_b", { senderSessionId: session });
		const original = h.ctx.sessions.prompt.bind(h.ctx.sessions);
		let calls = 0;
		vi.spyOn(h.ctx.sessions, "prompt").mockImplementation(async (id, input) => {
			if (++calls === 1) throw new Error("runtime did not start");
			return original(id, input);
		});
		const stamp = Date.now();
		const a = insertPeerMessage(h, task, "alpha", { createdAt: new Date(stamp).toISOString() });
		const b = insertPeerMessage(h, task, "beta", { createdAt: new Date(stamp + 1).toISOString() });
		const [first, second] = await Promise.all([h.ctx.tasks.injector.injectMessage(task, a), h.ctx.tasks.injector.injectMessage(task, b)]);
		expect(first).toBe(false);
		expect(second).toBe(true);
		expect(message(h, a.id).injectedSessionId).toBeNull();
		// The failed one is retried on its own (injectRetryMs is 100 ms in the harness).
		await eventually(() => message(h, a.id).injectedSessionId === session, "the retry to inject the first message");
		expect(meshPrompts(h).filter((p) => p.message.includes("alpha"))).toHaveLength(1);
	});

	it("gives up on a message after injectRetries retries until the next retryPending", async () => {
		const { h, project } = await setup({ taskTimings: { injectRetryMs: 30, injectRetries: 2 } });
		const session = await createSession(h, project.id);
		const task = insertTask(h, "peer_b", { senderSessionId: session });
		const m = insertPeerMessage(h, task, "stubborn");
		const original = h.ctx.sessions.prompt.bind(h.ctx.sessions);
		let failing = true;
		const spy = vi.spyOn(h.ctx.sessions, "prompt").mockImplementation(async (id, input) => {
			if (failing) throw new Error("session unavailable");
			return original(id, input);
		});
		expect(await h.ctx.tasks.injector.injectMessage(task, m)).toBe(false);
		await eventually(() => spy.mock.calls.length >= 3, "both retries");
		// The absence of a further retry cannot be awaited as an event; this is a bounded real wait (the timers are the code under test).
		const { promise: pause, resolve: resume } = Promise.withResolvers<void>();
		setTimeout(resume, 250);
		await pause;
		expect(spy.mock.calls).toHaveLength(3);
		expect(message(h, m.id).injectedSessionId).toBeNull();

		failing = false;
		await h.ctx.tasks.injector.retryPending();
		expect(message(h, m.id).injectedSessionId).toBe(session);
	});

	it("never injects into finished tasks, missing sessions or messages written by this node's own agent", async () => {
		const { h, project } = await setup();
		const session = await createSession(h, project.id);
		const self = h.ctx.identity.nodeId;

		// Already notified, so the boot-time sweep below has no status note to send for it.
		const finished = insertTask(h, "peer_b", { senderSessionId: session, status: "succeeded", notifiedStatus: "succeeded" });
		const late = insertPeerMessage(h, finished, "too late");
		expect(await h.ctx.tasks.injector.injectMessage(finished, late)).toBe(false);

		const orphan = insertTask(h, "peer_b", { senderSessionId: "ses_gone" });
		expect(await h.ctx.tasks.injector.injectMessage(orphan, insertPeerMessage(h, orphan, "nobody home"))).toBe(false);

		const noSession = insertTask(h, "peer_b", { senderSessionId: null });
		expect(await h.ctx.tasks.injector.injectMessage(noSession, insertPeerMessage(h, noSession, "no session"))).toBe(false);

		const active = insertTask(h, "peer_b", { senderSessionId: session });
		const own = insertPeerMessage(h, active, "I said this myself", { authorNodeId: self, authorNodeName: "Alpha", authorAgentName: "OMP Agent" });
		expect(await h.ctx.tasks.injector.injectMessage(active, own)).toBe(false);
		expect(message(h, own.id).injectedSessionId).toBeNull();
		// A human on this node writing in the thread is injected (it is the only own-node author that is).
		const human = insertPeerMessage(h, active, "please hurry", { authorKind: "human", authorNodeId: self, authorNodeName: "Alpha", authorAgentId: null, authorAgentName: null });
		expect(await h.ctx.tasks.injector.injectMessage(active, human)).toBe(true);

		await h.ctx.tasks.injector.retryPending();
		const texts = meshPrompts(h).map((p) => p.message);
		expect(texts).toHaveLength(1);
		expect(texts[0]).toContain("please hurry");
	});

	it("tells the delegating session once per finished status, including the result details", async () => {
		const { h, project } = await setup();
		const session = await createSession(h, project.id);
		const task = insertTask(h, "peer_b", { senderSessionId: session });
		expect(await h.ctx.tasks.injector.injectStatusNote(h.ctx.tasks.store.get(task.id))).toBe(false); // still running

		const done = h.ctx.tasks.store.update(task.id, {
			status: "succeeded",
			result: { summary: "All green now", autoCompleted: false, branch: "clam/beta/fix-abc123", commit: "0123456789abcdef", pushed: true, compareUrl: "https://github.com/octo/r/compare/main...x", artifacts: [] },
		});
		expect(await h.ctx.tasks.injector.injectStatusNote(done)).toBe(true);
		expect(h.ctx.tasks.store.get(task.id).notifiedStatus).toBe("succeeded");
		expect(await h.ctx.tasks.injector.injectStatusNote(h.ctx.tasks.store.get(task.id))).toBe(false);
		await h.ctx.tasks.injector.retryPending();

		const prompts = meshPrompts(h);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]?.streamingBehavior).toBeUndefined();
		expect(prompts[0]?.message).toContain(`task ${task.id} · "Fix the flaky test" · status succeeded`);
		expect(prompts[0]?.message).toContain("summary: All green now");
		expect(prompts[0]?.message).toContain("branch: clam/beta/fix-abc123 @ 0123456789ab (pushed)");
	});

	it("only notes outgoing tasks with a live delegating session; a failed note is retried", async () => {
		const { h, project } = await setup();
		const session = await createSession(h, project.id);
		const incoming = insertTask(h, "peer_b", { direction: "incoming", executorSessionId: session, status: "failed" });
		expect(await h.ctx.tasks.injector.injectStatusNote(incoming)).toBe(false);
		const goneSession = insertTask(h, "peer_b", { senderSessionId: "ses_gone", status: "failed" });
		expect(await h.ctx.tasks.injector.injectStatusNote(goneSession)).toBe(false);
		expect(h.ctx.tasks.store.get(goneSession.id).notifiedStatus).toBeNull();

		const original = h.ctx.sessions.prompt.bind(h.ctx.sessions);
		let calls = 0;
		vi.spyOn(h.ctx.sessions, "prompt").mockImplementation(async (id, input) => {
			if (++calls === 1) throw new Error("runtime did not start");
			return original(id, input);
		});
		const rejected = insertTask(h, "peer_b", { senderSessionId: session, status: "rejected", reason: "no matching project" });
		expect(await h.ctx.tasks.injector.injectStatusNote(rejected)).toBe(false);
		await eventually(() => h.ctx.tasks.store.get(rejected.id).notifiedStatus === "rejected", "the note retry");
		const [note] = meshPrompts(h);
		expect(note?.message).toContain("status rejected");
		expect(note?.message).toContain("reason: no matching project");
	});

	it("after a restart injects only what was not injected before (nothing twice)", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "clam-inject-"));
		const secrets = createMemorySecrets();
		const first = await startNode("Alpha", { dataDir, secrets });
		const workspace = (await api(first).post<{ id: string }>("/workspaces", { name: "W" })).body;
		const project = await createProject(first, workspace.id);
		const session = await createSession(first, project.id);
		const task = insertTask(first, "peer_b", { senderSessionId: session, id: "tsk_RESTART0001" });
		const m1 = insertPeerMessage(first, task, "before restart");
		expect(await first.ctx.tasks.injector.injectMessage(task, m1)).toBe(true);
		// Written but never injected: the process "died" in between.
		const m2 = insertPeerMessage(first, task, "lost in the crash", { createdAt: new Date(Date.now() + 5).toISOString() });
		await first.cleanup({ keepData: true });

		h = await startNode("Alpha", { dataDir, secrets });
		await eventually(() => message(h as FullHarness, m2.id).injectedSessionId === session, "boot-time re-injection of the lost message");
		expect(message(h, m1.id).injectedSessionId).toBe(session);
		await h.ctx.tasks.injector.retryPending();
		const texts = meshPrompts(h).map((p) => p.message);
		expect(texts).toHaveLength(2);
		expect(texts.filter((t) => t.includes("before restart"))).toHaveLength(1);
		expect(texts.filter((t) => t.includes("lost in the crash"))).toHaveLength(1);
	});
});

describe("MeshHostTools", () => {
	let a: FullHarness;
	let b: FullHarness;
	let paired: Paired;
	let project: Project;
	let session: string;
	let other: string;
	let lone: string;

	beforeAll(async () => {
		a = await startNode("Alpha");
		b = await startNode("Beta");
		paired = await pair(a, b);
		project = await createProject(a, paired.workspace.id);
		session = await createSession(a, project.id);
		other = await createSession(a, project.id);
		lone = await createSession(a, project.id);
	});
	afterAll(async () => {
		await a?.cleanup();
		await b?.cleanup();
	});

	const run = (sessionId: string, toolName: string, args: unknown, host: FullHarness = a): Promise<HostToolResult> =>
		host.ctx.tasks.hostTools.execute({ sessionId, toolCallId: "call_1", toolName, arguments: args, signal: new AbortController().signal, update() {} });
	const bId = () => b.ctx.identity.nodeId;

	/** The assistant text of a session turn that ran `@@fake-tool` directives, read once the run has settled (the transcript also serves the message still streaming). */
	async function fakeToolOutput(h: FullHarness, sessionId: string, marker: string): Promise<string> {
		let seen = "";
		return eventually(async () => {
			const state = (await api(h).get<{ isStreaming: boolean; isSettled: boolean }>(`/sessions/${sessionId}/state`)).body;
			if (state.isStreaming || !state.isSettled) return undefined;
			const page = (await api(h).get<MessagesPage>(`/sessions/${sessionId}/messages`)).body;
			const text = page.messages
				.filter((m) => m.role === "assistant")
				.flatMap((m) => m.content.flatMap((c) => (c.type === "text" ? [c.text] : [])))
				.join("\n");
			seen = JSON.stringify(page.messages.map((m) => [m.role, m.content]));
			return text.includes(marker) ? text : undefined;
		}, `fake omp output ${marker}; transcript: ${seen}`, 15_000).catch((error: unknown) => {
			throw new Error(`${String(error)}; transcript: ${seen}`);
		});
	}

	it("registers exactly the five mesh tools for every session", () => {
		const names = (id: string) => a.ctx.tasks.hostTools.definitions(id).map((d) => d.name);
		expect(names(session)).toEqual([...MESH_HOST_TOOLS]);
		expect(names("ses_anything")).toEqual([...MESH_HOST_TOOLS]);
		for (const d of a.ctx.tasks.hostTools.definitions(session)) expect(d.parameters).toMatchObject({ type: "object" });
	});

	it("registers them in the agent process and answers mesh_agents through it", async () => {
		await api(a).post(`/sessions/${session}/prompt`, { message: "who is there?\n@@fake-tool mesh_agents {}", clientId: "agents-1" });
		const text = await fakeToolOutput(a, session, "FAKE_TOOL_RESULT mesh_agents:");
		expect(text).toContain("FAKE_TOOL_RESULT mesh_agents: This node: Alpha");
		expect(text).toContain("Beta");
		const registered = readFileSync(a.fakeLog, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as { kind: string; names?: string[] })
			.find((r) => r.kind === "host_tools");
		// the mesh tools of the task engine, then the shared-session tools (`mesh_team`, `mesh_say`)
		expect(registered?.names).toEqual([...MESH_HOST_TOOLS, ...SHARED_HOST_TOOLS]);
	});

	it("mesh_agents lists this node, each peer with delegation permission and its agents", async () => {
		const text = await eventually(async () => {
			const result = await run(session, "mesh_agents", {});
			expect(result.isError).toBeUndefined();
			return result.text.includes("acceptsTasks") ? result.text : undefined;
		}, "the peer's agents in the directory");
		expect(text).toContain(`This node: Alpha (${a.ctx.identity.nodeId})`);
		expect(text).toMatch(new RegExp(`Beta \\(${bId()}\\) — (online|degraded); tasks: you may delegate`));
		expect(text).toMatch(/- OMP Agent \(agt_[^)]+\).*, acceptsTasks: true/);
	});

	it("mesh_agents says so when nobody is paired", async () => {
		const solo = await startNode("Solo");
		try {
			const workspace = (await api(solo).post<{ id: string }>("/workspaces", { name: "W" })).body;
			const soloProject = await createProject(solo, workspace.id);
			const id = await createSession(solo, soloProject.id);
			const result = await run(id, "mesh_agents", {}, solo);
			expect(result.text).toContain("This node: Solo");
			expect(result.text).toContain("No peer nodes are paired");
			const delegated = await run(id, "mesh_delegate", { node: "Beta", title: "t", instructions: "i" }, solo);
			expect(delegated).toMatchObject({ isError: true });
			expect(delegated.text).toContain("no peer nodes are paired");
		} finally {
			await solo.cleanup();
		}
	});

	it("rejects bad arguments, unknown tools and unknown sessions as error results", async () => {
		expect(await run(session, "mesh_message", { taskId: "tsk_x" })).toMatchObject({ isError: true, text: expect.stringContaining("mesh_message: text") });
		expect(await run(session, "mesh_complete", { outcome: "great", summary: "s" })).toMatchObject({ isError: true, text: expect.stringContaining("outcome") });
		expect(await run(session, "mesh_nope", {})).toMatchObject({ isError: true, text: expect.stringContaining("unknown tool") });
		expect(await run("ses_unknown", "mesh_agents", {})).toMatchObject({ isError: true, text: expect.stringContaining("not known") });
		const aborted = new AbortController();
		aborted.abort();
		const result = await a.ctx.tasks.hostTools.execute({ sessionId: session, toolCallId: "c", toolName: "mesh_agents", arguments: {}, signal: aborted.signal, update() {} });
		expect(result.isError).toBe(true);
	});

	it("mesh_delegate creates an outgoing task bound to the calling session, driven through the agent", async () => {
		const args = JSON.stringify({ node: "beta", agent: "omp agent", title: "Port the parser", instructions: "Rewrite parser.ts in Rust.", deliverAs: "summary", maxCostUsd: 2 });
		await api(a).post(`/sessions/${other}/prompt`, { message: `delegate\n@@fake-tool mesh_delegate ${args}`, clientId: "delegate-1" });
		const text = await fakeToolOutput(a, other, "FAKE_TOOL_RESULT mesh_delegate:");
		const id = /task (tsk_[A-Za-z0-9]+) to OMP Agent@Beta/.exec(text)?.[1];
		expect(id, text).toBeTruthy();
		expect(text).toContain(`FAKE_TOOL_RESULT mesh_delegate: Delegated: task ${id} to OMP Agent@Beta`);
		expect(text).toContain(`start with "[CL Agent Mesh] task ${id}"`);
		expect(text).toContain("Use mesh_message (taskId)");

		const row = a.ctx.tasks.store.get(id as string);
		expect(row).toMatchObject({ direction: "outgoing", peerId: bId(), senderSessionId: other, title: "Port the parser", description: "Rewrite parser.ts in Rust.", deliverAs: "summary", projectId: project.id });
		expect(row.constraints).toEqual({ maxCostUsd: 2 });
		expect(row.executorAgentId).toBeTruthy();
	});

	it("mesh_delegate without an agent lets the executor choose; unknown nodes and agents list the candidates", async () => {
		const ok = await run(session, "mesh_delegate", { node: bId(), title: "Anything", instructions: "do it", deliverAs: "summary" });
		expect(ok.isError).toBeUndefined();
		expect(ok.text).toMatch(/^Delegated: task tsk_[A-Za-z0-9]+ to any agent@Beta/);
		const id = /task (tsk_[A-Za-z0-9]+)/.exec(ok.text)?.[1] as string;
		expect(a.ctx.tasks.store.get(id)).toMatchObject({ senderSessionId: session, executorAgentId: null });

		const noNode = await run(session, "mesh_delegate", { node: "Gamma", title: "t", instructions: "i" });
		expect(noNode.isError).toBe(true);
		expect(noNode.text).toContain('no paired node "Gamma"');
		expect(noNode.text).toContain(`Beta (${bId()})`);

		const noAgent = await run(session, "mesh_delegate", { node: "Beta", agent: "Nobody", title: "t", instructions: "i" });
		expect(noAgent.isError).toBe(true);
		expect(noAgent.text).toContain('no agent "Nobody" on Beta');
		expect(noAgent.text).toContain("OMP Agent (agt_");
		expect(a.ctx.tasks.store.list({ direction: "outgoing" }).filter((t) => t.title === "t")).toHaveLength(0);
	});

	describe("mesh_message, mesh_task and mesh_complete", () => {
		it("only the delegating (sender) or executing (executor) session of a task may use it", async () => {
			const outgoing = insertTask(a, bId(), { senderSessionId: session });
			const incoming = insertTask(a, bId(), { direction: "incoming", executorSessionId: other });

			expect(await run(other, "mesh_message", { taskId: outgoing.id, text: "hi" })).toMatchObject({ isError: true, text: `this session is not part of task ${outgoing.id}` });
			expect(await run(session, "mesh_task", { taskId: incoming.id })).toMatchObject({ isError: true, text: `this session is not part of task ${incoming.id}` });
			// A sender session is not the executing session of an incoming task, and vice versa.
			const swapped = insertTask(a, bId(), { senderSessionId: other, executorSessionId: session });
			expect(await run(session, "mesh_message", { taskId: swapped.id, text: "hi" })).toMatchObject({ isError: true });
			expect(await run(session, "mesh_message", { taskId: "tsk_missing", text: "hi" })).toMatchObject({ isError: true, text: "task tsk_missing not found" });

			const sent = await run(session, "mesh_message", { taskId: outgoing.id, text: "ready when you are", kind: "note" });
			expect(sent.isError).toBeUndefined();
			expect(sent.text).toMatch(/^Message sent to Beta \(id msg_[A-Z0-9]+, kind note\)\. You can send 11 more messages on this task before a human must continue\./);
			const stored = a.ctx.tasks.store.messages(outgoing.id);
			expect(stored).toHaveLength(1);
			expect(stored[0]).toMatchObject({ authorKind: "agent", authorAgentName: "OMP Agent", kind: "note", text: "ready when you are", authorNodeId: a.ctx.identity.nodeId });
			// A message by this node's own agent is never fed back into its own session.
			expect(stored[0]?.injectedSessionId).toBeNull();

			const asked = await run(session, "mesh_message", { taskId: outgoing.id, text: "which branch?", kind: "question" });
			expect(asked.text).toContain('End your turn now; the answer arrives as a message starting "[CL Agent Mesh]".');

			// The executor side reports to the sender; instructions are the sender's privilege.
			const refused = await run(other, "mesh_message", { taskId: incoming.id, text: "do this", kind: "instruction" });
			expect(refused).toMatchObject({ isError: true, text: expect.stringContaining("only the task's sender") });
			const answered = await run(other, "mesh_message", { taskId: incoming.id, text: "main", kind: "answer" });
			expect(answered.isError).toBeUndefined();
			expect(answered.text).toContain("Message sent to Beta");
		});

		it("refuses finished tasks", async () => {
			const task = insertTask(a, bId(), { senderSessionId: session, status: "failed" });
			const result = await run(session, "mesh_message", { taskId: task.id, text: "hello?" });
			expect(result.isError).toBe(true);
			expect(result.text).toContain("failed");
			expect(a.ctx.tasks.store.messages(task.id)).toHaveLength(0);
		});

		it("enforces the loop guard at the 13th agent message and a human message replenishes it", async () => {
			const task = insertTask(a, bId(), { senderSessionId: session });
			for (let i = 1; i <= 12; i++) {
				const result = await run(session, "mesh_message", { taskId: task.id, text: `msg ${i}` });
				expect(result.isError, `message ${i}: ${result.text}`).toBeUndefined();
				expect(result.text).toContain(`You can send ${12 - i} more messages`);
			}
			const blocked = await run(session, "mesh_message", { taskId: task.id, text: "msg 13" });
			expect(blocked.isError).toBe(true);
			expect(blocked.text).toMatch(/Agent message limit reached/);
			expect(a.ctx.tasks.store.messages(task.id)).toHaveLength(12);
			expect((await run(session, "mesh_task", { taskId: task.id })).text).toContain("Messages you may still send: 0");

			await a.ctx.tasks.postMessage(task.id, { text: "carry on", kind: "note", author: { kind: "human", agentId: null, agentName: null } });
			const resumed = await run(session, "mesh_message", { taskId: task.id, text: "msg 14" });
			expect(resumed.isError, resumed.text).toBeUndefined();
			expect(resumed.text).toContain("You can send 11 more messages");
		});

		it("mesh_task reports role, status, peer, delivery, the budget and the last five messages", async () => {
			const task = insertTask(a, bId(), { senderSessionId: session, status: "blocked", reason: "waiting for an answer", executorAgentName: "Reviewer" });
			const stamp = Date.now();
			for (let i = 1; i <= 7; i++) insertPeerMessage(a, task, `thread message ${i} ${"x".repeat(i === 7 ? 500 : 0)}`, { createdAt: new Date(stamp + i).toISOString() });

			const text = (await run(session, "mesh_task", { taskId: task.id })).text;
			expect(text).toContain(`Task ${task.id} · "Fix the flaky test"`);
			expect(text).toContain("Your role: delegating agent (sender)");
			expect(text).toContain("Status: blocked (waiting for an answer)");
			expect(text).toContain("Executor: Reviewer@Beta");
			expect(text).toMatch(/Delivery: /);
			expect(text).toContain("Messages you may still send: 12");
			expect(text).toContain("Last 5 message(s):");
			expect(text).not.toContain("thread message 2");
			expect(text).toContain("- Reviewer@Beta (note): thread message 3");
			expect(text).toContain("thread message 7");
			expect(text).toContain("…");
			expect(text).not.toContain("x".repeat(301));

			const done = a.ctx.tasks.store.update(task.id, {
				status: "succeeded",
				reason: null,
				result: { summary: "Parser ported", autoCompleted: true, branch: "clam/beta/port-1", commit: "abcdef0123456789", pushed: false, compareUrl: null, artifacts: [{ artifactId: "art_1", name: "task.patch", sha256: "0".repeat(64), size: 10 }] },
			});
			const finished = (await run(session, "mesh_task", { taskId: done.id })).text;
			expect(finished).toContain("Status: succeeded");
			expect(finished).toContain("Branch: clam/beta/port-1 @ abcdef012345 (not pushed)");
			expect(finished).toContain("Artifacts: task.patch");
			expect(finished).toContain("Summary (auto-completed, the agent never called mesh_complete): Parser ported");
		});

		it("mesh_task from the executing session names the delegator", async () => {
			const task = insertTask(a, bId(), { direction: "incoming", executorSessionId: session, senderAgentName: "Planner" });
			const text = (await run(session, "mesh_task", { taskId: task.id })).text;
			expect(text).toContain("Your role: executing agent (executor)");
			expect(text).toContain("Delegated by: Planner@Beta");
			expect(text).not.toContain("Delivery:");
		});

		it("mesh_complete is an error from a session that executes no task", async () => {
			const outgoing = insertTask(a, bId(), { senderSessionId: session });
			const fromSender = await run(session, "mesh_complete", { taskId: outgoing.id, outcome: "succeeded", summary: "done" });
			expect(fromSender.isError).toBe(true);
			expect(fromSender.text.length).toBeGreaterThan(0);
			const noTask = await run(lone, "mesh_complete", { outcome: "failed", summary: "nothing" });
			expect(noTask.isError).toBe(true);
			expect(a.ctx.tasks.store.get(outgoing.id).status).toBe("running");
		});

		it("works end to end from the agent: mesh_message and mesh_task through the fake omp", async () => {
			const talker = await createSession(a, project.id);
			const task = insertTask(a, bId(), { senderSessionId: talker });
			const args = JSON.stringify({ taskId: "{{taskId}}", text: "hello from the agent", kind: "note" });
			await api(a).post(`/sessions/${talker}/prompt`, { message: `talk to ${task.id}\n@@fake-tool mesh_message ${args}\n@@fake-tool mesh_task {"taskId":"{{taskId}}"}`, clientId: "talk-1" });
			const text = await fakeToolOutput(a, talker, "FAKE_TOOL_RESULT mesh_task:");
			expect(text).toContain("FAKE_TOOL_RESULT mesh_message: Message sent to Beta");
			expect(text).toContain("hello from the agent");
			expect(a.ctx.tasks.store.messages(task.id).map((m) => m.text)).toEqual(["hello from the agent"]);
		});
	});
});
