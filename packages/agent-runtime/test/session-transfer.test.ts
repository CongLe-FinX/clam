import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { placeSessionFile, standardizeProjectDir } from "../src/omp/index.ts";
import { AgentRuntimeError } from "../src/types.ts";

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "clam-transfer-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function makeSource(withArtifacts: boolean): Promise<string> {
	const dir = join(root, "omp-sessions", "bucket");
	await mkdir(dir, { recursive: true });
	const file = join(dir, "2026-01-01T00-00-00-000Z_abc.jsonl");
	await writeFile(file, '{"type":"session"}\n');
	await writeFile(join(dir, `${file.split("/").at(-1)}.lock.os`), "leftover");
	if (withArtifacts) {
		await mkdir(join(dir, "2026-01-01T00-00-00-000Z_abc", "nested"), { recursive: true });
		await writeFile(join(dir, "2026-01-01T00-00-00-000Z_abc", "nested", "0.txt"), "artifact");
	}
	return file;
}

const exists = (path: string) =>
	stat(path).then(
		() => true,
		() => false,
	);

describe("placeSessionFile", () => {
	it("moves the journal and its artifacts directory, leaving nothing else touched", async () => {
		const source = await makeSource(true);
		const target = join(root, "sessions", "clam-1");
		const placed = await placeSessionFile(source, target);
		expect(placed).toBe(join(target, "2026-01-01T00-00-00-000Z_abc.jsonl"));
		expect(await readFile(placed, "utf8")).toBe('{"type":"session"}\n');
		expect(await readFile(join(target, "2026-01-01T00-00-00-000Z_abc", "nested", "0.txt"), "utf8")).toBe("artifact");
		expect(await exists(source)).toBe(false);
		expect(await exists(join(root, "omp-sessions", "bucket", "2026-01-01T00-00-00-000Z_abc"))).toBe(false);
		// Unrelated sibling files (the harmless lock leftover) stay where they were.
		expect(await readdir(join(root, "omp-sessions", "bucket"))).toEqual(["2026-01-01T00-00-00-000Z_abc.jsonl.lock.os"]);
	});

	it("works without an artifacts directory", async () => {
		const source = await makeSource(false);
		const placed = await placeSessionFile(source, join(root, "sessions", "clam-2"));
		expect(await exists(placed)).toBe(true);
		expect(await readdir(join(root, "sessions", "clam-2"))).toHaveLength(1);
	});

	it("refuses a target that already holds a session, and a bad source", async () => {
		const source = await makeSource(true);
		const target = join(root, "sessions", "clam-3");
		await mkdir(target, { recursive: true });
		await writeFile(join(target, "other.jsonl"), "{}\n");
		const error = await placeSessionFile(source, target).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(AgentRuntimeError);
		expect((error as AgentRuntimeError).code).toBe("invalid_argument");
		expect(await exists(source)).toBe(true);

		const missing = await placeSessionFile(join(root, "nope.jsonl"), join(root, "x")).catch((e: unknown) => e);
		expect((missing as AgentRuntimeError).code).toBe("invalid_argument");
		const notJournal = await placeSessionFile(join(root, "a.txt"), join(root, "x")).catch((e: unknown) => e);
		expect((notJournal as AgentRuntimeError).code).toBe("invalid_argument");
	});

	it("falls back to copy-then-remove when rename crosses devices (injected EXDEV)", async () => {
		const source = await makeSource(true);
		const target = join(root, "sessions", "clam-4");
		const renamed: string[] = [];
		const placed = await placeSessionFile(source, target, {
			async rename(from, to) {
				renamed.push(from);
				throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
			},
		});
		expect(renamed).toHaveLength(2);
		expect(await readFile(placed, "utf8")).toBe('{"type":"session"}\n');
		expect(await readFile(join(target, "2026-01-01T00-00-00-000Z_abc", "nested", "0.txt"), "utf8")).toBe("artifact");
		expect(await exists(source)).toBe(false);
		expect(await exists(join(root, "omp-sessions", "bucket", "2026-01-01T00-00-00-000Z_abc"))).toBe(false);
	});

	it("propagates other rename errors without deleting the source", async () => {
		const source = await makeSource(false);
		const error = await placeSessionFile(source, join(root, "sessions", "clam-5"), {
			async rename() {
				throw Object.assign(new Error("denied"), { code: "EACCES" });
			},
		}).catch((e: unknown) => e);
		expect((error as NodeJS.ErrnoException).code).toBe("EACCES");
		expect(await exists(source)).toBe(true);
	});
});

describe("standardizeProjectDir", () => {
	const same = (a: string, b: string): boolean => a.replace(/^\/private/, "") === b.replace(/^\/private/, "");

	it("strips /private on macOS only when both spellings are the same place (OMP's own rule)", () => {
		expect(standardizeProjectDir("/private/tmp/x/sandbox", "darwin", (p) => (same(p, "/tmp/x/sandbox") ? "/private/tmp/x/sandbox" : p))).toBe("/tmp/x/sandbox");
		expect(standardizeProjectDir("/private/var/folders/a/b", "darwin", (p) => (same(p, "/var/folders/a/b") ? "/private/var/folders/a/b" : p))).toBe("/var/folders/a/b");
	});

	it("keeps paths that are not aliases, other platforms, unresolvable paths and already standard spellings", () => {
		expect(standardizeProjectDir("/private/real/place", "darwin", (p) => p)).toBe("/private/real/place");
		expect(standardizeProjectDir("/private/tmp/x", "linux", (p) => p)).toBe("/private/tmp/x");
		expect(standardizeProjectDir("/private/tmp/x", "darwin", () => {
			throw new Error("ENOENT");
		})).toBe("/private/tmp/x");
		expect(standardizeProjectDir("/tmp/x", "darwin", (p) => p)).toBe("/tmp/x");
		expect(standardizeProjectDir("/Users/me/project", "darwin", (p) => p)).toBe("/Users/me/project");
	});
});
