import type { Task } from "@clam/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { contextsOn } from "./context-fixtures.ts";
import { api } from "./full-harness.ts";
import { eventually } from "./net-helpers.ts";
import { findTask, isolateGitConfig, promptsOf, startTaskPair, type GitConfigIsolation, type TaskPair } from "./task-fixtures.ts";

let gitConfig: GitConfigIsolation;
beforeAll(() => {
	gitConfig = isolateGitConfig();
});
afterAll(() => gitConfig.restore());

let pair: TaskPair;
afterEach(async () => {
	await pair?.cleanup();
});

describe("project memory reaches the first prompt of sessions created by other features", () => {
	it("a delegated task's executor session starts with the executor project's memory", async () => {
		pair = await startTaskPair();
		await pair.autoAcceptOnB(true);
		await contextsOn(pair.b).create({ workspaceId: pair.workspace.id, projectId: pair.projectB.id, type: "memory", title: "Test command", body: "Run pnpm test before pushing." });
		const description = ["Create TASK_SMOKE.md with one line.", "@@fake-sh echo hello from B > TASK_SMOKE.md", '@@fake-tool mesh_complete {"taskId":"{{taskId}}","outcome":"succeeded","summary":"created TASK_SMOKE.md"}'].join("\n");
		const created = await api(pair.a).post<Task>("/tasks", { targetNodeId: pair.b.ctx.identity.nodeId, projectId: pair.projectA.id, title: "Smoke", description, deliverAs: "branch" });
		expect(created.status).toBe(201);
		const onB = await eventually(() => findTask(pair.b, "Smoke"), "the task on B");
		await eventually(async () => (await api(pair.b).get<{ task: Task }>(`/tasks/${onB.id}`)).body.task.status === "succeeded", "the task to finish", 30_000);
		const first = promptsOf(pair.b)[0]?.message ?? "";
		expect(first).toMatch(/^\[CL Agent Mesh\] project memory · "demo-b" · 1 item\n/);
		expect(first).toContain("- [memory] Test command — Run pnpm test before pushing.");
		expect(first).toContain("[end of project memory]\n\n");
		// The task's own brief follows the memory section.
		expect(first.slice(first.indexOf("[end of project memory]"))).toContain("Smoke");
		// A's executor-less session did not get B's memory: the sender never sees the other node's contexts.
		expect(promptsOf(pair.a).some((p) => p.message.includes("Test command"))).toBe(false);
	});
});
