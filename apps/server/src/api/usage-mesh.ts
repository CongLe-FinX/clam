import { type MeshUsage, type MeshUsageRow, routes } from "@clam/contracts";
import { agents, projects, providerUsage } from "@clam/database";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { RoutePluginOptions } from "../context.ts";

const DELETED_KEY = "deleted";

/** CL Agent Mesh's own per-session accounting rolled up by project and by agent (`provider_usage`, OMP-recorded). */
export default async function meshUsageRoutes(app: FastifyInstance, { ctx }: RoutePluginOptions): Promise<void> {
	const sums = {
		input: sql<number>`coalesce(sum(${providerUsage.inputTokens}), 0)`,
		output: sql<number>`coalesce(sum(${providerUsage.outputTokens}), 0)`,
		cacheRead: sql<number>`coalesce(sum(${providerUsage.cacheReadTokens}), 0)`,
		cacheWrite: sql<number>`coalesce(sum(${providerUsage.cacheWriteTokens}), 0)`,
		cost: sql<number>`coalesce(sum(${providerUsage.cost}), 0)`,
		sessions: sql<number>`count(distinct ${providerUsage.sessionId})`,
	};

	function toRow(key: string, label: string, r: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; sessions: number }): MeshUsageRow {
		return {
			key,
			label,
			sessions: r.sessions,
			tokens: { input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, total: r.input + r.output + r.cacheRead + r.cacheWrite },
			cost: r.cost,
			source: "omp-recorded",
		};
	}

	app.get(routes.usageMesh, async (): Promise<MeshUsage> => {
		const byProject = ctx.db
			.select({ key: providerUsage.projectId, label: projects.name, ...sums })
			.from(providerUsage)
			.leftJoin(projects, sql`${providerUsage.projectId} = ${projects.id}`)
			.groupBy(providerUsage.projectId)
			.orderBy(sql`sum(${providerUsage.cost}) desc`)
			.all()
			.map((r) => toRow(r.key ?? DELETED_KEY, r.label ?? "Deleted project", r));
		const byAgent = ctx.db
			.select({ key: providerUsage.agentId, label: agents.name, ...sums })
			.from(providerUsage)
			.leftJoin(agents, sql`${providerUsage.agentId} = ${agents.id}`)
			.groupBy(providerUsage.agentId)
			.orderBy(sql`sum(${providerUsage.cost}) desc`)
			.all()
			.map((r) => toRow(r.key ?? DELETED_KEY, r.label ?? "Deleted agent", r));
		return { byProject, byAgent, fetchedAt: new Date().toISOString() };
	});
}
