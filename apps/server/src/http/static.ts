import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import { sendNotFound } from "./error-handler.ts";

const IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * Serve the built web app: hashed assets (`/assets/*`) are cached forever, everything else revalidates, and
 * unknown non-API GET navigations fall back to `index.html` for the client-side router.
 */
export async function registerStaticWeb(app: FastifyInstance, webDistDir: string): Promise<void> {
	await app.register(fastifyStatic, {
		root: webDistDir,
		wildcard: false,
		index: ["index.html"],
		preCompressed: true,
		// Cache-Control is decided in setHeaders / below, never by the plugin default (max-age=0).
		cacheControl: false,
		setHeaders(res, filePath) {
			const normalized = filePath.split("\\").join("/");
			res.setHeader("Cache-Control", normalized.includes("/assets/") ? IMMUTABLE : "no-cache");
		},
	});
	// Real files under the dist root (assets, fonts, favicon, ...), via the wildcard-less static handler.
	app.get("/*", async (request, reply) => {
		const pathname = request.url.split("?")[0] ?? "/";
		if (pathname.startsWith("/api/") || pathname === "/api" || pathname === "/ws") return sendNotFound(request, reply);
		const relative = decodeURIComponent(pathname).replace(/^\/+/, "");
		// A path with an extension is a real asset request: a miss is a genuine 404, not a router URL.
		if (relative.includes(".") && !relative.endsWith("/")) {
			try {
				return await reply.sendFile(relative);
			} catch {
				return reply.status(404).send({ error: { code: "not_found", message: "File not found" } });
			}
		}
		return reply.header("Cache-Control", "no-cache").type("text/html; charset=utf-8").sendFile("index.html", join(webDistDir));
	});
}
