import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { GitEngine } from "../src/index.ts";
import { captureWrapper, commitAll, makeFixture, newEngine, read, sh, tmpRoot, write } from "./helpers.ts";

/** Hash of every non-.git file (path + bytes) so "untouched" can be asserted byte-for-byte. */
function worktreeDigest(dir: string): string {
	const h = createHash("sha256");
	const walk = (rel: string) => {
		for (const name of readdirSync(join(dir, rel)).sort()) {
			if (name === ".git") continue;
			const r = rel ? `${rel}/${name}` : name;
			if (statSync(join(dir, r)).isDirectory()) walk(r);
			else h.update(r).update("\0").update(readFileSync(join(dir, r))).update("\0");
		}
	};
	walk("");
	return h.digest("hex");
}

const FORBIDDEN_COMMANDS = new Set(["reset", "stash", "clean", "rebase", "cherry-pick", "revert", "gc", "prune"]);

describe("fetch / pull / push (local bare remote, two clones)", () => {
	let engine: GitEngine;
	let capture: ReturnType<typeof captureWrapper>;
	beforeAll(async () => {
		const root = tmpRoot();
		capture = captureWrapper(root);
		engine = await newEngine(root, capture.bin);
	});

	it("pull: up-to-date, then fast-forward keeps unrelated dirty files", async () => {
		const fx = makeFixture();
		expect(await engine.pull(fx.b, {})).toMatchObject({ result: "up-to-date", reason: null, paths: [] });

		write(fx.a, "src/new.ts", "export const n = 1;\n");
		commitAll(fx.a, "add new");
		sh(fx.a, "push", "-q");

		write(fx.b, "README.md", "# local edit not overlapping\n");
		write(fx.b, "scratch.txt", "untracked scratch\n");
		const r = await engine.pull(fx.b, {});
		expect(r).toMatchObject({ result: "fast-forward", reason: null });
		expect(r.message).toContain("Fast-forward");
		expect(read(fx.b, "src/new.ts")).toBe("export const n = 1;\n");
		expect(read(fx.b, "README.md")).toBe("# local edit not overlapping\n");
		expect(read(fx.b, "scratch.txt")).toBe("untracked scratch\n");
		expect(await engine.status(fx.b)).toMatchObject({ ahead: 0, behind: 0 });
	});

	it("pull refuses (dirty-overlap) when local changes intersect incoming files; worktree byte-identical", async () => {
		const fx = makeFixture();
		write(fx.a, "src/app.ts", "upstream change\n");
		write(fx.a, "brand-new.txt", "upstream new file\n");
		commitAll(fx.a, "upstream edits");
		sh(fx.a, "push", "-q");

		write(fx.b, "src/app.ts", "my uncommitted edit\n");
		write(fx.b, "brand-new.txt", "my untracked file with the same name\n");
		write(fx.b, "other.txt", "unrelated\n");
		const before = worktreeDigest(fx.b);
		const headBefore = sh(fx.b, "rev-parse", "HEAD");

		const r = await engine.pull(fx.b, {});
		expect(r).toMatchObject({ result: "refused", reason: "dirty-overlap" });
		expect(r.paths).toEqual(["brand-new.txt", "src/app.ts"]);
		expect(worktreeDigest(fx.b)).toBe(before);
		expect(sh(fx.b, "rev-parse", "HEAD")).toBe(headBefore);
		expect(sh(fx.b, "status", "--porcelain=v1")).toContain("M src/app.ts");

		// Staged-only local changes count as dirty too.
		sh(fx.b, "checkout", "--", "src/app.ts");
		write(fx.b, "src/app.ts", "staged edit\n");
		sh(fx.b, "add", "src/app.ts");
		rmSync(join(fx.b, "brand-new.txt"));
		const r2 = await engine.pull(fx.b, {});
		expect(r2).toMatchObject({ result: "refused", reason: "dirty-overlap" });
		expect(r2.paths).toContain("src/app.ts");
	});

	it("pull refuses diverged branches and reports textual conflict paths", async () => {
		const fx = makeFixture();
		write(fx.a, "src/app.ts", "A version\n");
		commitAll(fx.a, "A edits app");
		sh(fx.a, "push", "-q");
		write(fx.b, "src/app.ts", "B version\n");
		write(fx.b, "b-only.txt", "b\n");
		commitAll(fx.b, "B edits app");
		const before = worktreeDigest(fx.b);
		const head = sh(fx.b, "rev-parse", "HEAD");
		const r = await engine.pull(fx.b, {});
		expect(r).toMatchObject({ result: "refused", reason: "diverged", paths: ["src/app.ts"] });
		expect(r.message).toContain("1 ahead, 1 behind");
		expect(worktreeDigest(fx.b)).toBe(before);
		expect(sh(fx.b, "rev-parse", "HEAD")).toBe(head);
		expect(existsSync(join(fx.b, ".git", "MERGE_HEAD"))).toBe(false);
	});

	it("pull refuses without upstream, when detached, and during a merge", async () => {
		const fx = makeFixture();
		await engine.createBranch(fx.b, { name: "no-upstream", checkout: true });
		expect(await engine.pull(fx.b, {})).toMatchObject({ result: "refused", reason: "no-upstream" });
		sh(fx.b, "checkout", "-q", "--detach");
		expect(await engine.pull(fx.b, {})).toMatchObject({ result: "refused", reason: "detached" });

		sh(fx.b, "switch", "-q", "main");
		write(fx.a, "src/app.ts", "A\n");
		commitAll(fx.a, "A");
		sh(fx.a, "push", "-q");
		write(fx.b, "src/app.ts", "B\n");
		commitAll(fx.b, "B");
		sh(fx.b, "fetch", "-q");
		expect(() => sh(fx.b, "merge", "origin/main")).toThrow();
		expect(await engine.pull(fx.b, {})).toMatchObject({ result: "refused", reason: "operation-in-progress" });
	});

	it("push: new branch with upstream, up-to-date, ff update; never uses force", async () => {
		const fx = makeFixture();
		await engine.createBranch(fx.a, { name: "feature/x", checkout: true });
		write(fx.a, "x.txt", "x\n");
		commitAll(fx.a, "x");
		const first = await engine.push(fx.a, { setUpstream: true });
		expect(first).toMatchObject({ result: "pushed", reason: null });
		expect(sh(fx.remote, "rev-parse", "refs/heads/feature/x")).toBe(sh(fx.a, "rev-parse", "HEAD"));
		expect((await engine.status(fx.a)).upstream).toBe("origin/feature/x");

		expect(await engine.push(fx.a, { setUpstream: true })).toMatchObject({ result: "up-to-date", reason: null });
		write(fx.a, "x.txt", "x2\n");
		commitAll(fx.a, "x2");
		expect(await engine.push(fx.a, { setUpstream: false })).toMatchObject({ result: "pushed" });

		// setUpstream:false on an untracked new branch leaves it without upstream
		await engine.createBranch(fx.a, { name: "no-track", checkout: true });
		write(fx.a, "y.txt", "y\n");
		commitAll(fx.a, "y");
		expect(await engine.push(fx.a, { setUpstream: false })).toMatchObject({ result: "pushed" });
		expect((await engine.status(fx.a)).upstream).toBeNull();
		expect(sh(fx.remote, "rev-parse", "--verify", "refs/heads/no-track").trim()).toHaveLength(40);
	});

	it("push rejects non-fast-forward, never forces, and leaves the remote unchanged", async () => {
		const fx = makeFixture();
		write(fx.a, "a.txt", "from A\n");
		commitAll(fx.a, "A");
		sh(fx.a, "push", "-q");
		const remoteHead = sh(fx.remote, "rev-parse", "main");

		write(fx.b, "b.txt", "from B\n");
		commitAll(fx.b, "B");
		const r = await engine.push(fx.b, { setUpstream: true });
		expect(r).toMatchObject({ result: "rejected", reason: "non-fast-forward" });
		expect(r.message).toMatch(/fetch first|non-fast-forward|rejected/);
		expect(sh(fx.remote, "rev-parse", "main")).toBe(remoteHead);

		for (const { argv } of capture.invocations()) {
			expect(FORBIDDEN_COMMANDS.has(argv.find((a, i) => i > 0 && !a.startsWith("-") && argv[i - 1] !== "-c") ?? "")).toBe(false);
			expect(argv.some((a) => a === "-f" || a.startsWith("--force") || /^\+/.test(a) || /:\+/.test(a))).toBe(false);
		}
		const pushes = capture.invocations().filter((i) => i.argv.includes("push") && i.argv.includes("--porcelain"));
		expect(pushes.length).toBeGreaterThan(0);
		for (const p of pushes) expect(p.argv.filter((a) => a.startsWith("refs/heads/")).every((a) => /^refs\/heads\/[^:]+:refs\/heads\/[^:]+$/.test(a))).toBe(true);
	});

	it("surfaces remote hook rejections verbatim (protected branch and other)", async () => {
		const fx = makeFixture();
		const hook = join(fx.remote, "hooks", "pre-receive");
		writeFileSync(hook, "#!/bin/sh\necho 'GH006: Protected branch update failed for refs/heads/main.' >&2\necho 'Changes must be made through a pull request.' >&2\nexit 1\n");
		chmodSync(hook, 0o755);
		write(fx.a, "p.txt", "p\n");
		commitAll(fx.a, "protected?");
		const r = await engine.push(fx.a, { setUpstream: true });
		expect(r).toMatchObject({ result: "rejected", reason: "protected-branch" });
		expect(r.message).toContain("remote: GH006: Protected branch update failed for refs/heads/main.");
		expect(r.message).toContain("remote: Changes must be made through a pull request.");

		writeFileSync(hook, "#!/bin/sh\necho 'commit message lacks a ticket id' >&2\nexit 1\n");
		const r2 = await engine.push(fx.a, { setUpstream: true });
		expect(r2).toMatchObject({ result: "rejected", reason: "other" });
		expect(r2.message).toContain("remote: commit message lacks a ticket id");

		writeFileSync(hook, "#!/bin/sh\necho 'Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization.' >&2\nexit 1\n");
		expect(await engine.push(fx.a, { setUpstream: true })).toMatchObject({ result: "rejected", reason: "sso" });
	});

	it("push: detached HEAD and operations in progress", async () => {
		const fx = makeFixture();
		sh(fx.a, "checkout", "-q", "--detach");
		expect(await engine.push(fx.a, { setUpstream: true })).toMatchObject({ result: "rejected", reason: "other" });
		sh(fx.a, "switch", "-q", "main");
		write(fx.a, "src/app.ts", "A\n");
		commitAll(fx.a, "A");
		sh(fx.a, "switch", "-qc", "t", "HEAD~1");
		write(fx.a, "src/app.ts", "T\n");
		commitAll(fx.a, "T");
		expect(() => sh(fx.a, "merge", "main")).toThrow();
		await expect(engine.push(fx.a, { setUpstream: true })).rejects.toMatchObject({ code: "operation_in_progress" });
	});

	it("no destructive git subcommand or flag was ever issued by the engine", () => {
		const invocations = capture.invocations();
		expect(invocations.length).toBeGreaterThan(20);
		for (const { argv } of invocations) {
			const sub = argv.find((a, i) => !a.startsWith("-") && (i === 0 || argv[i - 1] !== "-c"));
			expect(FORBIDDEN_COMMANDS.has(sub ?? "")).toBe(false);
			if (sub === "merge") expect(argv).toContain("--ff-only");
			if (sub === "checkout" || sub === "switch") expect(argv).not.toContain("-f");
			expect(argv).not.toContain("--hard");
			expect(argv).not.toContain("--force-with-lease");
		}
	});
});

describe("conflicts (merge-tree dry run)", () => {
	let engine: GitEngine;
	beforeAll(async () => {
		engine = await newEngine(tmpRoot());
	});

	it("reports textual conflicts and types without touching the worktree or index", async () => {
		const fx = makeFixture();
		write(fx.a, "src/app.ts", "A version\n");
		sh(fx.a, "rm", "-q", "README.md");
		commitAll(fx.a, "A edits app, deletes README");
		sh(fx.a, "push", "-q");
		write(fx.b, "src/app.ts", "B version\n");
		write(fx.b, "README.md", "# B edits readme\n");
		commitAll(fx.b, "B edits");
		sh(fx.b, "fetch", "-q");
		write(fx.b, "dirty.txt", "dirty\n");
		const digest = worktreeDigest(fx.b);
		const stBefore = sh(fx.b, "status", "--porcelain=v2");

		const report = await engine.conflicts(fx.b, {});
		expect(report).toMatchObject({ against: "origin/main", ahead: 1, behind: 1, clean: false, dirtyOverlap: [] });
		expect(report.conflicts).toEqual([
			{ path: "README.md", type: "modify/delete" },
			{ path: "src/app.ts", type: "content" },
		]);
		expect(worktreeDigest(fx.b)).toBe(digest);
		expect(sh(fx.b, "status", "--porcelain=v2")).toBe(stBefore);
		expect(existsSync(join(fx.b, ".git", "MERGE_HEAD"))).toBe(false);

		const explicit = await engine.conflicts(fx.b, { against: "origin/main" });
		expect(explicit.conflicts).toHaveLength(2);
	});

	it("is clean when histories merge, and reports dirty overlap with incoming changes", async () => {
		const fx = makeFixture();
		write(fx.a, "src/app.ts", "export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\n");
		commitAll(fx.a, "A appends");
		sh(fx.a, "push", "-q");
		write(fx.b, "README.md", "# changed\n");
		commitAll(fx.b, "B readme");
		write(fx.b, "src/app.ts", "local uncommitted\n");
		await engine.fetch(fx.b, {});
		const r = await engine.conflicts(fx.b, {});
		expect(r).toMatchObject({ clean: true, conflicts: [], ahead: 1, behind: 1, dirtyOverlap: ["src/app.ts"] });
	});

	it("errors when there is nothing to compare against", async () => {
		const fx = makeFixture();
		await engine.createBranch(fx.a, { name: "solo", checkout: true });
		await expect(engine.conflicts(fx.a, {})).rejects.toMatchObject({ code: "invalid_ref" });
		await expect(engine.conflicts(fx.a, { against: "nope" })).rejects.toMatchObject({ code: "invalid_ref" });
	});
});

describe("clone (local transport)", () => {
	let engine: GitEngine;
	beforeAll(async () => {
		engine = await newEngine(tmpRoot());
	});

	it("clones into an absent or empty directory, reports progress, refuses non-empty destinations", async () => {
		const fx = makeFixture();
		const dest = join(fx.root, "new", "nested", "clone");
		const phases: string[] = [];
		await engine.clone(`file://${fx.remote}`, dest, { onProgress: (p) => phases.push(p.phase) });
		expect(read(dest, "README.md")).toBe("# demo\n");
		expect(phases).toContain("Cloning");
		expect(await engine.status(dest)).toMatchObject({ branch: "main", upstream: "origin/main" });

		await expect(engine.clone(`file://${fx.remote}`, dest, {})).rejects.toMatchObject({ code: "dest_not_empty" });
		expect(read(dest, "README.md")).toBe("# demo\n");

		const empty = join(fx.root, "empty");
		mkdirSync(empty);
		await engine.clone(fx.remote, empty, { branch: "main" });
		expect(existsSync(join(empty, "README.md"))).toBe(true);
	});

	it("cleans up after failure and rejects URLs that embed credentials", async () => {
		const root = tmpRoot();
		const dest = join(root, "will-fail");
		await expect(engine.clone(join(root, "no-such-repo.git"), dest, {})).rejects.toMatchObject({ code: "failed" });
		expect(existsSync(dest)).toBe(false);
		await expect(engine.clone("https://user:pw@example.com/x/y.git", join(root, "d2"), {})).rejects.toThrow(/credentials/);
		await expect(engine.clone("-oProxyCommand=evil", join(root, "d3"), {})).rejects.toMatchObject({ code: "invalid_ref" });
		const ac = new AbortController();
		ac.abort();
		await expect(engine.clone("https://127.0.0.1:9/x.git", join(root, "d4"), { signal: ac.signal })).rejects.toThrow(/abort/);
		expect(existsSync(join(root, "d4"))).toBe(false);
	});
});
