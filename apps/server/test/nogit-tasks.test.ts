import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { workspaceMembers } from "@clam/database";
import type { FilesApplyResult, FilesPreview, Peer, Project, Task, TaskDetail } from "@clam/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { api } from "./full-harness.ts";
import { eventually, peerOf, signedRequest } from "./net-helpers.ts";
import { exists, read, startPlainPair, write, type PlainPair } from "./nogit-fixtures.ts";
import { findTask, promptsOf, waitForTask } from "./task-fixtures.ts";

/**
 * Tasks with no git repository, between two real in-process nodes (fake omp driven by `@@fake-*` directives): a task with
 * no project at all, input files, deliverAs files (bundle of what the agent created or changed), preview/apply on the sender.
 */

let pair: PlainPair;
afterEach(async () => {
	await pair?.cleanup();
});

const complete = (summary: string): string => `@@fake-tool mesh_complete {"taskId":"{{taskId}}","outcome":"succeeded","summary":${JSON.stringify(summary)}}`;

async function delegate(title: string, description: string, over: Record<string, unknown> = {}): Promise<Task> {
	const res = await api(pair.a).post<Task>("/tasks", { targetNodeId: pair.bId, title, description, ...over });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body;
}

describe("a task with no project and no repository", () => {
	it("runs in a fresh managed folder on B and comes back as a summary", async () => {
		pair = await startPlainPair();
		await pair.autoAcceptOnB(true);
		const created = await delegate("Plain question", ["Say hello.", complete("hello from B")].join("\n"), { deliverAs: "summary" });
		expect(created).toMatchObject({ direction: "outgoing", repo: null, projectId: null, inputFiles: null, deliverAs: "summary", workspaceId: pair.workspace.id });

		const done = await waitForTask(pair.a, created.id, (t) => t.status === "succeeded", "A mirrors the task as succeeded");
		expect(done.task.result).toMatchObject({ summary: "hello from B", branch: null, pushed: false, files: null });
		expect(done.task.repo).toBeNull();

		const onB = (await api(pair.b).get<TaskDetail>(`/tasks/${created.id}`)).body.task;
		expect(onB).toMatchObject({ direction: "incoming", repo: null, status: "succeeded" });
		expect(onB.projectId).not.toBeNull();
		const project = (await api(pair.b).get<Project>(`/projects/${onB.projectId}`)).body;
		expect(project).toMatchObject({ managed: true, vcs: "none" });
		expect(project.path).toContain(path.join(pair.b.dataDir, "projects"));
		// the brief says there is no repository and nothing to deliver but the summary
		const brief = promptsOf(pair.b).find((p) => p.message.includes("Plain question"))?.message ?? "";
		expect(brief).toContain("## Working folder");
		expect(brief).not.toContain("## Repository");
		expect(brief).toContain("Deliver as: summary");
	});

	it("defaults deliverAs to files without a project, and asks for the workspace when the target is in several", async () => {
		pair = await startPlainPair();
		const created = await delegate("Defaults", "Do something.");
		expect(created.deliverAs).toBe("files");

		// B becomes a member of a second workspace of A: a task without a project no longer knows which one is meant
		const second = (await api(pair.a).post<{ id: string }>("/workspaces", { name: "Second" })).body;
		pair.a.ctx.db.insert(workspaceMembers).values({ workspaceId: second.id, memberId: pair.bId, role: "member", permissions: [] }).run();
		const ambiguous = await api(pair.a).post<{ error: { code: string; details?: { workspaces: string[] } } }>("/tasks", { targetNodeId: pair.bId, title: "Which?", description: "x" });
		expect(ambiguous.status).toBe(409);
		expect(ambiguous.body.error.code).toBe("workspace_required");
		expect(ambiguous.body.error.details?.workspaces.sort()).toEqual([pair.workspace.id, second.id].sort());
		const chosen = await api(pair.a).post<Task>("/tasks", { targetNodeId: pair.bId, title: "Second one", description: "x", workspaceId: second.id });
		expect(chosen.status).toBe(201);
		expect(chosen.body.workspaceId).toBe(second.id);
		// a project of the first workspace cannot be used with the second
		const mismatch = await api(pair.a).post("/tasks", { targetNodeId: pair.bId, projectId: pair.projectA.id, workspaceId: second.id, title: "Mixed", description: "x" });
		expect(mismatch.status).toBe(400);
	});

	it("a project that does not exist, a missing workspace and unsafe or secret input are refused before anything is queued", async () => {
		pair = await startPlainPair();
		const before = pair.a.ctx.tasks.store.pendingOutbox().length;
		const missing = await api(pair.a).post("/tasks", { targetNodeId: pair.bId, projectId: "prj_nope", title: "x", description: "y" });
		expect(missing.status).toBe(404);
		const noProject = await api(pair.a).post<{ error: { message: string } }>("/tasks", { targetNodeId: pair.bId, title: "x", description: "y", inputPaths: ["a.txt"] });
		expect(noProject.status).toBe(400);
		expect(noProject.body.error.message).toMatch(/projectId/);
		const branch = await api(pair.a).post<{ error: { code: string } }>("/tasks", { targetNodeId: pair.bId, projectId: pair.projectA.id, title: "x", description: "y", deliverAs: "branch" });
		expect(branch.status).toBe(409);
		expect(branch.body.error.code).toBe("project_not_linked");
		write(pair.projectA.path, "ok.txt", "fine\n");
		const escaped = await api(pair.a).post<{ error: { code: string } }>("/tasks", { targetNodeId: pair.bId, projectId: pair.projectA.id, title: "x", description: "y", inputPaths: ["../outside"] });
		expect(escaped.status).toBe(400);
		expect(escaped.body.error.code).toBe("unsafe_path");
		const absent = await api(pair.a).post("/tasks", { targetNodeId: pair.bId, projectId: pair.projectA.id, title: "x", description: "y", inputPaths: ["nothing-here.txt"] });
		expect(absent.status).toBe(400);
		write(pair.projectA.path, "keys.txt", "aws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n");
		const leaking = await api(pair.a).post<{ error: { code: string; details?: { files: Array<{ path: string; rules: string[] }> } } }>("/tasks", { targetNodeId: pair.bId, projectId: pair.projectA.id, title: "x", description: "y", inputPaths: ["ok.txt", "keys.txt"] });
		expect(leaking.status).toBe(422);
		expect(leaking.body.error.code).toBe("input_contains_secrets");
		expect(JSON.stringify(leaking.body)).not.toContain("wJalrXUtnFEMI");
		expect(leaking.body.error.details?.files[0]?.path).toBe("keys.txt");
		expect((await api(pair.a).get<Task[]>("/tasks")).body).toEqual([]);
		expect(pair.a.ctx.tasks.store.pendingOutbox().length).toBe(before);
		expect(readdirSync(path.join(pair.a.dataDir, "artifacts"))).toEqual([]);
	});
});

describe("input files and deliverAs files", () => {
	async function inputTask(over: Record<string, unknown> = {}) {
		write(pair.projectA.path, "notes.txt", "alpha\n");
		write(pair.projectA.path, "data/keep.csv", "a,b\n1,2\n");
		write(pair.projectA.path, "private/unrelated.txt", "not sent\n");
		write(pair.projectA.path, ".env", "TOKEN=nope\n");
		return delegate("Append and summarize", ["Append a line to notes.txt and create summary.md.", "@@fake-sh echo beta >> notes.txt", "@@fake-sh echo '# summary' > summary.md", complete("appended and summarized")].join("\n"), {
			projectId: pair.projectA.id,
			deliverAs: "files",
			inputPaths: ["notes.txt", "data"],
			...over,
		});
	}

	it("sends the inputs, runs in a folder that holds them, returns only the files it created or changed", async () => {
		pair = await startPlainPair();
		await pair.autoAcceptOnB(true);
		const created = await inputTask();
		expect(created).toMatchObject({ deliverAs: "files", repo: null, projectId: pair.projectA.id, inputFiles: { fileCount: 2 } });
		expect(created.inputFiles?.sha256).toMatch(/^[0-9a-f]{64}$/);

		const done = await waitForTask(pair.a, created.id, (t) => t.status === "succeeded", "A mirrors the task as succeeded", 30_000);
		const files = done.task.result?.files;
		expect(files).toMatchObject({ fileCount: 2 });
		expect(done.task.result?.summary).toBe("appended and summarized");

		// B: the inputs were placed before the agent started; only inputs the agent touched travel back
		const onB = (await api(pair.b).get<TaskDetail>(`/tasks/${created.id}`)).body.task;
		expect(onB.inputFiles).toMatchObject({ fileCount: 2, sha256: created.inputFiles?.sha256 });
		const folder = (await api(pair.b).get<Project>(`/projects/${onB.projectId}`)).body.path;
		expect(read(folder, "notes.txt")).toBe("alpha\nbeta\n");
		expect(read(folder, "data/keep.csv")).toBe("a,b\n1,2\n");
		expect(exists(folder, "private/unrelated.txt")).toBe(false);
		expect(exists(folder, ".env")).toBe(false);
		const brief = promptsOf(pair.b).find((p) => p.message.includes("Append and summarize"))?.message ?? "";
		expect(brief).toContain("input file(s), already placed in the folder: data/keep.csv, notes.txt");
		expect(brief).toContain("Deliver as: files");
		expect(brief).toContain("CL Agent Mesh returns the files you created or changed");

		// the sender previews against the project the files came from: the input manifest is the base
		const preview = await api(pair.a).get<FilesPreview>(`/tasks/${created.id}/files/preview?projectId=${pair.projectA.id}`);
		expect(preview.status, JSON.stringify(preview.body)).toBe(200);
		expect(Object.fromEntries(preview.body.files.map((f) => [f.path, f.status]))).toEqual({ "notes.txt": "update", "summary.md": "new" });
		expect(preview.body.diffs["notes.txt"]).toContain("+beta");
		// nothing was written by previewing
		expect(read(pair.projectA.path, "notes.txt")).toBe("alpha\n");
		expect(exists(pair.projectA.path, "summary.md")).toBe(false);

		// A edits notes.txt itself in the meantime: a conflict, never overwritten unless listed
		writeFileSync(path.join(pair.projectA.path, "notes.txt"), "alpha\nlocal edit\n");
		const second = await api(pair.a).get<FilesPreview>(`/tasks/${created.id}/files/preview?projectId=${pair.projectA.id}`);
		expect(Object.fromEntries(second.body.files.map((f) => [f.path, f.status]))).toEqual({ "notes.txt": "conflict", "summary.md": "new" });
		const skipped = await api(pair.a).post<FilesApplyResult>(`/tasks/${created.id}/files/apply`, { projectId: pair.projectA.id });
		expect(skipped.status, JSON.stringify(skipped.body)).toBe(200);
		expect(skipped.body.written).toEqual(["summary.md"]);
		expect(skipped.body.skipped).toEqual([{ path: "notes.txt", reason: "conflict" }]);
		expect(read(pair.projectA.path, "notes.txt")).toBe("alpha\nlocal edit\n");
		expect(read(pair.projectA.path, "summary.md")).toBe("# summary\n");

		const forced = await api(pair.a).post<FilesApplyResult>(`/tasks/${created.id}/files/apply`, { projectId: pair.projectA.id, overwrite: ["notes.txt"] });
		expect(forced.body.written).toEqual(["notes.txt"]);
		expect(read(pair.projectA.path, "notes.txt")).toBe("alpha\nbeta\n");
		// applying again changes nothing
		const again = await api(pair.a).post<FilesApplyResult>(`/tasks/${created.id}/files/apply`, { projectId: pair.projectA.id });
		expect(again.body.written).toEqual([]);
		expect(again.body.skipped.map((s) => s.reason)).toEqual(["unchanged", "unchanged"]);

		// another project (no base): the files that exist there and differ are conflicts
		const other = (await api(pair.a).post<Project>("/projects", { workspaceId: pair.workspace.id, name: "elsewhere" })).body;
		write(other.path, "notes.txt", "different\n");
		const elsewhere = await api(pair.a).get<FilesPreview>(`/tasks/${created.id}/files/preview?projectId=${other.id}`);
		expect(Object.fromEntries(elsewhere.body.files.map((f) => [f.path, f.status]))).toEqual({ "notes.txt": "conflict", "summary.md": "new" });
		// the executor's own node has nothing to apply: its files are already in the folder
		const onExecutor = await api(pair.b).get<{ error: { code: string } }>(`/tasks/${created.id}/files/preview?projectId=${other.id}`);
		expect(onExecutor.status).toBe(409);
	});

	it("an offered task waits for a human on B, who may pick a plain local project (input files are placed without replacing different files)", async () => {
		pair = await startPlainPair();
		const created = await inputTask();
		const offered = await eventually(async () => findTask(pair.b, "Append and summarize"), "task offered on B");
		expect(offered).toMatchObject({ status: "offered", projectId: null, repo: null, inputFiles: { fileCount: 2 } });
		const mine = (await api(pair.b).post<Project>("/projects", { workspaceId: pair.workspace.id, name: "B scratch" })).body;
		write(mine.path, "notes.txt", "B's own notes\n");
		const decided = await api(pair.b).post<Task>(`/tasks/${created.id}/decide`, { decision: "accept", projectId: mine.id });
		expect(decided.status, JSON.stringify(decided.body)).toBe(200);
		expect(decided.body.projectId).toBe(mine.id);
		const done = await waitForTask(pair.a, created.id, (t) => t.status === "succeeded", "A sees the task succeed", 30_000);
		// notes.txt existed on B with other content: it was kept, and the agent's append applies to B's own file
		expect(read(mine.path, "notes.txt")).toBe("B's own notes\nbeta\n");
		expect(read(mine.path, "data/keep.csv")).toBe("a,b\n1,2\n");
		const brief = promptsOf(pair.b).find((p) => p.message.includes("Append and summarize"))?.message ?? "";
		expect(brief).toContain("were NOT placed because a different file with that name already exists in the folder: notes.txt");
		// the result is measured against the folder as it was when the agent started: B's pre-existing files are not "changed" by being there
		expect(done.task.result?.files?.fileCount).toBe(2);
		const preview = await api(pair.a).get<FilesPreview>(`/tasks/${created.id}/files/preview?projectId=${pair.projectA.id}`);
		expect(preview.body.files.map((f) => f.path).sort()).toEqual(["notes.txt", "summary.md"]);

		// a project of another workspace is refused for a task of this one
		const otherWorkspace = (await api(pair.b).post<{ id: string }>("/workspaces", { name: "Other" })).body;
		const stranger = (await api(pair.b).post<Project>("/projects", { workspaceId: otherWorkspace.id, name: "stranger" })).body;
		const second = await delegate("Second", complete("noop"), { deliverAs: "summary" });
		await eventually(async () => findTask(pair.b, "Second"), "second task offered");
		const mismatch = await api(pair.b).post<{ error: { code: string } }>(`/tasks/${second.id}/decide`, { decision: "accept", projectId: stranger.id });
		expect(mismatch.status).toBe(409);
		expect(mismatch.body.error.code).toBe("project_mismatch");
	});

	it("withholds result files that look like credentials and says so", async () => {
		pair = await startPlainPair();
		await pair.autoAcceptOnB(true);
		const created = await delegate(
			"Leaky",
			["@@fake-sh echo fine > ok.txt", "@@fake-sh printf 'aws_access_key_id = AKIAIOSFODNN7EXAMPLE\\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\\n' > keys.txt", complete("made two files")].join("\n"),
			{ deliverAs: "files" },
		);
		const done = await waitForTask(pair.a, created.id, (t) => t.status === "succeeded", "A sees the task succeed", 30_000);
		expect(done.task.result?.files?.fileCount).toBe(1);
		expect(done.task.result?.summary).toContain("keys.txt");
		expect(done.task.result?.summary).toContain("credentials");
		expect(JSON.stringify(done.task.result)).not.toContain("wJalrXUtnFEMI");
		expect(JSON.stringify(done.events)).not.toContain("wJalrXUtnFEMI");
		const preview = await api(pair.a).get<FilesPreview>(`/tasks/${created.id}/files/preview?projectId=${pair.projectA.id}`);
		expect(preview.body.files.map((f) => f.path)).toEqual(["ok.txt"]);
	});

	it("a task that changes nothing has no result files, and previewing it is a clear 409", async () => {
		pair = await startPlainPair();
		await pair.autoAcceptOnB(true);
		const created = await delegate("Nothing", complete("looked, changed nothing"), { deliverAs: "files" });
		const done = await waitForTask(pair.a, created.id, (t) => t.status === "succeeded", "A sees the task succeed");
		expect(done.task.result?.files).toBeNull();
		const res = await api(pair.a).get<{ error: { code: string } }>(`/tasks/${created.id}/files/preview?projectId=${pair.projectA.id}`);
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe("no_result_files");
	});

	it("retrying a files task sends the same input bundle again", async () => {
		pair = await startPlainPair();
		await pair.autoAcceptOnB(true);
		const first = await inputTask();
		await waitForTask(pair.a, first.id, (t) => t.status === "succeeded", "A sees the first run succeed", 30_000);
		const retried = await api(pair.a).post<Task>(`/tasks/${first.id}/retry`, {});
		expect(retried.status, JSON.stringify(retried.body)).toBe(201);
		expect(retried.body).toMatchObject({ deliverAs: "files", retryOf: first.id, projectId: pair.projectA.id });
		expect(retried.body.inputFiles?.sha256).toBe(first.inputFiles?.sha256);
		expect(retried.body.inputFiles?.artifactId).not.toBe(first.inputFiles?.artifactId);
		const done = await waitForTask(pair.a, retried.body.id, (t) => t.status === "succeeded", "A sees the retry succeed", 30_000);
		expect(done.task.result?.files?.fileCount).toBe(2);
	});
});

describe("the input bundle on the wire", () => {
	it("is served only to the executor of that task, only while it holds tasks.receive, and matches its digest", async () => {
		pair = await startPlainPair();
		write(pair.projectA.path, "notes.txt", "alpha\n");
		const created = await delegate("Inputs", complete("noop"), { projectId: pair.projectA.id, deliverAs: "files", inputPaths: ["notes.txt"] });
		const artifactId = created.inputFiles?.artifactId as string;
		const url = (id: string, art: string) => `/tasks/${id}/inputs/${art}`;

		const ok = await signedRequest(pair.b, pair.a.netUrl, { path: url(created.id, artifactId) });
		expect(ok.status).toBe(200);
		expect(ok.headers.get("content-length")).toBe(String(created.inputFiles?.size));
		expect(ok.headers.get("content-digest")).toBe(`sha-256=:${Buffer.from(created.inputFiles?.sha256 as string, "hex").toString("base64")}:`);

		expect((await signedRequest(pair.b, pair.a.netUrl, { path: url(created.id, "art_unknown") })).status).toBe(404);
		expect((await signedRequest(pair.b, pair.a.netUrl, { path: url("tsk_unknown", artifactId) })).status).toBe(404);
		// the bundle is an input of an OUTGOING task: the executor's own node does not serve it, and executor artifacts are not inputs
		const onB = await findTask(pair.b, "Inputs");
		if (onB) expect((await signedRequest(pair.a, pair.b.netUrl, { path: url(onB.id, artifactId) })).status).toBe(404);

		// without tasks.receive granted to B, A refuses
		const peer = await peerOf(pair.a, pair.bId);
		const revoked = await api(pair.a).patch<Peer>(`/network/peers/${pair.bId}`, { grantedCapabilities: (peer?.grantedCapabilities ?? []).filter((c) => c !== "tasks.receive") });
		expect(revoked.status).toBe(200);
		const refused = await signedRequest(pair.b, pair.a.netUrl, { path: url(created.id, artifactId) });
		expect(refused.status).toBe(403);
	});

	it("a task whose input cannot be fetched fails with the reason instead of running without its files", async () => {
		pair = await startPlainPair();
		await pair.autoAcceptOnB(true);
		// A stops granting tasks.receive before B asks for the inputs
		const peer = await peerOf(pair.a, pair.bId);
		await api(pair.a).patch(`/network/peers/${pair.bId}`, { grantedCapabilities: (peer?.grantedCapabilities ?? []).filter((c) => c !== "tasks.receive") });
		write(pair.projectA.path, "notes.txt", "alpha\n");
		const created = await delegate("No inputs for you", complete("noop"), { projectId: pair.projectA.id, deliverAs: "files", inputPaths: ["notes.txt"] });
		const failed = await waitForTask(pair.a, created.id, (t) => t.status === "failed", "A sees the task fail", 30_000);
		expect(failed.task.reason).toMatch(/input files could not be fetched/i);
		expect(failed.task.reason).toMatch(/tasks\.receive/);
	});
});
