import { NetworkError, wire, type NetworkClient } from "@clam/agent-network";
import type { DirectoryAgent } from "@clam/contracts";
import { peerAgents } from "@clam/database";
import type { ClamDb } from "@clam/database";
import { eq } from "drizzle-orm";
import type { EventBus, ServerContext } from "../context.ts";
import { listLocalAgents } from "../services/agents.ts";
import type { PeerService } from "./peers.ts";
import { errorText } from "./util.ts";

export interface DirectoryDeps {
	db: ClamDb;
	bus: EventBus;
	client: NetworkClient;
	peers: PeerService;
	local: Pick<ServerContext, "db" | "runtime" | "omp">;
	nodeId: string;
	nodeName(): string;
	log: { warn(o: object, m?: string): void };
}

/** The Agent Directory: this node's agents plus the cached agents of every non-revoked peer. */
export class DirectoryService {
	private readonly inFlight = new Map<string, Promise<boolean>>();

	constructor(private readonly deps: DirectoryDeps) {}

	list(): DirectoryAgent[] {
		const out: DirectoryAgent[] = [];
		const now = new Date().toISOString();
		for (const agent of listLocalAgents(this.deps.local)) {
			out.push({
				nodeId: this.deps.nodeId,
				nodeName: this.deps.nodeName(),
				nodeStatus: "self",
				agentId: agent.id,
				name: agent.name,
				role: agent.role,
				runtime: agent.runtime,
				capabilities: agent.capabilities,
				status: agent.status,
				activeSessions: agent.activeSessions,
				fetchedAt: now,
			});
		}
		for (const peer of this.deps.peers.activeRows()) {
			const status = peer.status as Exclude<DirectoryAgent["nodeStatus"], "self">;
			for (const row of this.deps.db.select().from(peerAgents).where(eq(peerAgents.peerId, peer.id)).orderBy(peerAgents.name, peerAgents.agentId).all()) {
				out.push({
					nodeId: peer.id,
					nodeName: peer.name,
					nodeStatus: status,
					agentId: row.agentId,
					name: row.name,
					role: row.role,
					runtime: row.runtime,
					capabilities: row.capabilities,
					// The cache keeps the last known entry; an unreachable node's agents cannot be considered available.
					status: status === "offline" ? "offline" : (row.status as DirectoryAgent["status"]),
					activeSessions: row.activeSessions,
					fetchedAt: row.fetchedAt,
				});
			}
		}
		return out;
	}

	/** Re-read the peer's `GET /agents` into the cache. Resolves true when the cached entries changed. Never throws. */
	refresh(peerId: string): Promise<boolean> {
		const running = this.inFlight.get(peerId);
		if (running) return running;
		const task = this.doRefresh(peerId).finally(() => this.inFlight.delete(peerId));
		this.inFlight.set(peerId, task);
		return task;
	}

	private async doRefresh(peerId: string): Promise<boolean> {
		const peer = this.deps.peers.row(peerId);
		if (!peer || peer.status === "revoked") return false;
		if (!(peer.receivedCapabilities as string[]).includes("agents.read")) return this.replace(peerId, []);
		try {
			const result = await this.deps.client.request<unknown>(peer.url, { method: "GET", path: "/agents", retry: false });
			const parsed = wire.AgentsResponse.safeParse(result.body);
			if (!parsed.success) {
				this.deps.log.warn({ peerId }, "peer returned an unreadable agent list");
				return false;
			}
			return this.replace(peerId, parsed.data.agents);
		} catch (error) {
			// A refusal of agents.read means the peer does not share its agents with us: show none, not stale ones.
			if (error instanceof NetworkError && error.status === 403 && error.code === "forbidden") return this.replace(peerId, []);
			this.deps.log.warn({ peerId, err: errorText(error) }, "agent directory refresh failed");
			return false;
		}
	}

	private replace(peerId: string, agents: wire.AgentEntry[]): boolean {
		const now = new Date().toISOString();
		const before = JSON.stringify(
			this.deps.db.select().from(peerAgents).where(eq(peerAgents.peerId, peerId)).orderBy(peerAgents.agentId).all().map((r) => [r.agentId, r.name, r.role, r.runtime, r.capabilities, r.status, r.activeSessions]),
		);
		const next = [...agents].sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
		const after = JSON.stringify(next.map((a) => [a.agentId, a.name, a.role, a.runtime, a.capabilities, a.status, a.activeSessions]));
		this.deps.db.transaction((tx) => {
			tx.delete(peerAgents).where(eq(peerAgents.peerId, peerId)).run();
			if (next.length > 0) {
				tx.insert(peerAgents)
					.values(next.map((a) => ({ peerId, agentId: a.agentId, name: a.name, role: a.role, runtime: a.runtime, capabilities: a.capabilities, status: a.status, activeSessions: a.activeSessions, fetchedAt: now })))
					.run();
			}
		});
		const changed = before !== after;
		if (changed) {
			this.deps.bus.publish("network", { type: "directory_changed" });
			this.deps.peers.publish(peerId);
		}
		return changed;
	}
}
