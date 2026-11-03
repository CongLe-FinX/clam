import compress from "@fastify/compress";
import { LOCAL_API_PREFIX } from "@clam/contracts";
import fastify, { LogController, type FastifyInstance } from "fastify";
import type { ServerContext } from "./context.ts";
import accessRoutes from "./api/access.ts";
import browserRoutes from "./api/browser.ts";
import agentRoutes from "./api/agents.ts";
import contextRoutes from "./api/contexts.ts";
import handoffRoutes from "./api/handoffs.ts";
import fsRoutes from "./api/fs.ts";
import githubRoutes from "./api/github.ts";
import gitRoutes from "./api/git.ts";
import networkRoutes from "./api/network.ts";
import nodeRoutes from "./api/node.ts";
import systemRoutes from "./api/system.ts";
import ompRoutes from "./api/omp.ts";
import previewRoutes from "./api/preview.ts";
import projectFileRoutes from "./api/project-files.ts";
import projectRoutes from "./api/projects.ts";
import sessionRoutes from "./api/sessions.ts";
import sharedRoutes from "./api/shared.ts";
import meshUsageRoutes from "./api/usage-mesh.ts";
import usageProviderRoutes from "./api/usage-provider.ts";
import taskRoutes from "./api/tasks.ts";
import terminalRoutes from "./api/terminal.ts";
import workspaceRoutes from "./api/workspaces.ts";
import { installLoopbackGate, installRemoteGate } from "./auth/gate.ts";
import { installErrorHandler, sendNotFound } from "./http/error-handler.ts";
import { installHostGuard } from "./http/host-guard.ts";
import { installBoundedClose } from "./http/shutdown.ts";
import { registerStaticWeb } from "./http/static.ts";
import { registerWebSocketHub } from "./ws/hub.ts";
import { registerTerminalSocket } from "./ws/terminal.ts";
import { registerBrowserSocket } from "./ws/browser.ts";

/** JSON bodies of the UI API (file writes, prompts with attachments). The wire listener's own limit is smaller and applies only to `/api/v1`. */
const UI_BODY_LIMIT = 2 * 1024 * 1024;

/**
 * Route plugins of the local UI API, registered under `/api/local` on EVERY UI surface (the loopback UI listener and the
 * public listener behind the owner-session gate).
 * ── REGISTRATION POINT: add a feature's `/api/local` routes here (one import above, one entry below). ──
 */
const LOCAL_API_PLUGINS = [
	accessRoutes,
	nodeRoutes,
	systemRoutes,
	workspaceRoutes,
	projectRoutes,
	projectFileRoutes,
	fsRoutes,
	agentRoutes,
	sessionRoutes,
	ompRoutes,
	meshUsageRoutes,
	usageProviderRoutes,
	githubRoutes,
	gitRoutes,
	networkRoutes,
	taskRoutes,
	sharedRoutes,
	contextRoutes,
	handoffRoutes,
	terminalRoutes,
	browserRoutes,
	previewRoutes,
];

/**
 * Mount the whole web-facing surface — `/ws`, every `/api/local` route plugin and the static web app, compressed — into
 * an encapsulated scope of `app`. The SAME code serves both listeners:
 *  - `remote: false` — the loopback UI listener (no login; its host/origin policy is `installHostGuard` on that app);
 *  - `remote: true`  — the public listener (tunnel origin), which keeps `/api/v1` and adds this surface behind the
 *    owner-session gate (`auth/gate.ts`): off by default, 404 everywhere while `remoteUiEnabled` is false.
 * The scope owns its content-type parser, body limit, headers and compression, so mounting it never changes how `/api/v1` behaves.
 */
export async function registerUiSurface(app: FastifyInstance, ctx: ServerContext, options: { remote: boolean }): Promise<void> {
	await app.register(async (ui) => {
		// Bodyless POSTs (abort, stop, restart, ...) are commonly sent with a JSON content type: treat an empty body as "no body".
		ui.removeContentTypeParser("application/json");
		ui.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
			if (body === "") return done(null, undefined);
			try {
				done(null, JSON.parse(body as string));
			} catch (error) {
				done(Object.assign(error as Error, { statusCode: 400 }), undefined);
			}
		});
		// Some clients/proxies label an empty POST with another type (e.g. `application/x-www-form-urlencoded`): still "no body".
		// Any other non-empty payload keeps Fastify's 415; route scopes with their own parsers (uploads) are unaffected.
		ui.addContentTypeParser("*", { parseAs: "buffer" }, (request, body, done) => {
			if ((body as Buffer).length === 0) return done(null, undefined);
			done(Object.assign(new Error(`Unsupported Media Type: ${request.headers["content-type"] ?? ""}`), { statusCode: 415, code: "FST_ERR_CTP_INVALID_MEDIA_TYPE" }), undefined);
		});
		ui.addHook("onRoute", (route) => {
			route.bodyLimit ??= UI_BODY_LIMIT;
		});
		if (options.remote) installRemoteGate(ui, ctx);
		else installLoopbackGate(ui);

		await ui.register(compress, { global: true, threshold: 1024, encodings: ["br", "gzip"] });
		await registerWebSocketHub(ui, ctx);
		registerTerminalSocket(ui, ctx);
		registerBrowserSocket(ui, ctx);
		for (const plugin of LOCAL_API_PLUGINS) await ui.register(plugin, { prefix: LOCAL_API_PREFIX, ctx });
		if (options.remote) {
			// An unknown `/api/local/*` must be as invisible to a signed-out caller as a real one: the gate answers 401 before this 404.
			ui.all(`${LOCAL_API_PREFIX}/*`, async (request, reply) => sendNotFound(request, reply));
		}
		if (ctx.config.webDistDir) await registerStaticWeb(ui, ctx.config.webDistDir);
	});
}

/**
 * Assemble the loopback UI listener's Fastify app around a fully built `ServerContext`: security guard, error
 * envelope, request logging and the UI surface (`registerUiSurface`).
 */
export async function buildApp(ctx: ServerContext): Promise<FastifyInstance> {
	const app = fastify({
		loggerInstance: ctx.log,
		// Per-request logging is emitted at debug level by the onResponse hook below.
		logController: new LogController({ disableRequestLogging: true }),
		bodyLimit: UI_BODY_LIMIT,
		// Behind no proxy in M1: trust nothing, and never derive the client address from forwarded headers.
		trustProxy: false,
	});

	installHostGuard(app);
	installErrorHandler(app);
	installBoundedClose(app);
	app.addHook("onSend", async (_request, reply) => {
		reply.header("X-Content-Type-Options", "nosniff");
		reply.header("Referrer-Policy", "no-referrer");
		if (!reply.hasHeader("Content-Security-Policy")) reply.header("Content-Security-Policy", "frame-ancestors 'none'");
		return undefined;
	});
	app.addHook("onResponse", async (request, reply) => {
		if (request.url !== "/ws") request.log.debug({ method: request.method, url: request.url, status: reply.statusCode, ms: Math.round(reply.elapsedTime) }, "request");
	});

	await registerUiSurface(app, ctx, { remote: false });
	return app;
}
