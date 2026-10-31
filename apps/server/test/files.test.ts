import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiError } from "../src/http/errors.ts";
import {
	languageFor,
	listDirectory,
	MAX_FILE_BYTES,
	readProjectFile,
	suggestDirectories,
} from "../src/services/files.ts";

let tmp: string;
let root: string;
let outside: string;

async function rejects(p: Promise<unknown>, status: number, code?: string) {
	const err = await p.then(
		() => null,
		(e: unknown) => e,
	);
	expect(err).toBeInstanceOf(ApiError);
	expect((err as ApiError).status).toBe(status);
	if (code) expect((err as ApiError).code).toBe(code);
}

beforeAll(() => {
	tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "clam-files-")));
	root = path.join(tmp, "proj");
	outside = path.join(tmp, "outside");
	mkdirSync(path.join(root, "src"), { recursive: true });
	mkdirSync(path.join(root, ".git"));
	mkdirSync(path.join(root, "node_modules"));
	mkdirSync(path.join(root, "Beta"));
	mkdirSync(outside);
	writeFileSync(path.join(outside, "secret.txt"), "top secret");
	writeFileSync(path.join(root, "b.txt"), "bee");
	writeFileSync(path.join(root, "A.md"), "# hi");
	writeFileSync(path.join(root, "src", "index.ts"), "export const x = 1;\n");
	writeFileSync(path.join(root, "bin.dat"), Buffer.from([1, 2, 0, 3]));
	writeFileSync(path.join(root, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
	writeFileSync(path.join(root, "big.txt"), Buffer.alloc(MAX_FILE_BYTES + 1, 97));
	writeFileSync(path.join(root, "exact.txt"), Buffer.alloc(MAX_FILE_BYTES, 98));
	writeFileSync(path.join(root, "Dockerfile"), "FROM scratch");
	writeFileSync(path.join(root, "mystery.zzz"), "?");
	symlinkSync(path.join(root, "b.txt"), path.join(root, "link-in"));
	symlinkSync(outside, path.join(root, "link-out"));
	symlinkSync(path.join(outside, "secret.txt"), path.join(root, "secret-link"));
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("listDirectory", () => {
	it("lists one level, dirs first then case-insensitive, skipping .git and node_modules", async () => {
		const entries = await listDirectory(root, "");
		expect(entries.map((e) => e.name)).toEqual([
			"Beta",
			"src",
			"A.md",
			"b.txt",
			"big.txt",
			"bin.dat",
			"Dockerfile",
			"exact.txt",
			"latin1.txt",
			"link-in",
			"link-out",
			"mystery.zzz",
			"secret-link",
		]);
	});

	it("reports kind, size, modifiedAt and POSIX relative paths", async () => {
		const top = await listDirectory(root, "");
		const file = top.find((e) => e.name === "b.txt");
		expect(file).toMatchObject({ kind: "file", size: 3, path: "b.txt" });
		expect(Number.isNaN(Date.parse(file?.modifiedAt ?? ""))).toBe(false);
		expect(top.find((e) => e.name === "src")).toMatchObject({ kind: "dir", size: null });
		expect(top.find((e) => e.name === "link-out")).toMatchObject({ kind: "symlink", size: null });
		expect(top.find((e) => e.name === "link-in")?.kind).toBe("symlink");
		expect(await listDirectory(root, "src/")).toEqual([expect.objectContaining({ name: "index.ts", path: "src/index.ts", kind: "file" })]);
	});

	it("rejects traversal, absolute paths, NUL bytes and symlink escapes", async () => {
		await rejects(listDirectory(root, ".."), 400, "invalid_path");
		await rejects(listDirectory(root, "src/../../outside"), 400, "invalid_path");
		await rejects(listDirectory(root, outside), 400, "invalid_path");
		await rejects(listDirectory(root, "src\0"), 400, "invalid_path");
		await rejects(listDirectory(root, "link-out"), 403, "path_outside_project");
	});

	it("404 for missing paths and 400 for files", async () => {
		await rejects(listDirectory(root, "nope"), 404);
		await rejects(listDirectory(root, "b.txt"), 400);
	});
});

describe("readProjectFile", () => {
	it("returns text with language", async () => {
		expect(await readProjectFile(root, "src/index.ts")).toEqual({
			path: "src/index.ts",
			size: 20,
			content: "export const x = 1;\n",
			truncated: false,
			binary: false,
			language: "typescript",
		});
		expect((await readProjectFile(root, "Dockerfile")).language).toBe("dockerfile");
		expect((await readProjectFile(root, "mystery.zzz")).language).toBeNull();
	});

	it("flags binary (NUL and invalid UTF-8) without content", async () => {
		expect(await readProjectFile(root, "bin.dat")).toMatchObject({ content: null, binary: true, truncated: false });
		expect(await readProjectFile(root, "latin1.txt")).toMatchObject({ content: null, binary: true });
	});

	it("truncates above 512 KB but returns files of exactly 512 KB", async () => {
		expect(await readProjectFile(root, "big.txt")).toMatchObject({ content: null, truncated: true, binary: false, size: MAX_FILE_BYTES + 1 });
		const exact = await readProjectFile(root, "exact.txt");
		expect(exact.truncated).toBe(false);
		expect(exact.content?.length).toBe(MAX_FILE_BYTES);
	});

	it("rejects directories, traversal and symlinks leaving the root; follows inside symlinks", async () => {
		await rejects(readProjectFile(root, "src"), 400);
		await rejects(readProjectFile(root, ""), 400);
		await rejects(readProjectFile(root, "../outside/secret.txt"), 400, "invalid_path");
		await rejects(readProjectFile(root, path.join(outside, "secret.txt")), 400, "invalid_path");
		await rejects(readProjectFile(root, "secret-link"), 403, "path_outside_project");
		await rejects(readProjectFile(root, "link-out/secret.txt"), 403, "path_outside_project");
		expect((await readProjectFile(root, "link-in")).content).toBe("bee");
	});
});

describe("languageFor", () => {
	it("maps extensions and well-known names", () => {
		expect(languageFor("a/b/Makefile")).toBe("makefile");
		expect(languageFor("x.tsx")).toBe("typescript");
		expect(languageFor("x.PY")).toBe("python");
		expect(languageFor("main.rs")).toBe("rust");
		expect(languageFor("noext")).toBeNull();
		expect(languageFor("x.unknownext")).toBeNull();
	});
});

describe("suggestDirectories", () => {
	let home: string;
	beforeAll(() => {
		home = path.join(tmp, "home");
		mkdirSync(path.join(home, "projects", "alpha", ".git"), { recursive: true });
		mkdirSync(path.join(home, "projects", "Alps"));
		mkdirSync(path.join(home, "projects", "beta"));
		mkdirSync(path.join(home, "projects", ".hidden"));
		writeFileSync(path.join(home, "projects", "afile"), "x");
		symlinkSync(path.join(home, "projects", "beta"), path.join(home, "projects", "alink"));
		mkdirSync(path.join(home, "docs"));
		mkdirSync(path.join(home, ".config"));
	});

	it("lists subdirectories of a prefix ending in a slash (no hidden, no files)", async () => {
		const r = await suggestDirectories(`${home}/projects/`, home);
		expect(r.map((s) => path.basename(s.path))).toEqual(["alink", "alpha", "Alps", "beta"]);
		expect(r.find((s) => s.path.endsWith("alpha"))?.isGitRepo).toBe(true);
		expect(r.find((s) => s.path.endsWith("beta"))?.isGitRepo).toBe(false);
		expect(r.every((s) => !s.path.endsWith("/"))).toBe(true);
	});

	it("filters by typed fragment, case-insensitively; hidden only on dot fragment", async () => {
		expect((await suggestDirectories(`${home}/projects/AL`, home)).map((s) => path.basename(s.path))).toEqual(["alink", "alpha", "Alps"]);
		expect((await suggestDirectories(`${home}/projects/.`, home)).map((s) => path.basename(s.path))).toEqual([".hidden"]);
	});

	it("expands ~ and treats empty/relative prefixes as the home directory", async () => {
		const names = (r: { path: string }[]) => r.map((s) => path.basename(s.path));
		expect(names(await suggestDirectories("~", home))).toEqual(["docs", "projects"]);
		expect(names(await suggestDirectories("~/", home))).toEqual(["docs", "projects"]);
		expect(names(await suggestDirectories("", home))).toEqual(["docs", "projects"]);
		expect(names(await suggestDirectories("relative/thing", home))).toEqual(["docs", "projects"]);
		expect(names(await suggestDirectories("~/pro", home))).toEqual(["projects"]);
		expect(names(await suggestDirectories("~/projects/b", home))).toEqual(["beta"]);
	});

	it("never throws on garbage and caps results at 20", async () => {
		expect(await suggestDirectories("/definitely/not/here/", home)).toEqual([]);
		expect(await suggestDirectories("/bad\0path", home)).toEqual([]);
		const many = path.join(tmp, "many");
		for (let i = 0; i < 30; i++) mkdirSync(path.join(many, `d${String(i).padStart(2, "0")}`), { recursive: true });
		const r = await suggestDirectories(`${many}/`, home);
		expect(r).toHaveLength(20);
		expect(path.basename(r[0]?.path ?? "")).toBe("d00");
	});
});
