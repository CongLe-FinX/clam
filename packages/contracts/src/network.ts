import { z } from "zod";
import { I18nText, IsoDate } from "./common.ts";

/**
 * Local UI contracts for M3 (pairing, peers, agent directory, Cloudflare Tunnel).
 * The node-to-node wire protocol (`/api/v1`) is specified in docs/agent-network-protocol.md
 * and implemented by `@clam/agent-network`; these types are what the local web UI sees.
 */

export const CAPABILITIES = [
	"agents.read",
	"events.read",
	"tasks.send",
	"tasks.receive",
	"tasks.cancel",
	"context.sync",
	"artifacts.read",
	"artifacts.write",
	"handoff.send",
	"handoff.receive",
	/** Invite this node into shared sessions, mirror conversations, ship checkpoints/snapshots and hand over the driver role. */
	"sessions.share",
] as const;
export const Capability = z.enum(CAPABILITIES);
export type Capability = z.infer<typeof Capability>;
/** Granted to a new peer unless the user changes it (docs/agent-network-protocol.md §10). */
export const DEFAULT_PEER_CAPABILITIES: Capability[] = ["agents.read", "tasks.send", "tasks.receive", "events.read"];

export const PeerStatus = z.enum(["online", "degraded", "offline", "revoked"]);
export type PeerStatus = z.infer<typeof PeerStatus>;

export const Peer = z.object({
	/** The peer's node id (`node_…`). */
	id: z.string(),
	name: z.string(),
	fingerprint: z.string(),
	/** Base URL of the peer's `/api/v1` (its tunnel URL, or a loopback URL in dev). */
	url: z.string(),
	status: PeerStatus,
	/** What WE allow the peer to do on this node. */
	grantedCapabilities: z.array(Capability),
	/** What the peer allows US to do on it (as it told us at pairing / last update). */
	receivedCapabilities: z.array(Capability),
	/** Workspaces shared with this peer. */
	workspaceIds: z.array(z.string()),
	protocolVersion: z.number().int(),
	agentCount: z.number().int(),
	latencyMs: z.number().nullable(),
	lastSeenAt: IsoDate.nullable(),
	/** Last heartbeat/connection error, if the peer is not online. */
	lastError: z.string().nullable(),
	pairedAt: IsoDate,
	revokedAt: IsoDate.nullable(),
	revokedBy: z.enum(["local", "remote"]).nullable(),
	/** Receiver policy (M4): run tasks from this peer without a human accepting them on this node. */
	autoAcceptTasks: z.boolean(),
});
export type Peer = z.infer<typeof Peer>;
export const UpdatePeerBody = z.object({
	name: z.string().trim().min(1).max(64).optional(),
	grantedCapabilities: z.array(Capability).optional(),
	autoAcceptTasks: z.boolean().optional(),
});

// ---------------------------------------------------------------- invitations (inviter side, node A)

export const InvitationState = z.enum(["pending", "consumed", "expired", "revoked", "locked"]);
export const Invitation = z.object({
	id: z.string(),
	workspaceId: z.string(),
	capabilities: z.array(Capability),
	state: InvitationState,
	attempts: z.number().int(),
	expiresAt: IsoDate,
	createdAt: IsoDate,
	/** This node's public `/api/v1` base URL to share with the joiner; null while no tunnel is running. */
	url: z.string().nullable(),
	/** This node's fingerprint, to be compared by the joiner. */
	fingerprint: z.string(),
	/** Plain code — present ONLY in the response that created the invitation; never stored or listed. */
	code: z.string().optional(),
});
export type Invitation = z.infer<typeof Invitation>;
export const CreateInvitationBody = z.object({
	workspaceId: z.string().min(1),
	capabilities: z.array(Capability).default(DEFAULT_PEER_CAPABILITIES),
	ttlMinutes: z.number().int().min(1).max(10).default(10),
});

/** A joiner that proved possession of the code and waits for the local user's approval. */
export const PairingRequest = z.object({
	id: z.string(),
	invitationId: z.string(),
	workspaceId: z.string(),
	remote: z.object({ nodeId: z.string(), name: z.string(), fingerprint: z.string(), url: z.string() }),
	state: z.enum(["awaiting_approval", "confirming", "paired", "rejected", "expired", "failed"]),
	error: z.string().nullable(),
	requestedAt: IsoDate,
	updatedAt: IsoDate,
});
export type PairingRequest = z.infer<typeof PairingRequest>;
export const ApprovePairingBody = z.object({ capabilities: z.array(Capability) });

// ---------------------------------------------------------------- joining (joiner side, node B)

export const NodePreview = z.object({
	nodeId: z.string(),
	name: z.string(),
	fingerprint: z.string(),
	publicUrl: z.string().nullable(),
	version: z.string(),
	protocolVersions: z.array(z.number().int()),
});
export type NodePreview = z.infer<typeof NodePreview>;
export const JoinPreviewBody = z.object({ url: z.string().url() });
export const JoinBody = z.object({
	url: z.string().url(),
	code: z.string().trim().min(6).max(32),
	/** The fingerprint the user saw on the inviter; the server refuses to pair if the remote presents another key. */
	expectedFingerprint: z.string().min(16),
});

export const OutgoingPairing = z.object({
	id: z.string(),
	remote: NodePreview,
	url: z.string(),
	state: z.enum(["hello_sent", "awaiting_remote_approval", "paired", "rejected", "expired", "failed"]),
	workspaceId: z.string().nullable(),
	error: z.string().nullable(),
	createdAt: IsoDate,
	updatedAt: IsoDate,
});
export type OutgoingPairing = z.infer<typeof OutgoingPairing>;

// ---------------------------------------------------------------- agent directory

export const DirectoryAgent = z.object({
	nodeId: z.string(),
	nodeName: z.string(),
	/** "self" for this node's own agents. */
	nodeStatus: z.union([PeerStatus, z.literal("self")]),
	agentId: z.string(),
	name: z.string(),
	role: z.string(),
	runtime: z.string(),
	capabilities: z.array(z.string()),
	status: z.enum(["online", "busy", "offline"]),
	activeSessions: z.number().int(),
	/** When this entry was last refreshed from the peer (own agents: now). */
	fetchedAt: IsoDate,
});
export type DirectoryAgent = z.infer<typeof DirectoryAgent>;

// ---------------------------------------------------------------- Cloudflare Tunnel

export const TunnelMode = z.enum(["off", "quick", "named"]);
export type TunnelMode = z.infer<typeof TunnelMode>;

export const TunnelState = z.object({
	cloudflared: z.object({ installed: z.boolean(), version: z.string().nullable(), binaryPath: z.string().nullable() }),
	config: z.object({
		mode: TunnelMode,
		/** Public hostname routed to this node in the Cloudflare dashboard (named mode). */
		hostname: z.string().nullable(),
		/** Whether a named-tunnel token is stored in the secret store (the token itself is never returned). */
		hasToken: z.boolean(),
		/** Start the tunnel when the server boots. */
		autoStart: z.boolean(),
	}),
	state: z.enum(["stopped", "starting", "running", "reconnecting", "error"]),
	/** HTTPS base URL peers use to reach this node's `/api/v1`. */
	publicUrl: z.string().nullable(),
	/**
	 * Named mode only: CLAM's own connector is not running, yet `https://<hostname>/api/v1/node/info` answered with THIS node's id and
	 * fingerprint — another cloudflared (on this machine or network) serves the route. Then `publicUrl` is `https://<hostname>`.
	 */
	externalConnector: z.boolean(),
	pid: z.number().nullable(),
	/** Active edge connections reported by cloudflared. */
	connections: z.number().int(),
	lastError: z.string().nullable(),
	/** Structured twin of `lastError` for localisation; absent when the error is cloudflared's own output. */
	lastErrorI18n: I18nText.nullable().optional(),
	startedAt: IsoDate.nullable(),
	/** The loopback listener that serves ONLY `/api/v1` and that the tunnel points at. */
	networkListener: z.object({ host: z.string(), port: z.number().int() }),
});
export type TunnelState = z.infer<typeof TunnelState>;
export const UpdateTunnelConfigBody = z.object({
	mode: TunnelMode,
	hostname: z.string().trim().min(1).nullable().optional(),
	/** Write-only. Omit to keep the stored token; null to delete it. */
	token: z.string().trim().min(20).nullable().optional(),
	autoStart: z.boolean().optional(),
});

/** Events on topic `network`. */
export type NetworkEvent =
	| { type: "peer"; peer: Peer }
	| { type: "invitation"; invitation: Invitation }
	| { type: "pairing_request"; request: PairingRequest }
	| { type: "join"; pairing: OutgoingPairing }
	| { type: "directory_changed" };

/** Events on topic `tunnel`. */
export type TunnelEvent = { type: "state"; state: TunnelState };
