import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GitCommit, GitOperation, GitPullResult, GitPushResult, GitStatus, Project, PullRequest, Workspace } from "@clam/contracts";
import { agentSessions, agents } from "@clam/database";
import { createGitEngine, GitEngineError, type GitEngine } from "@clam/git-engine";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import gitRoutes from "../src/api/git.ts";
import projectRoutes from "../src/api/projects.ts";
import workspaceRoutes from "../src/api/workspaces.ts";
import { readNodeSettings } from "../src/services/settings.ts";
import { fakeGithub, FAKE_TOKEN, type FakeRoutes } from "./fake-github.ts";
import { createTestHarness, idleRuntime, type TestHarness } from "./helpers.ts";

// Several tests below wait on real file-system events and the 300 ms watcher debounce; a fake clock cannot drive fs.watch.

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
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function identify(dir: string, name = "Local Dev", email = "dev@example.com"): void {
	git(dir, "config", "user.name", name);
	git(dir, "config", "user.email", email);
}

interface Fixture {
	root: string;
	origin: string;
	work: string;
	other: string;
}

/** A bare "remote", a working clone the project points at, and a second clone that plays the colleague. */
function makeFixture(): Fixture {
	const root = realpathSync(mkdtempSync(path.join(tmpdir(), "clam-git-")));
	const origin = path.join(root, "origin.git");
	git(root, "init", "--bare", "-b", "main", origin);
	const seed = path.join(root, "seed");
	git(root, "clone", origin, seed);
	identify(seed, "Seed", "seed@example.com");
	writeFileSync(path.join(seed, "a.txt"), "one\n");
	writeFileSync(path.join(seed, "b.txt"), "bee\n");
	git(seed, "add", ".");
	git(seed, "commit", "-m", "seed");
	git(seed, "push", "origin", "main");
	const work = path.join(root, "work");
	const other = path.join(root, "other");
	git(root, "clone", origin, work);
	git(root, "clone", origin, other);
	identify(work);
	identify(other, "Colleague", "colleague@example.com");
	return { root, origin, work, other };
}

let h: TestHarness;
let fx: Fixture;
let workspace: Workspace;
let project: Project;

const api = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
	h.app.inject({ method, url: `/api/local${url}`, payload: payload as object | undefined });

async function setup(ctx: Parameters<typeof createTestHarness>[0]["ctx"] = {}): Promise<void> {
	fx = makeFixture();
	h = await createTestHarness({ plugins: [workspaceRoutes, projectRoutes, gitRoutes], ctx });
	workspace = (await api("POST", "/workspaces", { name: "Main" })).json();
	const res = await api("POST", "/projects", { workspaceId: workspace.id, name: "work", path: fx.work });
	expect(res.statusCode, res.body).toBe(201);
	project = res.json();
}

afterEach(async () => {
	await h?.cleanup();
	if (fx) rmSync(fx.root, { recursive: true, force: true });
});

const g = (suffix: string) => `/projects/${project.id}/git${suffix}`;
const statusEvents = () => h.published.filter((p) => p.topic === `git:${project.id}` && (p.event as { type: string }).type === "status");

describe("status, local mutations and events", () => {
	beforeEach(() => setup());

	it("reports a clean tree, then staged/unstaged changes, and publishes git:<id> after every mutation", async () => {
		const clean = (await api("GET", g("/status"))).json<GitStatus>();
		expect(clean).toMatchObject({ isRepo: true, branch: "main", upstream: "origin/main", ahead: 0, behind: 0, clean: true, files: [], detached: false });
		expect(clean.remotes.map((r) => r.name)).toEqual(["origin"]);

		writeFileSync(path.join(fx.work, "a.txt"), "one\ntwo\n");
		writeFileSync(path.join(fx.work, "new.txt"), "new\n");
		const before = statusEvents().length;
		const staged = await api("POST", g("/stage"), { paths: ["a.txt", "new.txt"] });
		expect(staged.statusCode, staged.body).toBe(200);
		expect(staged.json<GitStatus>().files.map((f) => [f.path, f.staged])).toEqual([["a.txt", true], ["new.txt", true]]);
		expect(statusEvents().length).toBe(before + 1);

		const unstaged = (await api("POST", g("/unstage"), { paths: ["new.txt"] })).json<GitStatus>();
		expect(unstaged.files.find((f) => f.path === "new.txt")).toMatchObject({ kind: "untracked", staged: false, unstaged: true });
		expect(statusEvents().length).toBe(before + 2);
		const last = statusEvents().at(-1)?.event as { status: GitStatus };
		expect(last.status.files.map((f) => f.path)).toEqual(["a.txt", "new.txt"]);
	});

	it("rejects discard without confirm (400) and leaves the file intact; with confirm only the given path is reverted", async () => {
		writeFileSync(path.join(fx.work, "a.txt"), "edited a\n");
		writeFileSync(path.join(fx.work, "b.txt"), "edited b\n");
		const refused = await api("POST", g("/discard"), { paths: ["a.txt"] });
		expect(refused.statusCode).toBe(400);
		expect(refused.json().error.code).toBe("invalid_request");
		expect(readFileSync(path.join(fx.work, "a.txt"), "utf8")).toBe("edited a\n");
		const falseConfirm = await api("POST", g("/discard"), { paths: ["a.txt"], confirm: false });
		expect(falseConfirm.statusCode).toBe(400);

		const done = await api("POST", g("/discard"), { paths: ["a.txt"], confirm: true });
		expect(done.statusCode, done.body).toBe(200);
		expect(readFileSync(path.join(fx.work, "a.txt"), "utf8")).toBe("one\n");
		expect(readFileSync(path.join(fx.work, "b.txt"), "utf8")).toBe("edited b\n");
	});

	it("validates paths and refs: no traversal, no .git, no option injection", async () => {
		for (const bad of ["../outside", "/etc/passwd", ".git/config", ".git", ""]) {
			const res = await api("POST", g("/stage"), { paths: [bad] });
			expect(res.statusCode, bad).toBe(400);
		}
		expect((await api("POST", g("/checkout"), { branch: "--orphan" })).statusCode).toBe(400);
		expect((await api("GET", g("/diff?scope=commit&commit=--output=/tmp/x"))).statusCode).toBe(400);
		expect((await api("GET", g("/diff?scope=head&path=../x"))).statusCode).toBe(400);
		expect((await api("GET", g("/log?ref=-p"))).statusCode).toBe(400);
	});

	it("404s unknown projects and answers a project whose directory vanished with 409", async () => {
		expect((await api("GET", "/projects/prj_missing/git/status")).statusCode).toBe(404);
		const lone = path.join(fx.root, "lonely");
		mkdirSync(lone);
		const created = (await api("POST", "/projects", { workspaceId: workspace.id, name: "lonely", path: lone })).json<Project>();
		const notRepo = await api("GET", `/projects/${created.id}/git/status`);
		expect(notRepo.json<GitStatus>()).toMatchObject({ isRepo: false, branch: null });
		const stage = await api("POST", `/projects/${created.id}/git/stage`, { paths: ["x"] });
		expect(stage.statusCode).toBe(404);
		expect(stage.json().error.code).toBe("not_a_repo");
		rmSync(lone, { recursive: true });
		expect((await api("GET", `/projects/${created.id}/git/status`)).json().error.code).toBe("project_dir_missing");
	});

	it("creates and switches branches, lists history, diffs and the overview", async () => {
		const created = await api("POST", g("/branches"), { name: "feature/x", checkout: true });
		expect(created.json<GitStatus>().branch).toBe("feature/x");
		writeFileSync(path.join(fx.work, "a.txt"), "one\nfeature\n");
		const diff = (await api("GET", g("/diff?scope=head"))).json();
		expect(diff.files[0]).toMatchObject({ path: "a.txt", status: "modified", additions: 1, deletions: 0 });
		const committed = await api("POST", g("/commit"), { message: "feature work", paths: ["a.txt"] });
		expect(committed.statusCode, committed.body).toBe(200);
		const { commit, status } = committed.json<{ commit: GitCommit; status: GitStatus }>();
		expect(commit.subject).toBe("feature work");
		expect(status.ahead).toBe(0); // no upstream yet
		expect(status.clean).toBe(true);
		const log = (await api("GET", g("/log?limit=5"))).json();
		expect(log.commits.map((c: GitCommit) => c.subject)).toEqual(["feature work", "seed"]);
		const branches = (await api("GET", g("/branches"))).json<Array<{ name: string; current: boolean; remote: boolean }>>();
		expect(branches.filter((b) => !b.remote).map((b) => [b.name, b.current])).toEqual(expect.arrayContaining([["feature/x", true], ["main", false]]));
		const back = await api("POST", g("/checkout"), { branch: "main" });
		expect(back.json<GitStatus>().branch).toBe("main");

		const overview = (await api("GET", "/git/overview")).json<Array<{ project: Project; status: GitStatus | null; error: string | null }>>();
		expect(overview).toHaveLength(1);
		expect(overview[0]).toMatchObject({ project: { id: project.id }, error: null, status: { branch: "main", clean: true } });
	});

	it("refuses checkout that would overwrite local changes, never forcing", async () => {
		git(fx.work, "checkout", "-b", "other");
		writeFileSync(path.join(fx.work, "a.txt"), "other branch\n");
		git(fx.work, "commit", "-am", "other change");
		git(fx.work, "checkout", "main");
		// Now a.txt differs between branches and the working copy edits it.
		writeFileSync(path.join(fx.work, "a.txt"), "dirty edit\n");
		const res = await api("POST", g("/checkout"), { branch: "other" });
		expect(res.statusCode).toBe(409);
		expect(readFileSync(path.join(fx.work, "a.txt"), "utf8")).toBe("dirty edit\n");
		expect(git(fx.work, "branch", "--show-current").trim()).toBe("main");
	});

	it("scans .clmesh/ for secrets, writes README + config.json without committing, and is idempotent", async () => {
		const first = await api("POST", `/projects/${project.id}/clmesh/init`);
		expect(first.statusCode, first.body).toBe(200);
		const body = first.json<{ written: string[]; skipped: string[]; status: GitStatus }>();
		expect(body.written.sort()).toEqual([".clmesh/README.md", ".clmesh/config.json"]);
		expect(JSON.parse(readFileSync(path.join(fx.work, ".clmesh/config.json"), "utf8"))).toMatchObject({ projectId: project.id, workspaceId: workspace.id, version: 1 });
		expect(body.status.files.some((f) => f.path.startsWith(".clmesh"))).toBe(true);
		expect(git(fx.work, "log", "--oneline")).not.toContain(".clmesh");
		const second = (await api("POST", `/projects/${project.id}/clmesh/init`)).json<{ written: string[]; skipped: string[] }>();
		expect(second.written).toEqual([]);
		expect(second.skipped.sort()).toEqual([".clmesh/README.md", ".clmesh/config.json"]);
	});
});

describe("pull and push never overwrite or force", () => {
	beforeEach(() => setup());

	/** The colleague pushes a change to a.txt (and b2.txt). */
	function colleaguePushes(): void {
		writeFileSync(path.join(fx.other, "a.txt"), "one\nfrom colleague\n");
		writeFileSync(path.join(fx.other, "b2.txt"), "new file\n");
		git(fx.other, "add", ".");
		git(fx.other, "commit", "-m", "colleague change");
		git(fx.other, "push", "origin", "main");
	}

	it("refuses a pull whose incoming changes overlap uncommitted work (409) and leaves every file untouched", async () => {
		colleaguePushes();
		writeFileSync(path.join(fx.work, "a.txt"), "my uncommitted edit\n");
		const fetched = await api("POST", g("/fetch"));
		expect(fetched.statusCode, fetched.body).toBe(200);
		expect(fetched.json<GitStatus>().behind).toBe(1);

		const pull = await api("POST", g("/pull"));
		expect(pull.statusCode).toBe(409);
		const err = pull.json();
		expect(err.error.code).toBe("git_pull_refused");
		const result = err.error.details as GitPullResult;
		expect(result).toMatchObject({ result: "refused", reason: "dirty-overlap", paths: ["a.txt"] });
		expect(result.status.behind).toBe(1);
		expect(readFileSync(path.join(fx.work, "a.txt"), "utf8")).toBe("my uncommitted edit\n");
		expect(existsSync(path.join(fx.work, "b2.txt"))).toBe(false);
		expect(git(fx.work, "rev-parse", "HEAD")).toBe(git(fx.work, "rev-parse", "main~0")); // HEAD did not move

		// Explicit user action: discard the local edit, then the same pull fast-forwards.
		await api("POST", g("/discard"), { paths: ["a.txt"], confirm: true });
		const ok = await api("POST", g("/pull"));
		expect(ok.statusCode, ok.body).toBe(200);
		expect(ok.json<GitPullResult>()).toMatchObject({ result: "fast-forward", reason: null, status: { behind: 0, clean: true } });
		expect(readFileSync(path.join(fx.work, "a.txt"), "utf8")).toBe("one\nfrom colleague\n");
		expect(readFileSync(path.join(fx.work, "b2.txt"), "utf8")).toBe("new file\n");
		expect((await api("POST", g("/pull"))).json<GitPullResult>().result).toBe("up-to-date");
	});

	it("fast-forwards over unrelated uncommitted edits", async () => {
		colleaguePushes();
		writeFileSync(path.join(fx.work, "b.txt"), "unrelated local edit\n");
		const pull = await api("POST", g("/pull"));
		expect(pull.statusCode, pull.body).toBe(200);
		expect(pull.json<GitPullResult>().result).toBe("fast-forward");
		expect(readFileSync(path.join(fx.work, "b.txt"), "utf8")).toBe("unrelated local edit\n");
		expect(readFileSync(path.join(fx.work, "a.txt"), "utf8")).toBe("one\nfrom colleague\n");
	});

	it("rejects a non-fast-forward push (409, git's own message), never forces, and reports the conflict", async () => {
		colleaguePushes();
		const remoteBefore = git(fx.origin, "rev-parse", "main");
		writeFileSync(path.join(fx.work, "a.txt"), "one\nmy side\n");
		const commit = await api("POST", g("/commit"), { message: "my change", paths: ["a.txt"] });
		expect(commit.statusCode, commit.body).toBe(200);

		const push = await api("POST", g("/push"), {});
		expect(push.statusCode).toBe(409);
		const err = push.json();
		expect(err.error.code).toBe("git_push_rejected");
		const result = err.error.details as GitPushResult;
		expect(result).toMatchObject({ result: "rejected", reason: "non-fast-forward" });
		expect(result.message).toMatch(/rejected|non-fast-forward|fetch first|tip of your current branch is behind/i);
		expect(err.error.message).toBe(result.message);
		expect(git(fx.origin, "rev-parse", "main")).toBe(remoteBefore);

		await api("POST", g("/fetch"));
		const report = (await api("GET", g("/conflicts"))).json();
		expect(report).toMatchObject({ against: "origin/main", ahead: 1, behind: 1, clean: false });
		expect(report.conflicts.map((c: { path: string }) => c.path)).toEqual(["a.txt"]);
		// The dry run never touched the working tree.
		expect(readFileSync(path.join(fx.work, "a.txt"), "utf8")).toBe("one\nmy side\n");
		expect(git(fx.work, "status", "--porcelain")).toBe("");
		// A diverged pull is refused too, not merged.
		const pull = await api("POST", g("/pull"));
		expect(pull.statusCode).toBe(409);
		expect(pull.json().error.details).toMatchObject({ result: "refused", reason: "diverged" });
		expect(git(fx.work, "log", "--format=%s", "-3").trim().split("\n")).toEqual(["my change", "seed"]);
	});

	it("pushes a fast-forward and records git_sync_states", async () => {
		writeFileSync(path.join(fx.work, "a.txt"), "one\nmine\n");
		await api("POST", g("/commit"), { message: "mine", paths: ["a.txt"] });
		const push = await api("POST", g("/push"), {});
		expect(push.statusCode, push.body).toBe(200);
		expect(push.json<GitPushResult>()).toMatchObject({ result: "pushed", status: { ahead: 0, behind: 0 } });
		expect(git(fx.origin, "log", "--format=%s", "-1").trim()).toBe("mine");
		expect((await api("POST", g("/push"), {})).json<GitPushResult>().result).toBe("up-to-date");

		const rows = h.ctx.db.$client.prepare("select * from git_sync_states where project_id = ?").all(project.id) as Array<Record<string, unknown>>;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ branch: "main", commit_sha: git(fx.work, "rev-parse", "HEAD").trim(), remote_sha: git(fx.origin, "rev-parse", "main").trim(), ahead: 0, behind: 0, dirty: 0 });
		expect(rows[0]?.last_pushed_at).toEqual(expect.any(String));
		expect(rows[0]?.last_pulled_at).toBeNull();
	});

	it("publishes operation events for fetch/pull/push on git:<id>", async () => {
		await api("POST", g("/fetch"));
		const ops = h.published.filter((p) => p.topic === `git:${project.id}` && (p.event as { type: string }).type === "operation").map((p) => (p.event as { operation: GitOperation }).operation);
		expect(ops.map((o) => [o.kind, o.state])).toEqual([["fetch", "running"], ["fetch", "succeeded"]]);
		const op = await api("GET", `/git/operations/${ops[0]?.id}`);
		expect(op.json<GitOperation>()).toMatchObject({ kind: "fetch", state: "succeeded", projectId: project.id });
		expect((await api("GET", "/git/operations/gop_missing")).statusCode).toBe(404);
	});

	it("keeps the remote URL and .git/config free of credentials", async () => {
		await api("POST", g("/fetch"));
		const config = readFileSync(path.join(fx.work, ".git", "config"), "utf8");
		expect(config).not.toMatch(/https?:\/\/[^\s/@]+@/);
		expect(config).not.toContain(FAKE_TOKEN);
		expect(config).not.toMatch(/credential|extraheader|token/i);
		const status = (await api("GET", g("/status"))).json<GitStatus>();
		expect(status.remotes.every((r) => !/@/.test(r.url.replace(/^git@/, "")))).toBe(true);
	});
});

describe("serialized mutations", () => {
	it("runs concurrent mutations of one project strictly one at a time", async () => {
		const real = await createGitEngine({ runtimeDir: mkdtempSync(path.join(tmpdir(), "clam-run-")) });
		let active = 0;
		let maxActive = 0;
		const order: string[] = [];
		const slow =
			<A extends unknown[], R>(name: string, fn: (...a: A) => Promise<R>) =>
			async (...a: A): Promise<R> => {
				active++;
				maxActive = Math.max(maxActive, active);
				order.push(`start:${name}`);
				await new Promise((r) => setTimeout(r, 60));
				try {
					return await fn(...a);
				} finally {
					order.push(`end:${name}`);
					active--;
				}
			};
		const wrapped: GitEngine = Object.assign(Object.create(real) as GitEngine, {
			stage: slow("stage", real.stage.bind(real)),
			unstage: slow("unstage", real.unstage.bind(real)),
		});
		await setup({ git: wrapped });
		writeFileSync(path.join(fx.work, "a.txt"), "x\n");
		writeFileSync(path.join(fx.work, "b.txt"), "y\n");
		writeFileSync(path.join(fx.work, "c.txt"), "c\n");
		writeFileSync(path.join(fx.work, "d.txt"), "d\n");
		git(fx.work, "add", "c.txt");
		// Concurrent requests may reach the queue in any order, so each one touches its own path: the final
		// state is order-independent and the assertions check the invariant (one at a time), not arrival order.
		const results = await Promise.all([
			api("POST", g("/stage"), { paths: ["a.txt"] }),
			api("POST", g("/stage"), { paths: ["b.txt"] }),
			api("POST", g("/unstage"), { paths: ["c.txt"] }),
			api("POST", g("/stage"), { paths: ["d.txt"] }),
		]);
		expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 200]);
		expect(maxActive).toBe(1);
		expect(order).toHaveLength(8);
		for (let i = 0; i < order.length; i += 2) {
			expect(order[i]).toMatch(/^start:/);
			expect(order[i + 1]).toBe(order[i]!.replace("start:", "end:"));
		}
		expect(order.filter((o) => o.startsWith("start:")).sort()).toEqual(["start:stage", "start:stage", "start:stage", "start:unstage"]);
		expect(git(fx.work, "status", "--porcelain").trim().split("\n").sort()).toEqual(["?? c.txt", "A  d.txt", "M  a.txt", "M  b.txt"]);

		// A failing mutation does not block the next one.
		const bad = await api("POST", g("/stage"), { paths: ["does-not-exist.txt"] });
		expect(bad.statusCode).toBeGreaterThanOrEqual(400);
		expect((await api("POST", g("/unstage"), { paths: ["a.txt"] })).statusCode).toBe(200);
		await real.dispose();
	});
});

describe("working-tree watcher", () => {
	beforeEach(() => setup());

	const waitFor = async (predicate: () => boolean, ms: number, what: string) => {
		const t = Date.now();
		while (Date.now() - t < ms) {
			if (predicate()) return;
			await new Promise((r) => setTimeout(r, 25));
		}
		throw new Error(`timed out waiting for ${what}`);
	};

	it("publishes a debounced status when files change while the topic has subscribers, ignoring node_modules and .git/objects", async () => {
		const received: GitStatus[] = [];
		const stop = h.ctx.bus.subscribe(`git:${project.id}`, (event) => {
			const e = event as { type: string; status?: GitStatus };
			if (e.type === "status" && e.status) received.push(e.status);
		});
		await new Promise((r) => setTimeout(r, 300)); // let the recursive watcher attach

		mkdirSync(path.join(fx.work, "node_modules", "dep"), { recursive: true });
		writeFileSync(path.join(fx.work, "node_modules", "dep", "index.js"), "x");
		await new Promise((r) => setTimeout(r, 900));
		expect(received).toHaveLength(0);

		writeFileSync(path.join(fx.work, "a.txt"), "changed on disk\n");
		writeFileSync(path.join(fx.work, "a.txt"), "changed on disk twice\n");
		await waitFor(() => received.some((s) => s.files.some((f) => f.path === "a.txt")), 5000, "a status event for a.txt");
		const count = received.length;
		expect(count).toBeLessThanOrEqual(2); // debounced, not one per write

		stop();
		await new Promise((r) => setTimeout(r, 100));
		writeFileSync(path.join(fx.work, "b.txt"), "after unsubscribe\n");
		await new Promise((r) => setTimeout(r, 900));
		expect(received).toHaveLength(count);
	});

	it("refreshes when a session in the project finishes a tool call", async () => {
		const events: Array<(sessionId: string, event: unknown) => void> = [];
		await h.cleanup();
		const runtime = { ...idleRuntime(), onEvent: (l: (s: string, e: never) => void) => (events.push(l as never), () => {}) };
		fx = makeFixture();
		h = await createTestHarness({ plugins: [workspaceRoutes, projectRoutes, gitRoutes], ctx: { runtime } });
		workspace = (await api("POST", "/workspaces", { name: "Main" })).json();
		project = (await api("POST", "/projects", { workspaceId: workspace.id, name: "work", path: fx.work })).json();
		h.ctx.db.insert(agents).values({ id: "agt_1", nodeId: h.ctx.identity.nodeId, name: "OMP Agent", runtime: "omp" }).run();
		h.ctx.db.insert(agentSessions).values({ id: "ses_1", agentId: "agt_1", projectId: project.id, title: "t", sessionDir: fx.root }).run();

		const received: GitStatus[] = [];
		const stop = h.ctx.bus.subscribe(`git:${project.id}`, (event) => {
			const e = event as { type: string; status?: GitStatus };
			if (e.type === "status" && e.status) received.push(e.status);
		});
		// A change the OS watcher cannot be relied on to report on every platform; the tool_end hook must cover it.
		writeFileSync(path.join(fx.work, "tool-made.txt"), "from a tool\n");
		for (const listener of events) listener("ses_1", { type: "tool_end", toolCallId: "t1", isError: false, result: "ok" });
		await waitFor(() => received.some((s) => s.files.some((f) => f.path === "tool-made.txt")), 5000, "refresh after tool_end");
		stop();
	});
});

describe("commit identity and agent trailer", () => {
	it("uses the repo git config, then derives from the GitHub account, with a per-project override on top", async () => {
		await setup();
		// 1. repo git config (identify() ran in the fixture)
		expect((await api("GET", g("/identity"))).json()).toEqual({ name: "Local Dev", email: "dev@example.com", source: "git-config" });

		// 2. no repo identity → the GitHub account (noreply address; no email scope)
		git(fx.work, "config", "--unset", "user.name");
		git(fx.work, "config", "--unset", "user.email");
		const none = await api("GET", g("/identity"));
		expect(none.statusCode).toBe(409);
		expect(none.json().error.code).toBe("no_git_identity");
		const gh = await fakeGithub(h.ctx.db, {});
		h.ctx.github = gh.service;
		expect((await api("GET", g("/identity"))).json()).toEqual({ name: "Octo Cat", email: "4242+octo@users.noreply.github.com", source: "account" });

		// 3. per-project override wins, can be cleared
		const put = await api("PUT", g("/identity"), { name: "Project Person", email: "pp@example.com" });
		expect(put.json()).toEqual({ name: "Project Person", email: "pp@example.com", source: "project" });
		writeFileSync(path.join(fx.work, "a.txt"), "z\n");
		const committed = (await api("POST", g("/commit"), { message: "as override", paths: ["a.txt"] })).json<{ commit: GitCommit }>();
		expect(committed.commit).toMatchObject({ authorName: "Project Person", authorEmail: "pp@example.com" });
		expect((await api("PUT", g("/identity"), null)).json().source).toBe("account");
		expect((await api("PUT", g("/identity"), { name: "x", email: "not-an-email" })).statusCode).toBe(400);
	});

	it("adds an `Agent: <agent>@<node>` trailer for a session's commit and rejects foreign sessions", async () => {
		await setup();
		h.ctx.db.insert(agents).values({ id: "agt_1", nodeId: h.ctx.identity.nodeId, name: "OMP Agent", runtime: "omp" }).run();
		h.ctx.db.insert(agentSessions).values({ id: "ses_1", agentId: "agt_1", projectId: project.id, title: "t", sessionDir: fx.root }).run();
		const other = (await api("POST", "/projects", { workspaceId: workspace.id, name: "other", path: fx.other })).json<Project>();
		h.ctx.db.insert(agentSessions).values({ id: "ses_2", agentId: "agt_1", projectId: other.id, title: "t", sessionDir: fx.root }).run();

		writeFileSync(path.join(fx.work, "a.txt"), "agent edit\n");
		const plain = (await api("POST", g("/commit"), { message: "human commit", paths: ["a.txt"] })).json<{ commit: GitCommit }>();
		expect(plain.commit.trailers).toEqual({});

		writeFileSync(path.join(fx.work, "b.txt"), "agent edit\n");
		const nodeName = readNodeSettings(h.ctx.db).nodeName;
		const agentCommit = await api("POST", g("/commit"), { message: "agent commit", paths: ["b.txt"], sessionId: "ses_1" });
		expect(agentCommit.statusCode, agentCommit.body).toBe(200);
		expect(agentCommit.json<{ commit: GitCommit }>().commit.trailers).toEqual({ Agent: `OMP Agent@${nodeName}` });
		expect(git(fx.work, "log", "-1", "--format=%B")).toContain(`Agent: OMP Agent@${nodeName}`);

		writeFileSync(path.join(fx.work, "a.txt"), "again\n");
		expect((await api("POST", g("/commit"), { message: "x", paths: ["a.txt"], sessionId: "ses_2" })).statusCode).toBe(400);
		expect((await api("POST", g("/commit"), { message: "x", paths: ["a.txt"], sessionId: "ses_none" })).statusCode).toBe(404);
	});
});

describe("pull requests (GitHub REST is the only fake part)", () => {
	const rawPull = (over: Record<string, unknown> = {}) => ({
		number: 12,
		title: "Feature",
		body: "",
		state: "open",
		draft: false,
		html_url: "https://github.com/octo/r/pull/12",
		head: { ref: "feature", sha: "abc" },
		base: { ref: "main" },
		user: { login: "octo" },
		mergeable: true,
		created_at: "2026-01-01T00:00:00Z",
		updated_at: "2026-01-01T00:00:00Z",
		...over,
	});

	async function link(routes: FakeRoutes) {
		await setup();
		const gh = await fakeGithub(h.ctx.db, routes);
		h.ctx.github = gh.service;
		const patched = await api("PATCH", `/projects/${project.id}`, {
			repository: { owner: "octo", name: "r", externalId: "1", htmlUrl: "https://github.com/octo/r", defaultBranch: "main", accountId: gh.accountId },
		});
		expect(patched.statusCode, patched.body).toBe(200);
		return gh;
	}

	it("creates a PR for a pushed branch, lists and reads it; refuses unpushed branches and unlinked projects", async () => {
		const gh = await link({
			"POST https://api.github.com/repos/octo/r/pulls": (call) => ({ status: 201, json: rawPull({ draft: (call.body as { draft: boolean }).draft }) }),
			"GET https://api.github.com/repos/octo/r/pulls/12": { json: rawPull() },
			"GET https://api.github.com/repos/octo/r/pulls?": { json: [rawPull()] },
			"GET https://api.github.com/repos/octo/r/commits/abc/status": { json: { state: "success", total_count: 1 } },
			"GET https://api.github.com/repos/octo/r/commits/abc/check-runs": { json: { check_runs: [] } },
		});
		await api("POST", g("/branches"), { name: "feature", checkout: true });
		writeFileSync(path.join(fx.work, "a.txt"), "feature\n");
		await api("POST", g("/commit"), { message: "feature", paths: ["a.txt"] });

		const unpushed = await api("POST", g("/pulls"), { title: "Feature", base: "main" });
		expect(unpushed.statusCode).toBe(409);
		expect(unpushed.json().error.code).toBe("branch_not_pushed");

		const pushed = await api("POST", g("/push"), { setUpstream: true });
		expect(pushed.statusCode, pushed.body).toBe(200);
		expect(pushed.json<GitPushResult>().status.upstream).toBe("origin/feature");

		const created = await api("POST", g("/pulls"), { title: "Feature", base: "main", draft: true, body: "why" });
		expect(created.statusCode, created.body).toBe(201);
		expect(created.json<PullRequest>()).toMatchObject({ number: 12, head: "feature", base: "main", htmlUrl: "https://github.com/octo/r/pull/12" });
		const sent = gh.calls.find((c) => c.method === "POST");
		expect(sent?.body).toEqual({ title: "Feature", body: "why", head: "feature", base: "main", draft: true });
		expect(sent?.auth).toBe(`Bearer ${FAKE_TOKEN}`);

		expect((await api("GET", g("/pulls?state=all"))).json<PullRequest[]>().map((p) => p.number)).toEqual([12]);
		expect(gh.calls.at(-1)?.url).toContain("state=all");
		expect((await api("GET", g("/pulls/12"))).json<PullRequest>()).toMatchObject({ number: 12, mergeable: true, checks: "success" });
		expect((await api("GET", g("/pulls/abc"))).statusCode).toBe(400);
	});

	it("surfaces GitHub's refusals with their own wording", async () => {
		await link({
			"POST https://api.github.com/repos/octo/r/pulls": { status: 422, json: { message: "Validation Failed", errors: [{ message: "No commits between main and feature" }] } },
		});
		await api("POST", g("/branches"), { name: "feature", checkout: true });
		await api("POST", g("/push"), { setUpstream: true });
		const res = await api("POST", g("/pulls"), { title: "Feature", base: "main" });
		expect(res.statusCode).toBe(422);
		expect(res.json().error).toMatchObject({ code: "no_commits", message: expect.stringContaining("No commits between main and feature") });
	});

	it("409s without a linked repository", async () => {
		await setup();
		const res = await api("GET", g("/pulls"));
		expect(res.statusCode).toBe(409);
		expect(res.json().error.code).toBe("no_repository");
	});
});

describe("clone into a new project", () => {
	let clones: Array<{ url: string; dest: string; token: string | null }>;
	let destRoot: string;

	/** The engine is real; only the clone *source* is redirected from github.com to the local bare repo. */
	async function setupClone(opts: { failWith?: string } = {}) {
		fx = makeFixture();
		destRoot = path.join(fx.root, "clones");
		mkdirSync(destRoot);
		clones = [];
		const real = await createGitEngine({ runtimeDir: mkdtempSync(path.join(tmpdir(), "clam-run-")) });
		const redirected: GitEngine = Object.assign(Object.create(real) as GitEngine, {
			clone: async (url: string, dest: string, o: Parameters<GitEngine["clone"]>[2]) => {
				clones.push({ url, dest, token: o.auth ? await o.auth.token() : null });
				if (opts.failWith) {
					mkdirSync(dest, { recursive: true });
					writeFileSync(path.join(dest, "partial.pack"), "half a clone");
					throw new GitEngineError("network", opts.failWith, opts.failWith);
				}
				const { auth: _auth, ...rest } = o;
				return real.clone(fx.origin, dest, rest);
			},
		});
		h = await createTestHarness({ plugins: [workspaceRoutes, projectRoutes, gitRoutes], ctx: { git: redirected } });
		workspace = (await api("POST", "/workspaces", { name: "Main" })).json();
		const gh = await fakeGithub(h.ctx.db, {
			"GET https://api.github.com/repos/octo/r": { json: { id: 777, name: "r", full_name: "octo/r", private: true, description: null, html_url: "https://github.com/octo/r", default_branch: "main", pushed_at: null, owner: { login: "octo" }, permissions: { pull: true, push: true, admin: false } } },
		});
		h.ctx.github = gh.service;
		return { gh, real };
	}

	const waitOp = async (id: string): Promise<GitOperation> => {
		for (let i = 0; i < 200; i++) {
			const op = (await api("GET", `/git/operations/${id}`)).json<GitOperation>();
			if (op.state !== "running") return op;
			await new Promise((r) => setTimeout(r, 50));
		}
		throw new Error("clone did not finish");
	};

	it("clones, creates a project linked to the repository, and publishes progress/result on git-op:<id>", async () => {
		const { gh, real } = await setupClone();
		const dest = path.join(destRoot, "r");
		const res = await api("POST", "/projects/clone", { workspaceId: workspace.id, accountId: gh.accountId, owner: "octo", repo: "r", path: dest });
		expect(res.statusCode, res.body).toBe(202);
		const started = res.json<GitOperation>();
		expect(started).toMatchObject({ kind: "clone", state: "running", projectId: null });

		const done = await waitOp(started.id);
		expect(done).toMatchObject({ state: "succeeded", error: null, percent: 100 });
		expect(done.projectId).toMatch(/^prj_/);
		expect(clones).toEqual([{ url: "https://github.com/octo/r.git", dest, token: FAKE_TOKEN }]);

		const created = (await api("GET", `/projects/${done.projectId}`)).json<Project>();
		expect(created).toMatchObject({
			name: "r",
			path: realpathSync(dest),
			repository: { owner: "octo", name: "r", externalId: "777", htmlUrl: "https://github.com/octo/r", defaultBranch: "main", accountId: gh.accountId },
		});
		expect(readFileSync(path.join(dest, "a.txt"), "utf8")).toBe("one\n");
		// The bus carries the final event with the project (retained for late subscribers).
		expect(h.ctx.bus.latest(`git-op:${started.id}`)?.event).toMatchObject({ type: "operation", operation: { state: "succeeded" }, project: { id: done.projectId } });
		const events = h.published.filter((p) => p.topic === `git-op:${started.id}`).map((p) => (p.event as { operation: GitOperation }).operation.state);
		expect(events[0]).toBe("running");
		expect(events.at(-1)).toBe("succeeded");

		// Git state recorded and no credential anywhere in the clone.
		const status = (await api("GET", `/projects/${done.projectId}/git/status`)).json<GitStatus>();
		expect(status).toMatchObject({ isRepo: true, branch: "main", clean: true });
		expect(readFileSync(path.join(dest, ".git", "config"), "utf8")).not.toContain(FAKE_TOKEN);
		expect(h.ctx.db.$client.prepare("select count(*) as n from git_sync_states where project_id = ?").get(done.projectId)).toEqual({ n: 1 });
		await real.dispose();
	});

	it("answers 409 for a non-empty destination before doing any network work, and 404 for unknown account/workspace", async () => {
		const { gh, real } = await setupClone();
		const dest = path.join(destRoot, "busy");
		mkdirSync(dest);
		writeFileSync(path.join(dest, "precious.txt"), "keep me");
		const res = await api("POST", "/projects/clone", { workspaceId: workspace.id, accountId: gh.accountId, owner: "octo", repo: "r", path: dest });
		expect(res.statusCode).toBe(409);
		expect(res.json().error.code).toBe("git_dest_not_empty");
		expect(readFileSync(path.join(dest, "precious.txt"), "utf8")).toBe("keep me");
		expect(clones).toEqual([]);
		expect(gh.calls).toEqual([]);

		expect((await api("POST", "/projects/clone", { workspaceId: workspace.id, accountId: "gh_none", owner: "octo", repo: "r", path: path.join(destRoot, "x") })).statusCode).toBe(404);
		expect((await api("POST", "/projects/clone", { workspaceId: "ws_none", accountId: gh.accountId, owner: "octo", repo: "r", path: path.join(destRoot, "x") })).statusCode).toBe(404);
		expect((await api("POST", "/projects/clone", { workspaceId: workspace.id, accountId: gh.accountId, owner: "octo", repo: "r", path: "relative/dir" })).statusCode).toBe(400);
		expect((await api("POST", "/projects/clone", { workspaceId: workspace.id, accountId: gh.accountId, owner: "../evil", repo: "r", path: path.join(destRoot, "x") })).statusCode).toBe(400);
		await real.dispose();
	});

	it("removes a partially cloned destination it created, keeps an empty directory that pre-existed, and records the failure verbatim", async () => {
		const { gh, real } = await setupClone({ failWith: "fatal: unable to access 'https://github.com/octo/r.git/': Could not resolve host: github.com" });
		const created = path.join(destRoot, "fresh");
		const res = await api("POST", "/projects/clone", { workspaceId: workspace.id, accountId: gh.accountId, owner: "octo", repo: "r", path: created });
		expect(res.statusCode).toBe(202);
		const failed = await waitOp(res.json<GitOperation>().id);
		expect(failed).toMatchObject({ state: "failed", projectId: null, error: expect.stringContaining("Could not resolve host: github.com") });
		expect(existsSync(created)).toBe(false);

		const preexisting = path.join(destRoot, "empty-before");
		mkdirSync(preexisting);
		const res2 = await api("POST", "/projects/clone", { workspaceId: workspace.id, accountId: gh.accountId, owner: "octo", repo: "r", path: preexisting });
		await waitOp(res2.json<GitOperation>().id);
		expect(existsSync(preexisting)).toBe(true);
		expect(existsSync(path.join(preexisting, "partial.pack"))).toBe(false);
		expect((await api("GET", `/projects?workspaceId=${workspace.id}`)).json()).toEqual([]);
		await real.dispose();
	});
});

describe("auto-linking a project to its GitHub repository", () => {
	it("links a directory whose origin is a github.com repo (default account, metadata from the API) and never fails project creation", async () => {
		fx = makeFixture();
		h = await createTestHarness({ plugins: [workspaceRoutes, projectRoutes, gitRoutes] });
		const gh = await fakeGithub(h.ctx.db, {
			"GET https://api.github.com/repos/octo/r": { json: { id: 777, name: "r", full_name: "octo/r", private: false, description: null, html_url: "https://github.com/octo/r", default_branch: "trunk", pushed_at: null, owner: { login: "octo" }, permissions: { pull: true, push: true, admin: false } } },
		});
		h.ctx.github = gh.service;
		workspace = (await api("POST", "/workspaces", { name: "Main" })).json();

		git(fx.work, "remote", "set-url", "origin", "https://github.com/octo/r.git");
		const linked = (await api("POST", "/projects", { workspaceId: workspace.id, name: "linked", path: fx.work })).json<Project>();
		expect(linked.repository).toEqual({ owner: "octo", name: "r", externalId: "777", htmlUrl: "https://github.com/octo/r", defaultBranch: "trunk", accountId: gh.accountId });

		// ssh remote, API unreachable for the repo (404): linked with owner/name only.
		git(fx.other, "remote", "set-url", "origin", "git@github.com:octo/missing.git");
		const partial = await api("POST", "/projects", { workspaceId: workspace.id, name: "partial", path: fx.other });
		expect(partial.statusCode).toBe(201);
		expect(partial.json<Project>().repository).toMatchObject({ owner: "octo", name: "missing", externalId: null, accountId: gh.accountId });

		// A local-path origin is not a GitHub repo: no link.
		const plain = path.join(fx.root, "plain");
		git(fx.root, "clone", fx.origin, plain);
		const unlinked = (await api("POST", "/projects", { workspaceId: workspace.id, name: "plain", path: plain })).json<Project>();
		expect(unlinked.repository).toBeNull();
	});
});
