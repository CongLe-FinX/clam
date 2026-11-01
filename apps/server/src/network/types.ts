import type { NetworkClient } from "@clam/agent-network";
import type { Peer } from "@clam/contracts";
import type { ServerContext } from "../context.ts";
import type { ConnectionRegistry } from "./connections.ts";
import type { DirectoryService } from "./directory.ts";
import type { NetworkEventLog } from "./events.ts";
import type { InvitationService } from "./invitations.ts";
import type { LocalAgentsWatcher } from "./local-agents.ts";
import type { PeerMonitor } from "./monitor.ts";
import type { SqliteNonceStore } from "./nonce-store.ts";
import type { PairingService } from "./pairing.ts";
import type { PeerService } from "./peers.ts";
import type { TokenBuckets } from "./rate-limit.ts";
import type { TunnelService } from "./tunnel.ts";
import type { TaskService } from "../tasks/service.ts";
import type { SharedService } from "../shared/service.ts";
import type { ContextService } from "../context/service.ts";
import type { HandoffService } from "../handoff/service.ts";

/** What the network services are built from: the server context before `network` exists. */
export type NetworkBase = Omit<ServerContext, "network" | "access" | "sessions" | "turnOutputs" | "gitService" | "hostTools" | "tasks" | "shared" | "contexts" | "handoffs" | "terminals" | "browser" | "preview">;

/**
 * Everything the agent network is made of. Lives on `ServerContext.network`; the `/api/local` routes use the
 * services, the `/api/v1` listener uses them to authenticate and answer peers.
 */
export interface NetworkService {
	readonly events: NetworkEventLog;
	readonly client: NetworkClient;
	readonly tunnel: TunnelService;
	readonly peers: PeerService;
	readonly invitations: InvitationService;
	readonly pairing: PairingService;
	readonly directory: DirectoryService;
	readonly monitor: PeerMonitor;
	readonly nonces: SqliteNonceStore;
	readonly connections: ConnectionRegistry;
	readonly agentsWatcher: LocalAgentsWatcher;
	/** Per-peer request budget of the signed endpoints. */
	readonly peerBuckets: TokenBuckets;
	/** Budget per source address, charged BEFORE signature verification (verification records nonces). */
	readonly ipBuckets: TokenBuckets;
	/** Budget of the unauthenticated pairing endpoint. */
	readonly pairBuckets: TokenBuckets;
	/** Address peers should use to reach this node: the tunnel's public URL, or (dev) the loopback listener. Null when unreachable. */
	selfUrl(): string | null;
	/** An agent was added/edited: notify peers (`agents_changed`). */
	localAgentsChanged(): void;
	/** Revoke a peer: refuse it from this instant, then (best effort, in the background) tell it with a signed `/node/revoke`. */
	revokePeer(peerId: string): Promise<Peer>;
	/** Tell every peer our current URL and name (signed `/node/announce`). */
	announceSelf(): Promise<void>;
	/** The task engine serving `/api/v1/tasks*`; null until `attachTasks` (the listener then answers 404 for them). */
	readonly tasks: TaskService | null;
	/** Connect the task engine; call before `listen()` so the listener registers the task endpoints. */
	attachTasks(tasks: TaskService): void;
	/** The shared-session service serving `/api/v1/shared*`; null until `attachShared` (the listener then answers 404 for them). */
	readonly shared: SharedService | null;
	/** Connect the shared-session service; call before `listen()` so the listener registers its endpoints. */
	attachShared(shared: SharedService): void;
	/** The context service serving `/api/v1/context*`; null until `attachContexts` (the listener then answers 404 for them). */
	readonly contexts: ContextService | null;
	/** Connect the context service; call before `listen()` so the listener registers its endpoints. */
	attachContexts(contexts: ContextService): void;
	/** The handoff service serving `/api/v1/handoffs*`; null until `attachHandoffs` (the listener then answers 404 for them). */
	readonly handoffs: HandoffService | null;
	/** Connect the handoff service; call before `listen()` so the listener registers its endpoints. */
	attachHandoffs(handoffs: HandoffService): void;
	/** The server context whose owner web UI the public listener also serves (behind the owner-session gate); null = `/api/v1` only. */
	readonly ui: ServerContext | null;
	/** Connect the UI surface; call before `listen()` so the listener mounts it. */
	attachUi(ctx: ServerContext): void;
	/** Bind the `/api/v1` listener and start heartbeat, pairing housekeeping and the tunnel auto-start. */
	listen(): Promise<{ host: string; port: number }>;
	/** Stop everything this service started. */
	close(): Promise<void>;
}
