import { request, type IncomingMessage, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { pipeline } from "node:stream";
import { rewriteRequestHeaders, rewriteResponseHeaders, type RewriteContext } from "./rewrite.ts";
import type { UpstreamAddress } from "./upstream.ts";

/** What the proxy needs to talk to one previewed app. */
export interface ProxyTarget {
	address: UpstreamAddress;
	/** Path + query to ask the app for (`PreviewRoute.upstreamUrl`). */
	path: string;
	context: RewriteContext;
	/** A renewed preview-session cookie to add to the answer (sliding expiry). */
	setCookie?: string | undefined;
	/** Called with the function that tears the exchange down; returns its unregister (the owner session's end closes live exchanges). */
	track?: (close: () => void) => () => void;
}

/** Called when the upstream cannot be reached before any byte went to the browser. */
export type UpstreamFailure = (error: Error) => void;

/**
 * Reverse-proxy one HTTP exchange to `127.0.0.1:<port>` (or `[::1]`): the request body streams up, the response streams back
 * as it arrives (chunked bodies and server-sent events are never buffered). Hop-by-hop headers are dropped and the headers go
 * through `rewrite.ts`.
 */
export function proxyHttp(req: IncomingMessage, res: ServerResponse, target: ProxyTarget, onFailure: UpstreamFailure): void {
	const { context } = target;
	const upstream = request({
		host: target.address,
		port: context.port,
		method: req.method,
		path: target.path,
		headers: rewriteRequestHeaders(req.headers, context, { upgrade: false }),
		agent: false,
		setHost: false,
	});
	const untrack = target.track?.(() => {
		upstream.destroy();
		res.destroy();
	});
	const finish = (): void => untrack?.();
	res.once("close", () => {
		finish();
		upstream.destroy();
	});
	req.socket.setNoDelay(true);
	upstream.once("response", (answer) => {
		const headers = rewriteResponseHeaders(answer.headers, context);
		if (target.setCookie) headers["set-cookie"] = [...(Array.isArray(headers["set-cookie"]) ? headers["set-cookie"] : []), target.setCookie];
		res.writeHead(answer.statusCode ?? 502, answer.statusMessage, headers);
		res.flushHeaders();
		pipeline(answer, res, () => undefined);
	});
	upstream.once("error", (error) => {
		finish();
		if (res.headersSent) res.destroy(error);
		else onFailure(error);
	});
	pipeline(req, upstream, () => undefined);
}

/** `HTTP/1.1 101 Switching Protocols` + the header lines, as the bytes a raw socket needs. */
function rawHead(statusLine: string, headers: Array<[string, string]>): string {
	return `${statusLine}\r\n${headers.map(([name, value]) => `${name}: ${value}\r\n`).join("")}\r\n`;
}

/** Plain-text refusal of a WebSocket handshake on a raw socket. */
export function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
	const body = reason;
	socket.end(rawHead(`HTTP/1.1 ${status} ${reason}`, [["Connection", "close"], ["Content-Type", "text/plain; charset=utf-8"], ["Content-Length", String(Buffer.byteLength(body))], ["Cache-Control", "no-store"]]) + body);
}

/**
 * Proxy a WebSocket upgrade: replay the handshake upstream (Host/Origin rewritten), relay the 101 and then the bytes both ways
 * (no frame parsing, so HMR sockets, compression extensions and subprotocols work unchanged). A non-101 answer is relayed as the
 * refusal it is.
 */
export function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, target: ProxyTarget): void {
	const { context } = target;
	socket.on("error", () => socket.destroy());
	if (socket instanceof Socket) socket.setNoDelay(true);
	const upstream = request({
		host: target.address,
		port: context.port,
		method: req.method,
		path: target.path,
		headers: rewriteRequestHeaders(req.headers, context, { upgrade: true }),
		agent: false,
		setHost: false,
	});
	let untrack: (() => void) | undefined;
	const close = (): void => {
		untrack?.();
		upstream.destroy();
		socket.destroy();
	};
	untrack = target.track?.(close);
	socket.once("close", close);
	upstream.once("upgrade", (answer, upstreamSocket, upstreamHead) => {
		upstreamSocket.on("error", close);
		upstreamSocket.setNoDelay(true);
		const headers: Array<[string, string]> = [];
		for (let i = 0; i + 1 < answer.rawHeaders.length; i += 2) headers.push([answer.rawHeaders[i] as string, answer.rawHeaders[i + 1] as string]);
		socket.write(rawHead(`HTTP/1.1 ${answer.statusCode ?? 101} ${answer.statusMessage ?? "Switching Protocols"}`, headers));
		if (upstreamHead.length > 0) socket.write(upstreamHead);
		if (head.length > 0) upstreamSocket.write(head);
		upstreamSocket.once("close", close);
		socket.pipe(upstreamSocket);
		upstreamSocket.pipe(socket);
	});
	upstream.once("response", (answer) => {
		// The app refused the upgrade (404, 401, …): tell the browser the same, then end.
		const headers: Array<[string, string]> = [];
		for (const [name, value] of Object.entries(rewriteResponseHeaders(answer.headers, context))) {
			for (const one of Array.isArray(value) ? value : [value]) if (one !== undefined) headers.push([name, String(one)]);
		}
		headers.push(["Connection", "close"]);
		socket.write(rawHead(`HTTP/1.1 ${answer.statusCode ?? 502} ${answer.statusMessage ?? ""}`.trim(), headers));
		pipeline(answer, socket, () => close());
	});
	upstream.once("error", () => {
		if (socket.writable && !socket.destroyed) rejectUpgrade(socket, 502, "Bad Gateway");
		close();
	});
	upstream.end();
}
