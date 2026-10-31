import type { AgentSession, Context, Project, UiMessage, Workspace } from "@clam/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contextsOn } from "./context-fixtures.ts";
import { api, createFullHarness, type FullHarness } from "./full-harness.ts";
import { eventually } from "./net-helpers.ts";
import { promptAndWait, textOf, transcript } from "./shared-fixtures.ts";
import { promptsOf } from "./task-fixtures.ts";

let node: FullHarness;
let ws: Workspace;
let project: Project;

beforeEach(async () => {
	node = await createFullHarness();
	ws = (await api(node).post<Workspace>("/workspaces", { name: "W" })).body;
	project = (await api(node).post<Project>("/projects", { workspaceId: ws.id, name: "Billing", path: node.projectDir })).body;
});
afterEach(async () => {
	await node.cleanup();
});

const mk = (o: { title: string; body: string; type?: string; shareable?: boolean; project?: Project | null }) =>
	contextsOn(node).create({ workspaceId: ws.id, title: o.title, body: o.body, ...(o.type && { type: o.type }), ...(o.shareable !== undefined && { shareable: o.shareable }), ...((o.project === undefined ? project : o.project) && { projectId: (o.project === undefined ? project : o.project)?.id }) });
async function session(p: Project = project, extra: Record<string, unknown> = {}): Promise<AgentSession> {
	const res = await api(node).post<AgentSession>("/sessions", { projectId: p.id, ...extra });
	expect(res.status).toBe(201);
	return res.body;
}

describe("project memory in the first prompt", () => {
	it("prepends a compact memory section to the first prompt only", async () => {
		await mk({ title: "Coding style", body: "Tabs, no semicolons.\nMore detail.", type: "memory", shareable: true });
		await mk({ title: "Use SQLite", body: "It is embedded", type: "decision" });
		await mk({ title: "Company glossary", body: "ARR = annual recurring revenue", project: null });
		const s = await session();
		await promptAndWait(node, s.id, "What is our coding style?");
		await promptAndWait(node, s.id, "And the glossary?");
		const [first, second] = promptsOf(node).map((p) => p.message);
		expect(first).toMatch(/^\[CL Agent Mesh\] project memory · "Billing" · 3 items\n/);
		expect(first).toContain("- [memory] Coding style — Tabs, no semicolons.");
		expect(first).toContain("- [memory] Company glossary — ARR = annual recurring revenue");
		expect(first).toContain("- [decision] Use SQLite — It is embedded");
		expect(first).toContain("mesh_memory");
		expect(first?.endsWith("\n[end of project memory]\n\nWhat is our coding style?")).toBe(true);
		expect(first?.indexOf("[memory] Coding style")).toBeLessThan(first?.indexOf("[decision] Use SQLite") ?? 0);
		expect(second).toBe("And the glossary?");
		// The transcript shows the user's message as it was sent, preface included (the UI folds it).
		const user = (await transcript(node, s.id)).filter((m: UiMessage) => m.role === "user").map(textOf);
		expect(user[0]).toContain("[end of project memory]");
		expect(user[1]).toBe("And the glossary?");
	});

	it("does nothing for a project without contexts; ignores other projects' and deleted contexts", async () => {
		const other = (await api(node).post<Project>("/projects", { workspaceId: ws.id, name: "Other", path: node.dataDir })).body;
		await mk({ title: "Other's secret plan", body: "elsewhere", project: other });
		const gone = await mk({ title: "Removed", body: "x", shareable: true });
		await api(node).del(`/contexts/${gone.id}`);
		const s = await session();
		await promptAndWait(node, s.id, "hello");
		expect(promptsOf(node).map((p) => p.message)).toEqual(["hello"]);
	});

	it("also reaches the optional first prompt of a new session and a session started later", async () => {
		await mk({ title: "Release rule", body: "Tag from main", type: "memory" });
		const created = await api(node).post<AgentSession>("/sessions", { projectId: project.id, prompt: "start up" });
		expect(created.status).toBe(201);
		await eventually(() => promptsOf(node).length === 1, "the first prompt");
		expect(promptsOf(node)[0]?.message).toMatch(/Release rule — Tag from main[\s\S]*\n\nstart up$/);
	});

	it("is not repeated when the conversation is resumed (the runtime already has messages)", async () => {
		await mk({ title: "Always", body: "remember me" });
		const s = await session();
		await promptAndWait(node, s.id, "one");
		await api(node).post(`/sessions/${s.id}/restart`);
		await promptAndWait(node, s.id, "two");
		expect(promptsOf(node).map((p) => p.message).filter((m) => m.includes("project memory"))).toHaveLength(1);
		expect(promptsOf(node).at(-1)?.message).toBe("two");
	});

	it("stays within about two thousand characters however much there is", async () => {
		for (let i = 0; i < 60; i++) await mk({ title: `Note number ${i}`, body: `A fairly long first line describing note ${i} in some detail`, type: "note" });
		const s = await session();
		await promptAndWait(node, s.id, "go");
		const first = promptsOf(node)[0]?.message ?? "";
		const section = first.slice(0, first.indexOf("[end of project memory]") + "[end of project memory]".length);
		expect(section.length).toBeLessThanOrEqual(2000);
		expect(section).toMatch(/\(\+\d+ more: use mesh_memory to search them\)/);
	});
});

describe("host tools", () => {
	const call = (sessionId: string, toolName: string, args: unknown) =>
		node.ctx.hostTools.execute({ sessionId, toolCallId: "t", toolName, arguments: args, signal: new AbortController().signal, update() {} });

	it("registers mesh_memory and mesh_remember as essential tools", async () => {
		const s = await session();
		const defs = node.ctx.hostTools.definitions(s.id).filter((d) => d.name === "mesh_memory" || d.name === "mesh_remember");
		expect(defs.map((d) => [d.name, d.loadMode]).sort()).toEqual([["mesh_memory", "essential"], ["mesh_remember", "essential"]]);
	});

	it("mesh_memory searches, reads and lists the project's memory — and only this project's", async () => {
		const style = await mk({ title: "Coding style", body: "We use tabs for indentation, never semicolons.", type: "memory", shareable: true });
		const wide = await mk({ title: "Glossary", body: "MRR means monthly recurring revenue", project: null });
		const other = (await api(node).post<Project>("/projects", { workspaceId: ws.id, name: "Other", path: node.dataDir })).body;
		const hidden = await mk({ title: "Hidden plan", body: "tabs are banned elsewhere", project: other });
		const s = await session();

		const search = await call(s.id, "mesh_memory", { query: "tabs" });
		expect(search.isError).toBeFalsy();
		expect(search.text).toContain(`[memory] Coding style — ${style.id}`);
		expect(search.text).toContain("«tabs»");
		expect(search.text).not.toContain(hidden.id);
		const phrase = await call(s.id, "mesh_memory", { action: "search", query: '"monthly recurring"' });
		expect(phrase.text).toContain(wide.id);
		expect((await call(s.id, "mesh_memory", { query: "nonexistentword" })).text).toMatch(/No project memory matches/);

		const read = await call(s.id, "mesh_memory", { action: "read", id: style.id });
		expect(read.text).toContain("version 1, this project, shared with the workspace");
		expect(read.text).toContain("We use tabs for indentation, never semicolons.");
		expect((await call(s.id, "mesh_memory", { action: "read", id: wide.id })).text).toContain("workspace-wide, private to this node");
		const denied = await call(s.id, "mesh_memory", { action: "read", id: hidden.id });
		expect(denied.isError).toBe(true);

		const list = await call(s.id, "mesh_memory", {});
		expect(list.text).toContain(style.id);
		expect(list.text).toContain(wide.id);
		expect(list.text).not.toContain(hidden.id);
		expect((await call(s.id, "mesh_memory", { action: "list", type: "decision" })).text).toMatch(/no saved memory/);
	});

	it("mesh_memory rejects bad arguments clearly", async () => {
		const s = await session();
		expect((await call(s.id, "mesh_memory", { action: "read" })).text).toMatch(/needs `id`/);
		expect((await call(s.id, "mesh_memory", { action: "search" })).text).toMatch(/needs `query`/);
		expect((await call(s.id, "mesh_memory", { bogus: 1 })).text).toMatch(/unknown argument\(s\) bogus/);
		expect((await call(s.id, "mesh_memory", { limit: 99 })).isError).toBe(true);
		expect((await call("ses_missing", "mesh_memory", {})).text).toMatch(/does not belong to a project/);
	});

	it("mesh_remember saves a PRIVATE context authored by the agent, and updates only its own notes", async () => {
		const s = await session();
		const saved = await call(s.id, "mesh_remember", { title: "Use pnpm", body: "This repo uses pnpm, never npm.", type: "decision" });
		expect(saved.isError).toBeFalsy();
		const id = saved.text.match(/\((ctx_[0-9a-f]+)\)/)?.[1] as string;
		const row = await contextsOn(node).get(id);
		expect(row).toMatchObject({ title: "Use pnpm", type: "decision", shareable: false, projectId: project.id, workspaceId: ws.id });
		expect(row?.author).toMatchObject({ kind: "agent", agentName: expect.any(String) });
		expect(row?.sync.state).toBe("private");
		expect(saved.text).toContain("private to this node");

		const updated = await call(s.id, "mesh_remember", { id, title: "Use pnpm", body: "Use pnpm 10; never npm." });
		expect(updated.text).toContain("now version 2");
		expect((await contextsOn(node).get(id))?.body).toBe("Use pnpm 10; never npm.\n");

		// Shared items are people's; the agent cannot change what the workspace shares.
		await contextsOn(node).edit(id, { shareable: true });
		const refused = await call(s.id, "mesh_remember", { id, title: "Use pnpm", body: "changed by the agent" });
		expect(refused.isError).toBe(true);
		expect(refused.text).toMatch(/only a person edits shared items/);
		expect((await contextsOn(node).get(id))?.body).toBe("Use pnpm 10; never npm.\n");

		// Workspace scope.
		const wide = await call(s.id, "mesh_remember", { title: "House style", body: "Plain words.", scope: "workspace" });
		const wideId = wide.text.match(/\((ctx_[0-9a-f]+)\)/)?.[1] as string;
		expect((await contextsOn(node).get(wideId))?.projectId).toBeNull();
		expect(wide.text).toContain("the whole workspace");
		// What it saved is what mesh_memory finds next.
		expect((await call(s.id, "mesh_memory", { query: "pnpm" })).text).toContain(id);
	});

	it("mesh_remember is budgeted per session and validates its input", async () => {
		const s = await session();
		for (let i = 0; i < 12; i++) expect((await call(s.id, "mesh_remember", { title: `Fact ${i}`, body: `body ${i}` })).isError).toBeFalsy();
		const over = await call(s.id, "mesh_remember", { title: "One too many", body: "x" });
		expect(over.isError).toBe(true);
		expect(over.text).toMatch(/already saved 12 items/);
		// A fresh session has its own budget.
		const s2 = await session();
		expect((await call(s2.id, "mesh_remember", { title: "Fresh", body: "ok" })).isError).toBeFalsy();
		expect((await call(s2.id, "mesh_remember", { title: "", body: "x" })).text).toMatch(/title must not be empty/);
		expect((await call(s2.id, "mesh_remember", { title: "t", body: "x".repeat(20_001) })).text).toMatch(/at most 20000/);
		expect((await call(s2.id, "mesh_remember", { title: "t", body: "x", extra: true })).text).toMatch(/unknown argument/);
		expect((await call(s2.id, "mesh_remember", { id: "ctx_0000000000000000", title: "t", body: "x" })).text).toMatch(/No context/);
	});

	it("what an agent saved shows up in the next session's first prompt", async () => {
		const s = await session();
		await call(s.id, "mesh_remember", { title: "Deploy day", body: "Fridays are frozen.", type: "memory" });
		const next = await session();
		await promptAndWait(node, next.id, "hi");
		expect(promptsOf(node)[0]?.message).toContain("- [memory] Deploy day — Fridays are frozen.");
	});
});

export type { Context };
