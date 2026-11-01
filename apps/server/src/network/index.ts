import { Resolver } from "node:dns/promises";
import { join } from "node:path";
import { NetworkClient, signerFromIdentity, wire } from "@clam/agent-network";
import type { TunnelManager } from "@clam/cloudflare-tunnel";
import type { FastifyInstance } from "fastify";
import { readNodeSettings } from "../services/settings.ts";
import { ConnectionRegistry } from "./connections.ts";
import { DirectoryService } from "./directory.ts";
import { NetworkEventLog } from "./events.ts";
import { InvitationService } from "./invitations.ts";
import { buildNetworkApp } from "./listener.ts";
import { LocalAgentsWatcher } from "./local-agents.ts";
import { PeerMonitor, type MonitorOptions } from "./monitor.ts";
import { SqliteNonceStore } from "./nonce-store.ts";
import { PairingService } from "./pairing.ts";
import { PeerService } from "./peers.ts";
import { TokenBuckets } from "./rate-limit.ts";
import type { TaskService } from "../tasks/service.ts";
import type { SharedService } from "../shared/service.ts";
import type { ContextService } from "../context/service.ts";
import type { HandoffService } from "../handoff/service.ts";
import type { ServerContext } from "../context.ts";
import { TunnelService } from "./tunnel.ts";
import type { NetworkBase, NetworkService } from "./types.ts";
import { errorText } from "./util.ts";

export type { NetworkBase, NetworkService } from "./types.ts";

export interface NetworkOptions {
	/** `cloudflared` executable (`CLAM_CLOUDFLARED_BIN`). */
	cloudflaredBinary?: string;
	/** Test seam: a stand-in for the cloudflared process manager. */
	createTunnelManager?: (o: { originUrl: string; runtimeDir: string; binary?: string; log: { info(o: object, m?: string): void; warn(o: object, m?: string): void } }) => TunnelManager;
	monitor?: Partial<MonitorOptions>;
	/** Housekeeping period of pending pairings (default 5 s). */
	pairingTickMs?: number;
	/** How long an approved pairing waits before re-sending its confirm to an unreachable joiner (default 10 s). */
	confirmRetryMs?: number;
	/** Timeout of heartbeat and directory requests (default 8 s). */
	probeTimeoutMs?: number;
	/** Per-peer token bucket of the signed endpoints (default burst 120, 30/s). */
	peerRateLimit?: { capacity: number; perSecond: number };
	/** Clock skew tolerated on signed requests (default 60 s). */
	skewMs?: number;
	/** How long a freshly started tunnel's hostname may take to resolve before peers are told about it anyway (default 90 s). */
	dnsWaitMs?: number;
	/** Test seam: HTTP client of the named tunnel's external-connector probe (default: global `fetch`). */
	tunnelFetch?: typeof fetch;
	/** Period of that probe while a named tunnel is not running (default 60 s). */
	externalProbeMs?: number;
	/** Timeout of one probe request (default 5 s). */
	externalProbeTimeoutMs?: number;
}

/** A new quick-tunnel hostname can take a while to appear in DNS, and a lookup that comes too early may be negatively cached by the OS. */
async function waitUntilResolvable(hostname: string, timeoutMs: number): Promise<void> {
	if (hostname === "localhost" || /^[\d.]+$/.test(hostname) || hostname.startsWith("[")) return;
	// c-ares (dns.Resolver) asks the DNS servers directly and so does not touch the OS resolver cache that real requests use.
	const resolver = new Resolver({ timeout: 2000, tries: 1 });
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			if ((await resolver.resolve4(hostname)).length > 0) return;
		} catch {
			// not there yet
		}
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}
}

/**
 * Build the agent-network services (events, nonces, peers, pairing, tunnel, heartbeat, directory). Nothing runs until
 * `listen()`; the object is safe to create for contexts that never serve `/api/v1`.
 */
export function createNetwork(base: NetworkBase, options: NetworkOptions = {}): NetworkService {
	const { db, identity, log, bus, config } = base;
	const nodeName = (): string => readNodeSettings(db).nodeName;
	const signer = signerFromIdentity(identity);
	const client = new NetworkClient({ signer, allowLoopbackHttp: config.allowLoopbackPeers });
	// Heartbeats and directory reads must fail fast: a stalled peer is a missed beat, not a 30 s hang.
	const probeClient = new NetworkClient({ signer, allowLoopbackHttp: config.allowLoopbackPeers, timeoutMs: options.probeTimeoutMs ?? 8_000 });
	const events = new NetworkEventLog(db);
	const nonces = new SqliteNonceStore(db);
	const connections = new ConnectionRegistry();
	const peers = new PeerService({ db, bus, events, nodeId: identity.nodeId });

	const tunnel = new TunnelService({
		db,
		secrets: base.secrets,
		bus,
		log,
		nodeId: identity.nodeId,
		fingerprint: identity.fingerprint,
		fetch: options.tunnelFetch,
		externalProbeMs: options.externalProbeMs,
		externalProbeTimeoutMs: options.externalProbeTimeoutMs,
		runtimeDir: join(config.dataDir, "run"),
		binary: options.cloudflaredBinary,
		createManager: options.createTunnelManager,
		networkListener: () => ({ host: config.networkHost, port: config.networkPort }),
	});
	const selfUrl = (): string | null => tunnel.publicUrl() ?? (config.allowLoopbackPeers && config.networkPort > 0 ? `http://${config.networkHost.includes(":") ? `[${config.networkHost}]` : config.networkHost}:${config.networkPort}` : null);

	const invitations = new InvitationService({ db, secrets: base.secrets, bus, fingerprint: identity.fingerprint, selfUrl });
	const directory = new DirectoryService({ db, bus, client: probeClient, peers, local: base, nodeId: identity.nodeId, nodeName, log });
	let attachedTasks: TaskService | null = null;
	let attachedShared: SharedService | null = null;
	let attachedContexts: ContextService | null = null;
	let attachedHandoffs: HandoffService | null = null;
	let attachedUi: ServerContext | null = null;
	const monitor = new PeerMonitor({
		client,
		probeClient,
		nodeId: identity.nodeId,
		peers,
		directory,
		log,
		options: options.monitor,
		// SSE accelerator: a `task.updated` frame makes the sender poll that task now (polling stays authoritative).
		onTaskUpdated: (taskId) => {
			if (taskId) void attachedTasks?.sender.syncTask(taskId);
		},
	});
	const pairing = new PairingService({
		db,
		bus,
		log,
		identity,
		signer,
		// Joining against a dead address must fail in seconds, not after the 30 s default timeout times the retries.
		client: probeClient,
		peers,
		invitations,
		selfUrl,
		nodeName,
		allowLoopbackPeers: config.allowLoopbackPeers,
		confirmRetryMs: options.confirmRetryMs,
		onPaired: (peerId) => monitor.watch(peerId),
	});
	const agentsWatcher = new LocalAgentsWatcher({ db, runtime: base.runtime, omp: base.omp, bus, events });

	let app: FastifyInstance | null = null;
	let offTunnel: (() => void) | null = null;
	let announceRun = 0;

	const announceSelf = async (): Promise<void> => {
		const url = selfUrl();
		if (!url) return;
		const run = ++announceRun;
		const hostname = new URL(url).hostname;
		await waitUntilResolvable(hostname, options.dnsWaitMs ?? 90_000);
		if (run !== announceRun) return; // a newer URL superseded this one while DNS settled
		await Promise.allSettled(
			peers.activeRows().map(async (peer) => {
				try {
					await client.request(peer.url, {
						method: "POST",
						path: "/node/announce",
						body: { url, name: nodeName() } satisfies wire.AnnounceBody,
						// The peer verifies the new address before accepting it, which can lag a fresh hostname: keep trying for minutes.
						retry: { attempts: 8, baseDelayMs: 2_000, maxDelayMs: 30_000 },
					});
					log.info({ peerId: peer.id }, "announced our address to the peer");
				} catch (error) {
					log.warn({ peerId: peer.id, err: errorText(error) }, "could not announce our address to the peer");
				}
			}),
		);
	};

	const service: NetworkService = {
		events,
		client,
		tunnel,
		peers,
		invitations,
		pairing,
		directory,
		monitor,
		nonces,
		connections,
		agentsWatcher,
		peerBuckets: new TokenBuckets(options.peerRateLimit?.capacity ?? 120, options.peerRateLimit?.perSecond ?? 30),
		ipBuckets: new TokenBuckets(600, 100),
		pairBuckets: new TokenBuckets(10, 0.5),
		selfUrl,
		localAgentsChanged: () => agentsWatcher.schedule(),
		announceSelf,
		get tasks() {
			return attachedTasks;
		},
		attachTasks(tasks) {
			attachedTasks = tasks;
		},
		get shared() {
			return attachedShared;
		},
		attachShared(shared) {
			attachedShared = shared;
		},
		get contexts() {
			return attachedContexts;
		},
		attachContexts(contexts) {
			attachedContexts = contexts;
		},
		get handoffs() {
			return attachedHandoffs;
		},
		attachHandoffs(handoffs) {
			attachedHandoffs = handoffs;
		},
		get ui() {
			return attachedUi;
		},
		attachUi(ctx) {
			attachedUi = ctx;
		},

		async revokePeer(peerId) {
			const before = peers.row(peerId);
			const peer = peers.revoke(peerId, "local");
			// The local cut-off above is what matters and is already in force; the notice only spares the peer a confusing timeout.
			if (before && before.status !== "revoked") {
				void client
					.request(before.url, { method: "POST", path: "/node/revoke", body: { reason: "revoked by the other node's user" } satisfies wire.RevokeBody, retry: { attempts: 4, baseDelayMs: 1_000, maxDelayMs: 10_000 } })
					.catch((error) => log.warn({ peerId, err: errorText(error) }, "could not notify the peer about the revocation"));
			}
			return peer;
		},

		async listen() {
			if (app) throw new Error("The network listener is already running");
			app = await buildNetworkApp({ base, net: service, signer, version: config.version, skewMs: options.skewMs });
			try {
				await app.listen({ host: config.networkHost, port: config.networkPort });
			} catch (error) {
				await app.close();
				app = null;
				if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
					throw new Error(`Port ${config.networkPort} on ${config.networkHost} is already in use. Set CLAM_NETWORK_PORT to use another one.`);
				}
				throw error;
			}
			config.networkPort = (app.server.address() as { port: number }).port;
			nonces.startPruning();
			pairing.start(options.pairingTickMs);
			agentsWatcher.start();
			monitor.start();
			offTunnel = tunnel.onPublicUrlChange((url) => {
				if (url) void announceSelf();
			});
			void tunnel.autoStart();
			return { host: config.networkHost, port: config.networkPort };
		},

		async close() {
			offTunnel?.();
			offTunnel = null;
			announceRun++;
			agentsWatcher.stop();
			pairing.stop();
			nonces.stop();
			await monitor.stop();
			await tunnel.dispose();
			if (app) {
				const closing = app;
				app = null;
				// Peers keep HTTP connections open (keep-alive pools, event streams); do not let them hold shutdown up.
				const force = setTimeout(() => closing.server.closeAllConnections(), 500);
				try {
					await closing.close();
				} finally {
					clearTimeout(force);
				}
			}
		},
	};
	return service;
}
