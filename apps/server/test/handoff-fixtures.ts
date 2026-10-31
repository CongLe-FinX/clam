import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Capability, Handoff, HandoffDetail, Invitation, Peer, PairingRequest, Project, Task, TaskDetail, Workspace, OutgoingPairing } from "@clam/contracts";
import type { HandoffTimings } from "../src/handoff/hub.ts";
import type { FaultOptions } from "../src/handoff/fault.ts";
import { api, createFullHarness, type FullHarness } from "./full-harness.ts";
import { eventually, FAST, peerOf } from "./net-helpers.ts";
import { REPO, git, makeRepo } from "./task-fixtures.ts";

export { REPO, git } from "./task-fixtures.ts";

/** Prompt directive of the fake omp: call the host tool `mesh_complete` (`{{taskId}}` is replaced by the first task id of the prompt). */
export const tool = (name: string, args: Record<string, unknown>): string => `@@fake-tool ${name} ${JSON.stringify(args)}`;
export const BLOCK = tool("mesh_complete", { taskId: "{{taskId}}", outcome: "blocked", summary: "waiting for the next instruction" });
export const FINISH = tool("mesh_complete", { taskId: "{{taskId}}", outcome: "succeeded", summary: "finished on the new executor" });

export type Side = "a" | "b" | "c";
const NAMES: Record<Side, string> = { a: "node-a", b: "node-b", c: "node-c" };

export interface NodeOptions {
	handoffTimings?: Partial<HandoffTimings>;
	handoffFault?: FaultOptions;
	/** Extra environment of the fake omp processes. */
	env?: Record<string, string>;
}

interface Kept {
	dataDir: string;
	netPort: number;
	secrets: FullHarness["ctx"]["secrets"];
}

/**
 * Three paired in-process nodes (A the task sender, B the first executor, C the handoff target) in ONE workspace, everybody paired
 * with everybody, with the capabilities handoffs need granted both ways (`handoff.receive`, `tasks.cancel` on top of the pairing
 * defaults). Real servers, fake omp. `stop`/`start` model a process crash/restart of one node on the same data directory.
 */
export interface Trio {
	a: FullHarness;
	b: FullHarness;
	c: FullHarness;
	ids: Record<Side, string>;
	workspace: Workspace;
	root: string;
	node(side: Side): FullHarness;
	stop(side: Side): Promise<void>;
	start(side: Side, options?: NodeOptions): Promise<FullHarness>;
	/** Run a harness-level pair-wise grant (`handoff.receive`, `tasks.cancel`) from `from` to `to` and wait until `to` sees it. */
	grant(from: Side, to: Side, capabilities: Capability[]): Promise<void>;
	revoke(from: Side, to: Side, capabilities: Capability[]): Promise<void>;
	cleanup(): Promise<void>;
}

export async function startHandoffNode(name: string, extra: NodeOptions & { dataDir?: string; port?: number; secrets?: FullHarness["ctx"]["secrets"] } = {}): Promise<FullHarness> {
	return createFullHarness({
		dataDir: extra.dataDir,
		secrets: extra.secrets,
		env: extra.env,
		handoffTimings: { sweepMs: 150, ackRetryMs: 100, completeGraceMs: 400, ...extra.handoffTimings },
		...(extra.handoffFault && { handoffFault: extra.handoffFault }),
		network: { port: extra.port, nodeName: name, options: FAST },
	});
}

/** Pair `joiner` into `inviter`'s workspace `workspaceId` through the local routes only, exactly as a user would. */
export async function pairIn(inviter: FullHarness, joiner: FullHarness, workspaceId: string): Promise<void> {
	const a = api(inviter);
	const b = api(joiner);
	const created = await a.post<Invitation>("/network/invitations", { workspaceId });
	if (created.status !== 201) throw new Error(`invitation failed: ${JSON.stringify(created.body)}`);
	const joined = await b.post<OutgoingPairing>("/network/join", { url: inviter.netUrl, code: created.body.code, expectedFingerprint: inviter.ctx.identity.fingerprint });
	if (joined.status !== 201) throw new Error(`join failed: ${JSON.stringify(joined.body)}`);
	const request = await eventually(async () => (await a.get<PairingRequest[]>("/network/pairing-requests")).body.find((r) => r.state === "awaiting_approval" && r.invitationId === created.body.id), "pairing request on the inviter");
	const approved = await a.post<PairingRequest>(`/network/pairing-requests/${request.id}/approve`, { capabilities: ["agents.read", "events.read", "tasks.send", "tasks.receive", "tasks.cancel", "handoff.receive"] });
	if (approved.status !== 200) throw new Error(`approve failed: ${JSON.stringify(approved.body)}`);
	await eventually(async () => (await peerOf(inviter, joiner.ctx.identity.nodeId))?.status === "online" && (await peerOf(joiner, inviter.ctx.identity.nodeId))?.status === "online", "both peers online");
}

async function patchGrant(from: FullHarness, toId: string, change: (current: string[]) => string[]): Promise<void> {
	const peer = await peerOf(from, toId);
	const res = await api(from).patch<Peer>(`/network/peers/${toId}`, { grantedCapabilities: change(peer?.grantedCapabilities ?? []) });
	if (res.status !== 200) throw new Error(`grant failed: ${JSON.stringify(res.body)}`);
}

export async function startTrio(options: { a?: NodeOptions; b?: NodeOptions; c?: NodeOptions } = {}): Promise<Trio> {
	const root = realpathSync(mkdtempSync(path.join(tmpdir(), "clam-handoff-")));
	const nodes: Record<Side, FullHarness> = {
		a: await startHandoffNode(NAMES.a, options.a),
		b: await startHandoffNode(NAMES.b, options.b),
		c: await startHandoffNode(NAMES.c, options.c),
	};
	const workspace = (await api(nodes.a).post<Workspace>("/workspaces", { name: "Alpha" })).body;
	await pairIn(nodes.a, nodes.b, workspace.id);
	await pairIn(nodes.a, nodes.c, workspace.id);
	await pairIn(nodes.b, nodes.c, workspace.id);
	const ids = { a: nodes.a.ctx.identity.nodeId, b: nodes.b.ctx.identity.nodeId, c: nodes.c.ctx.identity.nodeId };
	const held = new Map<Side, Kept>();
	const self: Trio = {
		get a() {
			return nodes.a;
		},
		get b() {
			return nodes.b;
		},
		get c() {
			return nodes.c;
		},
		ids,
		workspace,
		root,
		node: (side) => nodes[side],
		async stop(side) {
			const node = nodes[side];
			held.set(side, { dataDir: node.dataDir, netPort: node.netPort, secrets: node.ctx.secrets });
			await node.cleanup({ keepData: true });
		},
		async start(side, o = {}) {
			const kept = held.get(side);
			if (!kept) throw new Error(`node ${side} was not stopped`);
			held.delete(side);
			nodes[side] = await startHandoffNode(NAMES[side], { ...o, dataDir: kept.dataDir, port: kept.netPort, secrets: kept.secrets });
			return nodes[side];
		},
		async grant(from, to, capabilities) {
			await patchGrant(nodes[from], ids[to], (cur) => [...new Set([...cur, ...capabilities])]);
			await eventually(async () => {
				const peer = await peerOf(nodes[to], ids[from]);
				return capabilities.every((c) => ((peer?.receivedCapabilities ?? []) as string[]).includes(c));
			}, `${to} sees the grant of ${from}`);
		},
		async revoke(from, to, capabilities) {
			await patchGrant(nodes[from], ids[to], (cur) => cur.filter((c) => !(capabilities as string[]).includes(c)));
			await eventually(async () => {
				const peer = await peerOf(nodes[to], ids[from]);
				return capabilities.every((c) => !((peer?.receivedCapabilities ?? []) as string[]).includes(c));
			}, `${to} sees the revocation of ${from}`);
		},
		async cleanup() {
			for (const side of ["a", "b", "c"] as const) {
				if (held.has(side)) {
					const kept = held.get(side) as Kept;
					rmSync(kept.dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
				} else {
					await nodes[side].cleanup();
				}
			}
			rmSync(root, { recursive: true, force: true });
		},
	};
	// The grants of the approvals above reached each inviter's peers; make sure every direction has them (joiners grant defaults only).
	for (const [from, to] of [["b", "a"], ["c", "a"], ["c", "b"]] as const) await self.grant(from, to, ["handoff.receive", "tasks.cancel"]);
	return self;
}

// ------------------------------------------------------------------ project helpers

/** A managed (git-less) project in the workspace of `node`. */
export async function managedProject(node: FullHarness, workspaceId: string, name: string, dir?: string): Promise<Project> {
	const created = await api(node).post<Project>("/projects", { workspaceId, name, ...(dir && { path: dir }) });
	if (created.status !== 201) throw new Error(`project failed: ${JSON.stringify(created.body)}`);
	return created.body;
}

/** A folder project at `dir` linked to `acme/demo` (the repository all clones of `makeRepo` share). */
export async function linkedProject(node: FullHarness, workspaceId: string, name: string, dir: string): Promise<Project> {
	const created = await api(node).post<Project>("/projects", { workspaceId, name, path: dir });
	if (created.status !== 201) throw new Error(`project failed: ${JSON.stringify(created.body)}`);
	const linked = await api(node).patch<Project>(`/projects/${created.body.id}`, {
		repository: { owner: REPO.owner, name: REPO.name, externalId: null, htmlUrl: REPO.htmlUrl, defaultBranch: "main", accountId: null },
	});
	if (linked.status !== 200) throw new Error(`link failed: ${JSON.stringify(linked.body)}`);
	return linked.body;
}

/** A third clone of the shared bare origin for node C (`makeRepo` gives A and B theirs). */
export function cloneFor(repo: { root: string; origin: string }, name: string, email: string): string {
	const dir = path.join(repo.root, name);
	git(repo.root, "clone", repo.origin, dir);
	git(dir, "config", "user.name", name);
	git(dir, "config", "user.email", email);
	return dir;
}

export { makeRepo };

// ------------------------------------------------------------------ task / handoff helpers

export async function waitForTaskOn(node: FullHarness, id: string, predicate: (task: Task) => boolean, what: string, timeoutMs = 20_000): Promise<TaskDetail> {
	return eventually(
		async () => {
			const res = await api(node).get<TaskDetail>(`/tasks/${id}`);
			return res.status === 200 && predicate(res.body.task) ? res.body : undefined;
		},
		what,
		timeoutMs,
	);
}

export async function handoffsOf(node: FullHarness): Promise<Handoff[]> {
	return (await api(node).get<Handoff[]>("/handoffs")).body;
}

/** The handoff of `taskId` on `node` (newest first) for a role. */
export async function handoffFor(node: FullHarness, taskId: string, role: "source" | "target"): Promise<Handoff | undefined> {
	return (await handoffsOf(node)).find((h) => h.subjectId === taskId && h.role === role);
}

export async function waitForHandoff(node: FullHarness, id: string, predicate: (h: Handoff) => boolean, what: string, timeoutMs = 25_000): Promise<HandoffDetail> {
	return eventually(
		async () => {
			const res = await api(node).get<HandoffDetail>(`/handoffs/${id}`);
			return res.status === 200 && predicate(res.body.handoff) ? res.body : undefined;
		},
		what,
		timeoutMs,
	);
}

/** Wait for the handoff of `taskId` to exist on `node` with the given role and satisfy the predicate. */
export async function waitForHandoffOf(node: FullHarness, taskId: string, role: "source" | "target", predicate: (h: Handoff) => boolean, what: string, timeoutMs = 25_000): Promise<Handoff> {
	return eventually(async () => {
		const found = await handoffFor(node, taskId, role);
		return found && predicate(found) ? found : undefined;
	}, what, timeoutMs);
}

/** Write `contents` into the project folder (`dir`), creating parents. */
export function writeProjectFile(dir: string, rel: string, contents: string): void {
	const file = path.join(dir, rel);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, contents);
}

export function readProjectFile(dir: string, rel: string): string | null {
	const file = path.join(dir, rel);
	return existsSync(file) ? readFileSync(file, "utf8") : null;
}

/** Run `git` in `cwd` and return stdout (for assertions about the target's dedicated branch). */
export function gitOut(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
