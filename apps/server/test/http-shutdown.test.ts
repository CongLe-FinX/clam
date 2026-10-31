import { once } from "node:events";
import { connect } from "node:net";
import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { installBoundedClose } from "../src/http/shutdown.ts";

/**
 * Stopping a node must not wait on clients: a connection that is still mid-request when `close()` starts (a stalled
 * upload through the tunnel, a response still in flight) would otherwise hold the server open until Node's request
 * timeout (minutes). `close()` gives it the grace period, then cuts it.
 */
describe("installBoundedClose", () => {
	it("close() finishes within the grace period while a client is stuck mid-request", async () => {
		const app = fastify();
		installBoundedClose(app, 300);
		let received!: () => void;
		const headersParsed = new Promise<void>((resolve) => (received = resolve));
		app.addHook("onRequest", async () => received());
		app.post("/upload", async () => ({ ok: true }));
		await app.listen({ port: 0, host: "127.0.0.1" });
		const { port } = app.server.address() as { port: number };

		const socket = connect(port, "127.0.0.1");
		await once(socket, "connect");
		// The headers promise 100 bytes, only 10 arrive: the request never completes on its own.
		socket.write("POST /upload HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/octet-stream\r\nContent-Length: 100\r\n\r\n0123456789");
		await headersParsed;

		const started = Date.now();
		await app.close();
		const elapsed = Date.now() - started;
		socket.destroy();
		expect(elapsed).toBeGreaterThanOrEqual(250);
		expect(elapsed).toBeLessThan(3_000);
	});
});
