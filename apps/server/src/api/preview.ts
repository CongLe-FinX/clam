import { PreviewTicketBody, UpdatePreviewConfigBody, routes, type PreviewCheckResult, type PreviewStatus, type PreviewTicket } from "@clam/contracts";
import type { FastifyInstance } from "fastify";
import type { RoutePluginOptions } from "../context.ts";

/**
 * Preview (REST side; the proxy itself is `preview/gateway.ts` on the network listener). `GET /preview` is visible to anyone on the
 * UI surface; minting a ticket and the reachability check are machine-tool-like: through the domain they need Preview switched on
 * (403 `preview_disabled`). Changing the preview host is loopback-only (`auth/gate.ts`).
 */
export default async function previewRoutes(app: FastifyInstance, { ctx }: RoutePluginOptions): Promise<void> {
	const { access, preview } = ctx;

	app.get(routes.preview, async (): Promise<PreviewStatus> => preview.status());

	app.put(routes.previewConfig, async (request): Promise<PreviewStatus> => preview.setHost(UpdatePreviewConfigBody.parse(request.body).host));

	app.post(routes.previewCheck, async (request): Promise<PreviewCheckResult> => {
		access.assertTool(request.access, "preview");
		return preview.check();
	});

	app.post(routes.previewTicket, async (request): Promise<PreviewTicket> => {
		access.assertTool(request.access, "preview");
		return preview.ticket(request.access, PreviewTicketBody.parse(request.body));
	});
}
