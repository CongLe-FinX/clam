import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Peer, Project, Task, TaskDetail, TaskEvent, Workspace } from "@clam/contracts";
import { api, type FullHarness } from "./full-harness.ts";
import { eventually, pair, peerOf, startNode } from "./net-helpers.ts";

export interface GitConfigIsolation {
	restore(): void;
}

/** Isolate git from the developer's configuration (identity, hooks, credential helpers, signing); call from `beforeAll`. */
export function isolateGitConfig(): GitConfigIsolation {
	const dir = mkdtempSync(path.join(tmpdir(), "clam-gitcfg-"));
	const file = path.join(dir, "gitconfig");
	writeFileSync(file, "[init]\n\tdefaultBranch = main\n");
	const previous = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
	process.env.GIT_CONFIG_GLOBAL = file;
	process.env.GIT_CONFIG_NOSYSTEM = "1";
	return {
		restore() {
			if (previous.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
			else process.env.GIT_CONFIG_GLOBAL = previous.global;
			if (previous.nosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
			else process.env.GIT_CONFIG_NOSYSTEM = previous.nosystem;
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

export function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function identify(dir: string, name: string, email: string): void {
	git(dir, "config", "user.name", name);
	git(dir, "config", "user.email", email);
}

export const REPO = { owner: "acme", name: "demo", htmlUrl: "https://github.com/acme/demo" };

export interface TaskPair {
	a: FullHarness;
	b: FullHarness;
	root: string;
	/** The bare repository both nodes' clones use as `origin`. */
	origin: string;
	workA: string;
	workB: string;
	workspace: Workspace;
	projectA: Project;
	projectB: Project;
	/** B's view of A and A's view of B. */
	peerAonB(): Promise<Peer | undefined>;
	peerBonA(): Promise<Peer | undefined>;
	/** `ping`-style helper: B auto-accepts tasks from A (the policy flag). */
	autoAcceptOnB(on: boolean): Promise<void>;
	/** Grant what delegation needs beyond the pairing defaults (`tasks.cancel` on B for A). */
	grantCancel(): Promise<void>;
	cleanup(): Promise<void>;
}

/** Bare origin with `main` (one commit), plus clones `workA`/`workB`. */
export function makeRepo(): { root: string; origin: string; workA: string; workB: string } {
	const root = realpathSync(mkdtempSync(path.join(tmpdir(), "clam-tasks-")));
	const origin = path.join(root, "origin.git");
	git(root, "init", "--bare", "-b", "main", origin);
	const seed = path.join(root, "seed");
	git(root, "clone", origin, seed);
	identify(seed, "Seed", "seed@example.com");
	writeFileSync(path.join(seed, "README.md"), "# demo\n");
	git(seed, "add", ".");
	git(seed, "commit", "-m", "seed");
	git(seed, "push", "origin", "main");
	const workA = path.join(root, "work-a");
	const workB = path.join(root, "work-b");
	git(root, "clone", origin, workA);
	git(root, "clone", origin, workB);
	identify(workA, "Dev A", "a@example.com");
	identify(workB, "Dev B", "b@example.com");
	return { root, origin, workA, workB };
}

/**
 * Two paired in-process nodes (A inviter, B joiner) sharing one workspace, each with a project at its own clone of
 * one bare repository linked to `acme/demo`. Real server, real git, fake omp; B does NOT auto-accept unless asked.
 */
export async function startTaskPair(options: { nodeA?: Parameters<typeof startNode>[1]; nodeB?: Parameters<typeof startNode>[1] } = {}): Promise<TaskPair> {
	const repo = makeRepo();
	const a = await startNode("node-a", options.nodeA);
	const b = await startNode("node-b", options.nodeB);
	const { workspace } = await pair(a, b);
	const link = async (node: FullHarness, name: string, dir: string): Promise<Project> => {
		const created = await api(node).post<Project>("/projects", { workspaceId: workspace.id, name, path: dir });
		if (created.status !== 201) throw new Error(`project failed: ${JSON.stringify(created.body)}`);
		const linked = await api(node).patch<Project>(`/projects/${created.body.id}`, {
			repository: { owner: REPO.owner, name: REPO.name, externalId: null, htmlUrl: REPO.htmlUrl, defaultBranch: "main", accountId: null },
		});
		if (linked.status !== 200) throw new Error(`link failed: ${JSON.stringify(linked.body)}`);
		return linked.body;
	};
	const projectA = await link(a, "demo-a", repo.workA);
	const projectB = await link(b, "demo-b", repo.workB);
	const aId = a.ctx.identity.nodeId;
	const bId = b.ctx.identity.nodeId;
	return {
		a,
		b,
		...repo,
		workspace,
		projectA,
		projectB,
		peerAonB: () => peerOf(b, aId),
		peerBonA: () => peerOf(a, bId),
		async autoAcceptOnB(on) {
			const res = await api(b).patch<Peer>(`/network/peers/${aId}`, { autoAcceptTasks: on });
			if (res.status !== 200) throw new Error(`autoAccept failed: ${JSON.stringify(res.body)}`);
		},
		async grantCancel() {
			const peer = await peerOf(b, aId);
			const res = await api(b).patch<Peer>(`/network/peers/${aId}`, { grantedCapabilities: [...new Set([...(peer?.grantedCapabilities ?? []), "tasks.cancel"])] });
			if (res.status !== 200) throw new Error(`grant failed: ${JSON.stringify(res.body)}`);
			// A learns the grant through the heartbeat (`receivedCapabilities`).
			await eventually(async () => ((await peerOf(a, bId))?.receivedCapabilities ?? []).includes("tasks.cancel"), "A sees tasks.cancel");
		},
		async cleanup() {
			await a.cleanup();
			await b.cleanup();
			rmSync(repo.root, { recursive: true, force: true });
		},
	};
}

/** Wait until the task (read through the local API of `node`) satisfies the predicate. */
export async function waitForTask(node: FullHarness, id: string, predicate: (task: Task) => boolean, what: string, timeoutMs = 20_000): Promise<TaskDetail> {
	return eventually(
		async () => {
			const res = await api(node).get<TaskDetail>(`/tasks/${id}`);
			return res.status === 200 && predicate(res.body.task) ? res.body : undefined;
		},
		what,
		timeoutMs,
	);
}

/** Task by title on a node (the id of an incoming task is only known there once delivered). */
export async function findTask(node: FullHarness, title: string): Promise<Task | undefined> {
	const res = await api(node).get<Task[]>("/tasks");
	return res.body.find((t) => t.title === title);
}

/** The `to` of every status event, in timeline order. */
export function statusSequence(events: readonly TaskEvent[]): string[] {
	return events.flatMap((e) => {
		if (e.type !== "status" || typeof e.payload !== "object" || e.payload === null || !("to" in e.payload)) return [];
		return typeof e.payload.to === "string" ? [e.payload.to] : [];
	});
}

export function branchesOf(origin: string): string[] {
	return git(origin, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean);
}

export function readFileAtBranch(origin: string, branch: string, file: string): string {
	return git(origin, "show", `${branch}:${file}`);
}


interface FakeRecord {
	kind: string;
	frame?: { type: string; message?: string; streamingBehavior?: string };
}

function fakeRecords(node: FullHarness): FakeRecord[] {
	if (!existsSync(node.fakeLog)) return [];
	return readFileSync(node.fakeLog, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as FakeRecord);
}

/** Every prompt the fake omp processes of `node` received, in order (`streamingBehavior` when the prompt arrived mid-turn). */
export function promptsOf(node: FullHarness): Array<{ message: string; streamingBehavior?: string }> {
	return fakeRecords(node).flatMap((r) =>
		r.kind === "command" && r.frame?.type === "prompt" && r.frame.message ? [{ message: r.frame.message, ...(r.frame.streamingBehavior && { streamingBehavior: r.frame.streamingBehavior }) }] : [],
	);
}
