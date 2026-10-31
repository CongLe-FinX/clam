import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parsePatch, unquoteCPath } from "../src/diff.ts";
import type { GitEngine } from "../src/index.ts";
import { commitAll, makeFixture, newEngine, sh, tmpRoot, write } from "./helpers.ts";

describe("diff parsing (unit)", () => {
	it("decodes C-quoted paths", () => {
		expect(unquoteCPath('"a\\tb\\303\\251\\"q\\\\"')).toBe('a\tbé"q\\');
		expect(unquoteCPath("plain")).toBe("plain");
	});

	it("parses hunks with line numbers, no-newline markers and rename headers", () => {
		const patch = [
			"diff --git a/old name.txt b/new name.txt",
			"similarity index 90%",
			"rename from old name.txt",
			"rename to new name.txt",
			"index 111..222 100644",
			"--- a/old name.txt\t",
			"+++ b/new name.txt\t",
			"@@ -1,3 +1,3 @@ heading",
			" keep",
			"-gone",
			"+added",
			" tail",
			"\\ No newline at end of file",
			"diff --git a/bin.dat b/bin.dat",
			"new file mode 100644",
			"index 0000000..333",
			"Binary files /dev/null and b/bin.dat differ",
			"",
		].join("\n");
		const { files, truncated } = parsePatch(patch);
		expect(truncated).toBe(false);
		expect(files[0]).toMatchObject({ path: "new name.txt", oldPath: "old name.txt", status: "renamed", additions: 1, deletions: 1, binary: false });
		expect(files[0]?.hunks[0]?.lines).toEqual([
			{ type: "context", content: "keep", oldNo: 1, newNo: 1 },
			{ type: "del", content: "gone", oldNo: 2, newNo: null },
			{ type: "add", content: "added", oldNo: null, newNo: 2 },
			{ type: "context", content: "tail", oldNo: 3, newNo: 3 },
			{ type: "meta", content: "\\ No newline at end of file", oldNo: null, newNo: null },
		]);
		expect(files[0]?.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, header: "@@ -1,3 +1,3 @@ heading" });
		expect(files[1]).toMatchObject({ path: "bin.dat", status: "added", binary: true, hunks: [] });
	});
});

describe("diff (real repositories)", () => {
	let engine: GitEngine;
	beforeAll(async () => {
		engine = await newEngine(tmpRoot());
	});

	it("scopes: unstaged / staged / head / commit / range with line numbers, statuses and languages", async () => {
		const fx = makeFixture();
		const a = fx.a;
		write(a, "src/app.ts", "export const a = 1;\nexport const b = 22;\nexport const c = 3;\nexport const d = 4;\n");
		sh(a, "add", "src/app.ts");
		write(a, "README.md", "# demo\nmore\n");
		sh(a, "rm", "-q", "--cached", "README.md");
		write(a, "notes.txt", "n1\nn2");

		const staged = await engine.diff(a, { scope: "staged", context: 3 });
		expect(staged.files.map((f) => [f.path, f.status])).toEqual([
			["README.md", "deleted"],
			["src/app.ts", "modified"],
		]);
		const app = staged.files.find((f) => f.path === "src/app.ts");
		expect(app).toMatchObject({ additions: 2, deletions: 1, language: "typescript", binary: false, tooLarge: false });
		expect(app?.hunks[0]?.lines.filter((l) => l.type === "add").map((l) => l.newNo)).toEqual([2, 4]);

		const unstaged = await engine.diff(a, { scope: "unstaged", context: 3 });
		const un = Object.fromEntries(unstaged.files.map((f) => [f.path, f]));
		expect(un["notes.txt"]).toMatchObject({ status: "untracked", additions: 2 });
		expect(un["notes.txt"]?.hunks[0]?.lines.at(-1)).toMatchObject({ type: "meta" });
		expect(un["README.md"]).toMatchObject({ status: "untracked" });
		expect(un["src/app.ts"]).toBeUndefined();

		const head = await engine.diff(a, { scope: "head", context: 0 });
		// README.md appears twice: deleted from the index (vs HEAD) and present again as an untracked file.
		expect(head.files.map((f) => `${f.path}:${f.status}`).sort()).toEqual(["README.md:deleted", "README.md:untracked", "notes.txt:untracked", "src/app.ts:modified"]);
		expect(head.files.find((f) => f.path === "src/app.ts")?.hunks.every((h) => h.lines.every((l) => l.type !== "context"))).toBe(true);

		const only = await engine.diff(a, { scope: "head", context: 3, path: "notes.txt" });
		expect(only.files.map((f) => f.path)).toEqual(["notes.txt"]);

		const base = sh(a, "rev-parse", "HEAD").trim();
		const sha = commitAll(a, "second");
		const c = await engine.diff(a, { scope: "commit", commit: sha, context: 3 });
		expect(c.files.map((f) => f.path).sort()).toEqual(["README.md", "notes.txt", "src/app.ts"]);
		const first = await engine.diff(a, { scope: "commit", commit: base, context: 3 });
		expect(first.files.every((f) => f.status === "added")).toBe(true);
		const range = await engine.diff(a, { scope: "range", base, head: sha, context: 3 });
		expect(range.files.length).toBe(c.files.length);
		await expect(engine.diff(a, { scope: "commit", commit: "--evil", context: 3 })).rejects.toMatchObject({ code: "invalid_ref" });
		await expect(engine.diff(a, { scope: "commit", commit: "nope-nope", context: 3 })).rejects.toMatchObject({ code: "invalid_ref" });
	});

	it("handles renames, binary files, odd file names and untracked binaries", async () => {
		const fx = makeFixture();
		const a = fx.a;
		sh(a, "mv", "src/app.ts", "src/main app.ts");
		writeFileSync(join(a, "bin.dat"), Buffer.from([0, 1, 2, 3, 0, 255, 0]));
		write(a, 'we"ird\tname é.txt', "odd\n");
		const staged = await engine.diff(a, { scope: "staged", context: 3 });
		expect(staged.files).toHaveLength(1);
		expect(staged.files[0]).toMatchObject({ path: "src/main app.ts", oldPath: "src/app.ts", status: "renamed", additions: 0, deletions: 0 });

		const un = await engine.diff(a, { scope: "unstaged", context: 3 });
		const byPath = Object.fromEntries(un.files.map((f) => [f.path, f]));
		expect(byPath["bin.dat"]).toMatchObject({ binary: true, status: "untracked", hunks: [] });
		expect(byPath['we"ird\tname é.txt']).toMatchObject({ status: "untracked", additions: 1 });

		sh(a, "add", "-A");
		const binStaged = await engine.diff(a, { scope: "staged", context: 3 });
		expect(binStaged.files.find((f) => f.path === "bin.dat")).toMatchObject({ binary: true, status: "added" });
	});

	it("reports conflicts in an unmerged tree without failing", async () => {
		const fx = makeFixture();
		const a = fx.a;
		sh(a, "switch", "-qc", "side");
		write(a, "src/app.ts", "side\n");
		commitAll(a, "side");
		sh(a, "switch", "-q", "main");
		write(a, "src/app.ts", "main\n");
		commitAll(a, "main");
		expect(() => sh(a, "merge", "side")).toThrow();
		const d = await engine.diff(a, { scope: "unstaged", context: 3 });
		expect(d.files.some((f) => f.path === "src/app.ts")).toBe(true);
	});

	it("applies per-file and total caps", async () => {
		const fx = makeFixture();
		const a = fx.a;
		const big = `${Array.from({ length: 30_000 }, (_, i) => `line number ${i} of a very large file`).join("\n")}\n`;
		write(a, "huge.txt", big);
		write(a, "small.txt", "small\n");
		const d = await engine.diff(a, { scope: "unstaged", context: 3 });
		const huge = d.files.find((f) => f.path === "huge.txt");
		expect(huge).toMatchObject({ tooLarge: true, hunks: [], additions: 30_000 });
		expect(d.files.find((f) => f.path === "small.txt")?.hunks).toHaveLength(1);
		expect(d.truncated).toBe(false);

		// Many mid-size files together exceed the total cap → later files are omitted.
		const mid = `${Array.from({ length: 6_000 }, (_, i) => `mid line ${i} with some padding text`).join("\n")}\n`;
		for (let i = 0; i < 40; i++) write(a, `mid/f${String(i).padStart(2, "0")}.txt`, mid);
		const t = await engine.diff(a, { scope: "unstaged", context: 3, path: "mid" });
		expect(t.truncated).toBe(true);
		expect(t.files.length).toBeGreaterThan(0);
		expect(t.files.length).toBeLessThan(40);
	});
});
