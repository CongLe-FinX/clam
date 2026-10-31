import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentSession, FileContent, FileEntry, Project, Workspace } from "@clam/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api, createFullHarness, type FullHarness } from "./full-harness.ts";
import { isolateGitConfig, type GitConfigIsolation } from "./task-fixtures.ts";
import { afterAll, beforeAll } from "vitest";

let gitConfig: GitConfigIsolation;
beforeAll(() => {
	gitConfig = isolateGitConfig();
});
afterAll(() => gitConfig.restore());

let node: FullHarness;
let scratch: string;
let workspace: Workspace;
beforeEach(async () => {
	node = await createFullHarness({});
	scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "clam-nogit-projects-")));
	workspace = (await api(node).post<Workspace>("/workspaces", { name: "Main" })).body;
});
afterEach(async () => {
	await node.cleanup();
	rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const managedDir = (id: string): string => path.join(node.dataDir, "projects", id);

describe("managed projects (no path, no git)", () => {
	it("creates an empty folder under <dataDir>/projects/<id> and reports vcs none live", async () => {
		const res = await api(node).post<Project>("/projects", { workspaceId: workspace.id, name: "Scratchpad" });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		const project = res.body;
		expect(project).toMatchObject({ name: "Scratchpad", managed: true, vcs: "none", repository: null, sessionCount: 0 });
		expect(project.path).toBe(realpathSync(managedDir(project.id)));
		expect(existsSync(project.path)).toBe(true);
		expect((await api(node).get<Project>(`/projects/${project.id}`)).body).toMatchObject({ managed: true, vcs: "none" });
		expect((await api(node).get<Project[]>(`/projects?workspaceId=${workspace.id}`)).body.map((p) => p.id)).toEqual([project.id]);
	});

	it("an unknown workspace is a 404 and creates no folder", async () => {
		const res = await api(node).post("/projects", { workspaceId: "ws_nope", name: "X" });
		expect(res.status).toBe(404);
		expect(existsSync(path.join(node.dataDir, "projects"))).toBe(false);
	});

	it("the file explorer and sessions work on a plain folder", async () => {
		const project = (await api(node).post<Project>("/projects", { workspaceId: workspace.id, name: "Plain" })).body;
		writeFileSync(path.join(project.path, "notes.txt"), "hello\n");
		mkdirSync(path.join(project.path, "docs"));
		writeFileSync(path.join(project.path, "docs", "a.md"), "# a\n");
		const listing = await api(node).get<FileEntry[]>(`/projects/${project.id}/files`);
		expect(listing.status).toBe(200);
		expect(listing.body.map((e) => e.name).sort()).toEqual(["docs", "notes.txt"]);
		const file = await api(node).get<FileContent>(`/projects/${project.id}/file?path=notes.txt`);
		expect(file.body).toMatchObject({ content: "hello\n" });
		const session = await api(node).post<AgentSession>("/sessions", { projectId: project.id, title: "In a plain folder" });
		expect(session.status, JSON.stringify(session.body)).toBe(201);
		expect(session.body.projectId).toBe(project.id);
		expect((await api(node).get<Project>(`/projects/${project.id}`)).body.sessionCount).toBe(1);
	});

	it("vcs is derived from the folder every time: git init flips it, a nested folder stays plain", async () => {
		const project = (await api(node).post<Project>("/projects", { workspaceId: workspace.id, name: "Becomes git" })).body;
		expect((await api(node).get<Project>(`/projects/${project.id}`)).body.vcs).toBe("none");
		execFileSync("git", ["init", "-q"], { cwd: project.path });
		expect((await api(node).get<Project>(`/projects/${project.id}`)).body.vcs).toBe("git");
		// a folder nested inside a repository is not a repository root
		const nested = path.join(project.path, "inner");
		mkdirSync(nested);
		const inner = (await api(node).post<Project>("/projects", { workspaceId: workspace.id, name: "Inner", path: nested })).body;
		expect(inner).toMatchObject({ vcs: "none", managed: false, repository: null });
	});

	it("a project at a chosen plain directory is not managed", async () => {
		const dir = path.join(scratch, "mine");
		mkdirSync(dir);
		const project = (await api(node).post<Project>("/projects", { workspaceId: workspace.id, name: "Mine", path: dir })).body;
		expect(project).toMatchObject({ managed: false, vcs: "none", path: dir });
	});

	it("deleting keeps the folder unless deleteFiles=true, which only managed projects accept", async () => {
		const kept = (await api(node).post<Project>("/projects", { workspaceId: workspace.id, name: "Keep" })).body;
		writeFileSync(path.join(kept.path, "precious.txt"), "x");
		expect((await api(node).del(`/projects/${kept.id}`)).status).toBe(204);
		expect(existsSync(path.join(kept.path, "precious.txt"))).toBe(true);

		const gone = (await api(node).post<Project>("/projects", { workspaceId: workspace.id, name: "Drop" })).body;
		writeFileSync(path.join(gone.path, "scratch.txt"), "x");
		expect((await api(node).del(`/projects/${gone.id}?deleteFiles=true`)).status).toBe(204);
		expect(existsSync(gone.path)).toBe(false);
		expect((await api(node).get(`/projects/${gone.id}`)).status).toBe(404);

		const dir = path.join(scratch, "chosen");
		mkdirSync(dir);
		writeFileSync(path.join(dir, "mine.txt"), "x");
		const chosen = (await api(node).post<Project>("/projects", { workspaceId: workspace.id, name: "Chosen", path: dir })).body;
		const refused = await api(node).del<{ error: { code: string } }>(`/projects/${chosen.id}?deleteFiles=true`);
		expect(refused.status).toBe(409);
		expect(existsSync(path.join(dir, "mine.txt"))).toBe(true);
		expect((await api(node).get(`/projects/${chosen.id}`)).status).toBe(200);
	});

	it("never deletes outside the managed root even if the row is tampered with", async () => {
		const dir = path.join(scratch, "victim");
		mkdirSync(dir);
		writeFileSync(path.join(dir, "keep.txt"), "x");
		const project = (await api(node).post<Project>("/projects", { workspaceId: workspace.id, name: "Tampered" })).body;
		node.ctx.db.$client.prepare("update projects set path = ? where id = ?").run(dir, project.id);
		expect((await api(node).del(`/projects/${project.id}?deleteFiles=true`)).status).toBe(204);
		expect(existsSync(path.join(dir, "keep.txt"))).toBe(true);
	});
});
