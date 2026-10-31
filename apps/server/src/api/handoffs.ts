import { CreateTaskHandoffBody, DecideHandoffBody, ExtendHandoffBody, HandoffListQuery, ReclaimHandoffBody, SetupDecisionBody, routes, type Handoff, type HandoffDetail } from "@clam/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RoutePluginOptions } from "../context.ts";

const IdParams = z.object({ id: z.string().min(1).max(128) });

/** Handoffs (M7), local UI side: Handoff Center list/detail, create (source), decide/setup (target), retry, extend, reclaim, cancel. */
export default async function handoffRoutes(app: FastifyInstance, { ctx }: RoutePluginOptions): Promise<void> {
	const handoffs = ctx.handoffs;

	app.get(routes.handoffs, async (req): Promise<Handoff[]> => handoffs.list(HandoffListQuery.parse(req.query)));
	app.post(routes.handoffs, async (req, reply) => reply.status(202).send(await handoffs.create(CreateTaskHandoffBody.parse(req.body))));
	app.get(routes.handoff(":id"), async (req): Promise<HandoffDetail> => handoffs.detail(IdParams.parse(req.params).id));
	app.delete(routes.handoff(":id"), async (req): Promise<Handoff> => handoffs.cancel(IdParams.parse(req.params).id));
	app.post(routes.handoffDecide(":id"), async (req): Promise<Handoff> => handoffs.decide(IdParams.parse(req.params).id, DecideHandoffBody.parse(req.body)));
	app.post(routes.handoffSetup(":id"), async (req): Promise<Handoff> => handoffs.setupDecision(IdParams.parse(req.params).id, SetupDecisionBody.parse(req.body)));
	app.post(routes.handoffRetry(":id"), async (req): Promise<Handoff> => handoffs.retry(IdParams.parse(req.params).id));
	app.post(routes.handoffExtend(":id"), async (req): Promise<Handoff> => handoffs.extend(IdParams.parse(req.params).id, ExtendHandoffBody.parse(req.body).minutes));
	app.post(routes.handoffReclaim(":id"), async (req): Promise<Handoff> => handoffs.reclaim(IdParams.parse(req.params).id, ReclaimHandoffBody.parse(req.body ?? {}).override));
}
