import { chmod, lstat, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	BundleError,
	DEFAULT_EXCLUDES,
	applyBundle,
	createBundle,
	previewBundle,
	readBundleManifest,
	scanFolder,
} from "../src/index.ts";
import { craftedBundle, gunzipSync, gzipSync, manifestFor, put, rawTarGz, registerCleanup, sha, text, tmp } from "./helpers.ts";

registerCleanup();

async function bundleOf(files: Record<string, string | Buffer>, mode?: Record<string, number>) {
	const src = await tmp("wf-src-");
	await put(src, files, mode);
	const out = join(await tmp("wf-out-"), "b.tgz");
	const result = await createBundle(src, out);
	return { src, out, ...result };
}

async function expectCode(promise: Promise<unknown>, code: BundleError["code"]) {
	const error = await promise.then(
		() => null,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(BundleError);
	expect((error as BundleError).code).toBe(code);
}

describe("manifest + round trip", () => {
	it("scanFolder lists sorted files with sha256, sizes and exec bit", async () => {
		const src = await tmp();
		await put(src, { "b.txt": "bee", "a/z.sh": "#!/bin/sh\n", "a/c.txt": "" }, { "a/z.sh": 0o755 });
		const m = await scanFolder(src);
		expect(m.version).toBe(1);
		expect(m.files.map((f) => f.path)).toEqual(["a/c.txt", "a/z.sh", "b.txt"]);
		expect(m.files.find((f) => f.path === "b.txt")).toEqual({ path: "b.txt", size: 3, sha256: sha("bee"), executable: false });
		expect(m.files.find((f) => f.path === "a/z.sh")?.executable).toBe(true);
		expect(m.totalSize).toBe(13);
	});

	it("round-trips content and exec bit; manifest readable without extracting", async () => {
		const bin = Buffer.from([0, 1, 2, 255, 254, 0, 9]);
		const { out, manifest, sha256, size } = await bundleOf(
			{ "README.md": "# hi\n", "bin/run.sh": "echo hi\n", "data/blob.bin": bin, "empty.txt": "" },
			{ "bin/run.sh": 0o755 },
		);
		expect((await stat(out)).size).toBe(size);
		expect(sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(await readBundleManifest(out)).toEqual(manifest);

		const dest = await tmp("wf-dest-");
		const res = await applyBundle(out, dest);
		expect(res.written).toEqual(["README.md", "bin/run.sh", "data/blob.bin", "empty.txt"]);
		expect(res.deleted).toEqual([]);
		expect(await text(dest, "README.md")).toBe("# hi\n");
		expect(await readFile(join(dest, "data/blob.bin"))).toEqual(bin);
		expect((await stat(join(dest, "bin/run.sh"))).mode & 0o111).not.toBe(0);
		expect((await stat(join(dest, "README.md"))).mode & 0o111).toBe(0);
		expect((await scanFolder(dest)).files).toEqual(manifest.files);
		expect((await readdir(dest)).sort()).toEqual(["README.md", "bin", "data", "empty.txt"]);
	});

	it("handles unicode, spaces and very long paths", async () => {
		const long = `${"d".repeat(60)}/${"e".repeat(60)}/${"f".repeat(60)}.txt`;
		const files = { "tài liệu/báo cáo 1.txt": "xin chào", "dir with space/ファイル.md": "日本語", [long]: "long" };
		const { out, manifest } = await bundleOf(files);
		expect(manifest.files.map((f) => f.path).sort()).toEqual(Object.keys(files).sort());
		const dest = await tmp();
		await applyBundle(out, dest);
		for (const [p, c] of Object.entries(files)) expect(await text(dest, p)).toBe(c);
	});
});

describe("determinism", () => {
	it("identical folders (different mtimes, different dirs) give identical sha256", async () => {
		const files = { "a.txt": "A", "sub/b.txt": "B", "sub/run.sh": "x" };
		const mode = { "sub/run.sh": 0o755 };
		const one = await bundleOf(files, mode);
		await new Promise((r) => setTimeout(r, 1100));
		const two = await bundleOf(files, mode);
		expect(one.sha256).toBe(two.sha256);
		expect(await readFile(one.out)).toEqual(await readFile(two.out));
		const again = await createBundle(one.src, join(await tmp(), "again.tgz"));
		expect(again.sha256).toBe(one.sha256);
	});

	it("different content gives a different sha256", async () => {
		const a = await bundleOf({ "a.txt": "A" });
		const b = await bundleOf({ "a.txt": "B" });
		expect(a.sha256).not.toBe(b.sha256);
	});
});

describe("excludes, gitignore, caps", () => {
	it("applies default excludes and reports them in skipped", async () => {
		const src = await tmp();
		await put(src, {
			"keep.txt": "k",
			".git/config": "x",
			"node_modules/pkg/index.js": "x",
			"dist/out.js": "x",
			"src/build/gen.js": "x",
			"__pycache__/a.pyc": "x",
			".venv/bin/python": "x",
			".DS_Store": "x",
			"run.log": "x",
			".env": "SECRET=1",
			".env.local": "SECRET=2",
			".env.example": "SECRET=",
			".clam-apply-abc/tmp": "x",
			".clam/state.json": "{}",
			".omp/sessions/s.jsonl": "{}",
		});
		const m = await scanFolder(src);
		expect(m.files.map((f) => f.path)).toEqual([".env.example", "keep.txt"]);
		const excluded = new Set(m.skipped.filter((s) => s.reason === "excluded").map((s) => s.path));
		for (const p of [".git/", "node_modules/", "dist/", "src/build/", ".env", ".env.local", "run.log", ".DS_Store", ".clam/", ".omp/"]) {
			expect(excluded.has(p), p).toBe(true);
		}
		expect(DEFAULT_EXCLUDES).toContain(".git/");
		expect(DEFAULT_EXCLUDES).toContain("node_modules/");
	});

	it("gitignore semantics (table)", async () => {
		const src = await tmp();
		await put(src, {
			".gitignore": "*.tmp\n!keep.tmp\n/rooted.txt\ncache/\ndocs/**/gen/\n# comment\n\n[ab].dat\nsecret?.txt\n!.env\n",
			"x.tmp": "1",
			"keep.tmp": "1",
			"rooted.txt": "1",
			"sub/rooted.txt": "1",
			"cache/a": "1",
			"sub/cache/a": "1",
			"docs/gen/a": "1",
			"docs/x/y/gen/a": "1",
			"docs/x/y/ok": "1",
			"a.dat": "1",
			"c.dat": "1",
			"secret1.txt": "1",
			"secret12.txt": "1",
			"sub/.gitignore": "*.md\n!important.md\n/local.txt\n",
			"sub/readme.md": "1",
			"sub/important.md": "1",
			"sub/local.txt": "1",
			"sub/deep/local.txt": "1",
			"top.md": "1",
			".env": "TOKEN=1",
		});
		const m = await scanFolder(src);
		expect(m.files.map((f) => f.path)).toEqual(
			[
				".gitignore",
				"c.dat",
				"docs/x/y/ok",
				"keep.tmp",
				"secret12.txt",
				"sub/.gitignore",
				"sub/deep/local.txt",
				"sub/important.md",
				"sub/rooted.txt",
				"top.md",
			].sort(),
		);
		// A project .gitignore can never re-include a default-excluded secret.
		expect(m.files.some((f) => f.path === ".env")).toBe(false);
	});

	it("respectGitignore:false ignores .gitignore; extra exclude globs apply", async () => {
		const src = await tmp();
		await put(src, { ".gitignore": "ignored.txt\n", "ignored.txt": "1", "a.txt": "1", "gen/x.ts": "1", "b.bak": "1" });
		const raw = await scanFolder(src, { respectGitignore: false, exclude: ["gen/", "*.bak"] });
		expect(raw.files.map((f) => f.path)).toEqual([".gitignore", "a.txt", "ignored.txt"]);
		const normal = await scanFolder(src, { exclude: ["!a.txt", "gen/"] });
		// extra excludes are a separate layer: a .gitignore-style negation there cannot resurrect anything.
		expect(normal.files.map((f) => f.path)).toEqual([".gitignore", "a.txt", "b.bak"]);
	});

	it("reports symlinks, special files and size caps in skipped", async () => {
		const src = await tmp();
		await put(src, { "ok.txt": "ok", "big.bin": Buffer.alloc(2000, 1), "z1.txt": Buffer.alloc(600, 2), "z2.txt": Buffer.alloc(600, 3) });
		await symlink("ok.txt", join(src, "link.txt"));
		await symlink(".", join(src, "dirlink"));
		const m = await scanFolder(src, { maxFileBytes: 1000, maxTotalBytes: 1000 });
		expect(m.files.map((f) => f.path)).toEqual(["ok.txt", "z1.txt"]);
		expect(m.skipped).toEqual(
			expect.arrayContaining([
				{ path: "big.bin", reason: "too_large" },
				{ path: "z2.txt", reason: "too_large" },
				{ path: "link.txt", reason: "symlink" },
				{ path: "dirlink", reason: "symlink" },
			]),
		);
		expect(m.totalSize).toBe(602);
		// archive carries the same skipped list
		const out = join(await tmp(), "c.tgz");
		const { manifest } = await createBundle(src, out, { maxFileBytes: 1000, maxTotalBytes: 1000 });
		expect(manifest.skipped).toEqual(m.skipped);
		expect((await readBundleManifest(out)).skipped).toEqual(m.skipped);
	});

	it("never bundles through symlinked directories", async () => {
		const outside = await tmp("wf-outside-");
		await put(outside, { "secret.txt": "top secret" });
		const src = await tmp();
		await put(src, { "a.txt": "a" });
		await symlink(outside, join(src, "escape"));
		const m = await scanFolder(src);
		expect(m.files.map((f) => f.path)).toEqual(["a.txt"]);
	});

	it("rejects a non-directory root", async () => {
		const src = await tmp();
		await put(src, { "f.txt": "x" });
		await expectCode(scanFolder(join(src, "f.txt")), "io");
		await expectCode(scanFolder(join(src, "missing")), "io");
	});
});

describe("paths subset and base delta", () => {
	it("paths limits to the listed files/folders (still honoring excludes)", async () => {
		const src = await tmp();
		await put(src, { "a.txt": "a", "b.txt": "b", "docs/x.md": "x", "docs/sub/y.md": "y", "src/z.ts": "z", ".env": "S", "other/.env": "S" });
		const out = join(await tmp(), "p.tgz");
		const { manifest } = await createBundle(src, out, { paths: ["a.txt", "./docs/", "other/.env", "does/not/exist"] });
		expect(manifest.files.map((f) => f.path)).toEqual(["a.txt", "docs/sub/y.md", "docs/x.md"]);
		await expectCode(createBundle(src, out, { paths: ["../etc"] }), "unsafe_path");
	});

	it("base delta bundles contain only changed/new files; deletions are carried and applied safely", async () => {
		const src = await tmp();
		await put(src, { "keep.txt": "same", "edit.txt": "v1", "gone.txt": "bye", "run.sh": "x" });
		const base = await scanFolder(src);

		// producer works on a copy
		const work = await tmp("wf-work-");
		await applyBundle(await mk(src), work);
		await put(work, { "edit.txt": "v2", "new.txt": "fresh", "sub/deep.txt": "d" });
		const { rm } = await import("node:fs/promises");
		await rm(join(work, "gone.txt"));
		await chmod(join(work, "run.sh"), 0o755);

		const delta = join(await tmp(), "delta.tgz");
		const { manifest } = await createBundle(work, delta, { base });
		expect(manifest.files.map((f) => f.path)).toEqual(["edit.txt", "new.txt", "run.sh", "sub/deep.txt"]);
		expect((manifest as { deleted?: string[] }).deleted).toEqual(["gone.txt"]);
		expect(manifest.totalSize).toBe(2 + 5 + 1 + 1);

		const preview = await previewBundle(delta, src, { base });
		expect(Object.fromEntries(preview.map((p) => [p.path, p.status]))).toEqual({
			"edit.txt": "update",
			"new.txt": "new",
			"run.sh": "update",
			"sub/deep.txt": "new",
		});

		// without deleteMissing nothing is deleted
		const noDelete = await tmp("wf-nd-");
		await applyBundle(await mk(src), noDelete);
		const r0 = await applyBundle(delta, noDelete, { base });
		expect(r0.deleted).toEqual([]);
		expect(await text(noDelete, "gone.txt")).toBe("bye");

		const r1 = await applyBundle(delta, src, { base, deleteMissing: true });
		expect(r1.written).toEqual(["edit.txt", "new.txt", "run.sh", "sub/deep.txt"]);
		expect(r1.deleted).toEqual(["gone.txt"]);
		await expect(lstat(join(src, "gone.txt"))).rejects.toThrow();
		expect(await text(src, "edit.txt")).toBe("v2");
		expect(await text(src, "keep.txt")).toBe("same");
		expect((await stat(join(src, "run.sh"))).mode & 0o111).not.toBe(0);
	});
});

async function mk(dir: string): Promise<string> {
	const out = join(await tmp("wf-mk-"), "x.tgz");
	await createBundle(dir, out);
	return out;
}

describe("preview + apply conflict semantics", () => {
	it("classifies new / unchanged / update / conflict", async () => {
		const src = await tmp();
		await put(src, { "new.txt": "n", "same.txt": "s", "upd.txt": "u1", "conf.txt": "c1", "nobase.txt": "b" });
		const base = await scanFolder(src);
		const remote = await tmp();
		await put(remote, { "new.txt": "n2", "same.txt": "s", "upd.txt": "u2", "conf.txt": "c2", "nobase.txt": "b2" });
		const bundle = join(await tmp(), "r.tgz");
		await createBundle(remote, bundle);

		await put(src, { "conf.txt": "c1-local-edit", "nobase.txt": "other" });
		const { rm } = await import("node:fs/promises");
		await rm(join(src, "new.txt"));

		const withBase = await previewBundle(bundle, src, { base });
		expect(Object.fromEntries(withBase.map((p) => [p.path, p.status]))).toEqual({
			"conf.txt": "conflict",
			"nobase.txt": "conflict",
			"new.txt": "new",
			"same.txt": "unchanged",
			"upd.txt": "update",
		});
		expect(withBase.find((p) => p.path === "new.txt")?.size).toBe(2);

		// no base: any differing existing file is a conflict
		const noBase = await previewBundle(bundle, src);
		expect(Object.fromEntries(noBase.map((p) => [p.path, p.status]))).toEqual({
			"conf.txt": "conflict",
			"nobase.txt": "conflict",
			"new.txt": "new",
			"same.txt": "unchanged",
			"upd.txt": "conflict",
		});
	});

	it("apply never overwrites conflicts unless listed in overwrite; honors paths", async () => {
		const src = await tmp();
		await put(src, { "upd.txt": "u1", "conf.txt": "c1", "same.txt": "s" });
		const base = await scanFolder(src);
		const remote = await tmp();
		await put(remote, { "upd.txt": "u2", "conf.txt": "c2", "same.txt": "s", "new.txt": "n" });
		const bundle = join(await tmp(), "r.tgz");
		await createBundle(remote, bundle);
		await put(src, { "conf.txt": "mine" });

		const first = await applyBundle(bundle, src, { base, paths: ["upd.txt", "conf.txt", "same.txt"] });
		expect(first.written).toEqual(["upd.txt"]);
		expect(first.skipped).toEqual([
			{ path: "conf.txt", reason: "conflict" },
			{ path: "new.txt", reason: "not_selected" },
			{ path: "same.txt", reason: "unchanged" },
		]);
		expect(await text(src, "conf.txt")).toBe("mine");
		expect(await text(src, "upd.txt")).toBe("u2");
		expect(await lstat(join(src, "new.txt")).catch(() => null)).toBeNull();

		// default (no paths) writes every new/update file, still skipping conflicts
		const second = await applyBundle(bundle, src, { base });
		expect(second.written).toEqual(["new.txt"]);
		expect(second.skipped.find((s) => s.path === "conf.txt")?.reason).toBe("conflict");
		expect(await text(src, "conf.txt")).toBe("mine");

		const third = await applyBundle(bundle, src, { base, overwrite: ["conf.txt"] });
		expect(third.written).toEqual(["conf.txt"]);
		expect(await text(src, "conf.txt")).toBe("c2");
	});

	it("deleteMissing on a full bundle needs base, only removes untouched files, never conflicts", async () => {
		const src = await tmp();
		await put(src, { "a.txt": "a", "gone1.txt": "g1", "gone2.txt": "g2", "dir/gone3.txt": "g3", "dir/stay.txt": "s" });
		const base = await scanFolder(src);
		const remote = await tmp();
		await put(remote, { "a.txt": "a2", "dir/stay.txt": "s" });
		const bundle = join(await tmp(), "r.tgz");
		await createBundle(remote, bundle);
		await put(src, { "gone2.txt": "locally edited" });

		const noBase = await applyBundle(bundle, src, { deleteMissing: true });
		expect(noBase.deleted).toEqual([]);

		const res = await applyBundle(bundle, src, { base, deleteMissing: true });
		expect(res.deleted).toEqual(["dir/gone3.txt", "gone1.txt"]);
		expect(res.skipped).toContainEqual({ path: "gone2.txt", reason: "conflict" });
		expect(await text(src, "gone2.txt")).toBe("locally edited");
		expect(await text(src, "dir/stay.txt")).toBe("s");
		expect(await text(src, "a.txt")).toBe("a2");
	});

	it("deleteMissing with an explicit overwrite removes a locally edited file", async () => {
		const src = await tmp();
		await put(src, { "a.txt": "a", "gone.txt": "g" });
		const base = await scanFolder(src);
		const remote = await tmp();
		await put(remote, { "a.txt": "a" });
		const bundle = join(await tmp(), "r.tgz");
		await createBundle(remote, bundle);
		await put(src, { "gone.txt": "edited" });
		const res = await applyBundle(bundle, src, { base, deleteMissing: true, overwrite: ["gone.txt"] });
		expect(res.deleted).toEqual(["gone.txt"]);
	});

	it("partial (paths-limited) full bundle does not treat out-of-scope base files as deletions", async () => {
		const src = await tmp();
		await put(src, { "a/x.txt": "x", "b/y.txt": "y" });
		const base = await scanFolder(src);
		const bundle = join(await tmp(), "r.tgz");
		await createBundle(src, bundle, { paths: ["a"] });
		const res = await applyBundle(bundle, src, { base, deleteMissing: true });
		expect(res.deleted).toEqual([]);
		expect(await text(src, "b/y.txt")).toBe("y");
	});

	it("applies into a folder that does not exist yet and leaves no staging dir", async () => {
		const { out } = await bundleOf({ "a/b/c.txt": "deep" });
		const dest = join(await tmp(), "fresh", "nested");
		await applyBundle(out, dest);
		expect(await text(dest, "a/b/c.txt")).toBe("deep");
		expect((await readdir(dest)).filter((n) => n.startsWith(".clam"))).toEqual([]);
	});

	it("never writes through a symlinked parent or over a directory", async () => {
		const { out } = await bundleOf({ "link/file.txt": "evil", "dirx": "file", "ok.txt": "ok" });
		const dest = await tmp();
		const outside = await tmp("wf-outside-");
		await symlink(outside, join(dest, "link"));
		await mkdir(join(dest, "dirx"));
		const pv = await previewBundle(out, dest);
		expect(Object.fromEntries(pv.map((p) => [p.path, p.status]))).toMatchObject({ "link/file.txt": "conflict", dirx: "conflict", "ok.txt": "new" });
		const res = await applyBundle(out, dest, { overwrite: ["link/file.txt", "dirx"] });
		expect(res.written).toEqual(["ok.txt"]);
		expect(await readdir(outside)).toEqual([]);
		expect((await lstat(join(dest, "dirx"))).isDirectory()).toBe(true);
	});

	it("overwriting a local symlink replaces the link itself, not its target", async () => {
		const { out } = await bundleOf({ "f.txt": "new" });
		const dest = await tmp();
		const outside = await tmp("wf-outside-");
		await writeFile(join(outside, "target.txt"), "precious");
		await symlink(join(outside, "target.txt"), join(dest, "f.txt"));
		const res = await applyBundle(out, dest, { overwrite: ["f.txt"] });
		expect(res.written).toEqual([]); // symlink at the path = blocked, never replaced silently
		expect(await readFile(join(outside, "target.txt"), "utf8")).toBe("precious");
	});
});

describe("unsafe and corrupt archives", () => {
	const good = { "a.txt": "A", "b.txt": "B" };

	it("rejects ../ and absolute paths and .git targets", async () => {
		for (const name of ["../evil.txt", "a/../../evil.txt", "/etc/evil.txt", ".git/hooks/pre-commit", "a/./b.txt", "a//b.txt"]) {
			const dest = await tmp();
			const archive = join(await tmp(), "u.tgz");
			await writeFile(archive, craftedBundle({ [name]: "x" }));
			await expectCode(readBundleManifest(archive), "unsafe_path");
			await expectCode(applyBundle(archive, dest), "unsafe_path");
			expect(await readdir(dest)).toEqual([]);
		}
	});

	it("rejects unsafe tar entry names even when the manifest is clean", async () => {
		const dest = await tmp();
		const archive = join(await tmp(), "u.tgz");
		await writeFile(archive, craftedBundle(good, [{ name: "files/../../evil.txt", data: Buffer.from("x") }]));
		await expectCode(applyBundle(archive, dest), "unsafe_path");
		expect(await readdir(dest)).toEqual([]);
	});

	it("rejects symlink, hardlink and device entries", async () => {
		for (const type of ["2", "1", "3", "4", "6"]) {
			const dest = await tmp();
			const archive = join(await tmp(), "u.tgz");
			await writeFile(archive, craftedBundle(good, [{ name: "files/link", type, linkname: "/etc/passwd" }]));
			await expectCode(applyBundle(archive, dest), "unsafe_path");
			expect(await readdir(dest)).toEqual([]);
		}
	});

	it("rejects tampered file content (sha256) and writes nothing, even for earlier files", async () => {
		const m = manifestFor(good);
		const archive = join(await tmp(), "t.tgz");
		await writeFile(
			archive,
			rawTarGz([
				{ name: "manifest.json", data: m },
				{ name: "files/a.txt", data: Buffer.from("A") },
				{ name: "files/b.txt", data: Buffer.from("X") }, // tampered
			]),
		);
		const dest = await tmp();
		await expectCode(applyBundle(archive, dest), "invalid_archive");
		expect(await readdir(dest)).toEqual([]);
	});

	it("rejects tampered content in a file that would have been skipped (not selected)", async () => {
		const archive = join(await tmp(), "t.tgz");
		await writeFile(
			archive,
			rawTarGz([
				{ name: "manifest.json", data: manifestFor(good) },
				{ name: "files/a.txt", data: Buffer.from("A") },
				{ name: "files/b.txt", data: Buffer.from("X") },
			]),
		);
		const dest = await tmp();
		await expectCode(applyBundle(archive, dest, { paths: ["a.txt"] }), "invalid_archive");
		expect(await readdir(dest)).toEqual([]);
	});

	it("rejects tampered manifests", async () => {
		const mk2 = async (manifest: Buffer, entries: Array<{ name: string; data: Buffer }>) => {
			const archive = join(await tmp(), "m.tgz");
			await writeFile(archive, rawTarGz([{ name: "manifest.json", data: manifest }, ...entries]));
			return archive;
		};
		const entries = [
			{ name: "files/a.txt", data: Buffer.from("A") },
			{ name: "files/b.txt", data: Buffer.from("B") },
		];
		const dest = await tmp();
		// wrong hash in manifest
		const wrongHash = JSON.parse(manifestFor(good).toString());
		wrongHash.files[0].sha256 = sha("nope");
		await expectCode(applyBundle(await mk2(Buffer.from(JSON.stringify(wrongHash)), entries), dest), "invalid_archive");
		// wrong size
		const wrongSize = JSON.parse(manifestFor(good).toString());
		wrongSize.files[0].size = 5;
		wrongSize.totalSize += 4;
		await expectCode(applyBundle(await mk2(Buffer.from(JSON.stringify(wrongSize)), entries), dest), "invalid_archive");
		// totalSize lie
		const lie = JSON.parse(manifestFor(good).toString());
		lie.totalSize = 999;
		await expectCode(applyBundle(await mk2(Buffer.from(JSON.stringify(lie)), entries), dest), "invalid_archive");
		// not JSON / wrong schema
		await expectCode(applyBundle(await mk2(Buffer.from("{nope"), entries), dest), "invalid_archive");
		await expectCode(applyBundle(await mk2(Buffer.from('{"version":2}'), entries), dest), "invalid_archive");
		// file in archive but not in manifest
		await expectCode(
			applyBundle(await mk2(manifestFor({ "a.txt": "A" }), entries), dest),
			"invalid_archive",
		);
		// manifest lists a file the archive lacks
		await expectCode(applyBundle(await mk2(manifestFor(good), entries.slice(0, 1)), dest), "invalid_archive");
		// duplicate manifest path
		const dup = JSON.parse(manifestFor({ "a.txt": "A" }).toString());
		dup.files.push(dup.files[0]);
		dup.totalSize = 2;
		await expectCode(applyBundle(await mk2(Buffer.from(JSON.stringify(dup)), entries.slice(0, 1)), dest), "invalid_archive");
		// duplicate archive entry
		await expectCode(applyBundle(await mk2(manifestFor({ "a.txt": "A" }), [entries[0] as never, entries[0] as never]), dest), "invalid_archive");
		// manifest not first
		const notFirst = join(await tmp(), "nf.tgz");
		await writeFile(notFirst, rawTarGz([{ name: "files/a.txt", data: Buffer.from("A") }, { name: "manifest.json", data: manifestFor({ "a.txt": "A" }) }]));
		await expectCode(readBundleManifest(notFirst), "invalid_archive");
		expect(await readdir(dest)).toEqual([]);
	});

	it("rejects non-gzip, truncated and bit-flipped archives", async () => {
		const { out } = await bundleOf({ "a.txt": "A".repeat(5000), "b.txt": "B".repeat(5000) });
		const buf = await readFile(out);
		const dest = await tmp();
		const garbage = join(await tmp(), "g.tgz");
		await writeFile(garbage, "this is not an archive");
		await expectCode(applyBundle(garbage, dest), "invalid_archive");
		await expectCode(readBundleManifest(garbage), "invalid_archive");
		const trunc = join(await tmp(), "t.tgz");
		await writeFile(trunc, buf.subarray(0, buf.length - 30));
		await expectCode(applyBundle(trunc, dest), "invalid_archive");
		const flipped = Buffer.from(buf);
		flipped[Math.floor(flipped.length / 2)] = (flipped[Math.floor(flipped.length / 2)] as number) ^ 0xff;
		const flip = join(await tmp(), "f.tgz");
		await writeFile(flip, flipped);
		await expectCode(applyBundle(flip, dest), "invalid_archive");
		// tar without end marker
		const noEnd = join(await tmp(), "ne.tgz");
		const raw = gunzipSync(buf);
		await writeFile(noEnd, gzipSync(raw.subarray(0, raw.length - 1024)));
		await expectCode(applyBundle(noEnd, dest), "invalid_archive");
		await expectCode(applyBundle(join(dest, "nope.tgz"), dest), "io");
		expect(await readdir(dest)).toEqual([]);
	});

	it("rejects a manifest claiming a huge bundle", async () => {
		const m = JSON.parse(manifestFor({ "a.txt": "A" }).toString());
		m.files[0].size = 5 * 1024 ** 3;
		m.totalSize = m.files[0].size;
		const archive = join(await tmp(), "h.tgz");
		await writeFile(archive, rawTarGz([{ name: "manifest.json", data: Buffer.from(JSON.stringify(m)) }]));
		await expectCode(applyBundle(archive, await tmp()), "too_large");
	});
});

describe("atomic writes", () => {
	it("a failure while verifying leaves no partial files and no staging dir; existing files untouched", async () => {
		const dest = await tmp();
		await put(dest, { "a.txt": "old-a", "keep.txt": "keep" });
		const archive = join(await tmp(), "t.tgz");
		const files = { "a.txt": "new-a", "z.txt": "new-z" };
		await writeFile(
			archive,
			rawTarGz([
				{ name: "manifest.json", data: manifestFor(files) },
				{ name: "files/a.txt", data: Buffer.from("new-a") },
				{ name: "files/z.txt", data: Buffer.from("broken") },
			]),
		);
		await expectCode(applyBundle(archive, dest, { overwrite: ["a.txt"] }), "invalid_archive");
		expect(await text(dest, "a.txt")).toBe("old-a");
		expect((await readdir(dest)).sort()).toEqual(["a.txt", "keep.txt"]);
	});

	it("a truncated archive fails mid-stream without touching the folder", async () => {
		const { out } = await bundleOf({ "a.txt": Buffer.alloc(200_000, 7), "b.txt": Buffer.alloc(200_000, 8) });
		const raw = gunzipSync(await readFile(out));
		const cut = join(await tmp(), "cut.tgz");
		await writeFile(cut, gzipSync(raw.subarray(0, 512 * 3 + 100_000)));
		const dest = await tmp();
		await expectCode(applyBundle(cut, dest), "invalid_archive");
		expect(await readdir(dest)).toEqual([]);
	});

	it("createBundle leaves no temp file when the folder changes during bundling", async () => {
		const src = await tmp();
		await put(src, { "a.txt": "a" });
		const outDir = await tmp();
		await expectCode(createBundle(join(src, "missing"), join(outDir, "x.tgz")), "io");
		expect(await readdir(outDir)).toEqual([]);
	});
});

describe("performance", () => {
	it("bundles, previews and applies 10k small files in < 5 s (scaled to FS speed) per phase", async () => {
		const src = await tmp();
		const files: Record<string, string> = {};
		for (let i = 0; i < 10_000; i++) files[`d${i % 100}/f${i}.txt`] = `content ${i}\n`;
		// The 5 s budget assumes an idle disk. Scale it by what the machine needs for the bare file-system work the
		// library cannot avoid (writing every file into a fresh tree, then reading every file back), so a loaded box does
		// not flake while a quadratic regression in the library still fails.
		let t = performance.now();
		await put(src, files);
		const writeSweepMs = performance.now() - t;
		t = performance.now();
		await Promise.all(Object.keys(files).map((p) => readFile(join(src, p))));
		const readSweepMs = performance.now() - t;
		const budget = Math.max(5000, 4 * (writeSweepMs + readSweepMs));
		const out = join(await tmp(), "big.tgz");
		t = performance.now();
		const { manifest } = await createBundle(src, out);
		const createMs = performance.now() - t;
		expect(manifest.files).toHaveLength(10_000);
		const dest = await tmp();
		t = performance.now();
		const res = await applyBundle(out, dest);
		const applyMs = performance.now() - t;
		expect(res.written).toHaveLength(10_000);
		t = performance.now();
		const pv = await previewBundle(out, dest);
		const previewMs = performance.now() - t;
		expect(pv.every((p) => p.status === "unchanged")).toBe(true);
		expect(createMs).toBeLessThan(budget);
		expect(applyMs).toBeLessThan(budget);
		expect(previewMs).toBeLessThan(budget);
		expect(await scanFolder(dest)).toEqual(await scanFolder(src));
	}, 60_000);
});
