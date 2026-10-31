import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitEngineError } from "../src/index.ts";
import { commitAll, configUser, newEngine, read, sh, tmpRoot, write } from "./helpers.ts";

function seededRepo(root: string): { repo: string; base: string } {
	const repo = join(root, "repo");
	sh(root, "init", "-q", "-b", "main", repo);
	configUser(repo);
	write(repo, "a.txt", "one\n");
	const base = commitAll(repo, "base");
	return { repo, base };
}

function rawGit(cwd: string, args: string[]): Buffer {
	return execFileSync("git", args, { cwd, env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

describe("formatPatch", () => {
	it("produces an mbox that `git am` applies to a fresh clone, reproducing the tree (binary included)", async () => {
		const root = tmpRoot();
		const { repo, base } = seededRepo(root);
		sh(repo, "checkout", "-q", "-b", "feature");
		write(repo, "a.txt", "one\ntwo\n");
		writeFileSync(join(repo, "blob.bin"), Buffer.from([0, 1, 2, 3, 255, 254, 0, 128, 7, 0]));
		commitAll(repo, "first");
		write(repo, "dir/b.txt", "bee\n");
		writeFileSync(join(repo, "blob.bin"), Buffer.from([9, 0, 0, 255, 1, 2, 3, 4]));
		const head = commitAll(repo, "second");

		const engine = await newEngine(root);
		const { patch, commits } = await engine.formatPatch(repo, { base });
		expect(commits).toBe(2);
		expect(patch.length).toBeGreaterThan(0);
		const text = patch.toString("utf8");
		expect(text.indexOf("Subject: [PATCH 1/2] first")).toBeGreaterThanOrEqual(0);
		expect(text.indexOf("Subject: [PATCH 2/2] second")).toBeGreaterThan(text.indexOf("[PATCH 1/2]"));

		const clone = join(root, "clone");
		sh(root, "clone", "-q", repo, clone);
		sh(clone, "checkout", "-q", "-b", "applied", base);
		configUser(clone, "Applier", "applier@example.com");
		const mbox = join(root, "out.mbox");
		writeFileSync(mbox, patch);
		sh(clone, "am", "--quiet", mbox);

		expect(sh(clone, "rev-parse", "HEAD^{tree}").trim()).toBe(sh(repo, "rev-parse", `${head}^{tree}`).trim());
		expect(read(clone, "a.txt")).toBe("one\ntwo\n");
		expect(readFileSync(join(clone, "blob.bin"))).toEqual(Buffer.from([9, 0, 0, 255, 1, 2, 3, 4]));
	});

	it("is byte-identical to running git directly, and honours an explicit head", async () => {
		const root = tmpRoot();
		const { repo, base } = seededRepo(root);
		write(repo, "a.txt", "one\ntwo\n");
		const mid = commitAll(repo, "mid");
		write(repo, "a.txt", "one\ntwo\nthree\n");
		commitAll(repo, "tip");

		const engine = await newEngine(root);
		const full = await engine.formatPatch(repo, { base });
		expect(full.patch.equals(rawGit(repo, ["format-patch", "--stdout", "--binary", "--no-color", `${base}..HEAD`]))).toBe(true);

		const partial = await engine.formatPatch(repo, { base, head: mid });
		expect(partial.commits).toBe(1);
		expect(partial.patch.equals(rawGit(repo, ["format-patch", "--stdout", "--binary", "--no-color", `${base}..${mid}`]))).toBe(true);
	});

	it("returns an empty buffer and 0 commits for an empty range", async () => {
		const root = tmpRoot();
		const { repo, base } = seededRepo(root);
		const engine = await newEngine(root);
		const r = await engine.formatPatch(repo, { base });
		expect(r.commits).toBe(0);
		expect(r.patch.length).toBe(0);
		const same = await engine.formatPatch(repo, { base: "HEAD", head: base });
		expect(same).toEqual({ patch: Buffer.alloc(0), commits: 0 });
	});

	it("works without any configured identity", async () => {
		const root = tmpRoot();
		const { repo, base } = seededRepo(root);
		write(repo, "a.txt", "changed\n");
		commitAll(repo, "change");
		sh(repo, "config", "--unset", "user.name");
		sh(repo, "config", "--unset", "user.email");
		const engine = await newEngine(root);
		expect((await engine.formatPatch(repo, { base })).commits).toBe(1);
	});

	it("rejects option-like and unknown refs with invalid_ref", async () => {
		const root = tmpRoot();
		const { repo, base } = seededRepo(root);
		const engine = await newEngine(root);
		for (const o of [{ base: "--output=/tmp/x" }, { base: "-1" }, { base, head: "--stdout" }, { base: "no-such-ref" }, { base, head: "no-such-ref" }, { base: "" }]) {
			const err = await engine.formatPatch(repo, o).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(GitEngineError);
			expect((err as GitEngineError).code).toBe("invalid_ref");
		}
	});

	it("rejects a directory that is not a repo root", async () => {
		const root = tmpRoot();
		const engine = await newEngine(root);
		const err = await engine.formatPatch(root, { base: "HEAD" }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(GitEngineError);
		expect((err as GitEngineError).code).toBe("not_a_repo");
	});
});
