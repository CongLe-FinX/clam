import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { AgentSession, MessagesPage, Peer, SharedInvite, SharedSession, SharedSessionDetail, UiMessage } from "@clam/contracts";
import { api, type FullHarness } from "./full-harness.ts";
import { eventually, peerOf, startNode } from "./net-helpers.ts";
import { startTaskPair, type TaskPair } from "./task-fixtures.ts";

export { branchesOf, git, isolateGitConfig, promptsOf, type GitConfigIsolation } from "./task-fixtures.ts";

export interface SharedPair extends TaskPair {
	aId: string;
	bId: string;
	/** A shared session driven by A with B as participant, once `shareAndJoin` ran. */
	shareAndJoin(options?: { title?: string; firstPrompt?: string; autoAccept?: boolean }): Promise<{ sessionId: string; shared: SharedSession; onB: SharedSession }>;
	/** Stop a node keeping its data (the process died / was shut down); `pair.a|b` stays the stopped harness until `start`. */
	stop(side: "a" | "b"): Promise<void>;
	/** Bring a stopped node back on the same ports and data (a restart of the process); replaces `pair.a|b`. */
	start(side: "a" | "b"): Promise<FullHarness>;
}

/** What the fake omp answers to a plain prompt: `FAKE: <message>` (see packages/agent-runtime/test/fixtures/fake-omp-rpc.mjs). */
export const fakeReply = (message: string): string => `FAKE: ${message}`;

export function textOf(message: UiMessage): string {
	return message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
}

/** Every message of a session (oldest first), read through the local API. */
export async function transcript(node: FullHarness, sessionId: string): Promise<UiMessage[]> {
	const pages: UiMessage[][] = [];
	let cursor: string | undefined;
	do {
		const res = await api(node).get<MessagesPage>(`/sessions/${sessionId}/messages?limit=256${cursor ? `&cursor=${cursor}` : ""}`);
		if (res.status !== 200) throw new Error(`messages ${res.status}: ${JSON.stringify(res.body)}`);
		pages.unshift(res.body.messages);
		cursor = res.body.nextCursor ?? undefined;
	} while (cursor);
	return pages.flat();
}

export async function transcriptTexts(node: FullHarness, sessionId: string): Promise<string[]> {
	return (await transcript(node, sessionId)).map(textOf);
}

let promptCounter = 0;

/** Wait until the session's agent is idle and settled (a prompt sent mid-turn is refused by omp unless it asks to steer or queue). */
export async function whenSettled(node: FullHarness, sessionId: string, timeoutMs = 20_000): Promise<void> {
	await eventually(
		async () => {
			const res = await api(node).get<{ isSettled: boolean; isStreaming: boolean; runtime: { state: string } }>(`/sessions/${sessionId}/state`);
			return res.status === 200 && res.body.isSettled && !res.body.isStreaming && res.body.runtime.state === "ready";
		},
		`session ${sessionId} to settle`,
		timeoutMs,
	);
}

/** Send a prompt to a session and resolve when the agent's answer to it is in the transcript. */
export async function promptAndWait(node: FullHarness, sessionId: string, message: string, timeoutMs = 20_000): Promise<string> {
	await whenSettled(node, sessionId, timeoutMs);
	const before = (await transcript(node, sessionId)).filter((m) => m.role === "assistant").length;
	const res = await api(node).post(`/sessions/${sessionId}/prompt`, { message, clientId: `test-${++promptCounter}-${Date.now()}` });
	if (res.status !== 202) throw new Error(`prompt ${res.status}: ${JSON.stringify(res.body)}`);
	return eventually(
		async () => {
			const assistants = (await transcript(node, sessionId)).filter((m) => m.role === "assistant");
			return assistants.length > before ? textOf(assistants[assistants.length - 1] as UiMessage) : undefined;
		},
		`the agent's answer to "${message.slice(0, 40)}"`,
		timeoutMs,
	);
}

export async function sharedOn(node: FullHarness, id: string): Promise<SharedSession> {
	const res = await api(node).get<SharedSessionDetail>(`/shared/${id}`);
	if (res.status !== 200) throw new Error(`shared ${res.status}: ${JSON.stringify(res.body)}`);
	return res.body.shared;
}

export async function detailOn(node: FullHarness, id: string): Promise<SharedSessionDetail> {
	const res = await api(node).get<SharedSessionDetail>(`/shared/${id}`);
	if (res.status !== 200) throw new Error(`shared ${res.status}: ${JSON.stringify(res.body)}`);
	return res.body;
}

export async function sessionOn(node: FullHarness, id: string): Promise<AgentSession> {
	const res = await api(node).get<AgentSession>(`/sessions/${id}`);
	if (res.status !== 200) throw new Error(`session ${res.status}: ${JSON.stringify(res.body)}`);
	return res.body;
}

export async function sessionsOn(node: FullHarness): Promise<AgentSession[]> {
	return (await api(node).get<AgentSession[]>("/sessions?archived=false")).body;
}

/** Wait until the shared session read on `node` satisfies the predicate. */
export async function waitForShared(node: FullHarness, id: string, predicate: (s: SharedSession) => boolean, what: string, timeoutMs = 20_000): Promise<SharedSession> {
	return eventually(
		async () => {
			const res = await api(node).get<SharedSessionDetail>(`/shared/${id}`);
			return res.status === 200 && predicate(res.body.shared) ? res.body.shared : undefined;
		},
		what,
		timeoutMs,
	);
}

/** Grant `sessions.share` from `node` to `peerId` and wait until the peer sees it as received. */
export async function grantShare(node: FullHarness, peerId: string, other: FullHarness): Promise<void> {
	const peer = await peerOf(node, peerId);
	const res = await api(node).patch<Peer>(`/network/peers/${peerId}`, { grantedCapabilities: [...new Set([...(peer?.grantedCapabilities ?? []), "sessions.share"])] });
	if (res.status !== 200) throw new Error(`grant failed: ${JSON.stringify(res.body)}`);
	await eventually(async () => ((await peerOf(other, node.ctx.identity.nodeId))?.receivedCapabilities ?? []).includes("sessions.share"), "the peer sees sessions.share");
}

/** Two paired nodes whose clones share one bare origin, `sessions.share` granted both ways. */
export async function startSharedPair(options: Parameters<typeof startTaskPair>[0] = {}): Promise<SharedPair> {
	const base = await startTaskPair(options);
	const aId = base.a.ctx.identity.nodeId;
	const bId = base.b.ctx.identity.nodeId;
	await grantShare(base.a, bId, base.b);
	await grantShare(base.b, aId, base.a);
	const held = new Map<"a" | "b", { dataDir: string; netPort: number; secrets: FullHarness["ctx"]["secrets"] }>();
	const names = { a: "node-a", b: "node-b" } as const;
	const pair: SharedPair = {
		...base,
		aId,
		bId,
		async shareAndJoin(o = {}) {
			if (o.autoAccept) await base.autoAcceptOnB(true);
			const created = await api(pair.a).post<AgentSession>("/sessions", { projectId: base.projectA.id, title: o.title ?? "Add notes" });
			if (created.status !== 201) throw new Error(`session failed: ${JSON.stringify(created.body)}`);
			if (o.firstPrompt) await promptAndWait(pair.a, created.body.id, o.firstPrompt);
			const added = await api(pair.a).post<SharedSession>(`/sessions/${created.body.id}/participants`, { nodeId: bId });
			if (added.status !== 201) throw new Error(`share failed: ${JSON.stringify(added.body)}`);
			if (!o.autoAccept) {
				const invite = await eventually(async () => (await api(pair.b).get<SharedInvite[]>("/shared/invites")).body.find((i) => i.sharedSessionId === added.body.id && i.state === "pending"), "the invitation on B");
				const accepted = await api(pair.b).post<SharedInvite>(`/shared/invites/${invite.id}/decide`, { decision: "accept" });
				if (accepted.status !== 200) throw new Error(`accept failed: ${JSON.stringify(accepted.body)}`);
			}
			const onB = await waitForShared(pair.b, added.body.id, (s) => s.localRole === "participant" && s.mirrorSessionId !== null, "B joined");
			await waitForShared(pair.a, added.body.id, (s) => s.participants.some((p) => p.nodeId === bId && p.state === "active"), "A sees B active");
			return { sessionId: created.body.id, shared: added.body, onB };
		},
		async stop(side) {
			const node = pair[side];
			held.set(side, { dataDir: node.dataDir, netPort: node.netPort, secrets: node.ctx.secrets });
			await node.cleanup({ keepData: true });
		},
		async start(side) {
			const kept = held.get(side);
			if (!kept) throw new Error(`node ${side} was not stopped`);
			held.delete(side);
			pair[side] = await startNode(names[side], { dataDir: kept.dataDir, port: kept.netPort, secrets: kept.secrets });
			return pair[side];
		},
		async cleanup() {
			for (const side of ["a", "b"] as const) {
				const kept = held.get(side);
				if (kept) rmSync(kept.dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
				else await pair[side].cleanup();
			}
			rmSync(base.root, { recursive: true, force: true });
		},
	};
	return pair;
}

/** Branch names on a bare repository. */
export function remoteBranches(origin: string): string[] {
	return execFileSync("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"], { cwd: origin, encoding: "utf8" }).split("\n").filter(Boolean);
}

/** Files (relative, sorted) under a directory, depth-first, skipping `.git`. */
export function listFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (current: string): void => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			if (entry.name === ".git") continue;
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else out.push(path.relative(dir, full));
		}
	};
	if (existsSync(dir)) walk(dir);
	return out.sort();
}

export function readIn(dir: string, file: string): string {
	return readFileSync(path.join(dir, file), "utf8");
}

/** The git worktree a node keeps for a git-mode shared session (`<dataDir>/worktrees/<sharedId>`); it exists once that node drives (or took over) the session. */
export function worktreeOf(node: FullHarness, sharedId: string): string {
	return path.join(node.dataDir, "worktrees", sharedId);
}
