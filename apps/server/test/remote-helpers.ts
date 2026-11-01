import type { SecretStore } from "@clam/secret-store";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request, type IncomingHttpHeaders } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreviewServiceOptions } from "../src/preview/service.ts";
import { createFullHarness, type FullHarness } from "./full-harness.ts";
import { FakeTunnelManager } from "./fake-tunnel.ts";
import { FAST } from "./net-helpers.ts";

export const PUBLIC_HOST = "owner-test.trycloudflare.com";
export const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`;
export const PASSWORD = "correct horse battery staple";
export const INLINE_SCRIPT = "document.documentElement.dataset.boot = '1';";

/** The error envelope every non-2xx JSON answer uses. */
export interface ApiJson {
	error?: { code: string; message: string; details?: { retryAfterSeconds?: number } };
}

export interface Raw<T = ApiJson> {
	status: number;
	headers: IncomingHttpHeaders;
	text: string;
	json: T | undefined;
	/** Every `Set-Cookie` header. */
	cookies: string[];
}

export interface RawOptions {
	method?: string;
	path: string;
	/** Defaults to the node's public hostname (what cloudflared forwards). */
	host?: string;
	origin?: string | null;
	cookie?: string;
	ip?: string;
	body?: unknown;
	headers?: Record<string, string>;
}

/** One HTTP request to a node's PUBLIC listener, with full control of Host/Origin/Cookie/cf-connecting-ip. */
export function raw<T = ApiJson>(port: number, o: RawOptions): Promise<Raw<T>> {
	const { promise, resolve, reject } = Promise.withResolvers<Raw<T>>();
	const payload = o.body === undefined ? undefined : JSON.stringify(o.body);
	const headers: Record<string, string> = { Host: o.host ?? PUBLIC_HOST, ...(o.headers ?? {}) };
	if (o.origin !== null && o.origin !== undefined) headers.Origin = o.origin;
	if (o.cookie) headers.Cookie = o.cookie;
	if (o.ip) headers["cf-connecting-ip"] = o.ip;
	if (payload !== undefined) {
		headers["Content-Type"] = "application/json";
		headers["Content-Length"] = String(Buffer.byteLength(payload));
	}
	const req = request({ host: "127.0.0.1", port, method: o.method ?? "GET", path: o.path, headers, agent: false }, (res) => {
		const chunks: Buffer[] = [];
		res.on("data", (c: Buffer) => chunks.push(c));
		res.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8");
			let json: T | undefined;
			try {
				json = text ? (JSON.parse(text) as T) : undefined;
			} catch {
				json = undefined;
			}
			resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json, cookies: res.headers["set-cookie"] ?? [] });
		});
	});
	req.on("error", reject);
	req.end(payload);
	return promise;
}

/** `name=value` of a Set-Cookie line, for sending back. */
export const cookiePair = (setCookie: string): string => setCookie.split(";")[0] ?? "";

export interface WsHandshake {
	status: number;
	/** Present only when the server answered 101. */
	ws?: RawWs;
}

/** Minimal client frames: masked text out, unmasked frames in (text/close). */
export class RawWs {
	readonly texts: string[] = [];
	/** Binary frames received, in order. */
	readonly binaries: Buffer[] = [];
	closeCode: number | null = null;
	ended = false;
	private buffer = Buffer.alloc(0);
	private readonly waiters = new Set<() => void>();

	constructor(
		readonly socket: Socket,
		head: Buffer,
	) {
		socket.on("data", (chunk: Buffer) => this.feed(chunk));
		socket.on("close", () => {
			this.ended = true;
			this.wake();
		});
		socket.on("error", () => undefined);
		if (head.length) this.feed(head);
	}

	private wake(): void {
		for (const wake of [...this.waiters]) wake();
	}

	private feed(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		for (;;) {
			if (this.buffer.length < 2) return;
			const opcode = this.buffer[0]! & 0x0f;
			let length = this.buffer[1]! & 0x7f;
			let offset = 2;
			if (length === 126) {
				if (this.buffer.length < 4) return;
				length = this.buffer.readUInt16BE(2);
				offset = 4;
			} else if (length === 127) {
				if (this.buffer.length < 10) return;
				length = Number(this.buffer.readBigUInt64BE(2));
				offset = 10;
			}
			if (this.buffer.length < offset + length) return;
			const payload = this.buffer.subarray(offset, offset + length);
			this.buffer = this.buffer.subarray(offset + length);
			if (opcode === 0x1) this.texts.push(payload.toString("utf8"));
			if (opcode === 0x2) this.binaries.push(Buffer.from(payload));
			if (opcode === 0x8) this.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
			this.wake();
		}
	}

	send(message: unknown): void {
		this.frame(0x1, Buffer.from(JSON.stringify(message), "utf8"));
	}

	/** One masked binary frame (terminal input). */
	sendBinary(data: Buffer | string): void {
		this.frame(0x2, Buffer.from(data));
	}

	private frame(opcode: number, payload: Buffer): void {
		const mask = randomBytes(4);
		const first = 0x80 | opcode;
		const header = payload.length < 126 ? Buffer.from([first, 0x80 | payload.length]) : Buffer.from([first, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
		const masked = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]!));
		this.socket.write(Buffer.concat([header, mask, masked]));
	}

	/** The last few binary frames, decoded: cheap to poll while a large stream is still arriving. */
	get tail(): string {
		return Buffer.concat(this.binaries.slice(-4)).toString("utf8");
	}

	/** Everything received as binary frames, decoded. */
	get output(): string {
		return Buffer.concat(this.binaries).toString("utf8");
	}

	async until(done: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!done()) {
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
			const { promise, resolve } = Promise.withResolvers<void>();
			this.waiters.add(resolve);
			setTimeout(resolve, 50);
			await promise;
			this.waiters.delete(resolve);
		}
	}

	destroy(): void {
		this.socket.destroy();
	}
}

/** A WebSocket upgrade request to a node's public listener. */
export function wsUpgrade(port: number, o: { path?: string; host?: string; origin?: string | null; cookie?: string; ip?: string }): Promise<WsHandshake> {
	const { promise, resolve, reject } = Promise.withResolvers<WsHandshake>();
	const headers: Record<string, string> = {
		Host: o.host ?? PUBLIC_HOST,
		Connection: "Upgrade",
		Upgrade: "websocket",
		"Sec-WebSocket-Version": "13",
		"Sec-WebSocket-Key": randomBytes(16).toString("base64"),
	};
	if (o.origin !== null && o.origin !== undefined) headers.Origin = o.origin;
	if (o.cookie) headers.Cookie = o.cookie;
	if (o.ip) headers["cf-connecting-ip"] = o.ip;
	const req = request({ host: "127.0.0.1", port, path: o.path ?? "/ws", headers, agent: false });
	req.on("upgrade", (_res, socket, head) => resolve({ status: 101, ws: new RawWs(socket, head) }));
	req.on("response", (res) => {
		res.resume();
		res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
	});
	req.on("error", (error) => {
		// A server that drops the connection without answering is a refusal too.
		if ((error as NodeJS.ErrnoException).code === "ECONNRESET" || error.message.includes("socket hang up")) resolve({ status: 0 });
		else reject(error);
	});
	req.end();
	return promise;
}

export interface RemoteNode {
	n: FullHarness;
	fake: FakeTunnelManager;
	dist: string;
	/** The public listener's port. */
	port: number;
	cleanup(options?: { keepData?: boolean }): Promise<void>;
}

/** A full node with a (fake) quick tunnel that is already up at `PUBLIC_ORIGIN`, serving a tiny SPA from `dist`. */
export async function remoteNode(options: { dataDir?: string; secrets?: SecretStore; preview?: PreviewServiceOptions } = {}): Promise<RemoteNode> {
	const dist = mkdtempSync(join(tmpdir(), "clam-remote-dist-"));
	mkdirSync(join(dist, "assets"));
	writeFileSync(join(dist, "index.html"), `<!doctype html><html><head><script>${INLINE_SCRIPT}</script></head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>`);
	writeFileSync(join(dist, "assets", "app.js"), "console.log('spa')");
	const fake = new FakeTunnelManager();
	fake.url = PUBLIC_ORIGIN;
	const n = await createFullHarness({
		webDistDir: dist,
		dataDir: options.dataDir,
		secrets: options.secrets,
		preview: options.preview,
		network: { options: { ...FAST, createTunnelManager: () => fake, dnsWaitMs: 100 } },
	});
	// Quick tunnel up, exactly as a user would: configure, start.
	await fetch(`${n.url}/api/local/tunnel/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "quick" }) });
	await fetch(`${n.url}/api/local/tunnel/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
	return {
		n,
		fake,
		dist,
		port: n.netPort,
		async cleanup(cleanupOptions) {
			await n.cleanup(cleanupOptions);
			rmSync(dist, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
		},
	};
}
