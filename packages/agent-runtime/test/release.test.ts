import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type OmpRuntimeOptions, type OmpSupervisor, createOmpCli, createOmpRuntime, placeSessionFile } from "../src/omp/index.ts";
import { AgentRuntimeError, type RuntimeSessionSpec } from "../src/types.ts";

const FAKE_OMP = fileURLToPath(new URL("./fixtures/fake-omp.mjs", import.meta.url));

let tmp: string;
const supervisors: OmpSupervisor[] = [];

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "clam-release-"));
});

afterEach(async () => {
	await Promise.all(supervisors.splice(0).map((s) => s.shutdown()));
	rmSync(tmp, { recursive: true, force: true });
});

function create(options: Partial<OmpRuntimeOptions> = {}) {
	const supervisor = createOmpRuntime({
		binary: () => FAKE_OMP,
		settings: { maxConcurrentRuntimes: 4, idleTimeoutMs: 60_000, approvalMode: "yolo" },
		env: { FAKE_OMP_LOG: join(tmp, "fake.log"), FAKE_OMP_EVENT_DELAY_MS: "1", FAKE_OMP_HOME: join(tmp, "home") },
		startTimeoutMs: 5000,
		requestTimeoutMs: 5000,
		closeGraceMs: 1000,
		stateRefreshMs: 10,
		restart: { baseDelayMs: 20, maxDelayMs: 100, maxAttempts: 3 },
		reapIntervalMs: 20,
		...options,
	});
	supervisors.push(supervisor);
	return supervisor;
}

function cli() {
	return createOmpCli({ binary: () => FAKE_OMP, env: { FAKE_OMP_HOME: join(tmp, "home") } });
}

function spec(id: string, cwd = join(tmp, "project")): RuntimeSessionSpec {
	mkdirSync(cwd, { recursive: true });
	return { sessionId: id, cwd, sessionDir: join(tmp, "sessions", id) };
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function records(kind: string): Array<{ kind: string; action?: string }> {
	return readFileSync(join(tmp, "fake.log"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { kind: string; action?: string })
		.filter((record) => record.kind === kind);
}

async function transcript(supervisor: OmpSupervisor, id: string): Promise<string> {
	const session = supervisor.get(id);
	if (!session) throw new Error("no session");
	return JSON.stringify((await session.messages({ limit: 100 })).messages);
}

async function settledPrompt(supervisor: OmpSupervisor, id: string, message: string, cwd?: string) {
	const session = await supervisor.open(spec(id, cwd));
	const before = (await session.messages({ limit: 100 })).messages.length;
	await session.prompt({ message, clientId: `c-${message}` });
	await waitFor(() => (supervisor.get(id)?.status().state ?? "") === "ready", "ready");
	// Wait for the assistant reply (user + assistant = 2 new messages).
	const deadline = Date.now() + 8000;
	while ((await session.messages({ limit: 100 })).messages.length < before + 2) {
		if (Date.now() > deadline) throw new Error("no assistant reply");
		await sleep(10);
	}
	return session;
}

describe("OmpSupervisor.withReleased", () => {
	it("stops the process so the lease is released, then restarts it in the background", async () => {
		const supervisor = create();
		const session = await settledPrompt(supervisor, "s1", "hello release");
		const file = session.binding().runtimeSessionFile as string;
		const out = join(tmp, "snap.tar");

		await expect(cli().sessionPack(file, out)).rejects.toMatchObject({ code: "session_locked" });
		expect(records("lease").map((r) => r.action)).toEqual(["acquired"]);

		const result = await supervisor.withReleased("s1", async () => {
			expect(supervisor.get("s1")?.state).toBe("stopped");
			return cli().sessionPack(file, out);
		});
		expect(result).toEqual({ archivePath: out });
		expect(records("lease").map((r) => r.action)).toEqual(["acquired", "released"]);

		await waitFor(() => supervisor.get("s1")?.state === "ready", "background restart");
		expect(records("spawn")).toHaveLength(2);
		// The conversation survived the cycle and the new process can be prompted.
		expect(await transcript(supervisor, "s1")).toContain("FAKE: hello release");
	});

	it("makes a prompt issued during the cycle wait, then succeed", async () => {
		const supervisor = create();
		await settledPrompt(supervisor, "s2", "first");
		let workDone = false;
		let promptSettled = false;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const cycle = supervisor.withReleased("s2", async () => {
			await gate;
			workDone = true;
		});
		await waitFor(() => supervisor.get("s2")?.state === "stopped", "released");
		const prompted = (async () => {
			const session = await supervisor.open(spec("s2"));
			await session.prompt({ message: "during", clientId: "c-during" });
			promptSettled = true;
		})();
		await sleep(200);
		expect(promptSettled).toBe(false);
		expect(supervisor.get("s2")?.state).toBe("stopped");
		release();
		await cycle;
		await prompted;
		expect(workDone).toBe(true);
		await waitFor(() => supervisor.get("s2")?.state === "ready", "ready again");
		const deadline = Date.now() + 8000;
		while (!(await transcript(supervisor, "s2")).includes("FAKE: during")) {
			if (Date.now() > deadline) throw new Error("prompt during the cycle was not answered");
			await sleep(10);
		}
		expect(records("spawn")).toHaveLength(2);
	});

	it("rejects with invalid_state when the session does not settle in time, without stopping it", async () => {
		const supervisor = create();
		const session = await supervisor.open(spec("s3"));
		await session.prompt({ message: "__slow__", clientId: "c-slow" });
		await waitFor(() => supervisor.get("s3")?.state === "busy", "busy");
		let ran = false;
		const error = await supervisor
			.withReleased("s3", async () => {
				ran = true;
			}, { idleTimeoutMs: 200 })
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(AgentRuntimeError);
		expect((error as AgentRuntimeError).code).toBe("invalid_state");
		expect((error as AgentRuntimeError).message).toContain("busy");
		expect(ran).toBe(false);
		expect(supervisor.get("s3")?.state).toBe("busy");
		await session.abort();
	});

	it("does not start anything when there was no live process", async () => {
		const supervisor = create();
		await settledPrompt(supervisor, "s4", "hello");
		await supervisor.stop("s4");
		const value = await supervisor.withReleased("s4", async () => 42);
		expect(value).toBe(42);
		await sleep(150);
		expect(supervisor.get("s4")).toBeUndefined();
		expect(records("spawn")).toHaveLength(1);
		// A never-opened session id works too.
		await expect(supervisor.withReleased("never", async () => "ok")).resolves.toBe("ok");
		expect(records("spawn")).toHaveLength(1);
	});

	it("restarts and rethrows when the work throws", async () => {
		const supervisor = create();
		await settledPrompt(supervisor, "s5", "hello");
		const boom = new Error("pack failed");
		await expect(
			supervisor.withReleased("s5", async () => {
				throw boom;
			}),
		).rejects.toBe(boom);
		await waitFor(() => supervisor.get("s5")?.state === "ready", "restart after failure");
		expect(records("spawn")).toHaveLength(2);
	});

	it("serializes concurrent cycles of one session", async () => {
		const supervisor = create();
		await settledPrompt(supervisor, "s6", "hello");
		const order: string[] = [];
		const job = (name: string, ms: number) => async () => {
			order.push(`${name}:start`);
			await sleep(ms);
			order.push(`${name}:end`);
			return name;
		};
		const results = await Promise.all([
			supervisor.withReleased("s6", job("a", 80)),
			supervisor.withReleased("s6", job("b", 10)),
			supervisor.withReleased("s6", job("c", 10)),
		]);
		expect(results).toEqual(["a", "b", "c"]);
		expect(order).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
		await waitFor(() => supervisor.get("s6")?.state === "ready", "ready");
	});

	it("does not deadlock or restart when the supervisor shuts down during the work", async () => {
		const supervisor = create();
		await settledPrompt(supervisor, "s7", "hello");
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const cycle = supervisor.withReleased("s7", () => gate);
		await waitFor(() => supervisor.get("s7")?.state === "stopped", "released");
		await supervisor.shutdown();
		release();
		await cycle;
		await sleep(100);
		expect(records("spawn")).toHaveLength(1);
	});

	it("does not restart when the session is stopped explicitly during the work", async () => {
		const supervisor = create();
		await settledPrompt(supervisor, "s8", "hello");
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const cycle = supervisor.withReleased("s8", () => gate);
		await waitFor(() => supervisor.get("s8")?.state === "stopped", "released");
		await supervisor.stop("s8");
		release();
		await cycle;
		await sleep(100);
		expect(supervisor.get("s8")).toBeUndefined();
		expect(records("spawn")).toHaveLength(1);
	});
});

describe("session round trip with the fake omp", () => {
	it("packs a driver session, unpacks it elsewhere and resumes it in a new runtime", async () => {
		const supervisor = create();
		const driver = await settledPrompt(supervisor, "driver", "remember PELICAN-42");
		const sessionFile = driver.binding().runtimeSessionFile as string;
		const ompCli = cli();

		const archive = await supervisor.withReleased("driver", () => ompCli.sessionPack(sessionFile, join(tmp, "driver.tar")));

		const otherCwd = join(tmp, "projB");
		mkdirSync(otherCwd, { recursive: true });
		const unpacked = await ompCli.sessionUnpack(archive.archivePath, otherCwd);
		expect(unpacked.mode).toBe("created");
		const targetDir = join(tmp, "sessions", "taker");
		const placed = await placeSessionFile(unpacked.sessionFile, targetDir);
		expect(placed.startsWith(targetDir)).toBe(true);

		const taker = await settledPrompt(supervisor, "taker", "what did I say?", otherCwd);
		expect(taker.binding().runtimeSessionFile).toBe(placed);
		const text = await transcript(supervisor, "taker");
		expect(text).toContain("FAKE: remember PELICAN-42");
		expect(text).toContain("arrived");
		expect(text).toContain("FAKE: what did I say?");
		// The driver is untouched and running again.
		await waitFor(() => supervisor.get("driver")?.state === "ready", "driver restarted");
	});
});
