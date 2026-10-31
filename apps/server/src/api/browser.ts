import { NavigateBody, OpenTabBody, routes, type BrowserDownload, type BrowserStatus, type BrowserTab, type ListeningPort } from "@clam/contracts";
import type { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RoutePluginOptions } from "../context.ts";
import { ApiError } from "../http/errors.ts";
import { sendFile } from "../http/file-response.ts";
import { rawBodyScope } from "../http/raw-body.ts";
import { recordAudit } from "../services/audit.ts";

const TabParams = z.object({ id: z.string().regex(/^[\w-]{1,64}$/) });
const UploadQuery = z.object({ name: z.string().min(1).max(255) });
const MAX_UPLOAD_BYTES = 1024 ** 3;

/**
 * The machine's Browser (REST side): status + install, tabs, navigation, listening ports, downloads and file-chooser uploads.
 * Pixels and input travel on `/ws/browser/:tabId` (`ws/browser.ts`). Loopback UI: always. Through the domain: only with the
 * Browser switched on (`AccessService.assertTool`, 403 `tool_disabled`). Never reachable through `/api/v1`.
 */
export default async function browserRoutes(app: FastifyInstance, { ctx }: RoutePluginOptions): Promise<void> {
	const { access, browser } = ctx;
	// Every route of this plugin is a machine tool: one gate, before any handler runs.
	app.addHook("onRequest", async (request) => access.assertTool(request.access, "browser"));

	app.get(routes.browser, async (): Promise<BrowserStatus> => browser.status());

	app.post(routes.browserInstall, async (request): Promise<BrowserStatus> => {
		const status = browser.install();
		recordAudit(ctx, "browser.install", { via: request.access.via, sid: request.access.session?.sid.slice(0, 8) ?? null }, "warning");
		return status;
	});

	app.get(routes.browserTabs, async (): Promise<BrowserTab[]> => browser.listTabs());

	app.post(routes.browserTabs, async (request, reply): Promise<BrowserTab> => {
		const body = OpenTabBody.parse(request.body ?? {});
		const tab = await browser.openTab(body.url);
		return reply.status(201).send(tab);
	});

	app.delete<{ Params: { id: string } }>(routes.browserTab(":id"), async (request, reply) => {
		await browser.closeTab(TabParams.parse(request.params).id);
		return reply.status(204).send();
	});

	app.post<{ Params: { id: string } }>(routes.browserNavigate(":id"), async (request): Promise<BrowserTab> => browser.navigate(TabParams.parse(request.params).id, NavigateBody.parse(request.body).url));

	app.get(routes.browserPorts, async (): Promise<ListeningPort[]> => browser.ports());

	app.get(routes.browserDownloads, async (): Promise<BrowserDownload[]> => browser.listDownloads());

	app.get<{ Params: { name: string } }>(`${routes.browserDownloads}/:name`, { config: { compress: false } }, async (request, reply) => {
		const found = browser.downloadFile(request.params.name);
		if (!found) throw ApiError.notFound("Download");
		return sendFile(request, reply, { abs: found.file, size: found.size, name: request.params.name, mimeType: "application/octet-stream", download: true });
	});

	// Uploads for a page's file chooser arrive as raw bytes in their own scope (no JSON parsing, never buffered).
	await app.register(async (upload) => {
		rawBodyScope(upload);
		upload.put<{ Params: { uploadId: string } }>(routes.browserUpload(":uploadId"), { bodyLimit: MAX_UPLOAD_BYTES }, async (request, reply) => {
			await browser.receiveUpload(request.params.uploadId, UploadQuery.parse(request.query).name, request.body as Readable);
			return reply.status(204).send();
		});
	});
}
