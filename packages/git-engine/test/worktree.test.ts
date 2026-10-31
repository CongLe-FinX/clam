import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { GitEngine } from "../src/index.ts";
import { commitAll, makeFixture, newEngine, read, sh, tmpRoot, write } from "./helpers.ts";

const author = { name: "Agent Smith", email: "smith@example.com" };

describe("commit / log / branches", () => {
	let engine: GitEngine;
	beforeAll(async () => {
		engine = await newEngine(tmpRoot());
	});

	it("commits staged changes with author, multi-line body and trailers; log parses them", async () => {
		const fx = makeFixture();
		const a = fx.a;
		write(a, "src/app.ts", "export const a = 100;\n");
		await engine.stage(a, ["src/app.ts"]);
		const c = await engine.commit(a, {
			message: "feat: change a\n\nLonger body\nsecond line\n\nCo-authored-by: Someone <s@example.com>",
			author,
			trailers: { Agent: "OMP Agent@my-mac", "Task-Id": "t-1" },
		});
		expect(c).toMatchObject({ subject: "feat: change a", authorName: "Agent Smith", authorEmail: "smith@example.com" });
		expect(c.trailers).toMatchObject({ Agent: "OMP Agent@my-mac", "Task-Id": "t-1", "Co-authored-by": "Someone <s@example.com>" });
		expect(c.body).toContain("Longer body\nsecond line");
		expect(c.parents).toHaveLength(1);
		expect(c.refs).toEqual(expect.arrayContaining(["HEAD", "main"]));
		expect(new Date(c.authoredAt).toISOString()).toBe(c.authoredAt);
		expect(sh(a, "log", "-1", "--format=%cn <%ce>").trim()).toBe("Agent Smith <smith@example.com>");
		expect((await engine.status(a)).clean).toBe(true);
	});

	it("commits only the given paths and leaves other staged changes staged", async () => {
		const fx = makeFixture();
		const a = fx.a;
		write(a, "one.txt", "1\n");
		write(a, "two.txt", "2\n");
		write(a, "three.txt", "3\n");
		await engine.stage(a, ["two.txt"]);
		const c = await engine.commit(a, { message: "only one and three", paths: ["one.txt", "three.txt"], author });
		expect(sh(a, "show", "--name-only", "--format=", c.sha).trim().split("\n").sort()).toEqual(["one.txt", "three.txt"]);
		const st = await engine.status(a);
		expect(st.files).toEqual([{ path: "two.txt", origPath: null, kind: "added", staged: true, unstaged: false }]);
	});

	it("refuses to commit when nothing is staged and an empty message", async () => {
		const fx = makeFixture();
		await expect(engine.commit(fx.a, { message: "nothing", author })).rejects.toMatchObject({ code: "failed" });
		await expect(engine.commit(fx.a, { message: "   ", author })).rejects.toMatchObject({ code: "failed" });
		await expect(engine.commit(fx.a, { message: "x", author, trailers: { "bad key": "v" } })).rejects.toMatchObject({ code: "failed" });
	});

	it("commits into an empty repository and pages the log with a cursor", async () => {
		const dir = tmpRoot();
		sh(dir, "init", "-q", "-b", "main");
		expect(await engine.log(dir, { limit: 5 })).toEqual({ commits: [], nextCursor: null });
		const shas: string[] = [];
		for (let i = 0; i < 5; i++) {
			write(dir, `f${i}.txt`, `${i}\n`);
			await engine.stage(dir, [`f${i}.txt`]);
			shas.push((await engine.commit(dir, { message: `commit ${i}`, author })).sha);
		}
		const p1 = await engine.log(dir, { limit: 2 });
		expect(p1.commits.map((c) => c.subject)).toEqual(["commit 4", "commit 3"]);
		expect(p1.nextCursor).not.toBeNull();
		// new commits after the first page must not shift later pages
		write(dir, "late.txt", "late\n");
		await engine.stage(dir, ["late.txt"]);
		await engine.commit(dir, { message: "late", author });
		const p2 = await engine.log(dir, { limit: 2, cursor: p1.nextCursor ?? undefined });
		expect(p2.commits.map((c) => c.subject)).toEqual(["commit 2", "commit 1"]);
		const p3 = await engine.log(dir, { limit: 2, cursor: p2.nextCursor ?? undefined });
		expect(p3.commits.map((c) => c.subject)).toEqual(["commit 0"]);
		expect(p3.nextCursor).toBeNull();
		await expect(engine.log(dir, { limit: 2, cursor: "bogus" })).rejects.toMatchObject({ code: "invalid_ref" });
		expect((await engine.log(dir, { ref: shas[1], limit: 10 })).commits.map((c) => c.subject)).toEqual(["commit 1", "commit 0"]);
	});

	it("lists local and remote branches with tracking info, skipping origin/HEAD", async () => {
		const fx = makeFixture();
		const a = fx.a;
		sh(a, "switch", "-qc", "feature");
		write(a, "f.txt", "f\n");
		commitAll(a, "feature work");
		sh(a, "push", "-q", "-u", "origin", "feature");
		sh(a, "commit", "-q", "--allow-empty", "-m", "unpushed");
		sh(a, "remote", "set-head", "origin", "main");
		const list = await engine.branches(a);
		const feature = list.find((b) => b.name === "feature" && !b.remote);
		expect(feature).toMatchObject({ current: true, upstream: "origin/feature", ahead: 1, behind: 0, subject: "unpushed" });
		expect(list.find((b) => b.name === "main" && !b.remote)).toMatchObject({ current: false, upstream: "origin/main", ahead: 0, behind: 0 });
		expect(list.find((b) => b.name === "origin/feature")).toMatchObject({ remote: true, upstream: null, ahead: null });
		expect(list.some((b) => b.name === "origin/HEAD" || b.name === "origin")).toBe(false);
	});
});

describe("branches: create / checkout", () => {
	let engine: GitEngine;
	beforeAll(async () => {
		engine = await newEngine(tmpRoot());
	});

	it("creates (with and without checkout), validates names, refuses duplicates", async () => {
		const fx = makeFixture();
		const a = fx.a;
		await engine.createBranch(a, { name: "clam/node/task-1", checkout: true });
		expect((await engine.status(a)).branch).toBe("clam/node/task-1");
		await engine.createBranch(a, { name: "other", from: "main", checkout: false });
		expect((await engine.status(a)).branch).toBe("clam/node/task-1");
		expect((await engine.branches(a)).some((b) => b.name === "other")).toBe(true);
		for (const bad of ["-x", "a..b", "with space", "end.lock", "a~b", ""]) {
			await expect(engine.createBranch(a, { name: bad, checkout: false })).rejects.toMatchObject({ code: "invalid_ref" });
		}
		await expect(engine.createBranch(a, { name: "other", checkout: false })).rejects.toMatchObject({ code: "invalid_ref" });
		await expect(engine.createBranch(a, { name: "ok", from: "--oops", checkout: false })).rejects.toMatchObject({ code: "invalid_ref" });
	});

	it("checks out a remote-only branch as a tracking branch (bare name and origin/ name)", async () => {
		const fx = makeFixture();
		sh(fx.a, "switch", "-qc", "remote-only");
		write(fx.a, "r.txt", "r\n");
		commitAll(fx.a, "remote only");
		sh(fx.a, "push", "-q", "origin", "remote-only");
		sh(fx.a, "switch", "-qc", "second");
		sh(fx.a, "push", "-q", "origin", "second");
		await engine.fetch(fx.b, {});
		await engine.checkout(fx.b, "remote-only");
		expect(await engine.status(fx.b)).toMatchObject({ branch: "remote-only", upstream: "origin/remote-only" });
		await engine.checkout(fx.b, "origin/second");
		expect(await engine.status(fx.b)).toMatchObject({ branch: "second", upstream: "origin/second" });
		await engine.checkout(fx.b, "main");
		expect((await engine.status(fx.b)).branch).toBe("main");
		await expect(engine.checkout(fx.b, "no-such-branch")).rejects.toMatchObject({ code: "invalid_ref" });
		await expect(engine.checkout(fx.b, "-f")).rejects.toMatchObject({ code: "invalid_ref" });
	});

	it("refuses to switch when local changes would be overwritten and leaves the tree untouched", async () => {
		const fx = makeFixture();
		const a = fx.a;
		sh(a, "switch", "-qc", "other");
		write(a, "src/app.ts", "other version\n");
		commitAll(a, "other");
		sh(a, "switch", "-q", "main");
		write(a, "src/app.ts", "my precious local edit\n");
		await expect(engine.checkout(a, "other")).rejects.toMatchObject({ code: "would_overwrite" });
		expect(read(a, "src/app.ts")).toBe("my precious local edit\n");
		expect((await engine.status(a)).branch).toBe("main");
		// Non-conflicting local changes travel with the checkout.
		sh(a, "checkout", "--", "src/app.ts");
		write(a, "scratch.txt", "keep me\n");
		await engine.checkout(a, "other");
		expect(read(a, "scratch.txt")).toBe("keep me\n");
	});
});

describe("stage / unstage / discard", () => {
	let engine: GitEngine;
	beforeAll(async () => {
		engine = await newEngine(tmpRoot());
	});

	it("stages and unstages exactly the given paths (literal, including glob-looking names)", async () => {
		const fx = makeFixture();
		const a = fx.a;
		write(a, "*.txt", "star\n");
		write(a, "real.txt", "real\n");
		await engine.stage(a, ["*.txt"]);
		expect((await engine.status(a)).files.filter((f) => f.staged).map((f) => f.path)).toEqual(["*.txt"]);
		await engine.stage(a, ["real.txt"]);
		await engine.unstage(a, ["*.txt"]);
		const st = await engine.status(a);
		expect(st.files.find((f) => f.path === "*.txt")).toMatchObject({ staged: false, kind: "untracked" });
		expect(st.files.find((f) => f.path === "real.txt")).toMatchObject({ staged: true });
		await expect(engine.stage(a, ["../escape.txt"])).rejects.toMatchObject({ code: "invalid_ref" });
		await expect(engine.stage(a, [".git/config"])).rejects.toMatchObject({ code: "invalid_ref" });
	});

	it("unstages in a repository without commits", async () => {
		const dir = tmpRoot();
		sh(dir, "init", "-q", "-b", "main");
		write(dir, "a.txt", "a\n");
		write(dir, "b.txt", "b\n");
		await engine.stage(dir, ["a.txt", "b.txt"]);
		await engine.unstage(dir, ["a.txt"]);
		const st = await engine.status(dir);
		expect(st.files.map((f) => [f.path, f.staged]).sort()).toEqual([["a.txt", false], ["b.txt", true]]);
	});

	it("discard touches only the given paths", async () => {
		const fx = makeFixture();
		const a = fx.a;
		write(a, "keep.txt", "tracked\n");
		write(a, "docs/one.md", "1\n");
		commitAll(a, "more files");
		// changes: tracked-modified (given), tracked-modified (not given), untracked (given), untracked (not given), staged-new (given), deleted (given)
		write(a, "src/app.ts", "modified but discarded\n");
		write(a, "keep.txt", "modified and kept\n");
		write(a, "junk.txt", "junk\n");
		write(a, "unrelated.txt", "unrelated\n");
		write(a, "staged-new.txt", "new\n");
		sh(a, "add", "staged-new.txt");
		sh(a, "rm", "-q", "-f", "docs/one.md");

		await engine.discard(a, ["src/app.ts", "junk.txt", "staged-new.txt", "docs"]);
		expect(read(a, "src/app.ts")).toBe("export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");
		expect(existsSync(join(a, "junk.txt"))).toBe(false);
		expect(existsSync(join(a, "staged-new.txt"))).toBe(false);
		expect(read(a, "docs/one.md")).toBe("1\n");
		expect(read(a, "keep.txt")).toBe("modified and kept\n");
		expect(read(a, "unrelated.txt")).toBe("unrelated\n");
		const st = await engine.status(a);
		expect(st.files.map((f) => [f.path, f.kind]).sort()).toEqual([["keep.txt", "modified"], ["unrelated.txt", "untracked"]]);
	});

	it("discarding a staged rename restores the original and removes the new name; discarding an unknown path is a no-op", async () => {
		const fx = makeFixture();
		const a = fx.a;
		sh(a, "mv", "README.md", "RENAMED.md");
		await engine.discard(a, ["RENAMED.md"]);
		expect(existsSync(join(a, "README.md"))).toBe(true);
		expect(existsSync(join(a, "RENAMED.md"))).toBe(false);
		expect((await engine.status(a)).clean).toBe(true);
		await engine.discard(a, ["does/not/exist.txt"]);
		expect(readFileSync(join(a, "README.md"), "utf8")).toBe("# demo\n");
	});
});
