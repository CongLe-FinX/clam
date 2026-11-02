import { existsSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentSession, FileEntry, GitStatus } from "@clam/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { api } from "./full-harness.ts";
import { eventually } from "./net-helpers.ts";
import { git, isolateGitConfig, promptAndWait, remoteBranches, sessionOn, startSharedPair, whenSettled, worktreeOf, type GitConfigIsolation, type SharedPair } from "./shared-fixtures.ts";

/**
 * A git-mode shared session works in its own git worktree (`<dataDir>/worktrees/<sharedId>`), addressed by the checkout id
 * `<projectId>~<sharedId>`; the project's own folder is never switched by shared-session code.
 */

let gitConfig: GitConfigIsolation;
beforeAll(() => {
	gitConfig = isolateGitConfig();
});
afterAll(() => gitConfig.restore());

let pair: SharedPair;
afterEach(async () => {
	await pair?.cleanup();
});

type ErrorBody = { error: { code: string; message: string } };

describe("sharing a session", () => {
	it("leaves the project folder on its branch with its uncommitted files; the driver works in the worktree; git routes answer per checkout id", async () => {
		pair = await startSharedPair();
		writeFileSync(path.join(pair.workA, "ROOT_ONLY.md"), "uncommitted, written before the share\n");
		const { sessionId, shared } = await pair.shareAndJoin({ title: "Add notes", firstPrompt: "write the notes" });
		const branch = shared.repo?.branch as string;
		const worktree = worktreeOf(pair.a, shared.id);
		const checkoutId = `${pair.projectA.id}~${shared.id}`;

		// the project folder: same branch, its uncommitted file still there and still uncommitted
		expect(git(pair.workA, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
		expect(git(pair.workA, "status", "--porcelain").trim()).toBe("?? ROOT_ONLY.md");
		expect(git(worktree, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(branch);
		expect(existsSync(path.join(worktree, "ROOT_ONLY.md"))).toBe(false);

		// the driving session works in the worktree: runtime cwd, the files it writes, the id the UI uses
		expect((await sessionOn(pair.a, sessionId)).checkoutId).toBe(checkoutId);
		await promptAndWait(pair.a, sessionId, "@@fake-sh echo from-the-agent > IN_WORKTREE.md");
		await whenSettled(pair.a, sessionId);
		expect(realpathSync(pair.a.ctx.runtime.get(sessionId)?.spec.cwd as string)).toBe(realpathSync(worktree));
		expect(existsSync(path.join(worktree, "IN_WORKTREE.md"))).toBe(true);
		expect(existsSync(path.join(pair.workA, "IN_WORKTREE.md"))).toBe(false);

		// a checkpoint commits the worktree: the shared branch has the agent's file, never the project folder's uncommitted one
		const manual = await api(pair.a).post<{ seq: number }>(`/shared/${shared.id}/checkpoint`, { note: "now" });
		expect(manual.status, JSON.stringify(manual.body)).toBe(200);
		expect(remoteBranches(pair.origin)).toContain(branch);
		expect(git(pair.origin, "show", `${branch}:IN_WORKTREE.md`)).toBe("from-the-agent\n");
		expect(() => git(pair.origin, "show", `${branch}:ROOT_ONLY.md`)).toThrow();
		expect(git(pair.workA, "status", "--porcelain").trim()).toBe("?? ROOT_ONLY.md");

		// git status per checkout id: the worktree reports the shared branch, the bare project id the project folder's branch
		const inWorktree = await api(pair.a).get<GitStatus>(`/projects/${checkoutId}/git/status`);
		expect(inWorktree.status, JSON.stringify(inWorktree.body)).toBe(200);
		expect(inWorktree.body).toMatchObject({ branch, clean: true });
		const inProject = await api(pair.a).get<GitStatus>(`/projects/${pair.projectA.id}/git/status`);
		expect(inProject.body.branch).toBe("main");
		expect(inProject.body.files.map((f) => f.path)).toEqual(["ROOT_ONLY.md"]);

		// files and raw bytes follow the checkout id too
		const listed = await api(pair.a).get<FileEntry[]>(`/projects/${checkoutId}/files?path=`);
		expect(listed.body.map((f) => f.name)).toContain("IN_WORKTREE.md");
		expect(listed.body.map((f) => f.name)).not.toContain("ROOT_ONLY.md");

		// unknown or foreign checkout ids are clear errors
		expect((await api(pair.a).get<ErrorBody>(`/projects/${pair.projectA.id}~shs_nope/git/status`)).status).toBe(404);
		expect((await api(pair.b).get<ErrorBody>(`/projects/${pair.projectB.id}~${shared.id}/git/status`)).body.error.code).toBe("checkout_not_available");

		// the branch is locked to its worktree: the project folder cannot switch to it
		const switched = await api(pair.a).post<ErrorBody>(`/projects/${pair.projectA.id}/git/checkout`, { branch });
		expect(switched.status).toBe(409);
		expect(switched.body.error.code).toBe("git_branch_in_worktree");
		expect(git(pair.workA, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
	});

	it("another session of the same project keeps working in the project folder", async () => {
		pair = await startSharedPair();
		await pair.shareAndJoin({ title: "Add notes", firstPrompt: "write the notes" });
		const other = await api(pair.a).post<AgentSession>("/sessions", { projectId: pair.projectA.id, title: "Other work" });
		expect(other.body.checkoutId).toBe(pair.projectA.id);
		await promptAndWait(pair.a, other.body.id, "@@fake-sh echo sibling > SIBLING.md");
		expect(existsSync(path.join(pair.workA, "SIBLING.md"))).toBe(true);
		expect(realpathSync(pair.a.ctx.runtime.get(other.body.id)?.spec.cwd as string)).toBe(realpathSync(pair.workA));
	});
});

describe("a share made before worktrees existed", () => {
	async function legacyShare() {
		pair = await startSharedPair();
		const { sessionId, shared } = await pair.shareAndJoin({ title: "Add notes", firstPrompt: "write the notes" });
		// what the old code left behind: no worktree for the share (the runtime is stopped first, as after a server restart)
		await pair.a.ctx.runtime.stop(sessionId);
		const worktree = worktreeOf(pair.a, shared.id);
		git(pair.workA, "worktree", "remove", "--force", worktree);
		expect(existsSync(worktree)).toBe(false);
		return { sessionId, shared, worktree };
	}

	it("gets its worktree on demand when the shared branch is not checked out in the project folder", async () => {
		const { sessionId, shared, worktree } = await legacyShare();
		expect((await sessionOn(pair.a, sessionId)).checkoutId).toBe(pair.projectA.id);
		// opening the runtime creates it (attaching the existing local branch)
		const state = await api(pair.a).get(`/sessions/${sessionId}/state`);
		expect(state.status, JSON.stringify(state.body)).toBe(200);
		await eventually(() => existsSync(path.join(worktree, ".git")), "the worktree to be created");
		expect(git(worktree, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(shared.repo?.branch);
		expect((await sessionOn(pair.a, sessionId)).checkoutId).toBe(`${pair.projectA.id}~${shared.id}`);
		expect(realpathSync(pair.a.ctx.runtime.get(sessionId)?.spec.cwd as string)).toBe(realpathSync(worktree));
		expect(git(pair.workA, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
	});

	it("keeps working in the project folder, never switching it, when that folder itself has the shared branch checked out", async () => {
		const { sessionId, shared, worktree } = await legacyShare();
		git(pair.workA, "switch", shared.repo?.branch as string);
		const state = await api(pair.a).get(`/sessions/${sessionId}/state`);
		expect(state.status, JSON.stringify(state.body)).toBe(200);
		expect(existsSync(worktree)).toBe(false);
		expect((await sessionOn(pair.a, sessionId)).checkoutId).toBe(pair.projectA.id);
		expect(realpathSync(pair.a.ctx.runtime.get(sessionId)?.spec.cwd as string)).toBe(realpathSync(pair.workA));
		// a checkpoint commits there without moving HEAD
		await whenSettled(pair.a, sessionId);
		const manual = await api(pair.a).post<{ seq: number }>(`/shared/${shared.id}/checkpoint`, {});
		expect(manual.status, JSON.stringify(manual.body)).toBe(200);
		expect(git(pair.workA, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(shared.repo?.branch);
	});
});

describe("leaving a shared session", () => {
	it("removes the participant's worktree (never forced) and keeps the branch", async () => {
		pair = await startSharedPair();
		const { shared } = await pair.shareAndJoin({ title: "Add notes", firstPrompt: "write the notes" });
		// a worktree on B as after a takeover (created by hand here: the takeover path is covered in shared-takeover.test.ts)
		const worktree = worktreeOf(pair.b, shared.id);
		git(pair.workB, "fetch", "origin");
		git(pair.workB, "worktree", "add", "--track", "-b", shared.repo?.branch as string, worktree, `origin/${shared.repo?.branch}`);
		const left = await api(pair.b).post(`/shared/${shared.id}/leave`, {});
		expect(left.status, JSON.stringify(left.body)).toBe(200);
		expect(existsSync(worktree)).toBe(false);
		expect(git(pair.workB, "branch", "--list", shared.repo?.branch as string)).toContain(shared.repo?.branch as string);
	});
});
