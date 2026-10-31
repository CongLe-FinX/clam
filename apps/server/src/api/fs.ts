import { routes } from "@clam/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RoutePluginOptions } from "../context.ts";
import { suggestDirectories } from "../services/files.ts";

const Query = z.object({ prefix: z.string().default("") });

/** Directory autocomplete for the "add project" path picker. */
export default async function fsRoutes(app: FastifyInstance, _opts: RoutePluginOptions): Promise<void> {
	app.get(routes.dirSuggestions, async (req) => suggestDirectories(Query.parse(req.query).prefix));
}
