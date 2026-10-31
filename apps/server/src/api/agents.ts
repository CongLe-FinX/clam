import { UpdateAgentBody, routes } from "@clam/contracts";
import { agents } from "@clam/database";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RoutePluginOptions } from "../context.ts";
import { ApiError } from "../http/errors.ts";
import { listLocalAgents, toAgents } from "../services/agents.ts";

const IdParams = z.object({ id: z.string().min(1) });

/** Agents of this node. Status is derived from OMP availability and live runtimes; it is never stored. */
export default async function agentRoutes(app: FastifyInstance, { ctx }: RoutePluginOptions): Promise<void> {
	app.get(routes.agents, async () => listLocalAgents(ctx));

	app.patch(routes.agent(":id"), async (req) => {
		const { id } = IdParams.parse(req.params);
		const body = UpdateAgentBody.parse(req.body);
		if (!ctx.db.select({ id: agents.id }).from(agents).where(eq(agents.id, id)).get()) throw ApiError.notFound("Agent");
		const set: Partial<typeof agents.$inferInsert> = { updatedAt: new Date().toISOString() };
		if (body.name !== undefined) set.name = body.name;
		if (body.role !== undefined) set.role = body.role;
		if (body.capabilities !== undefined) set.capabilities = body.capabilities;
		ctx.db.update(agents).set(set).where(eq(agents.id, id)).run();
		const [updated] = toAgents(ctx, ctx.db.select().from(agents).where(eq(agents.id, id)).all());
		if (!updated) throw ApiError.notFound("Agent");
		ctx.network.localAgentsChanged();
		return updated;
	});
}
