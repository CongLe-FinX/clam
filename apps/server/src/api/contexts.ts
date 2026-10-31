import { ContextListQuery, ContextSearchQuery, CreateContextBody, ResolveContextConflictBody, UpdateContextBody, routes, type Context, type ContextExportResult, type ContextImportResult, type ContextSearchHit, type ContextVersion } from "@clam/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RoutePluginOptions } from "../context.ts";

const IdParams = z.object({ id: z.string().min(1).max(128) });
const ProjectParams = z.object({ projectId: z.string().min(1).max(128) });

/** Workspace/project context (M6): memory, plans, decisions, summaries; local UI side. Peer sync and agent tools live in `src/context/`. */
export default async function contextRoutes(app: FastifyInstance, { ctx }: RoutePluginOptions): Promise<void> {
	const contexts = ctx.contexts;

	app.get(routes.contexts, async (req): Promise<Context[]> => contexts.list(ContextListQuery.parse(req.query)));
	app.post(routes.contexts, async (req, reply) => reply.status(201).send(contexts.create(CreateContextBody.parse(req.body), contexts.humanAuthor())));

	// Registered before `/contexts/:id`; find-my-way prefers the static segment anyway.
	app.get(routes.contextSearch, async (req): Promise<ContextSearchHit[]> => {
		const { q, ...rest } = ContextSearchQuery.parse(req.query);
		return contexts.search({ q, ...rest });
	});

	app.get(routes.context(":id"), async (req): Promise<Context> => contexts.get(IdParams.parse(req.params).id));
	app.patch(routes.context(":id"), async (req): Promise<Context> => contexts.update(IdParams.parse(req.params).id, UpdateContextBody.parse(req.body), contexts.humanAuthor()));
	app.delete(routes.context(":id"), async (req, reply) => {
		contexts.remove(IdParams.parse(req.params).id, contexts.humanAuthor());
		return reply.status(204).send();
	});
	app.get(routes.contextVersions(":id"), async (req): Promise<ContextVersion[]> => contexts.versions(IdParams.parse(req.params).id));
	app.post(routes.contextResolve(":id"), async (req): Promise<Context> => contexts.resolve(IdParams.parse(req.params).id, ResolveContextConflictBody.parse(req.body), contexts.humanAuthor()));

	// git projects: write shareable contexts to `.clmesh/` (working tree only, never committed) / read them back.
	app.post(routes.contextExport(":projectId"), async (req): Promise<ContextExportResult> => contexts.clmesh.export(ProjectParams.parse(req.params).projectId));
	app.post(routes.contextImport(":projectId"), async (req): Promise<ContextImportResult> => contexts.clmesh.import(ProjectParams.parse(req.params).projectId));
}
