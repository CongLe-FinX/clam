import { existsSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { GitEngineError, type GitEngine } from "../src/index.ts";
import { makeFixture, newEngine, sh, tmpRoot, write } from "./helpers.ts";

async function codeOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (err) {
		if (err instanceof GitEngineError) return err.code;
		throw err;
	}
	return "ok";
}

describe("linked worktrees", () => {
	let engine: GitEngine;
	beforeAll(async () => {
		engine = await newEngine(tmpRoot());
	});

	it("adds a worktree on a new branch from HEAD without touching the main checkout", async () => {
		const f = makeFixture();
		write(f.a, "dirty.txt", "uncommitted\n");
		const wt = join(f.root, "wt", "one");
		await engine.worktreeAdd(f.a, { path: wt, branch: "feature/one", newBranch: true, startPoint: "HEAD" });
		expect(existsSync(join(wt, ".git"))).toBe(true);
		expect(existsSync(join(wt, "dirty.txt"))).toBe(false);
		expect((await engine.status(wt)).branch).toBe("feature/one");
		const main = await engine.status(f.a);
		expect(main.branch).toBe("main");
		expect(main.files.map((x) => x.path)).toEqual(["dirty.txt"]);
	});

	it("pushes a worktree branch with an upstream set from inside the worktree", async () => {
		const f = makeFixture();
		const wt = join(f.root, "wt");
		await engine.worktreeAdd(f.a, { path: wt, branch: "feat", newBranch: true, startPoint: "HEAD" });
		expect((await engine.status(wt)).upstream).toBeNull();
		const pushed = await engine.push(wt, { setUpstream: true });
		expect(pushed.result).toBe("pushed");
		expect((await engine.status(wt)).upstream).toBe("origin/feat");
	});

	it("creates a tracking worktree from a remote branch and fast-forwards it", async () => {
		const f = makeFixture();
		sh(f.a, "switch", "-q", "-c", "shared");
		write(f.a, "x.txt", "1\n");
		sh(f.a, "add", "-A");
		sh(f.a, "commit", "-q", "-m", "x");
		sh(f.a, "push", "-q", "-u", "origin", "shared");
		await engine.fetch(f.b, {});
		const wt = join(f.root, "wtb");
		await engine.worktreeAdd(f.b, { path: wt, branch: "shared", newBranch: true, startPoint: "origin/shared", track: true });
		const st = await engine.status(wt);
		expect(st.branch).toBe("shared");
		expect(st.upstream).toBe("origin/shared");
		expect((await engine.status(f.b)).branch).toBe("main");
		write(f.a, "y.txt", "2\n");
		sh(f.a, "add", "-A");
		sh(f.a, "commit", "-q", "-m", "y");
		sh(f.a, "push", "-q");
		const pulled = await engine.pull(wt, {});
		expect(pulled.result).toBe("fast-forward");
		expect(existsSync(join(wt, "y.txt"))).toBe(true);
	});

	it("attaches an existing local branch, and refuses one another working tree holds", async () => {
		const f = makeFixture();
		sh(f.a, "branch", "existing");
		const wt = join(f.root, "wt-existing");
		await engine.worktreeAdd(f.a, { path: wt, branch: "existing" });
		expect((await engine.status(wt)).branch).toBe("existing");
		expect(await codeOf(engine.worktreeAdd(f.a, { path: join(f.root, "other"), branch: "existing" }))).toBe("branch_in_worktree");
		expect(await codeOf(engine.worktreeAdd(f.a, { path: join(f.root, "other"), branch: "main" }))).toBe("branch_in_worktree");
		expect(await codeOf(engine.worktreeAdd(f.a, { path: join(f.root, "other"), branch: "nope" }))).toBe("invalid_ref");
		expect(await codeOf(engine.worktreeAdd(f.a, { path: join(f.root, "other"), branch: "existing", newBranch: true }))).toBe("invalid_ref");
	});

	it("lists worktrees (main first) and maps a branch switch onto a held branch to branch_in_worktree", async () => {
		const f = makeFixture();
		const wt = join(f.root, "wt-list");
		await engine.worktreeAdd(f.a, { path: wt, branch: "held", newBranch: true, startPoint: "HEAD" });
		const list = await engine.worktreeList(f.a);
		expect(list).toHaveLength(2);
		expect(realpathSync(list[0]?.path as string)).toBe(realpathSync(f.a));
		expect(list[0]?.branch).toBe("main");
		expect(list[1]).toMatchObject({ branch: "held", prunable: false });
		expect(realpathSync(list[1]?.path as string)).toBe(realpathSync(wt));
		expect(await codeOf(engine.checkout(f.a, "held"))).toBe("branch_in_worktree");
		expect((await engine.status(f.a)).branch).toBe("main");
	});

	it("removes a clean worktree (branch kept), refuses a dirty one without force, and prunes vanished ones", async () => {
		const f = makeFixture();
		const clean = join(f.root, "wt-clean");
		await engine.worktreeAdd(f.a, { path: clean, branch: "clean", newBranch: true, startPoint: "HEAD" });
		await engine.worktreeRemove(f.a, clean);
		expect(existsSync(clean)).toBe(false);
		expect(sh(f.a, "branch", "--list", "clean").trim()).toContain("clean");

		const dirty = join(f.root, "wt-dirty");
		await engine.worktreeAdd(f.a, { path: dirty, branch: "dirty", newBranch: true, startPoint: "HEAD" });
		write(dirty, "wip.txt", "work\n");
		expect(await codeOf(engine.worktreeRemove(f.a, dirty))).toBe("dirty_worktree");
		expect(existsSync(join(dirty, "wip.txt"))).toBe(true);

		rmSync(dirty, { recursive: true, force: true });
		expect((await engine.worktreeList(f.a)).some((w) => w.prunable)).toBe(true);
		await engine.worktreePrune(f.a);
		expect(await engine.worktreeList(f.a)).toHaveLength(1);
	});
});
