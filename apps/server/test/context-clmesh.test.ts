import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Context, ContextExportResult, ContextImportResult, Project, Workspace } from "@clam/contracts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { contextsOn } from "./context-fixtures.ts";
import { api, createFullHarness, type FullHarness } from "./full-harness.ts";
import { git, isolateGitConfig, makeRepo, type GitConfigIsolation } from "./task-fixtures.ts";

let isolation: GitConfigIsolation;
beforeAll(() => {
	isolation = isolateGitConfig();
});
afterAll(() => isolation.restore());

let repo: ReturnType<typeof makeRepo>;
let a: FullHarness;
let b: FullHarness;
let wsA: Workspace;
let wsB: Workspace;
let projA: Project;
let projB: Project;

async function project(node: FullHarness, workspace: Workspace, name: string, dir: string): Promise<Project> {
	const res = await api(node).post<Project>("/projects", { workspaceId: workspace.id, name, path: dir });
	if (res.status !== 201) throw new Error(`project failed: ${JSON.stringify(res.body)}`);
	return res.body;
}

beforeEach(async () => {
	repo = makeRepo();
	a = await createFullHarness();
	b = await createFullHarness();
	wsA = (await api(a).post<Workspace>("/workspaces", { name: "Team" })).body;
	wsB = (await api(b).post<Workspace>("/workspaces", { name: "Team" })).body;
	projA = await project(a, wsA, "demo", repo.workA);
	projB = await project(b, wsB, "demo", repo.workB);
});
afterEach(async () => {
	await a.cleanup();
	await b.cleanup();
	rmSync(repo.root, { recursive: true, force: true });
});

const exportOf = async (node: FullHarness, p: Project) => api(node).post<ContextExportResult>(`/projects/${p.id}/context/export`);
const importOf = async (node: FullHarness, p: Project) => api(node).post<ContextImportResult>(`/projects/${p.id}/context/import`);
const mk = (node: FullHarness, workspace: Workspace, o: Parameters<ReturnType<typeof contextsOn>["create"]>[0] extends infer T ? Partial<T> : never) => contextsOn(node).create({ workspaceId: workspace.id, title: "x", body: "y", ...o });
const clmesh = (dir: string) => path.join(dir, ".clmesh");
function allFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(path.join(dir, e.name)).map((f) => `${e.name}/${f}`) : [e.name]));
}
const commitCount = (dir: string) => Number(git(dir, "rev-list", "--count", "HEAD").trim());

describe("export to .clmesh/", () => {
	it("writes the shareable contexts by type, an index and the bootstrap files — and never commits", async () => {
		const memory = await mk(a, wsA, { type: "memory", title: "Coding style", body: "Tabs, no semicolons", shareable: true, projectId: projA.id });
		const decision = await mk(a, wsA, { type: "decision", title: "Use SQLite", body: "Embedded and simple", shareable: true, projectId: projA.id });
		await mk(a, wsA, { type: "plan", title: "Release plan", body: "1. tag\n2. publish", shareable: true, projectId: projA.id });
		await mk(a, wsA, { type: "note", title: "Standup notes", body: "talked", shareable: true, projectId: projA.id });
		await mk(a, wsA, { type: "summary", title: "Sprint summary", body: "done", shareable: true, projectId: projA.id });
		const wide = await mk(a, wsA, { type: "memory", title: "Company glossary", body: "ARR means annual recurring revenue", shareable: true });
		await mk(a, wsA, { type: "memory", title: "My private scratchpad", body: "private-text-do-not-publish", projectId: projA.id });

		const before = commitCount(repo.workA);
		const res = await exportOf(a, projA);
		expect(res.status).toBe(200);
		expect(res.body.refused).toEqual([]);
		const date = decision.createdAt.slice(0, 10);
		expect(res.body.written.sort()).toEqual(
			[
				".clmesh/context/index.json",
				`.clmesh/decisions/${date}-use-sqlite.md`,
				".clmesh/memory/coding-style.md",
				".clmesh/memory/company-glossary.md",
				".clmesh/notes/standup-notes.md",
				".clmesh/plans/release-plan.md",
				".clmesh/summaries/sprint-summary.md",
			],
		);
		const files = allFiles(clmesh(repo.workA)).sort();
		expect(files).toEqual(["README.md", "config.json", "context/index.json", `decisions/${date}-use-sqlite.md`, "memory/coding-style.md", "memory/company-glossary.md", "notes/standup-notes.md", "plans/release-plan.md", "summaries/sprint-summary.md"]);
		for (const f of files) expect(readFileSync(path.join(clmesh(repo.workA), f), "utf8")).not.toContain("private-text-do-not-publish");

		const style = readFileSync(path.join(clmesh(repo.workA), "memory/coding-style.md"), "utf8");
		expect(style).toContain(`id: ${memory.id}`);
		expect(style).toContain("type: memory");
		expect(style).toContain('title: "Coding style"');
		expect(style).toContain(`sha256: ${memory.sha256}`);
		expect(style).toContain("scope: project");
		expect(style).toContain("shareable: true");
		expect(style.endsWith("\n\nTabs, no semicolons\n")).toBe(true);
		expect(readFileSync(path.join(clmesh(repo.workA), "memory/company-glossary.md"), "utf8")).toContain("scope: workspace");

		const index = JSON.parse(readFileSync(path.join(clmesh(repo.workA), "context/index.json"), "utf8")) as { schema: number; contexts: Array<{ id: string; path: string }> };
		expect(index.schema).toBe(1);
		expect(index.contexts.map((c) => c.path)).toEqual(["decisions/" + date + "-use-sqlite.md", "memory/coding-style.md", "memory/company-glossary.md", "notes/standup-notes.md", "plans/release-plan.md", "summaries/sprint-summary.md"]);
		expect(index.contexts.map((c) => c.id)).toContain(wide.id);

		// Written to the working tree only: still one commit, the new directory is untracked.
		expect(commitCount(repo.workA)).toBe(before);
		expect(git(repo.workA, "status", "--porcelain").trim()).toBe("?? .clmesh/");
		expect(res.body.status?.files.some((f) => f.path.startsWith(".clmesh/"))).toBe(true);
		// The export noted where each context lives.
		expect((await contextsOn(a).get(memory.id))?.gitPath).toBe("memory/coding-style.md");
	});

	it("is idempotent: a second export changes nothing", async () => {
		await mk(a, wsA, { title: "Stable", body: "same text", shareable: true, projectId: projA.id });
		await exportOf(a, projA);
		const again = await exportOf(a, projA);
		expect(again.body.written).toEqual([]);
		expect(again.body.removed).toEqual([]);
		expect(again.body.unchanged).toContain(".clmesh/memory/stable.md");
		expect(again.body.unchanged).toContain(".clmesh/context/index.json");
	});

	it("refuses a context that contains a token and writes the rest", async () => {
		const token = `ghp_${"aB3dE5gH7jK9mN1pQ3rS5tU7vW9xY1zA2bC4".slice(0, 36)}`;
		const leaky = await mk(a, wsA, { title: "Deploy notes", body: `Deploy with token ${token} please`, shareable: true, projectId: projA.id });
		const clean = await mk(a, wsA, { title: "Clean note", body: "nothing sensitive", shareable: true, projectId: projA.id });
		const res = await exportOf(a, projA);
		expect(res.status).toBe(200);
		expect(res.body.refused).toEqual([{ contextId: leaky.id, path: ".clmesh/memory/deploy-notes.md", rule: "github-token", line: expect.any(Number) }]);
		expect(res.body.written).toContain(".clmesh/memory/clean-note.md");
		expect(res.body.written).not.toContain(".clmesh/memory/deploy-notes.md");
		expect(existsSync(path.join(clmesh(repo.workA), "memory/deploy-notes.md"))).toBe(false);
		for (const f of allFiles(clmesh(repo.workA))) expect(readFileSync(path.join(clmesh(repo.workA), f), "utf8")).not.toContain(token);
		const index = JSON.parse(readFileSync(path.join(clmesh(repo.workA), "context/index.json"), "utf8")) as { contexts: Array<{ id: string }> };
		expect(index.contexts.map((c) => c.id)).toEqual([clean.id]);
		// Fixing the text lets it through on the next export.
		await contextsOn(a).edit(leaky.id, { body: "Deploy with the token from the vault" });
		const fixed = await exportOf(a, projA);
		expect(fixed.body.refused).toEqual([]);
		expect(fixed.body.written).toContain(".clmesh/memory/deploy-notes.md");
	});

	it("removes the file of a context that stopped being shareable or was deleted", async () => {
		const stays = await mk(a, wsA, { title: "Stays", body: "x", shareable: true, projectId: projA.id });
		const unshared = await mk(a, wsA, { title: "Unshared", body: "y", shareable: true, projectId: projA.id });
		const deleted = await mk(a, wsA, { title: "Deleted", body: "z", shareable: true, projectId: projA.id });
		await exportOf(a, projA);
		expect(allFiles(clmesh(repo.workA))).toEqual(expect.arrayContaining(["memory/unshared.md", "memory/deleted.md"]));
		await contextsOn(a).edit(unshared.id, { shareable: false });
		await api(a).del(`/contexts/${deleted.id}`);
		const res = await exportOf(a, projA);
		expect(res.body.removed.sort()).toEqual([".clmesh/memory/deleted.md", ".clmesh/memory/unshared.md"]);
		expect(allFiles(clmesh(repo.workA)).filter((f) => f.startsWith("memory/"))).toEqual(["memory/stays.md"]);
		expect((await contextsOn(a).get(stays.id))?.gitPath).toBe("memory/stays.md");
	});

	it("gives two contexts with one title two files", async () => {
		await mk(a, wsA, { title: "Same title", body: "one", shareable: true, projectId: projA.id });
		await mk(a, wsA, { title: "Same title", body: "two", shareable: true, projectId: projA.id });
		await exportOf(a, projA);
		const memory = allFiles(clmesh(repo.workA)).filter((f) => f.startsWith("memory/"));
		expect(memory).toHaveLength(2);
		expect(memory).toContain("memory/same-title.md");
		expect(memory.filter((f) => /^memory\/same-title-[0-9a-f]{6}\.md$/.test(f))).toHaveLength(1);
	});

	it("needs a git project", async () => {
		const plain = (await api(a).post<Project>("/projects", { workspaceId: wsA.id, name: "plain" })).body;
		expect(plain.vcs).toBe("none");
		for (const op of ["export", "import"]) {
			const res = await api(a).post(`/projects/${plain.id}/context/${op}`);
			expect(res.status).toBe(409);
			expect((res.body as { error: { code: string } }).error.code).toBe("not_a_git_project");
		}
		expect((await api(a).post("/projects/prj_missing/context/export")).status).toBe(404);
	});
});

describe("import from .clmesh/", () => {
	/** A exports and pushes; B pulls. */
	async function publish(): Promise<void> {
		await exportOf(a, projA);
		git(repo.workA, "add", ".clmesh");
		git(repo.workA, "commit", "-m", "context");
		git(repo.workA, "push", "origin", "main");
		git(repo.workB, "pull", "--ff-only");
	}

	it("round trip: contexts exported on A arrive on B with their ids, versions and scope; a second import is a no-op", async () => {
		const memory = await mk(a, wsA, { title: "Coding style", body: "Tabs", shareable: true, projectId: projA.id });
		await contextsOn(a).edit(memory.id, { body: "Tabs, no semicolons" });
		const wide = await mk(a, wsA, { type: "decision", title: "Glossary rule", body: "use plain words", shareable: true });
		await publish();

		const first = await importOf(b, projB);
		expect(first.status).toBe(200);
		expect(first.body.created.sort()).toEqual([`.clmesh/decisions/${wide.createdAt.slice(0, 10)}-glossary-rule.md`, ".clmesh/memory/coding-style.md"]);
		expect(first.body.skipped).toEqual([]);
		const onB = await contextsOn(b).get(memory.id);
		expect(onB).toMatchObject({ title: "Coding style", body: "Tabs, no semicolons\n", version: 2, shareable: true, workspaceId: wsB.id, projectId: projB.id, gitPath: "memory/coding-style.md" });
		expect(onB?.sha256).toBe((await contextsOn(a).get(memory.id))?.sha256);
		expect(await contextsOn(b).get(wide.id)).toMatchObject({ projectId: null, type: "decision" });
		expect((await api(b).get<Context[]>(`/contexts/search?q=semicolons`)).body.map((h: any) => h.context.id)).toEqual([memory.id]);

		const second = await importOf(b, projB);
		expect(second.body.created).toEqual([]);
		expect(second.body.updated).toEqual([]);
		expect(second.body.unchanged).toHaveLength(2);
	});

	it("a hand-edited file becomes a new version; an older file changes nothing", async () => {
		const c = await mk(a, wsA, { title: "Style", body: "Tabs", shareable: true, projectId: projA.id });
		await publish();
		await importOf(b, projB);
		const file = path.join(clmesh(repo.workB), "memory/style.md");
		writeFileSync(file, readFileSync(file, "utf8").replace("Tabs", "Spaces, two"));
		const edited = await importOf(b, projB);
		expect(edited.body.updated).toEqual([".clmesh/memory/style.md"]);
		const onB = await contextsOn(b).get(c.id);
		expect(onB).toMatchObject({ body: "Spaces, two\n", version: 2 });
		expect(onB?.author.kind).toBe("human");
		// Putting the original file back is a stale version now: nothing changes.
		writeFileSync(file, renderOld(c));
		const stale = await importOf(b, projB);
		expect(stale.body.unchanged).toEqual([".clmesh/memory/style.md"]);
		expect((await contextsOn(b).get(c.id))?.version).toBe(2);
	});

	function renderOld(c: Context): string {
		return `---\nid: ${c.id}\ntype: memory\ntitle: "Style"\nversion: 1\nsha256: ${c.sha256}\nscope: project\nshareable: true\nauthor: "human@node"\nupdated: ${c.updatedAt}\n---\n\nTabs\n`;
	}

	it("a file edited from an older version while the context moved on locally is a conflict, not a merge", async () => {
		const c = await mk(a, wsA, { title: "Style", body: "Tabs", shareable: true, projectId: projA.id });
		await publish();
		await importOf(b, projB);
		await contextsOn(b).edit(c.id, { body: "Tabs, locally changed" });
		const file = path.join(clmesh(repo.workB), "memory/style.md");
		writeFileSync(file, readFileSync(file, "utf8").replace("Tabs", "Spaces from git"));
		const res = await importOf(b, projB);
		expect(res.body.conflicts).toEqual([".clmesh/memory/style.md"]);
		const onB = await contextsOn(b).get(c.id);
		expect(onB?.body).toBe("Tabs, locally changed\n");
		expect(onB?.sync.state).toBe("conflict");
		expect(onB?.sync.conflict?.body).toBe("Spaces from git\n");
		// Resolved by a person, like any conflict.
		const resolved = await api(b).post<Context>(`/contexts/${c.id}/resolve`, { keep: "remote" });
		expect(resolved.body.body).toBe("Spaces from git\n");
	});

	it("skips and reports files with a secret, bad front matter, another workspace's context or a private one", async () => {
		const priv = await mk(b, wsB, { title: "Mine alone", body: "private", projectId: projB.id });
		const foreign = await mk(a, wsA, { title: "Elsewhere", body: "other workspace", shareable: true });
		await publish();
		const dir = clmesh(repo.workB);
		mkdirSync(path.join(dir, "memory"), { recursive: true });
		const token = `ghp_${"aB3dE5gH7jK9mN1pQ3rS5tU7vW9xY1zA2bC4".slice(0, 36)}`;
		const front = (id: string, title: string) => `---\nid: ${id}\ntype: memory\ntitle: "${title}"\nversion: 1\nsha256: ${"a".repeat(64)}\nscope: workspace\nshareable: true\n---\n\n`;
		writeFileSync(path.join(dir, "memory/leaky.md"), `${front("ctx_1111111111111111", "Leaky")}token ${token}\n`);
		writeFileSync(path.join(dir, "memory/broken.md"), "no front matter at all\n");
		writeFileSync(path.join(dir, "memory/private-clash.md"), `${front(priv.id, "Mine alone")}public now?\n`);
		writeFileSync(path.join(dir, "memory/wrong-dir.md"), front("ctx_2222222222222222", "x").replace("type: memory", "type: plan"));
		writeFileSync(path.join(dir, "memory/not-shareable.md"), front("ctx_3333333333333333", "n").replace("shareable: true", "shareable: false"));
		// A link is never followed.
		writeFileSync(path.join(repo.root, "outside.md"), `${front("ctx_4444444444444444", "Outside")}via link\n`);
		const { symlinkSync } = await import("node:fs");
		symlinkSync(path.join(repo.root, "outside.md"), path.join(dir, "memory/link.md"));
		const res = await importOf(b, projB);
		const reasons = Object.fromEntries(res.body.skipped.map((s) => [s.path, s.reason]));
		expect(reasons[".clmesh/memory/leaky.md"]).toMatch(/possible secret \(github-token@/);
		expect(reasons[".clmesh/memory/broken.md"]).toBe("no front matter");
		expect(reasons[".clmesh/memory/private-clash.md"]).toBe("private on this node");
		expect(reasons[".clmesh/memory/wrong-dir.md"]).toMatch(/does not belong/);
		expect(reasons[".clmesh/memory/not-shareable.md"]).toBe("not marked shareable");
		expect(".clmesh/memory/link.md" in reasons).toBe(false);
		for (const id of ["ctx_1111111111111111", "ctx_2222222222222222", "ctx_3333333333333333", "ctx_4444444444444444"]) expect(await contextsOn(b).get(id)).toBeUndefined();
		expect((await contextsOn(b).get(priv.id))?.body).toBe("private\n");
		expect(res.body.created).toContain(`.clmesh/memory/elsewhere.md`);
		expect(foreign.shareable).toBe(true);
	});

	it("a context deleted on B is not brought back by an older file", async () => {
		const c = await mk(a, wsA, { title: "Temporary", body: "x", shareable: true, projectId: projA.id });
		await publish();
		await importOf(b, projB);
		await api(b).del(`/contexts/${c.id}`);
		const res = await importOf(b, projB);
		expect(res.body.unchanged).toEqual([".clmesh/memory/temporary.md"]);
		expect(await contextsOn(b).get(c.id)).toBeUndefined();
	});

	it("an import with no .clmesh/ directory is an empty result", async () => {
		const res = await importOf(b, projB);
		expect(res.body).toEqual({ created: [], updated: [], unchanged: [], conflicts: [], skipped: [] });
	});
});
