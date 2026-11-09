import type { Agent } from "@clam/contracts";
import { agentSessions, agents } from "@clam/database";
import { inArray } from "drizzle-orm";
import type { ServerContext } from "../context.ts";
import { activeTasksByAgent } from "../tasks/store.ts";

type AgentsContext = Pick<ServerContext, "db" | "runtime" | "omp">;

/**
 * Contract `Agent`s for the given rows. Status is derived from OMP availability, live runtimes and delegated tasks
 * (an agent executing a `running`/`blocked` task is busy even when its session is idle); it is never stored.
 */
export function toAgents(ctx: AgentsContext, rows: Array<typeof agents.$inferSelect>): Agent[] {
	const live = ctx.runtime.list().filter((s) => s.state !== "stopped");
	const byAgent = new Map<string, { active: number; busy: boolean }>();
	if (live.length > 0) {
		const owners = ctx.db
			.select({ id: agentSessions.id, agentId: agentSessions.agentId })
			.from(agentSessions)
			.where(inArray(agentSessions.id, live.map((s) => s.sessionId)))
			.all();
		// Busy means the agent is in a turn: a session waiting only on background work it left running is not "working".
		const busy = new Set(live.filter((s) => s.state === "busy" && !s.background).map((s) => s.sessionId));
		for (const owner of owners) {
			const entry = byAgent.get(owner.agentId) ?? { active: 0, busy: false };
			entry.active++;
			if (busy.has(owner.id)) entry.busy = true;
			byAgent.set(owner.agentId, entry);
		}
	}
	const installed = ctx.omp.binaryPath() !== null;
	const taskLoad = activeTasksByAgent(ctx.db);
	return rows.map((row) => {
		const entry = byAgent.get(row.id);
		const working = (taskLoad.get(row.id)?.running ?? 0) > 0;
		return {
			id: row.id,
			nodeId: row.nodeId,
			name: row.name,
			role: row.role,
			runtime: "omp" as const,
			capabilities: row.capabilities,
			status: !installed ? "offline" : entry?.busy || working ? "busy" : "online",
			activeSessions: entry?.active ?? 0,
			createdAt: row.createdAt,
		};
	});
}

/** Every agent of this node, oldest first. */
export function listLocalAgents(ctx: AgentsContext): Agent[] {
	return toAgents(ctx, ctx.db.select().from(agents).orderBy(agents.createdAt).all());
}
