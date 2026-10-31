import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSetupCommand, scrubOutputLine } from "../src/index.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "clam-run-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("runSetupCommand", () => {
	it("captures output in cwd and reports the exit code", async () => {
		const lines: string[] = [];
		const r = await runSetupCommand({ command: "pwd; echo out; echo err 1>&2; exit 3", cwd: dir, timeoutMs: 10_000, onOutput: (l) => lines.push(l) });
		expect(r).toMatchObject({ exitCode: 3, timedOut: false, aborted: false, error: null });
		expect(lines).toContain("out");
		expect(lines).toContain("err");
		expect(r.outputTail.split("\n")[0]).toContain(dir.replace(/^\/private/, ""));
	});

	it("keeps only the last N lines", async () => {
		const r = await runSetupCommand({ command: "for i in $(seq 1 50); do echo line$i; done", cwd: dir, timeoutMs: 10_000, maxTailLines: 5 });
		expect(r.exitCode).toBe(0);
		expect(r.outputTail.split("\n")).toEqual(["line46", "line47", "line48", "line49", "line50"]);
	});

	it("scrubs secrets from the tail and the callback", async () => {
		const token = "ghp_Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb3d";
		const seen: string[] = [];
		const r = await runSetupCommand({ command: `echo "token ${token}"; echo fine`, cwd: dir, timeoutMs: 10_000, onOutput: (l) => seen.push(l) });
		expect(r.outputTail).not.toContain(token);
		expect(seen.join("\n")).not.toContain(token);
		expect(r.outputTail).toContain("[line redacted");
		expect(r.outputTail).toContain("fine");
		expect(scrubOutputLine("hello world")).toBe("hello world");
	});

	it("handles a final line without newline", async () => {
		const r = await runSetupCommand({ command: "printf partial", cwd: dir, timeoutMs: 10_000 });
		expect(r.outputTail).toBe("partial");
	});

	it("timeout kills the child process group, including grandchildren", async () => {
		const pidFile = join(dir, "pids");
		const started = Date.now();
		const r = await runSetupCommand({
			command: `(sleep 60 & echo $! >> "${pidFile}"; wait) & echo $! >> "${pidFile}"; sleep 60`,
			cwd: dir,
			timeoutMs: 600,
			killGraceMs: 300,
		});
		expect(r.timedOut).toBe(true);
		expect(Date.now() - started).toBeLessThan(10_000);
		await sleep(200);
		const pids = readFileSync(pidFile, "utf8").split(/\s+/).filter(Boolean).map(Number);
		expect(pids.length).toBeGreaterThan(0);
		for (const pid of pids) expect(alive(pid)).toBe(false);
	});

	it("escalates to SIGKILL when SIGTERM is ignored", async () => {
		const r = await runSetupCommand({ command: "trap '' TERM; sleep 30", cwd: dir, timeoutMs: 300, killGraceMs: 300 });
		expect(r.timedOut).toBe(true);
		expect(r.exitCode === null || r.exitCode !== 0).toBe(true);
	});

	it("abort signal kills and reports aborted", async () => {
		const ac = new AbortController();
		const p = runSetupCommand({ command: "sleep 30", cwd: dir, timeoutMs: 60_000, signal: ac.signal, killGraceMs: 300 });
		setTimeout(() => ac.abort(), 200);
		const r = await p;
		expect(r).toMatchObject({ aborted: true, timedOut: false });
	});

	it("an already-aborted signal never starts the command", async () => {
		const ac = new AbortController();
		ac.abort();
		const marker = join(dir, "ran");
		const r = await runSetupCommand({ command: `touch "${marker}"`, cwd: dir, timeoutMs: 5000, signal: ac.signal });
		expect(r.aborted).toBe(true);
		expect(() => readFileSync(marker)).toThrow();
	});

	it("reports a spawn failure (bad cwd) without throwing", async () => {
		writeFileSync(join(dir, "f"), "");
		const r = await runSetupCommand({ command: "echo hi", cwd: join(dir, "f"), timeoutMs: 5000 });
		expect(r.error ?? "").not.toBe("");
		expect(r.exitCode).toBeNull();
	});
});
