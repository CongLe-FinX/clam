import { spawnSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOmpCli } from "../src/omp/index.ts";
import { AgentRuntimeError } from "../src/types.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-omp.mjs", import.meta.url));

let home: string;
let work: string;
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "clam-session-cli-"));
	work = join(home, "work");
	await mkdir(work, { recursive: true });
});
afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

function makeCli(extraEnv: NodeJS.ProcessEnv = {}) {
	return createOmpCli({ binary: () => FAKE, env: { FAKE_OMP_HOME: home, ...extraEnv } });
}

async function calls(): Promise<string[][]> {
	const text = await readFile(join(home, "calls.jsonl"), "utf8").catch(() => "");
	return text
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as string[]);
}

/** A journal in the fake's format: header + one user message. */
async function writeJournal(name = "2026-01-01T00-00-00-000Z_sess-1.jsonl"): Promise<string> {
	const file = join(work, name);
	const header = { type: "session", version: 3, id: "sess-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/origin/project" };
	const message = { type: "message", message: { role: "user", content: [{ type: "text", text: "remember PELICAN-42" }], timestamp: 1 } };
	await writeFile(file, `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`);
	return file;
}

function lockPath(file: string): string {
	return join(work, `.${file.split("/").at(-1)}.lock.os`);
}

function deadPid(): number {
	const child = spawnSync(process.execPath, ["-e", "0"]);
	return child.pid;
}

async function rejection(promise: Promise<unknown>): Promise<AgentRuntimeError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(AgentRuntimeError);
		return error as AgentRuntimeError;
	}
	throw new Error("expected a rejection");
}

describe("sessionPack", () => {
	it("packs a session, returns the archive path and logs argv as an array", async () => {
		const file = await writeJournal();
		const out = join(work, "snap.tar");
		const result = await makeCli().sessionPack(file, out);
		expect(result).toEqual({ archivePath: out });
		expect((await stat(out)).size).toBeGreaterThan(2048);
		expect(await calls()).toContainEqual(["session", "pack", file, out]);
	});

	it("is deterministic for the same journal", async () => {
		const file = await writeJournal();
		await makeCli().sessionPack(file, join(work, "a.tar"));
		await makeCli().sessionPack(file, join(work, "b.tar"));
		expect(await readFile(join(work, "a.tar"), "utf8")).toBe(await readFile(join(work, "b.tar"), "utf8"));
	});

	it("refuses with session_locked while a live process holds the lease, and ignores a stale lock", async () => {
		const file = await writeJournal();
		await writeFile(lockPath(file), String(process.pid));
		const error = await rejection(makeCli().sessionPack(file, join(work, "snap.tar")));
		expect(error.code).toBe("session_locked");
		expect(error.message).toContain("another live omp process");
		await expect(stat(join(work, "snap.tar"))).rejects.toThrow();

		await writeFile(lockPath(file), String(deadPid()));
		await expect(makeCli().sessionPack(file, join(work, "snap.tar"))).resolves.toEqual({ archivePath: join(work, "snap.tar") });
	});

	it("rejects bad arguments before spawning anything", async () => {
		const file = await writeJournal();
		const cli = makeCli();
		expect((await rejection(cli.sessionPack("", join(work, "o.tar")))).code).toBe("invalid_argument");
		expect((await rejection(cli.sessionPack(file, "  "))).code).toBe("invalid_argument");
		expect((await rejection(cli.sessionPack("--help", join(work, "o.tar")))).code).toBe("invalid_argument");
		expect((await rejection(cli.sessionPack(file, "-o.tar"))).code).toBe("invalid_argument");
		expect((await rejection(cli.sessionPack(join(work, "missing.jsonl"), join(work, "o.tar")))).code).toBe("invalid_argument");
		expect(await calls()).toEqual([]);
	});

	it("maps a timeout", async () => {
		const file = await writeJournal();
		const error = await rejection(makeCli({ FAKE_OMP_SESSION_SLOW_MS: "5000" }).sessionPack(file, join(work, "o.tar"), { timeoutMs: 300 }));
		expect(error.code).toBe("timeout");
	});

	it("maps a spawn failure and a missing binary", async () => {
		const file = await writeJournal();
		const broken = createOmpCli({ binary: () => join(home, "no-such-omp") });
		expect((await rejection(broken.sessionPack(file, join(work, "o.tar")))).code).toBe("start_failed");
		const missing = createOmpCli({ binary: () => null });
		expect((await rejection(missing.sessionPack(file, join(work, "o.tar")))).code).toBe("not_installed");
	});
});

describe("sessionUnpack", () => {
	async function pack(): Promise<string> {
		const file = await writeJournal();
		const out = join(work, "snap.tar");
		await makeCli().sessionPack(file, out);
		return out;
	}

	it("creates a new local session for the cwd and reports the created mode", async () => {
		const archive = await pack();
		const cwd = join(work, "projB");
		const result = await makeCli().sessionUnpack(archive, cwd);
		expect(result.mode).toBe("created");
		expect(isAbsolute(result.sessionFile)).toBe(true);
		expect(result.sessionFile.startsWith(join(home, "sessions"))).toBe(true);
		expect(result.sessionFile.endsWith("_sess-1.jsonl")).toBe(true);
		const lines = (await readFile(result.sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		expect(lines[0]).toMatchObject({ type: "session", id: "sess-1", cwd });
		expect(lines[1].message.content[0].text).toBe("remember PELICAN-42");
		expect(lines.at(-1)).toMatchObject({ type: "message", message: { role: "custom", customType: "arrived" } });
		expect((await calls()).at(-1)).toEqual(["session", "unpack", archive, "--cwd", cwd]);
	});

	it("rejects garbage, tampered and missing archives as invalid_archive", async () => {
		const cli = makeCli();
		const garbage = join(work, "garbage.tar");
		await writeFile(garbage, "not an archive at all");
		expect((await rejection(cli.sessionUnpack(garbage, work))).code).toBe("invalid_archive");

		const archive = await pack();
		const envelope = JSON.parse(await readFile(archive, "utf8"));
		envelope.session += "tampered\n";
		const tampered = join(work, "tampered.tar");
		await writeFile(tampered, JSON.stringify(envelope));
		expect((await rejection(cli.sessionUnpack(tampered, work))).code).toBe("invalid_archive");

		expect((await rejection(cli.sessionUnpack(join(work, "missing.tar"), work))).code).toBe("invalid_archive");
	});

	it("rejects bad arguments", async () => {
		const cli = makeCli();
		expect((await rejection(cli.sessionUnpack("", work))).code).toBe("invalid_argument");
		expect((await rejection(cli.sessionUnpack("-x.tar", work))).code).toBe("invalid_argument");
		expect((await rejection(cli.sessionUnpack(join(work, "a.tar"), ""))).code).toBe("invalid_argument");
		expect((await rejection(cli.sessionUnpack(join(work, "a.tar"), "--cwd"))).code).toBe("invalid_argument");
	});

	it("maps a timeout", async () => {
		const archive = await pack();
		const error = await rejection(makeCli({ FAKE_OMP_SESSION_SLOW_MS: "5000" }).sessionUnpack(archive, work, { timeoutMs: 300 }));
		expect(error.code).toBe("timeout");
	});
});

describe("sessionMoved", () => {
	it("marks the copy as departed", async () => {
		const file = await writeJournal();
		await makeCli().sessionMoved(file, "node-b");
		const last = (await readFile(file, "utf8")).trim().split("\n").at(-1) as string;
		expect(JSON.parse(last)).toMatchObject({ message: { role: "custom", customType: "departed" } });
		expect((await calls()).at(-1)).toEqual(["session", "moved", file, "--to", "node-b"]);
	});

	it("refuses with session_locked while a live process writes the session", async () => {
		const file = await writeJournal();
		await writeFile(lockPath(file), String(process.pid));
		expect((await rejection(makeCli().sessionMoved(file, "node-b"))).code).toBe("session_locked");
		expect((await readFile(file, "utf8")).includes("departed")).toBe(false);
	});

	it("rejects bad arguments and missing files", async () => {
		const file = await writeJournal();
		const cli = makeCli();
		expect((await rejection(cli.sessionMoved(file, ""))).code).toBe("invalid_argument");
		expect((await rejection(cli.sessionMoved(file, "--to"))).code).toBe("invalid_argument");
		expect((await rejection(cli.sessionMoved(join(work, "missing.jsonl"), "node-b"))).code).toBe("invalid_argument");
		await appendFile(file, "");
		expect(await calls()).toEqual([]);
	});

	it("maps a timeout", async () => {
		const file = await writeJournal();
		const error = await rejection(makeCli({ FAKE_OMP_SESSION_SLOW_MS: "5000" }).sessionMoved(file, "node-b", { timeoutMs: 300 }));
		expect(error.code).toBe("timeout");
	});
});
