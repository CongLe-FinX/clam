import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentSession, Peer, Project, SharedInvite, SharedSession, Workspace } from "@clam/contracts";
import { api, type FullHarness } from "./full-harness.ts";
import { eventually, pair, peerOf, startNode } from "./net-helpers.ts";
import { grantShare, promptAndWait, waitForShared } from "./shared-fixtures.ts";

export { listFiles, readIn } from "./shared-fixtures.ts";

export interface PlainPair {
	a: FullHarness;
	b: FullHarness;
	aId: string;
	bId: string;
	workspace: Workspace;
	/** A managed project (no path given, no git) on A. */
	projectA: Project;
	root: string;
	autoAcceptOnB(on: boolean): Promise<void>;
	/** A shared session in FILES mode: A drives a session in `projectA`, B (auto-accept) joins into a managed folder. */
	shareAndJoin(options?: { title?: string; firstPrompt?: string; projectId?: string }): Promise<{ sessionId: string; shared: SharedSession; onB: SharedSession }>;
	stop(side: "a" | "b"): Promise<void>;
	start(side: "a" | "b"): Promise<FullHarness>;
	cleanup(): Promise<void>;
}

/** Two paired in-process nodes with NO git anywhere: A owns a managed (empty) project; `sessions.share` is granted both ways. */
export async function startPlainPair(): Promise<PlainPair> {
	const root = realpathSync(mkdtempSync(path.join(tmpdir(), "clam-nogit-")));
	const a = await startNode("node-a");
	const b = await startNode("node-b");
	const { workspace } = await pair(a, b);
	const aId = a.ctx.identity.nodeId;
	const bId = b.ctx.identity.nodeId;
	await grantShare(a, bId, b);
	await grantShare(b, aId, a);
	const created = await api(a).post<Project>("/projects", { workspaceId: workspace.id, name: "notes" });
	if (created.status !== 201) throw new Error(`managed project failed: ${JSON.stringify(created.body)}`);
	const held = new Map<"a" | "b", { dataDir: string; netPort: number; secrets: FullHarness["ctx"]["secrets"] }>();
	const names = { a: "node-a", b: "node-b" } as const;
	const self: PlainPair = {
		a,
		b,
		aId,
		bId,
		workspace,
		projectA: created.body,
		root,
		async autoAcceptOnB(on) {
			const res = await api(self.b).patch<Peer>(`/network/peers/${aId}`, { autoAcceptTasks: on });
			if (res.status !== 200) throw new Error(`autoAccept failed: ${JSON.stringify(res.body)}`);
		},
		async shareAndJoin(o = {}) {
			const created = await api(self.a).post<AgentSession>("/sessions", { projectId: o.projectId ?? self.projectA.id, title: o.title ?? "Plain notes" });
			if (created.status !== 201) throw new Error(`session failed: ${JSON.stringify(created.body)}`);
			if (o.firstPrompt) await promptAndWait(self.a, created.body.id, o.firstPrompt);
			const added = await api(self.a).post<SharedSession>(`/sessions/${created.body.id}/participants`, { nodeId: bId });
			if (added.status !== 201) throw new Error(`share failed: ${JSON.stringify(added.body)}`);
			const invite = await eventually(async () => (await api(self.b).get<SharedInvite[]>("/shared/invites")).body.find((i) => i.sharedSessionId === added.body.id && i.state === "pending"), "the invitation on B");
			const accepted = await api(self.b).post<SharedInvite>(`/shared/invites/${invite.id}/decide`, { decision: "accept" });
			if (accepted.status !== 200) throw new Error(`accept failed: ${JSON.stringify(accepted.body)}`);
			const onB = await waitForShared(self.b, added.body.id, (s) => s.localRole === "participant" && s.mirrorSessionId !== null, "B joined");
			await waitForShared(self.a, added.body.id, (s) => s.participants.some((p) => p.nodeId === bId && p.state === "active"), "A sees B active");
			return { sessionId: created.body.id, shared: added.body, onB };
		},
		async stop(side) {
			const node = self[side];
			held.set(side, { dataDir: node.dataDir, netPort: node.netPort, secrets: node.ctx.secrets });
			await node.cleanup({ keepData: true });
		},
		async start(side) {
			const kept = held.get(side);
			if (!kept) throw new Error(`node ${side} was not stopped`);
			held.delete(side);
			self[side] = await startNode(names[side], { dataDir: kept.dataDir, port: kept.netPort, secrets: kept.secrets });
			return self[side];
		},
		async cleanup() {
			for (const side of ["a", "b"] as const) {
				const kept = held.get(side);
				if (kept) rmSync(kept.dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
				else await self[side].cleanup();
			}
			rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
		},
	};
	return self;
}

export function write(dir: string, file: string, content: string): void {
	const target = path.join(dir, file);
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, content);
}

export function read(dir: string, file: string): string {
	return readFileSync(path.join(dir, file), "utf8");
}

export const exists = (dir: string, file: string): boolean => existsSync(path.join(dir, file));
