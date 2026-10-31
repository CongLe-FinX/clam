import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { GitEngine } from "../src/index.ts";
import { parseStatusV2 } from "../src/status.ts";
import { commitAll, configUser, makeFixture, newEngine, sh, tmpRoot, write } from "./helpers.ts";

describe("parseStatusV2", () => {
	it("parses branch headers, renames, conflicts and untracked paths", () => {
		const raw = [
			"# branch.oid 0123456789abcdef0123456789abcdef01234567",
			"# branch.head feature/x",
			"# branch.upstream origin/feature/x",
			"# branch.ab +2 -1",
			"1 .M N... 100644 100644 100644 aaaa bbbb dir/with space/file.ts",
			"2 R. N... 100644 100644 100644 aaaa bbbb R100 new name.txt",
			"old name.txt",
			"u UU N... 100644 100644 100644 100644 aaaa bbbb cccc conflict.txt",
			"? untracked/ü.txt",
			"",
		].join("\0");
		const s = parseStatusV2(raw);
		expect(s).toMatchObject({ branch: "feature/x", upstream: "origin/feature/x", ahead: 2, behind: 1, detached: false });
		expect(s.files).toEqual([
			{ path: "dir/with space/file.ts", origPath: null, kind: "modified", staged: false, unstaged: true },
			{ path: "new name.txt", origPath: "old name.txt", kind: "renamed", staged: true, unstaged: false },
			{ path: "conflict.txt", origPath: null, kind: "conflicted", staged: false, unstaged: true },
			{ path: "untracked/ü.txt", origPath: null, kind: "untracked", staged: false, unstaged: true },
		]);
	});

	it("handles detached HEAD and an unborn branch", () => {
		expect(parseStatusV2(["# branch.oid abc", "# branch.head (detached)", ""].join("\0"))).toMatchObject({ detached: true, branch: null, headSha: "abc" });
		expect(parseStatusV2(["# branch.oid (initial)", "# branch.head main", ""].join("\0"))).toMatchObject({ headSha: null, branch: "main" });
	});
});

describe("status (real repositories)", () => {
	let engine: GitEngine;
	beforeAll(async () => {
		engine = await newEngine(tmpRoot());
	});

	it("reports a non-repository without throwing", async () => {
		const dir = tmpRoot();
		const st = await engine.status(dir);
		expect(st.isRepo).toBe(false);
		expect(await engine.isRepo(dir)).toBe(false);
		expect(await engine.isRepo(join(dir, "missing"))).toBe(false);
	});

	it("does not treat a subdirectory of a repository as a repository root", async () => {
		const fx = makeFixture();
		mkdirSync(join(fx.a, "src"), { recursive: true });
		expect(await engine.isRepo(join(fx.a, "src"))).toBe(false);
		await expect(engine.stage(join(fx.a, "src"), ["app.ts"])).rejects.toMatchObject({ code: "not_a_repo" });
	});

	it("an empty repository has no head and an unborn branch", async () => {
		const dir = tmpRoot();
		sh(dir, "init", "-q", "-b", "trunk");
		const st = await engine.status(dir);
		expect(st).toMatchObject({ isRepo: true, branch: "trunk", headSha: null, clean: true, upstream: null, remotes: [] });
	});

	it("tracks staged, unstaged, renamed, deleted, untracked and unicode paths; ahead/behind; remotes; lastFetchedAt", async () => {
		const fx = makeFixture();
		const dir = fx.a;
		write(dir, "src/app.ts", "export const a = 1;\nexport const b = 22;\nexport const c = 3;\n");
		write(dir, "naïve file ü.txt", "hi\n");
		write(dir, "new dir/inner.txt", "x\n");
		sh(dir, "mv", "README.md", "READ ME.md");
		const st = await engine.status(dir);
		const byPath = Object.fromEntries(st.files.map((f) => [f.path, f]));
		expect(byPath["src/app.ts"]).toMatchObject({ kind: "modified", staged: false, unstaged: true });
		expect(byPath["naïve file ü.txt"]).toMatchObject({ kind: "untracked", unstaged: true, staged: false });
		expect(byPath["new dir/inner.txt"]).toMatchObject({ kind: "untracked" });
		expect(byPath["READ ME.md"]).toMatchObject({ kind: "renamed", origPath: "README.md", staged: true });
		expect(st).toMatchObject({ branch: "main", upstream: "origin/main", ahead: 0, behind: 0, clean: false, detached: false, operation: null });
		expect(st.remotes).toEqual([{ name: "origin", url: fx.remote, github: null }]);
		expect(st.lastFetchedAt).toBeNull();

		await engine.fetch(dir, {});
		expect((await engine.status(dir)).lastFetchedAt).not.toBeNull();

		commitAll(dir, "local");
		sh(dir, "commit", "-q", "--allow-empty", "-m", "second");
		expect(await engine.status(dir)).toMatchObject({ ahead: 2, behind: 0, clean: true });
	});

	it("reports detached HEAD", async () => {
		const fx = makeFixture();
		sh(fx.a, "checkout", "-q", "--detach");
		const st = await engine.status(fx.a);
		expect(st).toMatchObject({ detached: true, branch: null, upstream: null });
		expect(st.headSha).toMatch(/^[0-9a-f]{40}$/);
	});

	it("detects merge, rebase, cherry-pick and revert in progress (also in linked worktrees)", async () => {
		const fx = makeFixture();
		const a = fx.a;
		sh(a, "switch", "-qc", "side");
		write(a, "src/app.ts", "side\n");
		commitAll(a, "side change");
		sh(a, "switch", "-q", "main");
		write(a, "src/app.ts", "main\n");
		commitAll(a, "main change");
		const sideSha = sh(a, "rev-parse", "side").trim();

		expect(() => sh(a, "merge", "side")).toThrow();
		const merging = await engine.status(a);
		expect(merging.operation).toBe("merge");
		expect(merging.files.find((f) => f.path === "src/app.ts")).toMatchObject({ kind: "conflicted" });
		sh(a, "merge", "--abort");

		expect(() => sh(a, "cherry-pick", sideSha)).toThrow();
		expect((await engine.status(a)).operation).toBe("cherry-pick");
		sh(a, "cherry-pick", "--abort");

		expect(() => sh(a, "rebase", "side")).toThrow();
		expect((await engine.status(a)).operation).toBe("rebase");
		sh(a, "rebase", "--abort");

		const mainSha = sh(a, "rev-parse", "main").trim();
		expect(() => sh(a, "revert", "--no-edit", "HEAD~1")).toThrow();
		expect((await engine.status(a)).operation).toBe("revert");
		sh(a, "revert", "--abort");
		expect(mainSha).toHaveLength(40);

		// Linked worktree: state files live under .git/worktrees/<name>/
		const wt = join(fx.root, "wt");
		sh(a, "worktree", "add", "-q", "-b", "wt-branch", wt, "main~1");
		write(wt, "src/app.ts", "wt\n");
		commitAll(wt, "wt change");
		expect(() => sh(wt, "merge", "side")).toThrow();
		expect((await engine.status(wt)).operation).toBe("merge");
	});

	it("parses github remotes, strips credentials, reads identity", async () => {
		const dir = tmpRoot();
		sh(dir, "init", "-q", "-b", "main");
		configUser(dir);
		sh(dir, "remote", "add", "origin", "https://user:secretpass@github.com/octo/hello.git");
		sh(dir, "remote", "add", "up", "git@github.com:other/thing.git");
		const st = await engine.status(dir);
		expect(st.remotes).toEqual([
			{ name: "origin", url: "https://github.com/octo/hello.git", github: "octo/hello" },
			{ name: "up", url: "git@github.com:other/thing.git", github: "other/thing" },
		]);
		expect(await engine.githubRemote(dir)).toEqual({ owner: "octo", repo: "hello" });
		expect(await engine.configIdentity(dir)).toEqual({ name: "Test User", email: "test@example.com" });
		writeFileSync(join(dir, "x"), "x");
	});
});
