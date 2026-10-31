import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Project, Workspace } from "@clam/contracts";
import { agentSessions, agents, projects, workspaceMembers, workspaces } from "@clam/database";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fsRoutes from "../src/api/fs.ts";
import projectRoutes from "../src/api/projects.ts";
import workspaceRoutes from "../src/api/workspaces.ts";
import { idleRuntime, createTestHarness, type TestHarness } from "./helpers.ts";

let h: TestHarness;
let runtime: ReturnType<typeof idleRuntime>;
let scratch: string;

beforeEach(async () => {
	runtime = idleRuntime();
	h = await createTestHarness({ plugins: [workspaceRoutes, projectRoutes, fsRoutes], ctx: { runtime } });
	scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "clam-projects-")));
});
afterEach(async () => {
	await h.cleanup();
	rmSync(scratch, { recursive: true, force: true });
});

const api = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
	h.app.inject({ method, url: `/api/local${url}`, payload: payload as object | undefined });

async function mkWorkspace(name = "Main"): Promise<Workspace> {
	const res = await api("POST", "/workspaces", { name });
	expect(res.statusCode).toBeLessThan(300);
	return res.json();
}
function mkDir(name: string): string {
	const dir = path.join(scratch, name);
	mkdirSync(dir, { recursive: true });
	return dir;
}
async function mkProject(workspaceId: string, name: string, dir: string): Promise<Project> {
	const res = await api("POST", "/projects", { workspaceId, name, path: dir });
	expect(res.statusCode, res.body).toBeLessThan(300);
	return res.json();
}
function seedSession(id: string, projectId: string, sessionDir: string, updatedAt?: string) {
	h.ctx.db.insert(agents).values({ id: "agt_1", nodeId: h.ctx.identity.nodeId, name: "a", runtime: "omp" }).onConflictDoNothing().run();
	h.ctx.db
		.insert(agentSessions)
		.values({ id, agentId: "agt_1", projectId, title: id, sessionDir, ...(updatedAt && { updatedAt }) })
		.run();
}

describe("workspaces", () => {
	it("creates, lists, reads, updates", async () => {
		const ws = await mkWorkspace("Zeta");
		expect(ws).toMatchObject({ name: "Zeta", description: "", projectCount: 0, ownerNodeId: h.ctx.identity.nodeId });
		expect(ws.id).toMatch(/^ws_[0-9a-f]{16}$/);
		const members = h.ctx.db.select().from(workspaceMembers).all();
		expect(members).toEqual([expect.objectContaining({ workspaceId: ws.id, memberId: h.ctx.identity.nodeId, role: "owner" })]);

		await mkWorkspace("alpha");
		expect(((await api("GET", "/workspaces")).json() as Workspace[]).map((w) => w.name)).toEqual(["alpha", "Zeta"]);
		expect((await api("GET", `/workspaces/${ws.id}`)).json()).toMatchObject({ id: ws.id });

		const patched = await api("PATCH", `/workspaces/${ws.id}`, { description: "d" });
		expect(patched.statusCode).toBe(200);
		expect(patched.json()).toMatchObject({ name: "Zeta", description: "d" });
		expect(Date.parse(patched.json().updatedAt)).toBeGreaterThanOrEqual(Date.parse(ws.updatedAt));
	});

	it("validates input, 404s unknown ids and rejects duplicate names case-insensitively", async () => {
		const ws = await mkWorkspace("Main");
		expect((await api("POST", "/workspaces", { name: "main" })).statusCode).toBe(409);
		expect((await api("POST", "/workspaces", { name: "  " })).statusCode).toBe(400);
		const other = await mkWorkspace("Other");
		expect((await api("PATCH", `/workspaces/${other.id}`, { name: "MAIN" })).statusCode).toBe(409);
		expect((await api("PATCH", `/workspaces/${ws.id}`, { name: "MAIN" })).statusCode).toBe(200);
		expect((await api("GET", "/workspaces/ws_nope")).statusCode).toBe(404);
		expect((await api("PATCH", "/workspaces/ws_nope", { name: "x" })).statusCode).toBe(404);
		expect((await api("DELETE", "/workspaces/ws_nope")).statusCode).toBe(404);
	});

	it("deletes with cascade: stops runtimes, removes session dirs under dataDir only, publishes removes", async () => {
		const ws = await mkWorkspace();
		const keep = await mkWorkspace("Keep");
		const p1 = await mkProject(ws.id, "p1", mkDir("p1"));
		const p2 = await mkProject(ws.id, "p2", mkDir("p2"));
		const pk = await mkProject(keep.id, "pk", mkDir("pk"));

		const inside1 = path.join(h.dataDir, "sessions", "s1");
		const inside2 = path.join(h.dataDir, "sessions", "s2");
		const foreign = mkDir("foreign-session-dir");
		const keptDir = path.join(h.dataDir, "sessions", "s4");
		for (const d of [inside1, inside2, keptDir]) mkdirSync(d, { recursive: true });
		writeFileSync(path.join(inside1, "x.jsonl"), "x");
		seedSession("ses_1", p1.id, inside1);
		seedSession("ses_2", p2.id, inside2);
		seedSession("ses_3", p2.id, foreign);
		seedSession("ses_4", pk.id, keptDir);

		const res = await api("DELETE", `/workspaces/${ws.id}`);
		expect(res.statusCode).toBe(204);

		expect(existsSync(inside1)).toBe(false);
		expect(existsSync(inside2)).toBe(false);
		expect(existsSync(foreign)).toBe(true);
		expect(existsSync(path.join(scratch, "p1"))).toBe(true);
		expect(existsSync(keptDir)).toBe(true);
		expect([...runtime.stopped].sort()).toEqual(["ses_1", "ses_2", "ses_3"]);
		const removed = h.published.filter((p) => p.topic === "sessions").map((p) => p.event);
		expect(removed).toHaveLength(3);
		expect(removed).toEqual(expect.arrayContaining([1, 2, 3].map((n) => ({ type: "remove", sessionId: `ses_${n}` }))));

		expect(h.ctx.db.select().from(workspaces).all().map((w) => w.id)).toEqual([keep.id]);
		expect(h.ctx.db.select().from(projects).all().map((p) => p.id)).toEqual([pk.id]);
		expect(h.ctx.db.select().from(agentSessions).all().map((s) => s.id)).toEqual(["ses_4"]);
		expect(h.ctx.db.select().from(workspaceMembers).all().map((m) => m.workspaceId)).toEqual([keep.id]);
	});
});

describe("projects", () => {
	it("validates path: relative, missing, file; and unknown workspace", async () => {
		const ws = await mkWorkspace();
		const file = path.join(scratch, "file.txt");
		writeFileSync(file, "x");
		const bad = async (p: string) => api("POST", "/projects", { workspaceId: ws.id, name: "x", path: p });
		for (const p of ["relative/dir", path.join(scratch, "missing"), file]) {
			const res = await bad(p);
			expect(res.statusCode).toBe(400);
			expect(res.json().error.code).toBe("invalid_request");
		}
		expect((await bad(file)).json().error.message).toMatch(/not a directory/);
		expect((await bad("relative/dir")).json().error.message).toMatch(/absolute/);
		const res = await api("POST", "/projects", { workspaceId: "ws_nope", name: "x", path: scratch });
		expect(res.statusCode).toBe(404);
	});

	it("stores the canonical path and rejects a duplicate canonical path per workspace", async () => {
		const ws = await mkWorkspace();
		const other = await mkWorkspace("Other");
		const real = mkDir("real");
		const link = path.join(scratch, "link");
		symlinkSync(real, link);
		const prj = await mkProject(ws.id, "p", link);
		expect(prj.path).toBe(real);
		expect(prj.id).toMatch(/^prj_[0-9a-f]{16}$/);
		expect((await api("POST", "/projects", { workspaceId: ws.id, name: "dup", path: real })).statusCode).toBe(409);
		expect((await api("POST", "/projects", { workspaceId: ws.id, name: "dup", path: `${real}/../real` })).statusCode).toBe(409);
		await mkProject(other.id, "same dir elsewhere", real);
	});

	it("lists with counts and filters by workspace", async () => {
		const ws = await mkWorkspace();
		const other = await mkWorkspace("Other");
		const a = await mkProject(ws.id, "a", mkDir("a"));
		const b = await mkProject(ws.id, "b", mkDir("b"));
		await mkProject(other.id, "c", mkDir("c"));
		seedSession("s1", a.id, path.join(h.dataDir, "sessions", "s1"), "2026-01-01T00:00:00.000Z");
		seedSession("s2", a.id, path.join(h.dataDir, "sessions", "s2"), "2026-02-01T00:00:00.000Z");

		const list = (await api("GET", `/projects?workspaceId=${ws.id}`)).json() as Project[];
		expect(list.map((p) => p.name).sort()).toEqual(["a", "b"]);
		expect(list.find((p) => p.id === a.id)).toMatchObject({ sessionCount: 2, lastActivityAt: "2026-02-01T00:00:00.000Z", repository: null });
		expect(list.find((p) => p.id === b.id)).toMatchObject({ sessionCount: 0, lastActivityAt: null });
		expect(((await api("GET", "/projects")).json() as Project[]).length).toBe(3);
		expect((await api("GET", `/projects/${a.id}`)).json()).toMatchObject({ sessionCount: 2 });
		expect((await api("GET", "/workspaces")).json().find((w: Workspace) => w.id === ws.id).projectCount).toBe(2);
		expect((await api("GET", "/projects/prj_nope")).statusCode).toBe(404);
	});

	it("PATCH renames and keeps repository_id in sync with repository.externalId", async () => {
		const ws = await mkWorkspace();
		const prj = await mkProject(ws.id, "p", mkDir("p"));
		const repository = { owner: "o", name: "r", externalId: "42", htmlUrl: "https://github.com/o/r", defaultBranch: "main", accountId: null };
		const res = await api("PATCH", `/projects/${prj.id}`, { name: "renamed", repository });
		expect(res.statusCode).toBe(200);
		expect(res.json()).toMatchObject({ name: "renamed", repository });
		expect(h.ctx.db.select().from(projects).all()[0]).toMatchObject({ repositoryId: "42", repository });

		expect((await api("PATCH", `/projects/${prj.id}`, { name: "again" })).json().repository).toEqual(repository);
		const cleared = await api("PATCH", `/projects/${prj.id}`, { repository: null });
		expect(cleared.json().repository).toBeNull();
		expect(h.ctx.db.select().from(projects).all()[0]?.repositoryId).toBeNull();
		expect((await api("PATCH", `/projects/${prj.id}`, { name: "" })).statusCode).toBe(400);
		expect((await api("PATCH", "/projects/prj_nope", { name: "x" })).statusCode).toBe(404);
	});

	it("DELETE removes sessions, their dirs under dataDir only, and never the project path", async () => {
		const ws = await mkWorkspace();
		const dir = mkDir("proj");
		writeFileSync(path.join(dir, "keep.txt"), "x");
		const prj = await mkProject(ws.id, "p", dir);
		const inside = path.join(h.dataDir, "sessions", "s1");
		mkdirSync(inside, { recursive: true });
		// A session dir pointing at the project itself must never be deleted.
		seedSession("s1", prj.id, inside);
		seedSession("s2", prj.id, dir);
		const res = await api("DELETE", `/projects/${prj.id}`);
		expect(res.statusCode).toBe(204);
		expect(existsSync(inside)).toBe(false);
		expect(existsSync(path.join(dir, "keep.txt"))).toBe(true);
		expect([...runtime.stopped].sort()).toEqual(["s1", "s2"]);
		expect(h.published.filter((p) => p.topic === "sessions")).toHaveLength(2);
		expect(h.ctx.db.select().from(projects).all()).toEqual([]);
		expect(h.ctx.db.select().from(agentSessions).all()).toEqual([]);
		expect((await api("DELETE", `/projects/${prj.id}`)).statusCode).toBe(404);
	});

	it("serves files over HTTP with path safety", async () => {
		const ws = await mkWorkspace();
		const dir = mkDir("web");
		const outside = mkDir("outside");
		writeFileSync(path.join(outside, "secret"), "s");
		writeFileSync(path.join(dir, "a.ts"), "let a = 1");
		symlinkSync(outside, path.join(dir, "esc"));
		const prj = await mkProject(ws.id, "p", dir);
		expect((await api("GET", `/projects/${prj.id}/files`)).json()).toEqual([expect.objectContaining({ name: "a.ts", kind: "file" }), expect.objectContaining({ name: "esc", kind: "symlink" })]);
		expect((await api("GET", `/projects/${prj.id}/file?path=a.ts`)).json()).toMatchObject({ content: "let a = 1", language: "typescript" });
		expect((await api("GET", `/projects/${prj.id}/file?path=..%2Foutside%2Fsecret`)).json().error.code).toBe("invalid_path");
		const esc = await api("GET", `/projects/${prj.id}/file?path=esc%2Fsecret`);
		expect(esc.statusCode).toBe(403);
		expect(esc.json().error.code).toBe("path_outside_project");
		expect((await api("GET", `/projects/${prj.id}/file?path=.`)).statusCode).toBe(400);
		expect((await api("GET", "/projects/prj_nope/files")).statusCode).toBe(404);
	});

	it("serves directory suggestions", async () => {
		mkDir("suggest/alpha");
		const res = await api("GET", `/fs/suggest?prefix=${encodeURIComponent(`${scratch}/suggest/`)}`);
		expect(res.json()).toEqual([{ path: path.join(scratch, "suggest", "alpha"), isGitRepo: false }]);
		expect((await api("GET", "/fs/suggest")).statusCode).toBe(200);
	});
});
