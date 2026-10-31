import { routes } from "@clam/contracts";
import { createSqliteHistory, createUsageService, UsageError } from "@clam/provider-usage";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RoutePluginOptions } from "../context.ts";
import { ApiError } from "../http/errors.ts";

/** `?refresh=1` / `?refresh=true` forces a new `omp` run; anything else serves the cache. */
const Query = z.object({
	refresh: z
		.enum(["1", "true", "0", "false"])
		.optional()
		.transform((v) => v === "1" || v === "true"),
});

const BACKGROUND_REFRESH_MS = 30 * 60_000;

/** OMP-recorded usage (`omp stats`) and provider-reported quota (`omp usage`), cached stale-while-revalidate. */
export default async function usageProviderRoutes(app: FastifyInstance, { ctx }: RoutePluginOptions): Promise<void> {
	const service = createUsageService({
		dataDir: ctx.config.dataDir,
		binaryPath: () => ctx.omp.binaryPath(),
		profile: () => ctx.config.ompProfile,
		history: createSqliteHistory(ctx.db.$client),
		onError: (label, err) => ctx.log.warn({ err, label }, `usage: omp ${label} refresh failed`),
	});

	const toApiError = (err: unknown): unknown => {
		if (!(err instanceof UsageError)) return err;
		return err.code === "omp_missing" ? ApiError.unavailable(err.message) : ApiError.upstream(err.message);
	};

	app.get(routes.usageRecorded, async (req) => {
		const { refresh } = Query.parse(req.query);
		try {
			return await service.recorded({ refresh });
		} catch (err) {
			throw toApiError(err);
		}
	});

	app.get(routes.usageQuota, async (req) => {
		const { refresh } = Query.parse(req.query);
		try {
			return await service.quota({ refresh });
		} catch (err) {
			throw toApiError(err);
		}
	});

	// Keeps accumulated daily history filling while the server runs (omp's own window is only 24h).
	const stop = service.startBackgroundRefresh(BACKGROUND_REFRESH_MS);
	app.addHook("onClose", async () => stop());
}
