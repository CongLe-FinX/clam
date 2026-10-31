import { rmSync } from "node:fs";
import type { Context, Peer, Workspace } from "@clam/contracts";
import { api, type FullHarness } from "./full-harness.ts";
import { eventually, pair, peerOf, startNode } from "./net-helpers.ts";

export const SYNC_TIMINGS = { reconcileMs: 300 };

/** `node` lets `peerId` use `context.sync` on it, and waits until `other` (that peer) sees the grant. */
export async function grantContextSync(node: FullHarness, peerId: string, other: FullHarness, on = true): Promise<void> {
	const peer = await peerOf(node, peerId);
	const current = (peer?.grantedCapabilities ?? []).filter((c) => c !== "context.sync");
	const res = await api(node).patch<Peer>(`/network/peers/${peerId}`, { grantedCapabilities: on ? [...current, "context.sync"] : current });
	if (res.status !== 200) throw new Error(`grant failed: ${JSON.stringify(res.body)}`);
	await eventually(async () => ((await peerOf(other, node.ctx.identity.nodeId))?.receivedCapabilities ?? []).includes("context.sync") === on, `the peer sees context.sync ${on ? "granted" : "revoked"}`);
}

export interface ContextPair {
	a: FullHarness;
	b: FullHarness;
	aId: string;
	bId: string;
	workspace: Workspace;
	/** Revoke / restore `context.sync` in both directions (edits made meanwhile do not travel: how the tests make edits concurrent). */
	partition(): Promise<void>;
	heal(): Promise<void>;
	stop(side: "a" | "b"): Promise<void>;
	start(side: "a" | "b"): Promise<FullHarness>;
	cleanup(): Promise<void>;
}

/** Two paired in-process nodes sharing one workspace, `context.sync` granted both ways (fast reconcile timers). */
export async function startContextPair(options: { grant?: boolean } = {}): Promise<ContextPair> {
	const a = await startNode("node-a", { contextTimings: SYNC_TIMINGS });
	const b = await startNode("node-b", { contextTimings: SYNC_TIMINGS });
	const { workspace } = await pair(a, b);
	const aId = a.ctx.identity.nodeId;
	const bId = b.ctx.identity.nodeId;
	if (options.grant !== false) {
		await grantContextSync(a, bId, b);
		await grantContextSync(b, aId, a);
	}
	const held = new Map<"a" | "b", { dataDir: string; netPort: number; secrets: FullHarness["ctx"]["secrets"] }>();
	const names = { a: "node-a", b: "node-b" } as const;
	const self: ContextPair = {
		a,
		b,
		aId,
		bId,
		workspace,
		async partition() {
			await grantContextSync(self.a, bId, self.b, false);
			await grantContextSync(self.b, aId, self.a, false);
		},
		async heal() {
			await grantContextSync(self.a, bId, self.b);
			await grantContextSync(self.b, aId, self.a);
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
			self[side] = await startNode(names[side], { dataDir: kept.dataDir, port: kept.netPort, secrets: kept.secrets, contextTimings: SYNC_TIMINGS });
			return self[side];
		},
		async cleanup() {
			for (const side of ["a", "b"] as const) {
				const kept = held.get(side);
				if (kept) rmSync(kept.dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
				else await self[side].cleanup();
			}
		},
	};
	return self;
}

/** Thin wrappers over the context routes of one node. */
export function contextsOn(node: FullHarness) {
	const http = api(node);
	return {
		async create(body: { workspaceId: string; projectId?: string; type?: string; title: string; body: string; shareable?: boolean }): Promise<Context> {
			const res = await http.post<Context>("/contexts", { type: "memory", shareable: false, ...body });
			if (res.status !== 201) throw new Error(`create failed: ${res.status} ${JSON.stringify(res.body)}`);
			return res.body;
		},
		async get(id: string): Promise<Context | undefined> {
			const res = await http.get<Context>(`/contexts/${id}`);
			return res.status === 200 ? res.body : undefined;
		},
		async list(query = ""): Promise<Context[]> {
			return (await http.get<Context[]>(`/contexts${query}`)).body;
		},
		async edit(id: string, patch: { title?: string; body?: string; shareable?: boolean }): Promise<Context> {
			const current = await http.get<Context>(`/contexts/${id}`);
			const res = await http.patch<Context>(`/contexts/${id}`, { baseVersion: current.body.version, ...patch });
			if (res.status !== 200) throw new Error(`edit failed: ${res.status} ${JSON.stringify(res.body)}`);
			return res.body;
		},
		http,
	};
}

export async function waitForContext(node: FullHarness, id: string, predicate: (c: Context) => boolean, what: string, timeoutMs = 15_000): Promise<Context> {
	return eventually(async () => {
		const c = await contextsOn(node).get(id);
		return c && predicate(c) ? c : undefined;
	}, what, timeoutMs);
}
