import { Buffer } from "node:buffer";
import {
	API_PREFIX,
	ERROR_CODES,
	FORMAT,
	HEADER,
	PROTOCOL_VERSION,
	SSE_KEEPALIVE,
	contentDigest,
	decodeCursor,
	encodeCursor,
	encodeSseComment,
	encodeSseEvent,
	hasCapabilities,
	normalizePeerUrl,
	publicKeyToWire,
	ulid,
	verifyRequest,
	wire,
	type Signer,
} from "@clam/agent-network";
import { CAPABILITIES, type Capability } from "@clam/contracts";
import fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { ServerContext } from "../context.ts";
import { ApiError } from "../http/errors.ts";
import { installErrorHandler } from "../http/error-handler.ts";
import { installBoundedClose } from "../http/shutdown.ts";
import { registerUiSurface } from "../app.ts";
import { hostnameOf, isLocalHostHeader } from "../http/host-guard.ts";
import { HealthService } from "../services/health.ts";
import { readNodeSettings } from "../services/settings.ts";
import { NODE_STREAM } from "./events.ts";
import { localAgentsWire } from "./local-agents.ts";
import { registerTaskWireRoutes } from "./tasks-routes.ts";
import { registerSharedWireRoutes } from "./shared-routes.ts";
import { registerContextWireRoutes } from "./context-routes.ts";
import { registerHandoffWireRoutes } from "./handoff-routes.ts";
import type { NetworkBase, NetworkService } from "./types.ts";
import { errorText } from "./util.ts";

const EMPTY = Buffer.alloc(0);
/** JSON bodies on `/api/v1` are small (pairing, announce, tasks, messages); artifacts are only ever downloaded. */
const BODY_LIMIT = 1024 * 1024;
const KEEPALIVE_MS = 15_000;
const SECURITY_HEADER_NAMES = [HEADER.signature, HEADER.nodeId].map((name) => name.toLowerCase());

declare module "fastify" {
	interface FastifyRequest {
		/** Exact request body bytes, for the `Content-Digest` check. */
		rawBody: Buffer;
		/** Set by `authenticate`: the verified peer. */
		peer?: { id: string; capabilities: Capability[] };
		requestId: string;
	}
}

export interface ListenerDeps {
	base: NetworkBase;
	net: NetworkService;
	signer: Signer;
	/** Skew allowed between clocks, ms (default 60 s). */
	skewMs?: number;
	/** `GET /node/info` payload basics. */
	version: string;
}

/** The caller's address: Cloudflare's header when the request came through the local tunnel connector, else the socket peer. */
const sourceOf = (request: FastifyRequest): string => (request.headers["cf-connecting-ip"] as string | undefined) ?? request.ip;

const hostnamesOfPublicUrl = (net: NetworkService): string | null => net.tunnel.publicHostname();

/**
 * The network listener (the tunnel's origin): a second Fastify instance. `/api/v1/*` is the node-to-node protocol: signature
 * auth, never cookies. When a UI context is attached (`net.ui`) it ALSO mounts the owner web UI surface — the same
 * `registerUiSurface` the loopback listener uses — behind the owner-session gate (`auth/gate.ts`): every non-`/api/v1`
 * path stays a plain 404 until `remoteUiEnabled` is on, and with it on `/api/local/*` and `/ws` need a valid owner
 * session. Authenticated wire routes verify the peer's Ed25519 signature (`verifyRequest`), then the per-peer rate
 * limit, then the granted capabilities.
 */
export async function buildNetworkApp(deps: ListenerDeps): Promise<FastifyInstance> {
	const { base, net } = deps;
	const app = fastify({
		loggerInstance: base.log,
		logController: new LogController({ disableRequestLogging: true }),
		bodyLimit: BODY_LIMIT,
		// The tunnel's connector is a local process; client addresses from forwarded headers are never trusted.
		trustProxy: false,
	});
	const health = new HealthService({ db: base.db, ompCli: base.ompCli, runtime: base.runtime, startedAt: base.startedAt, bus: base.bus, log: base.log });
	// Also installs the plain 404 for every path outside /api/v1. Fastify's defaults (case-sensitive, no trailing-slash folding) keep signed paths exact.
	installErrorHandler(app);
	installBoundedClose(app);

	// Keep the exact bytes (the digest covers them); never fail before authentication on malformed JSON.
	app.removeAllContentTypeParsers();
	app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
		const bytes = body as Buffer;
		request.rawBody = bytes;
		if (bytes.length === 0) return done(null, undefined);
		try {
			done(null, JSON.parse(bytes.toString("utf8")));
		} catch {
			done(null, Symbol.for("clam.invalid-json"));
		}
	});

	app.addHook("onRequest", async (request, reply) => {
		// A WebSocket upgrade is only ever meant for the UI surface's sockets: `/ws` and the machine tools' `/ws/<tool>/…`. For anything
		// else keep what Node did before this listener had an upgrade handler: drop the connection without an answer.
		const upgrading = "upgrade" in request.raw && request.raw.upgrade === true;
		const upgradePath = (request.raw.url ?? "").split("?")[0] ?? "";
		if (upgrading && !(net.ui !== null && (upgradePath === "/ws" || upgradePath.startsWith("/ws/")))) {
			request.raw.socket.destroy();
			reply.hijack();
			return undefined;
		}
		if (upgrading) {
			// Any answer other than the handshake itself (bad Host, gate refusal, 404) leaves the upgraded socket open: end it once the answer is written.
			reply.header("connection", "close");
			reply.raw.once("finish", () => request.raw.socket.destroySoon());
		}
		request.rawBody = EMPTY;
		const supplied = request.headers["x-request-id"];
		request.requestId = typeof supplied === "string" && FORMAT.id.test(supplied) ? supplied : ulid();
		reply.header("X-Request-Id", request.requestId);
		const host = request.headers.host;
		const tunnelHost = hostnamesOfPublicUrl(net);
		const allowed = isLocalHostHeader(host) || (tunnelHost !== null && host !== undefined && hostnameOf(host) === hostnameOf(tunnelHost));
		if (!allowed) return reply.status(403).send({ error: { code: "forbidden_host", message: "Unexpected Host header" } });
		return undefined;
	});
	app.addHook("onSend", async (request, reply, payload) => {
		// The UI surface (owner web UI behind its session gate) sets its own headers, caching and compression; these are the wire protocol's.
		if (request.uiSurface) return payload;
		reply.header("X-Content-Type-Options", "nosniff");
		reply.header("Cache-Control", "no-store");
		const type = String(reply.getHeader("content-type") ?? "");
		if ((typeof payload === "string" || Buffer.isBuffer(payload)) && type.startsWith("application/json")) {
			reply.header("Content-Digest", contentDigest(Buffer.from(payload)));
		}
		return payload;
	});
	app.addHook("onResponse", async (request, reply) => {
		request.log.debug({ method: request.method, url: request.url.split("?")[0], status: reply.statusCode, requestId: request.requestId, peer: request.peer?.id }, "network request");
	});

	const bodyOf = <T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } }, request: FastifyRequest): T => {
		if (request.body === Symbol.for("clam.invalid-json")) throw ApiError.badRequest("The request body is not valid JSON");
		const parsed = schema.safeParse(request.body ?? {});
		if (!parsed.success) {
			throw ApiError.badRequest(parsed.error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join("; "));
		}
		return parsed.data;
	};

	/** Steps 1–8 of docs/agent-network-protocol.md §3; throws the `ApiError` to answer with. */
	async function authenticate(request: FastifyRequest, reply: FastifyReply, needed: Capability[]): Promise<void> {
		// Verification records every nonce it accepts, so someone who knows a peer id could flood `nonce_log`: cap each source first.
		const ipWait = net.ipBuckets.take(sourceOf(request));
		if (ipWait > 0) {
			reply.header("Retry-After", String(ipWait));
			throw new ApiError(429, ERROR_CODES.rateLimited, "Too many requests", { retryAfterSeconds: ipWait });
		}
		const raw = request.raw.url ?? request.url;
		const queryAt = raw.indexOf("?");
		const result = await verifyRequest(
			{
				method: request.method,
				path: queryAt === -1 ? raw : raw.slice(0, queryAt),
				rawQuery: queryAt === -1 ? "" : raw.slice(queryAt + 1),
				host: request.headers.host ?? "",
				headers: request.headers,
				bodyBytes: request.rawBody,
			},
			{ lookupPeer: (nodeId) => net.peers.lookupKey(nodeId), nonces: net.nonces, skewMs: deps.skewMs },
		);
		if (!result.ok) throw new ApiError(result.status, result.code, result.message, result.details);
		const waitSeconds = net.peerBuckets.take(result.peerId);
		if (waitSeconds > 0) {
			reply.header("Retry-After", String(waitSeconds));
			throw new ApiError(429, ERROR_CODES.rateLimited, "Too many requests", { retryAfterSeconds: waitSeconds });
		}
		const peer = net.peers.row(result.peerId);
		if (!peer || peer.status === "revoked") throw new ApiError(403, ERROR_CODES.peerRevoked, "peer has been revoked");
		const granted = peer.grantedCapabilities as Capability[];
		if (!hasCapabilities(granted, needed)) {
			const missing = needed.filter((c) => !granted.includes(c));
			throw new ApiError(403, ERROR_CODES.forbidden, `Missing capability: ${missing.join(", ")}`, { missing });
		}
		request.peer = { id: peer.id, capabilities: granted };
	}
	const requires = (...needed: Capability[]) => async (request: FastifyRequest, reply: FastifyReply) => authenticate(request, reply, needed);

	await app.register(
		async (api) => {
			// ------------------------------------------------------------------ GET /node/info (public)
			api.get("/node/info", async () => {
				const { identity } = base;
				return {
					protocolVersions: [PROTOCOL_VERSION],
					nodeId: identity.nodeId,
					name: readNodeSettings(base.db).nodeName,
					publicKey: publicKeyToWire(identity.publicKey),
					fingerprint: identity.fingerprint,
					appVersion: base.config.version,
					platform: process.platform,
					arch: process.arch,
					publicUrl: net.selfUrl(),
					capabilities: [...CAPABILITIES],
					runtimes: ["omp"],
					startedAt: base.startedAt.toISOString(),
				} satisfies wire.NodeInfo;
			});

			// ------------------------------------------------------------------ GET /node/health (public minimal / signed full)
			api.get("/node/health", async (request, reply) => {
				const signed = SECURITY_HEADER_NAMES.some((name) => request.headers[name] !== undefined);
				if (!signed) {
					let status: wire.HealthStatus = "ok";
					try {
						base.db.$client.prepare("select 1").get();
					} catch {
						status = "down";
					}
					return { status, time: Date.now() } satisfies wire.NodeHealthMinimal;
				}
				await authenticate(request, reply, []);
				const result = await health.check();
				const peer = net.peers.row(request.peer?.id ?? "");
				const taskCounts = net.tasks?.store.taskCounts() ?? { running: 0, queued: 0 };
				return {
					status: result.status,
					uptimeMs: Math.round(result.uptimeMs),
					time: Date.now(),
					activeRuntimes: result.activeRuntimes,
					maxConcurrentRuntimes: readNodeSettings(base.db).maxConcurrentRuntimes,
					runningTasks: taskCounts.running,
					queuedTasks: taskCounts.queued,
					checks: result.checks.map((c) => ({ name: c.name, status: c.status, ...(c.message !== undefined && { message: c.message.slice(0, 500) }) })),
					// Additive (protocol §13): lets a peer that cannot hold an event stream (quick tunnels buffer SSE) notice
					// an agent-list change and a capability change within one heartbeat.
					agentsRevision: net.agentsWatcher.revision(),
					grantedCapabilities: peer?.grantedCapabilities ?? [],
				} satisfies wire.NodeHealthFull & { agentsRevision: string; grantedCapabilities: unknown };
			});

			// ------------------------------------------------------------------ POST /node/pair (code proof / transcript signatures)
			api.post("/node/pair", async (request, reply) => {
				const wait = net.pairBuckets.take(sourceOf(request));
				if (wait > 0) {
					reply.header("Retry-After", String(wait));
					throw new ApiError(429, ERROR_CODES.rateLimited, "Too many pairing requests", { retryAfterSeconds: wait });
				}
				const body = bodyOf(wire.PairRequest, request);
				return net.pairing.handlePair(body);
			});

			// ------------------------------------------------------------------ GET /agents
			api.get("/agents", { preHandler: requires("agents.read") }, async () => localAgentsWire(base));

			// ------------------------------------------------------------------ POST /node/announce
			api.post("/node/announce", { preHandler: requires() }, async (request) => {
				const peerId = request.peer?.id as string;
				const body = bodyOf(wire.AnnounceBody, request);
				const url = normalizePeerUrl(body.url, { allowLoopbackHttp: base.config.allowLoopbackPeers });
				if (!url) throw ApiError.badRequest("url must be an https:// URL");
				const peer = net.peers.row(peerId);
				if (!peer) throw new ApiError(403, ERROR_CODES.peerRevoked, "peer has been revoked");
				if (url !== peer.url) {
					// Before ever sending a signed request to an address a peer names, check it really is that peer.
					try {
						const probe = await net.client.request<unknown>(url, { method: "GET", path: "/node/info", signed: false, retry: false, signal: AbortSignal.timeout(8_000) });
						const info = wire.NodeInfo.safeParse(probe.body);
						if (!info.success || info.data.nodeId !== peer.id || info.data.fingerprint !== peer.fingerprint) {
							throw new ApiError(409, "fingerprint_mismatch", "The announced address does not belong to this peer");
						}
					} catch (error) {
						if (error instanceof ApiError) throw error;
						throw new ApiError(502, "url_unreachable", `The announced address could not be verified: ${errorText(error)}`);
					}
				}
				net.peers.applyAnnounce(peerId, { url, name: body.name });
				return { ok: true } satisfies wire.OkResponse;
			});

			// ------------------------------------------------------------------ POST /node/revoke
			api.post("/node/revoke", { preHandler: requires() }, async (request) => {
				bodyOf(wire.RevokeBody, request);
				net.peers.revoke(request.peer?.id as string, "remote");
				return { ok: true } satisfies wire.OkResponse;
			});

			// ------------------------------------------------------------------ GET /events (SSE)
			api.get("/events", { preHandler: requires("events.read") }, async (request, reply) => {
				const peerId = request.peer?.id as string;
				const query = request.query as { stream?: string; cursor?: string };
				if (query.stream !== undefined && query.stream !== NODE_STREAM) throw ApiError.notFound("Stream");
				const cursorText = query.cursor ?? (request.headers["last-event-id"] as string | undefined);
				let after: number | null = null;
				if (cursorText) {
					const positions = decodeCursor(cursorText);
					if (!positions) throw ApiError.badRequest("Malformed event cursor");
					after = positions[NODE_STREAM] ?? 0;
				}

				reply.hijack();
				const raw = reply.raw;
				raw.writeHead(200, {
					"Content-Type": "text/event-stream; charset=utf-8",
					"Cache-Control": "no-store",
					"X-Accel-Buffering": "no",
					"X-Content-Type-Options": "nosniff",
					"X-Request-Id": request.requestId,
				});
				raw.socket?.setNoDelay(true);
				let closed = false;
				let unsubscribe: (() => void) | null = null;
				const finish = (): void => {
					if (closed) return;
					closed = true;
					unsubscribe?.();
					clearInterval(keepalive);
					forget();
					if (!raw.writableEnded) raw.end();
				};
				const write = (chunk: string): void => {
					if (!closed && !raw.writableEnded) raw.write(chunk);
				};
				const sendEvent = (e: { seq: number; type: string; payload: Record<string, unknown>; audience: string | null; at: string }): void => {
					const revoked = net.peers.row(peerId)?.status === "revoked";
					// A revoked peer gets nothing more, except the notice that it was revoked.
					if (revoked && !(e.type === "peer_revoked" && e.audience === peerId)) return;
					const payload = e.audience !== null && e.audience !== peerId ? {} : e.payload;
					write(
						encodeSseEvent({
							id: encodeCursor({ [NODE_STREAM]: e.seq }),
							event: e.type,
							data: { stream: NODE_STREAM, seq: e.seq, eventId: `evt_${NODE_STREAM}_${e.seq}`, at: e.at, correlationId: `corr_${NODE_STREAM}_${e.seq}`, type: e.type, payload },
						}),
					);
				};
				const keepalive = setInterval(() => write(SSE_KEEPALIVE), KEEPALIVE_MS);
				keepalive.unref();
				const forget = net.connections.add(peerId, { close: finish });
				raw.on("close", finish);
				write(encodeSseComment("open"));

				const bounds = net.events.bounds(NODE_STREAM);
				let from = after ?? bounds.last; // no cursor: start from now, history is not replayed
				if (after !== null && bounds.last > 0 && (after > bounds.last || after < bounds.first - 1)) {
					// We no longer hold the range the consumer asks for: tell it to refetch state instead of faking continuity.
					write(
						encodeSseEvent({
							id: encodeCursor({ [NODE_STREAM]: bounds.last }),
							event: "stream.reset",
							data: { stream: NODE_STREAM, seq: bounds.last, eventId: `evt_${NODE_STREAM}_reset_${bounds.last}`, at: new Date().toISOString(), correlationId: `corr_${NODE_STREAM}_reset`, type: "stream.reset", payload: {} },
						}),
					);
					from = bounds.last;
				}
				// Subscribe and replay in one synchronous section (SQLite is synchronous): no event can fall between them.
				let sent = from;
				const live = (e: Parameters<typeof sendEvent>[0]): void => {
					if (e.seq <= sent) return;
					sent = e.seq;
					sendEvent(e);
					if (e.type === "peer_revoked" && e.audience === peerId) finish();
				};
				unsubscribe = net.events.subscribe(NODE_STREAM, live);
				for (let batch = net.events.after(NODE_STREAM, from); batch.length > 0; batch = net.events.after(NODE_STREAM, sent)) {
					for (const e of batch) live(e);
				}
				return reply;
			});

			// ------------------------------------------------------------------ /tasks* (M4)
			if (net.tasks) registerTaskWireRoutes(api, { tasks: net.tasks, authenticate, requires, bodyOf });
			// ------------------------------------------------------------------ /shared* (M5)
			if (net.shared && net.tasks) registerSharedWireRoutes(api, { shared: net.shared, idempotency: net.tasks.idempotency, requires, bodyOf });
			// ------------------------------------------------------------------ /context* (M6)
			if (net.contexts && net.tasks) registerContextWireRoutes(api, { contexts: net.contexts, idempotency: net.tasks.idempotency, requires, bodyOf });
			// ------------------------------------------------------------------ /handoffs* (M7)
			if (net.handoffs && net.tasks) registerHandoffWireRoutes(api, { handoffs: net.handoffs, idempotency: net.tasks.idempotency, requires, bodyOf });
			// ── REGISTRATION POINT: further wire route sets (shared sessions, ...) are registered here, next to the tasks routes. ──
		},
		{ prefix: API_PREFIX },
	);
	// Owner web UI through this domain (off until `remoteUiEnabled`; see `auth/gate.ts`). Registered after `/api/v1`, in its own scope.
	if (net.ui) await registerUiSurface(app, net.ui, { remote: true });
	// Idle SSE sockets must not hold shutdown up.
	app.addHook("preClose", async () => net.connections.closeAll());
	return app;
}

