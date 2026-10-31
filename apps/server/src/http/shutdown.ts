import type { FastifyInstance } from "fastify";

/** How long `close()` lets in-flight responses finish before cutting every remaining connection. */
export const CLOSE_GRACE_MS = 2_000;

/**
 * Bound `app.close()`.
 *
 * Fastify closes keep-alive connections that are idle when `close()` starts, but a connection that was still busy at
 * that moment (a response being written, a hook still running) stays open after it goes idle until the keep-alive
 * timeout (72 s) expires, so stopping the node could hang for over a minute. This gives in-flight requests
 * `graceMs` to finish, then destroys every connection that is still open.
 */
export function installBoundedClose(app: FastifyInstance, graceMs = CLOSE_GRACE_MS): void {
	let timer: NodeJS.Timeout | undefined;
	app.addHook("preClose", (done) => {
		timer = setTimeout(() => app.server.closeAllConnections(), graceMs);
		timer.unref();
		done();
	});
	app.addHook("onClose", (_instance, done) => {
		clearTimeout(timer);
		done();
	});
}
