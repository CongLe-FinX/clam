import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HandoffEnvironment } from "@clam/contracts";
import { type ClamDb, openDatabase } from "@clam/database";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HandoffHub, DEFAULT_HANDOFF_TIMINGS, HandoffStepError, type SetupInput } from "../src/handoff/hub.ts";
import { DependencySetup } from "../src/handoff/setup.ts";
import { HandoffStore } from "../src/handoff/store.ts";
import { writeNodeSettings } from "../src/services/settings.ts";

/** Dependency setup + validation against real temp folders; the rest of the handoff engine is not needed. */

const APPEND = (file: string) => `node -e "require('fs').appendFileSync('${file}','x')"`;

let root: string;
let dir: string;
let db: ClamDb;
let store: HandoffStore;
let setup: DependencySetup;
let notes: string[];
let changes: number;

function hubOf(timings: Partial<typeof DEFAULT_HANDOFF_TIMINGS> = {}): HandoffHub {
	return {
		store,
		ctx: { db },
		log: { debug() {}, warn() {}, info() {}, error() {} },
		timings: { ...DEFAULT_HANDOFF_TIMINGS, ...timings },
		changed: () => {
			changes += 1;
		},
		note: (_id: string, summary: string) => {
			notes.push(summary);
		},
	} as unknown as HandoffHub;
}

function env(over: Partial<HandoffEnvironment> = {}): HandoffEnvironment {
	return { os: null, arch: null, runtimes: [], packageManager: null, requiredEnvVars: [], setupCommands: [], checkCommand: null, ...over };
}

const install = (command: string): HandoffEnvironment["packageManager"] => ({ name: "node", lockfile: null, installCommand: command });

function input(over: Partial<SetupInput> = {}): SetupInput {
	return { dir, environment: env(), requiredFiles: [], gitCommit: null, checkCommand: null, ...over };
}

function handoff(id: string): string {
	store.insert({
		id,
		kind: "task",
		role: "target",
		state: "context_restored",
		peerId: "node_peer",
		subjectId: "tsk_1",
		title: "t",
		workspaceId: "ws_1",
		sourceNodeId: "node_peer",
		sourceNodeName: "peer",
		targetNodeId: "node_self",
		targetNodeName: "self",
		fromEpoch: 0,
		toEpoch: 1,
		vcs: "files",
		correlationId: "corr_1",
	});
	return id;
}

const count = (file: string): number => (existsSync(join(dir, file)) ? readFileSync(join(dir, file), "utf8").length : 0);

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "clam-handoff-setup-"));
	dir = join(root, "work");
	mkdirSync(dir);
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "tiny", version: "1.0.0" }));
	db = openDatabase({ file: join(root, "clam.db") });
	store = new HandoffStore(db, { nodeId: "node_self" });
	notes = [];
	changes = 0;
	setup = new DependencySetup(hubOf());
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("policy ask", () => {
	it("waits for approval, runs after approve, and is ready", async () => {
		writeNodeSettings(db, { dependencySetup: "ask" });
		const id = handoff("hnd_ask");
		const environment = env({ packageManager: install(APPEND("ran.txt")), setupCommands: [APPEND("setup.txt")] });

		const first = await setup.setupAndValidate(id, input({ environment }));
		expect(first).toEqual({ status: "waiting", pending: [APPEND("ran.txt"), APPEND("setup.txt")] });
		expect(count("ran.txt")).toBe(0);
		const rows = store.setupRows(id);
		expect(rows.map((r) => [r.purpose, r.state])).toEqual([
			["install", "pending_approval"],
			["setup", "pending_approval"],
		]);

		// still waiting after a partial answer
		setup.decide(id, { approve: [rows[0]?.id as string], deny: [] });
		expect((await setup.setupAndValidate(id, input({ environment }))).status).toBe("waiting");
		expect(count("ran.txt")).toBe(0);

		setup.decide(id, { approve: [rows[1]?.id as string], deny: [] });
		const done = await setup.setupAndValidate(id, input({ environment }));
		expect(done.status).toBe("ready");
		if (done.status !== "ready") return;
		expect(done.report.ran.map((r) => r.exitCode)).toEqual([0, 0]);
		expect(done.report.skipped).toEqual([]);
		expect(count("ran.txt")).toBe(1);
		expect(count("setup.txt")).toBe(1);
		expect(store.setupRows(id).every((r) => r.state === "succeeded")).toBe(true);
		expect(store.get(id).setupFingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect(changes).toBeGreaterThan(0);
	});

	it("a denied command is skipped with a reason, never a failure", async () => {
		writeNodeSettings(db, { dependencySetup: "ask" });
		const id = handoff("hnd_deny");
		const environment = env({ packageManager: install(APPEND("ran.txt")) });
		await setup.setupAndValidate(id, input({ environment }));
		const [row] = store.setupRows(id);
		setup.decide(id, { approve: [], deny: [row?.id as string] });

		const outcome = await setup.setupAndValidate(id, input({ environment }));
		expect(outcome.status).toBe("ready");
		if (outcome.status !== "ready") return;
		expect(count("ran.txt")).toBe(0);
		expect(outcome.report.ran).toEqual([]);
		expect(outcome.report.skipped).toEqual([{ command: APPEND("ran.txt"), reason: "denied by the user on this node" }]);
		expect(store.get(id).setupFingerprint).toBeNull();
	});

	it("rejects unknown or conflicting decisions", async () => {
		writeNodeSettings(db, { dependencySetup: "ask" });
		const id = handoff("hnd_bad");
		await setup.setupAndValidate(id, input({ environment: env({ packageManager: install(APPEND("ran.txt")) }) }));
		const [row] = store.setupRows(id);
		expect(() => setup.decide(id, { approve: ["hsu_nope"], deny: [] })).toThrow(/not found/i);
		expect(() => setup.decide(id, { approve: [row?.id as string], deny: [row?.id as string] })).toThrow();
		setup.decide(id, { approve: [row?.id as string], deny: [] });
		setup.decide(id, { approve: [row?.id as string], deny: [] });
		expect(() => setup.decide(id, { approve: [], deny: [row?.id as string] })).toThrow(/approved already/);
	});
});

describe("nested projects", () => {
	const project = (rel: string, command: string): NonNullable<HandoffEnvironment["projects"]>[number] => ({ path: rel, packageManager: { name: "node", lockfile: null, installCommand: command } });

	it("installs each nested project with its own folder as the working directory, after the root's install", async () => {
		writeNodeSettings(db, { dependencySetup: "auto" });
		mkdirSync(join(dir, "web"));
		mkdirSync(join(dir, "services", "api"), { recursive: true });
		const id = handoff("hnd_nested");
		const environment = env({ packageManager: install(APPEND("ran.txt")), projects: [project("web", APPEND("ran.txt")), project("services/api", APPEND("ran.txt"))] });

		const outcome = await setup.setupAndValidate(id, input({ environment }));
		expect(outcome.status).toBe("ready");
		// the same command ran three times, once per folder: it is the cwd that makes them different installs
		expect(count("ran.txt")).toBe(1);
		expect(count("web/ran.txt")).toBe(1);
		expect(count("services/api/ran.txt")).toBe(1);
		expect(store.setupRows(id).map((r) => [r.purpose, r.state, r.cwd])).toEqual([
			["install", "succeeded", dir],
			["install", "succeeded", join(dir, "web")],
			["install", "succeeded", join(dir, "services", "api")],
		]);
		expect(store.get(id).setupFingerprint).toMatch(/^[0-9a-f]{64}$/);
	});

	it("with nothing at the root, a nested project is still installed (and asked about) on its own", async () => {
		writeNodeSettings(db, { dependencySetup: "ask" });
		mkdirSync(join(dir, "web"));
		const id = handoff("hnd_nested_ask");
		const environment = env({ projects: [project("web", APPEND("ran.txt"))] });

		expect(await setup.setupAndValidate(id, input({ environment }))).toEqual({ status: "waiting", pending: [APPEND("ran.txt")] });
		const [row] = store.setupRows(id);
		expect(row?.cwd).toBe(join(dir, "web"));
		setup.decide(id, { approve: [row?.id as string], deny: [] });
		expect((await setup.setupAndValidate(id, input({ environment }))).status).toBe("ready");
		expect(count("web/ran.txt")).toBe(1);
		expect(count("ran.txt")).toBe(0);
	});

	it("a nested folder that escapes the work folder (a hostile manifest) is never run", async () => {
		writeNodeSettings(db, { dependencySetup: "auto" });
		const id = handoff("hnd_nested_escape");
		const environment = env({ projects: [project("../outside", APPEND("pwned.txt")), project("/tmp", APPEND("pwned.txt"))] });
		const outcome = await setup.setupAndValidate(id, input({ environment }));
		expect(outcome.status).toBe("ready");
		expect(store.setupRows(id)).toEqual([]);
		expect(existsSync(join(root, "outside", "pwned.txt"))).toBe(false);
	});
});

describe("policy auto and skip", () => {
	it("auto runs every command without asking", async () => {
		writeNodeSettings(db, { dependencySetup: "auto" });
		const id = handoff("hnd_auto");
		const outcome = await setup.setupAndValidate(id, input({ environment: env({ packageManager: install(APPEND("ran.txt")), setupCommands: [APPEND("ran.txt")] }) }));
		expect(outcome.status).toBe("ready");
		expect(count("ran.txt")).toBe(1); // the duplicate command is planned once
		expect(notes.some((n) => n.includes("succeeded"))).toBe(true);
	});

	it("skip marks everything skipped and runs nothing", async () => {
		writeNodeSettings(db, { dependencySetup: "skip" });
		const id = handoff("hnd_skip");
		const outcome = await setup.setupAndValidate(id, input({ environment: env({ packageManager: install(APPEND("ran.txt")) }), checkCommand: APPEND("check.txt") }));
		expect(outcome.status).toBe("ready");
		if (outcome.status !== "ready") return;
		expect(count("ran.txt")).toBe(0);
		expect(count("check.txt")).toBe(0);
		expect(outcome.report.skipped.map((s) => s.command)).toEqual([APPEND("ran.txt"), APPEND("check.txt")]);
		expect(outcome.report.skipped[0]?.reason).toMatch(/switched off/);
	});

	it("nothing to do is ready at once, even under ask", async () => {
		writeNodeSettings(db, { dependencySetup: "ask" });
		const outcome = await setup.setupAndValidate(handoff("hnd_none"), input());
		expect(outcome).toEqual({ status: "ready", report: { ran: [], skipped: [], validation: "nothing to validate" } });
	});
});

describe("failures", () => {
	it("a failing command fails the step with deps_failed and the row keeps the output", async () => {
		writeNodeSettings(db, { dependencySetup: "auto" });
		const id = handoff("hnd_fail");
		const environment = env({ packageManager: install(`node -e "console.log('boom-line'); process.exit(3)"`) });
		const error = await setup.setupAndValidate(id, input({ environment })).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(HandoffStepError);
		expect((error as HandoffStepError).code).toBe("deps_failed");
		expect((error as HandoffStepError).step).toBe(5);
		expect((error as HandoffStepError).message).toMatch(/exited with code 3.*boom-line/);
		const [row] = store.setupRows(id);
		expect(row).toMatchObject({ state: "failed", exitCode: 3 });
		expect(row?.outputTail).toContain("boom-line");
		expect(store.get(id).setupFingerprint).toBeNull();
	});

	it("a failed command is run again on re-entry", async () => {
		writeNodeSettings(db, { dependencySetup: "auto" });
		const id = handoff("hnd_retry");
		// fails until flag.txt exists
		const command = `node -e "const fs=require('fs');if(!fs.existsSync('flag.txt')){process.exit(1)};fs.appendFileSync('ran.txt','x')"`;
		const environment = env({ packageManager: install(command) });
		await expect(setup.setupAndValidate(id, input({ environment }))).rejects.toMatchObject({ code: "deps_failed" });
		writeFileSync(join(dir, "flag.txt"), "ok");
		expect((await setup.setupAndValidate(id, input({ environment }))).status).toBe("ready");
		expect(count("ran.txt")).toBe(1);
	});

	it("a command over the step timeout fails with deps_failed", async () => {
		writeNodeSettings(db, { dependencySetup: "auto" });
		const slow = new DependencySetup(hubOf({ stepTimeoutMs: 200 }));
		const id = handoff("hnd_slow");
		const environment = env({ packageManager: install(`node -e "setTimeout(()=>{},30000)"`) });
		await expect(slow.setupAndValidate(id, input({ environment }))).rejects.toMatchObject({ code: "deps_failed", message: expect.stringMatching(/timed out/) });
	});
});

describe("fingerprint", () => {
	it("an unchanged input is not set up twice", async () => {
		writeNodeSettings(db, { dependencySetup: "auto" });
		const id = handoff("hnd_fp");
		const environment = env({ packageManager: install(APPEND("ran.txt")) });
		await setup.setupAndValidate(id, input({ environment }));
		expect(count("ran.txt")).toBe(1);

		// the rows are gone (e.g. a re-planned run), the fingerprint still says: done for exactly this input
		store.clearSetup(id);
		const again = await setup.setupAndValidate(id, input({ environment }));
		expect(count("ran.txt")).toBe(1);
		expect(again.status).toBe("ready");
		if (again.status !== "ready") return;
		expect(again.report.skipped[0]?.reason).toMatch(/already set up/);

		// changing the dependencies changes the fingerprint
		store.clearSetup(id);
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "tiny", version: "2.0.0" }));
		await setup.setupAndValidate(id, input({ environment }));
		expect(count("ran.txt")).toBe(2);
	});

	it("a succeeded command is not re-run on re-entry", async () => {
		writeNodeSettings(db, { dependencySetup: "auto" });
		const id = handoff("hnd_reenter");
		const environment = env({ packageManager: install(APPEND("ran.txt")), setupCommands: [APPEND("two.txt")] });
		await setup.setupAndValidate(id, input({ environment }));
		await setup.setupAndValidate(id, input({ environment }));
		expect([count("ran.txt"), count("two.txt")]).toEqual([1, 1]);
	});
});

describe("runtime issues", () => {
	it("reports a missing or mismatching tool without failing", async () => {
		writeNodeSettings(db, { dependencySetup: "skip" });
		const id = handoff("hnd_rt");
		const outcome = await setup.setupAndValidate(id, input({ environment: env({ runtimes: [{ name: "node", versionRange: ">=9999" }] }) }));
		expect(outcome.status).toBe("ready");
		if (outcome.status !== "ready") return;
		expect(outcome.report.runtimeIssues?.[0]).toMatch(/node .* does not satisfy >=9999/);
	});
});

describe("validation (step 6)", () => {
	it("required files must exist", async () => {
		writeNodeSettings(db, { dependencySetup: "auto" });
		const id = handoff("hnd_req");
		writeFileSync(join(dir, "a.txt"), "a");
		await expect(setup.setupAndValidate(id, input({ requiredFiles: ["a.txt", "missing.txt", "sub/gone.txt"] }))).rejects.toMatchObject({
			code: "validation_failed",
			step: 6,
			message: expect.stringMatching(/missing\.txt, sub\/gone\.txt/),
		});
		mkdirSync(join(dir, "sub"));
		writeFileSync(join(dir, "missing.txt"), "m");
		writeFileSync(join(dir, "sub", "gone.txt"), "g");
		const outcome = await setup.setupAndValidate(id, input({ requiredFiles: ["a.txt", "missing.txt", "sub/gone.txt"] }));
		expect(outcome.status === "ready" && outcome.report.validation).toBe("3 required files present");
	});

	it("a required path cannot escape the folder", async () => {
		const id = handoff("hnd_escape");
		writeFileSync(join(root, "outside.txt"), "x");
		await expect(setup.setupAndValidate(id, input({ requiredFiles: ["../outside.txt"] }))).rejects.toMatchObject({ code: "validation_failed" });
	});

	it("git HEAD must equal the commit", async () => {
		const id = handoff("hnd_git");
		const run = (...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
		run("init", "-q");
		run("add", ".");
		run("commit", "-q", "-m", "one");
		const head = run("rev-parse", "HEAD");
		const ok = await setup.setupAndValidate(id, input({ gitCommit: head }));
		expect(ok.status === "ready" && ok.report.validation).toBe(`HEAD matches ${head.slice(0, 12)}`);
		await expect(setup.setupAndValidate(id, input({ gitCommit: "0".repeat(40) }))).rejects.toMatchObject({ code: "validation_failed", message: expect.stringMatching(/HEAD is .*expected 000000000000/) });
	});

	it("not a git repository fails when a commit is expected", async () => {
		const id = handoff("hnd_nogit");
		await expect(setup.setupAndValidate(id, input({ gitCommit: "a".repeat(40) }))).rejects.toMatchObject({ code: "validation_failed", message: expect.stringMatching(/not a git repository/) });
	});

	it("the check command must pass (and needs approval under ask)", async () => {
		writeNodeSettings(db, { dependencySetup: "ask" });
		const id = handoff("hnd_check");
		const check = `node -e "process.exit(require('fs').existsSync('ok.txt')?0:2)"`;
		const first = await setup.setupAndValidate(id, input({ checkCommand: check }));
		expect(first).toEqual({ status: "waiting", pending: [check] });
		const [row] = store.setupRows(id);
		expect(row?.purpose).toBe("check");
		setup.decide(id, { approve: [row?.id as string], deny: [] });
		await expect(setup.setupAndValidate(id, input({ checkCommand: check }))).rejects.toMatchObject({ code: "validation_failed", step: 6, message: expect.stringMatching(/check command failed.*code 2/) });
		writeFileSync(join(dir, "ok.txt"), "1");
		const outcome = await setup.setupAndValidate(id, input({ checkCommand: check }));
		expect(outcome.status === "ready" && outcome.report.validation).toBe(`\`${check}\` passed`);
	});

	it("a denied check command is reported, not run", async () => {
		writeNodeSettings(db, { dependencySetup: "ask" });
		const id = handoff("hnd_checkdeny");
		await setup.setupAndValidate(id, input({ checkCommand: APPEND("check.txt") }));
		const [row] = store.setupRows(id);
		setup.decide(id, { approve: [], deny: [row?.id as string] });
		const outcome = await setup.setupAndValidate(id, input({ checkCommand: APPEND("check.txt") }));
		expect(count("check.txt")).toBe(0);
		expect(outcome.status === "ready" && outcome.report.validation).toMatch(/was not run \(denied on this node\)/);
	});

	it("the phases split step 5 from step 6", async () => {
		writeNodeSettings(db, { dependencySetup: "auto" });
		const id = handoff("hnd_phase");
		const environment = env({ packageManager: install(APPEND("ran.txt")) });
		const deps = await setup.setupAndValidate(id, input({ environment, phase: "setup", requiredFiles: ["nope.txt"] }));
		expect(deps.status === "ready" && deps.report.validation).toBeUndefined();
		expect(count("ran.txt")).toBe(1);
		await expect(setup.setupAndValidate(id, input({ environment, phase: "validate", requiredFiles: ["nope.txt"] }))).rejects.toMatchObject({ code: "validation_failed" });
		expect(count("ran.txt")).toBe(1); // validation never re-installs
		writeFileSync(join(dir, "nope.txt"), "now");
		const done = await setup.setupAndValidate(id, input({ environment, phase: "validate", requiredFiles: ["nope.txt"] }));
		expect(done.status === "ready" && done.report.ran.length).toBe(1);
	});
});
