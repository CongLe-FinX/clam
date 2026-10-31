import { createHash } from "node:crypto";
import type { wire } from "@clam/agent-network";
import type { ServerContext } from "../context.ts";
import { listLocalAgents } from "../services/agents.ts";
import type { NetworkEventLog } from "./events.ts";
import { activeTasksByAgent } from "../tasks/store.ts";
import { NODE_STREAM } from "./events.ts";

type Deps = Pick<ServerContext, "db" | "runtime" | "omp" | "bus"> & { events: NetworkEventLog };

/** This node's agents as served on `GET /api/v1/agents`. */
export function localAgentsWire(ctx: Pick<ServerContext, "db" | "runtime" | "omp">): wire.AgentsResponse {
	const load = activeTasksByAgent(ctx.db);
	return {
		agents: listLocalAgents(ctx).map((agent) => ({
			agentId: agent.id,
			name: agent.name,
			role: agent.role,
			runtime: agent.runtime,
			capabilities: agent.capabilities,
			status: agent.status,
			activeTasks: load.get(agent.id)?.active ?? 0,
			acceptsTasks: agent.status !== "offline",
			activeSessions: agent.activeSessions,
		})),
	};
}

/**
 * Notices changes to what this node would answer on `GET /agents` (an agent was edited, a runtime started or went
 * busy) and appends an `agents_changed` event to the `node` stream. The revision is also returned by the signed health
 * endpoint so peers that cannot hold an event stream (quick tunnels buffer SSE) still notice within one heartbeat.
 */
export class LocalAgentsWatcher {
	private last: string;
	private debounce: NodeJS.Timeout | null = null;
	private off: (() => void) | null = null;
	/** Set by `stop()`: task and runtime activity may still report changes while the node shuts down, after the database is gone. */
	private stopped = false;

	constructor(private readonly deps: Deps) {
		this.last = this.revision();
	}

	revision(): string {
		const agents = localAgentsWire(this.deps).agents.map((a) => [a.agentId, a.name, a.role, a.runtime, a.capabilities, a.status, a.activeSessions, a.activeTasks]);
		return createHash("sha256").update(JSON.stringify(agents)).digest("hex").slice(0, 16);
	}

	start(): void {
		this.stopped = false;
		this.last = this.revision();
		this.off = this.deps.runtime.onStatus(() => this.schedule());
	}

	stop(): void {
		this.stopped = true;
		this.off?.();
		this.off = null;
		if (this.debounce) clearTimeout(this.debounce);
		this.debounce = null;
	}

	/** Something that feeds `GET /agents` changed; coalesce bursts (a runtime start emits several statuses). */
	schedule(): void {
		if (this.stopped) return;
		if (this.debounce) clearTimeout(this.debounce);
		this.debounce = setTimeout(() => this.check(), 200);
		this.debounce.unref();
	}

	check(): void {
		this.debounce = null;
		const revision = this.revision();
		if (revision === this.last) return;
		this.last = revision;
		this.deps.events.append(NODE_STREAM, "agents_changed", { count: localAgentsWire(this.deps).agents.length });
		this.deps.bus.publish("network", { type: "directory_changed" });
	}
}
