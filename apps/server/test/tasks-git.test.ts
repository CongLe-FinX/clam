import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { node, openDatabase, projects, workspaces } from "@clam/database";
import { createGitEngine, type GitEngine } from "@clam/git-engine";
import { loadOrCreateIdentity } from "@clam/node-identity";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createEventBus } from "../src/bus.ts";
import type { ServerContext } from "../src/context.ts";
import { GitService } from "../src/services/git-service.ts";
import { ArtifactStore } from "../src/tasks/artifacts.ts";
import { newTaskId, TaskStore, type TaskRow } from "../src/tasks/store.ts";
import { TaskBlockedError, TaskFailedError, TaskGit, type ProjectRef } from "../src/tasks/task-git.ts";

const OLD_ENV = { ...process.env };
let globalConfigDir: string;

beforeAll(() => {
	// Isolate from the developer's git configuration (identity, hooks, credential helpers, signing).
	globalConfigDir = mkdtempSync(path.join(tmpdir(), "clam-gitcfg-"));
	const file = path.join(globalConfigDir, "gitconfig");
	writeFileSync(file, "[init]\n\tdefaultBranch = main\n");
	process.env.GIT_CONFIG_GLOBAL = file;
	process.env.GIT_CONFIG_NOSYSTEM = "1";
});
afterAll(() => {
	process.env = OLD_ENV;
	rmSync(globalConfigDir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function identify(dir: string): void {
	git(dir, "config", "user.name", "Local Dev");
	git(dir, "config", "user.email", "dev@example.com");
}

interface Fixture {
	root: string;
	origin: string;
	work: string;
}

/** A bare "remote" with `main` and `develop` (one commit ahead of main), and the working clone the project points at. */
function makeFixture(): Fixture {
	const root = realpathSync(mkdtempSync(path.join(tmpdir(), "clam-taskgit-")));
	const origin = path.join(root, "origin.git");
	git(root, "init", "--bare", "-b", "main", origin);
	const seed = path.join(root, "seed");
	git(root, "clone", origin, seed);
	identify(seed);
	for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"]) writeFileSync(path.join(seed, name), `${name}\n`);
	git(seed, "add", ".");
	git(seed, "commit", "-m", "seed");
	git(seed, "push", "origin", "main");
	git(seed, "switch", "-c", "develop");
	writeFileSync(path.join(seed, "dev.txt"), "dev\n");
	git(seed, "add", ".");
	git(seed, "commit", "-m", "develop work");
	git(seed, "push", "origin", "develop");
	const work = path.join(root, "work");
	git(root, "clone", origin, work);
	identify(work);
	return { root, origin, work };
}

let fx: Fixture;
let engine: GitEngine;
let dataDir: string;
let runtimeDir: string;
let ctx: ServerContext;
let close: () => void;
let store: TaskStore;
let taskGit: TaskGit;
let project: ProjectRef;
let nodeId: string;

beforeEach(async () => {
	fx = makeFixture();
	dataDir = mkdtempSync(path.join(tmpdir(), "clam-taskgit-data-"));
	runtimeDir = mkdtempSync(path.join(tmpdir(), "clam-run-"));
	engine = await createGitEngine({ runtimeDir });
	const db = openDatabase({ file: path.join(dataDir, "clam.db") });
	const identity = loadOrCreateIdentity({ dataDir });
	nodeId = identity.nodeId;
	db.insert(node).values({ id: nodeId, name: "exec-node", publicKey: identity.publicKey, fingerprint: identity.fingerprint }).run();
	db.insert(workspaces).values({ id: "wsp_1", name: "Main", ownerNodeId: nodeId }).run();
	db.insert(projects).values({ id: "prj_1", workspaceId: "wsp_1", name: "work", path: fx.work }).run();
	// Only the members GitService touches; the rest of the server context is irrelevant to git.
	ctx = {
		db,
		git: engine,
		bus: createEventBus(),
		runtime: { onEvent: () => () => {} },
		github: { listAccounts: () => [] },
		log: { debug() {}, warn() {}, info() {}, error() {} },
	} as unknown as ServerContext;
	ctx.gitService = new GitService(ctx);
	close = () => db.$client.close();
	store = new TaskStore(db, { nodeId });
	taskGit = new TaskGit({ gitService: ctx.gitService, git: engine, artifacts: new ArtifactStore(store, path.join(dataDir, "artifacts")), log: ctx.log, nodeName: () => "Exec Node" });
	project = { id: "prj_1", path: fx.work, repository: { owner: "acme", name: "demo", externalId: null, htmlUrl: "https://github.com/acme/demo", defaultBranch: "main", accountId: null } };
});

afterEach(async () => {
	await ctx.gitService.dispose();
	await engine.dispose();
	close();
	rmSync(fx.root, { recursive: true, force: true });
	rmSync(dataDir, { recursive: true, force: true });
	rmSync(runtimeDir, { recursive: true, force: true });
});

function makeTask(patch: Partial<TaskRow> = {}): TaskRow {
	return store.insert({
		id: newTaskId(),
		direction: "incoming",
		peerId: "node_peer",
		workspaceId: "wsp_1",
		projectId: "prj_1",
		title: "Fix the widget",
		repoUrl: "https://github.com/acme/demo",
		senderNodeId: "node_peer",
		senderNodeName: "Peer",
		executorNodeId: nodeId,
		executorNodeName: "Exec Node",
		executorAgentName: "Coder",
		correlationId: "corr_1",
		...patch,
	});
}

const write = (name: string, content: string) => {
	mkdirSync(path.dirname(path.join(fx.work, name)), { recursive: true });
	writeFileSync(path.join(fx.work, name), content);
};
const originRefs = () => git(fx.origin, "for-each-ref", "--format=%(refname:short) %(objectname)");
const originBranch = (name: string) => git(fx.origin, "rev-parse", `refs/heads/${name}`);

describe("prepare", () => {
	it("creates and checks out the task branch from origin/<default branch>, without an upstream", async () => {
		const task = makeTask();
		const prepared = await taskGit.prepare(task, project);
		expect(prepared).toMatchObject({ baseBranch: "main", baseRef: "origin/main", originalBranch: "main", originalSha: git(fx.work, "rev-parse", "main") });
		expect(prepared.workBranch).toMatch(/^clam\/exec-node\/fix-the-widget-[a-z0-9]{6}$/);
		expect(git(fx.work, "rev-parse", "--abbrev-ref", "HEAD")).toBe(prepared.workBranch);
		expect(git(fx.work, "rev-parse", "HEAD")).toBe(originBranch("main"));
		// A tracking branch would make the later push update `main` on the remote.
		expect(() => git(fx.work, "config", "--get-regexp", `branch\\.${prepared.workBranch}\\.`)).toThrow();
	});

	it("uses the task's explicit branch as base", async () => {
		const task = makeTask({ repoBranch: "develop" });
		const prepared = await taskGit.prepare(task, project);
		expect(prepared.baseRef).toBe("origin/develop");
		expect(git(fx.work, "rev-parse", "HEAD")).toBe(originBranch("develop"));
		expect(existsSync(path.join(fx.work, "dev.txt"))).toBe(true);
	});

	it("falls back to origin/main when the project knows no default branch", async () => {
		const prepared = await taskGit.prepare(makeTask(), { ...project, repository: null });
		expect(prepared.baseBranch).toBe("main");
	});

	it("blocks on tracked changes (staged or not) naming the paths, but untracked files do not block", async () => {
		const task = makeTask();
		write("untracked.txt", "x\n");
		await expect(taskGit.prepare(task, project)).resolves.toBeDefined();
		git(fx.work, "switch", "main");

		write("a.txt", "changed\n");
		write("b.txt", "changed\n");
		git(fx.work, "add", "b.txt");
		const err = await taskGit.prepare(makeTask(), project).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(TaskBlockedError);
		expect((err as Error).message).toContain("a.txt");
		expect((err as Error).message).toContain("b.txt");
		expect(git(fx.work, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
	});

	it("blocks while a merge is in progress", async () => {
		git(fx.work, "switch", "-c", "side");
		write("a.txt", "side\n");
		git(fx.work, "commit", "-am", "side");
		git(fx.work, "switch", "main");
		write("a.txt", "main\n");
		git(fx.work, "commit", "-am", "main");
		expect(() => git(fx.work, "merge", "side")).toThrow();
		await expect(taskGit.prepare(makeTask(), project)).rejects.toBeInstanceOf(TaskBlockedError);
	});

	it("blocks when the directory is not a git repository", async () => {
		const plain = path.join(fx.root, "plain");
		mkdirSync(plain);
		ctx.db.insert(projects).values({ id: "prj_plain", workspaceId: "wsp_1", name: "plain", path: plain }).run();
		await expect(taskGit.prepare(makeTask(), { id: "prj_plain", path: plain, repository: null })).rejects.toBeInstanceOf(TaskBlockedError);
	});

	it("fails when the base branch is missing on origin", async () => {
		const err = await taskGit.prepare(makeTask({ repoBranch: "nope" }), project).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(TaskFailedError);
		expect((err as Error).message).toBe("base branch nope not found on origin");
	});

	it("is idempotent: when already on the task branch it returns the stored preparation and changes nothing", async () => {
		const task = makeTask();
		const first = await taskGit.prepare(task, project);
		const updated = store.patchExecState(task.id, { prepared: first });
		write("a.txt", "agent work in progress\n");
		const second = await taskGit.prepare(updated, project);
		expect(second).toEqual(first);
		expect(readFileSync(path.join(fx.work, "a.txt"), "utf8")).toBe("agent work in progress\n");

		// Without stored state the original branch cannot be known.
		const bare = await taskGit.prepare(task, project);
		expect(bare).toMatchObject({ workBranch: first.workBranch, baseRef: "origin/main" });
	});

	it("checks out an existing local task branch instead of failing on creation", async () => {
		const task = makeTask();
		const first = await taskGit.prepare(task, project);
		git(fx.work, "switch", "main");
		const again = await taskGit.prepare(task, project);
		expect(again.workBranch).toBe(first.workBranch);
		expect(git(fx.work, "rev-parse", "--abbrev-ref", "HEAD")).toBe(first.workBranch);
	});
});

describe("deliver", () => {
	it("commits modified, new, deleted, renamed and untracked files, pushes only the task branch, and restores the original branch", async () => {
		const task = makeTask();
		const prepared = await taskGit.prepare(task, project);
		const mainBefore = originBranch("main");
		write("a.txt", "modified\n");
		write("new.txt", "new\n");
		write("nested/deep/untracked.txt", "u\n");
		unlinkSync(path.join(fx.work, "b.txt"));
		git(fx.work, "mv", "c.txt", "c-renamed.txt");

		const result = await taskGit.deliver(task, project, prepared, { sessionId: null });
		expect(result).toMatchObject({ branch: prepared.workBranch, pushed: true, changed: true, artifacts: [] });
		expect(result.compareUrl).toBe(`https://github.com/acme/demo/compare/main...${prepared.workBranch.split("/").map(encodeURIComponent).join("/")}`);

		expect(originBranch("main")).toBe(mainBefore);
		expect(originBranch(prepared.workBranch)).toBe(result.commit);
		expect(git(fx.origin, "show", "--stat", "--format=%an|%s", prepared.workBranch)).toContain("Fix the widget");
		const files = git(fx.origin, "ls-tree", "-r", "--name-only", prepared.workBranch).split("\n");
		expect(files).toEqual(expect.arrayContaining(["a.txt", "new.txt", "nested/deep/untracked.txt", "c-renamed.txt", "d.txt"]));
		expect(files).not.toContain("b.txt");
		expect(files).not.toContain("c.txt");
		const message = git(fx.origin, "log", "-1", "--format=%B", prepared.workBranch);
		expect(message).toContain(`Task: ${task.id}`);
		expect(message).toContain("Agent: Coder@Exec Node");
		expect(git(fx.origin, "log", "--format=%s", "main..".concat(prepared.workBranch))).toBe("Fix the widget");

		expect(git(fx.work, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
		expect(originRefs()).toContain(`${prepared.workBranch} ${result.commit}`);
	});

	it("returns an unchanged result when the agent changed nothing", async () => {
		const task = makeTask();
		const prepared = await taskGit.prepare(task, project);
		const result = await taskGit.deliver(task, project, prepared, { sessionId: null });
		expect(result).toEqual({ branch: null, commit: null, pushed: false, compareUrl: null, artifacts: [], changed: false, note: "The agent made no changes." });
		expect(git(fx.work, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
		expect(originRefs()).not.toContain("clam/");
	});

	it("pushes commits the agent made itself even when the tree is clean", async () => {
		const task = makeTask();
		const prepared = await taskGit.prepare(task, project);
		write("own.txt", "own\n");
		git(fx.work, "add", "own.txt");
		git(fx.work, "commit", "-m", "agent commit");
		const result = await taskGit.deliver(task, project, prepared, { sessionId: null });
		expect(result).toMatchObject({ pushed: true, changed: false, branch: prepared.workBranch });
		expect(originBranch(prepared.workBranch)).toBe(result.commit);
	});

	it("attaches a patch artifact and keeps the branch when the push is refused", async () => {
		const task = makeTask();
		const prepared = await taskGit.prepare(task, project);
		const hook = path.join(fx.origin, "hooks", "pre-receive");
		writeFileSync(hook, "#!/bin/sh\necho 'protected by test' >&2\nexit 1\n");
		chmodSync(hook, 0o755);
		write("a.txt", "patched\n");

		const result = await taskGit.deliver(task, project, prepared, { sessionId: null });
		expect(result).toMatchObject({ pushed: false, branch: prepared.workBranch, compareUrl: null, changed: true });
		expect(result.commit).toBe(git(fx.work, "rev-parse", prepared.workBranch));
		expect(result.note).toContain("protected by test");
		expect(originRefs()).not.toContain(prepared.workBranch);
		expect(result.artifacts).toHaveLength(1);
		const [artifact] = result.artifacts;
		expect(artifact?.name).toBe("fix-the-widget.patch");
		const row = store.artifacts(task.id)[0];
		expect(row?.sha256).toBe(artifact?.sha256);
		const stored = readFileSync(path.join(dataDir, "artifacts", row?.storagePath ?? ""), "utf8");
		expect(stored).toContain("Subject: [PATCH] Fix the widget");
		expect(stored).toContain("+patched");
		expect(git(fx.work, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
	});

	it("never pushes onto the base branch when the task branch tracks it", async () => {
		const task = makeTask();
		const prepared = await taskGit.prepare(task, project);
		git(fx.work, "branch", "--set-upstream-to=origin/main");
		const mainBefore = originBranch("main");
		write("a.txt", "dangerous\n");
		const err = await taskGit.deliver(task, project, prepared, { sessionId: null }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(TaskFailedError);
		expect(originBranch("main")).toBe(mainBefore);
		expect(readFileSync(path.join(fx.work, "a.txt"), "utf8")).toBe("dangerous\n");
	});

	it("fails with a clear error when no commit identity is available, leaving the changes in the tree", async () => {
		const task = makeTask();
		const prepared = await taskGit.prepare(task, project);
		git(fx.work, "config", "--unset", "user.name");
		git(fx.work, "config", "--unset", "user.email");
		write("a.txt", "work\n");
		const err = await taskGit.deliver(task, project, prepared, { sessionId: null }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(TaskFailedError);
		expect((err as Error).message).toMatch(/^cannot commit the agent's changes: /);
		expect(readFileSync(path.join(fx.work, "a.txt"), "utf8")).toBe("work\n");
	});
});

describe("describeLeftovers", () => {
	it("reports the branch and uncommitted files without touching anything", async () => {
		const task = makeTask();
		const prepared = await taskGit.prepare(task, project);
		expect(await taskGit.describeLeftovers(task, project, prepared)).toMatchObject({ branch: prepared.workBranch, dirty: false });
		write("a.txt", "x\n");
		write("n.txt", "y\n");
		const leftovers = await taskGit.describeLeftovers(task, project, prepared);
		expect(leftovers).toEqual({
			branch: prepared.workBranch,
			dirty: true,
			note: `Work left on branch ${prepared.workBranch} with 2 uncommitted file(s); nothing was committed or pushed.`,
		});
		expect(git(fx.work, "status", "--porcelain").split("\n")).toHaveLength(2);
		expect(await taskGit.describeLeftovers(task, project, null)).toMatchObject({ dirty: true });
	});
});
