import {
	API_PREFIX,
	NetworkError,
	deriveCodeKey,
	generatePairingNonce,
	helloProofParts,
	invitationIdFromCode,
	normalizeInvitationCode,
	normalizePeerUrl,
	pairingProof,
	publicKeyToBase64,
	publicKeyToWire,
	replyProofParts,
	signTranscript,
	transcriptHash,
	verifyPairingProof,
	verifyTranscript,
	wire,
	type NetworkClient,
	type Signer,
} from "@clam/agent-network";
import {
	CAPABILITIES,
	DEFAULT_PEER_CAPABILITIES,
	type Capability,
	type JoinBody,
	type NodePreview,
	type OutgoingPairing,
	type PairingRequest,
} from "@clam/contracts";
import { pairingInvitations, pairingJoins, pairingRequests, workspaceMembers, workspaces } from "@clam/database";
import type { ClamDb } from "@clam/database";
import { fingerprintOfPublicKey, nodeIdFromFingerprint, type NodeIdentity } from "@clam/node-identity";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";
import type { EventBus } from "../context.ts";
import { ApiError } from "../http/errors.ts";
import type { InvitationService } from "./invitations.ts";
import type { PeerService } from "./peers.ts";
import { KeyedLock, errorText, normalizeFingerprint } from "./util.ts";

type RequestRow = typeof pairingRequests.$inferSelect;
type JoinRow = typeof pairingJoins.$inferSelect;

/** A rejection is signed over a transcript whose capability list can never be a real grant. */
const REJECTED_MARKER = ["rejected"];
const RESOLVED_HISTORY = 25;
/** The inviter keeps retrying an approved-but-unconfirmed pairing this long past the invitation's expiry. */
const CONFIRM_GRACE_MS = 10 * 60_000;
const CONFIRM_RETRY_MS = 10_000;
const JOIN_FIRST_ATTEMPT = { attempts: 3, baseDelayMs: 400, maxDelayMs: 3000 } as const;
const CONFIRM_ATTEMPTS = { attempts: 3, baseDelayMs: 500, maxDelayMs: 4000 } as const;

const notFound = () => new ApiError(404, "not_found", "Not found");

export interface PairingServiceDeps {
	db: ClamDb;
	bus: EventBus;
	log: { info(o: object, m?: string): void; warn(o: object, m?: string): void };
	identity: NodeIdentity;
	signer: Signer;
	client: NetworkClient;
	peers: PeerService;
	invitations: InvitationService;
	selfUrl(): string | null;
	nodeName(): string;
	allowLoopbackPeers: boolean;
	/** Delay before re-sending a confirm the joiner did not answer (default 10 s). */
	confirmRetryMs?: number;
	/** A peer was just pinned: start monitoring it. */
	onPaired(peerId: string): void;
	now?: () => number;
}

function isCapability(value: string): value is Capability {
	return (CAPABILITIES as readonly string[]).includes(value);
}

function capabilitiesOf(values: readonly string[]): Capability[] {
	const out = [...new Set(values)];
	const invalid = out.find((v) => !isCapability(v));
	if (invalid !== undefined) throw ApiError.badRequest(`Unknown capability "${invalid.slice(0, 64)}"`);
	return out as Capability[];
}

/** Maps a failed call to a remote node onto the local API's error envelope. */
function remoteError(error: unknown, what: string): ApiError {
	if (error instanceof NetworkError) {
		if (error.status === 404) return new ApiError(422, "invitation_rejected", "The invitation code is wrong, expired, locked or already used");
		if (error.code === "invalid_peer_url") return ApiError.badRequest(error.message);
		return new ApiError(502, "peer_unreachable", `${what}: ${error.message}`, { code: error.code, status: error.status });
	}
	return error instanceof ApiError ? error : new ApiError(502, "peer_unreachable", `${what}: ${errorText(error)}`);
}

/**
 * The pairing handshake (docs/agent-network-protocol.md §11) for both roles.
 *
 * Inviter: `handleHello` (proof-authenticated, attempt-limited, uniform 404) → request waits for the user →
 * `approve`/`reject` → signed confirm to the joiner → both pin keys. Joiner: `preview` → `join` (fingerprint check,
 * hello, verify the inviter's proof) → waits → `handleConfirm` when the inviter's confirm arrives.
 * Every step is persisted so a restart resumes where it stopped; the invitation code is never stored.
 */
export class PairingService {
	private readonly now: () => number;
	private readonly locks = new KeyedLock();
	private readonly lastConfirmAttempt = new Map<string, number>();
	private timer: NodeJS.Timeout | null = null;

	constructor(private readonly deps: PairingServiceDeps) {
		this.now = deps.now ?? Date.now;
	}

	// ------------------------------------------------------------------------------------------ lifecycle

	/** Resume interrupted handshakes and keep expiring/retrying while the process runs. */
	start(intervalMs = 5_000): void {
		// The joiner's hello was sent but its answer (and the code needed to verify it) is gone: the user must join again.
		const interrupted = this.deps.db.select().from(pairingJoins).where(eq(pairingJoins.state, "hello_sent")).all();
		for (const row of interrupted) this.failJoin(row.id, "Interrupted by a restart; join again with the invitation code");
		void this.tick();
		this.timer = setInterval(() => void this.tick(), intervalMs);
		this.timer.unref();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	/** One housekeeping pass: expire what ran out of time, retry approved pairings that could not reach the joiner. */
	async tick(): Promise<void> {
		try {
			await this.deps.invitations.sweep();
			const now = this.now();
			for (const row of this.deps.db.select().from(pairingJoins).where(inArray(pairingJoins.state, ["hello_sent", "awaiting_remote_approval"])).all()) {
				if (Date.parse(row.expiresAt) <= now) this.setJoinState(row.id, "expired", "The invitation expired before the other node approved it");
			}
			for (const row of this.deps.db.select().from(pairingRequests).where(inArray(pairingRequests.state, ["awaiting_approval", "confirming"])).all()) {
				const invitation = this.deps.invitations.row(row.invitationId);
				const expiresAt = invitation ? Date.parse(invitation.expiresAt) : 0;
				if (row.state === "awaiting_approval" && expiresAt <= now) {
					this.setRequestState(row.id, "expired", "The invitation expired before it was approved");
					await this.deps.invitations.finish(row.invitationId, "expired");
				} else if (row.state === "confirming") {
					if (now > expiresAt + CONFIRM_GRACE_MS) {
						this.setRequestState(row.id, "failed", "The other node could not be reached to complete pairing");
						continue;
					}
					if (now - (this.lastConfirmAttempt.get(row.id) ?? 0) >= (this.deps.confirmRetryMs ?? CONFIRM_RETRY_MS)) await this.confirmWithJoiner(row.id);
				}
			}
		} catch (error) {
			this.deps.log.warn({ err: errorText(error) }, "pairing housekeeping failed");
		}
	}

	// ------------------------------------------------------------------------------------------ mapping

	private requestState(row: RequestRow): PairingRequest["state"] {
		if (row.state === "awaiting_approval") {
			const invitation = this.deps.invitations.row(row.invitationId);
			if (!invitation || Date.parse(invitation.expiresAt) <= this.now()) return "expired";
		}
		return row.state as PairingRequest["state"];
	}

	toPairingRequest(row: RequestRow): PairingRequest {
		return {
			id: row.id,
			invitationId: row.invitationId,
			workspaceId: row.workspaceId,
			remote: { nodeId: row.remoteNodeId, name: row.remoteName, fingerprint: row.remoteFingerprint, url: row.remoteUrl },
			state: this.requestState(row),
			error: row.error,
			requestedAt: row.requestedAt,
			updatedAt: row.updatedAt,
		};
	}

	toOutgoing(row: JoinRow): OutgoingPairing {
		const state = (row.state === "hello_sent" || row.state === "awaiting_remote_approval") && Date.parse(row.expiresAt) <= this.now() ? "expired" : row.state;
		return {
			id: row.id,
			remote: row.remotePreview as NodePreview,
			url: row.url,
			state: state as OutgoingPairing["state"],
			workspaceId: row.workspaceId,
			error: row.error,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		};
	}

	listRequests(): PairingRequest[] {
		const rows = this.deps.db.select().from(pairingRequests).orderBy(desc(pairingRequests.requestedAt)).limit(RESOLVED_HISTORY * 2).all();
		return rows.map((row) => this.toPairingRequest(row));
	}

	listJoins(): OutgoingPairing[] {
		return this.deps.db.select().from(pairingJoins).orderBy(desc(pairingJoins.createdAt)).limit(RESOLVED_HISTORY).all().map((row) => this.toOutgoing(row));
	}

	private requestRow(id: string): RequestRow {
		const row = this.deps.db.select().from(pairingRequests).where(eq(pairingRequests.id, id)).get();
		if (!row) throw ApiError.notFound("Pairing request");
		return row;
	}

	private publishRequest(id: string): void {
		const row = this.deps.db.select().from(pairingRequests).where(eq(pairingRequests.id, id)).get();
		if (row) this.deps.bus.publish("network", { type: "pairing_request", request: this.toPairingRequest(row) });
	}

	private publishJoin(id: string): void {
		const row = this.deps.db.select().from(pairingJoins).where(eq(pairingJoins.id, id)).get();
		if (row) this.deps.bus.publish("network", { type: "join", pairing: this.toOutgoing(row) });
	}

	private setRequestState(id: string, state: RequestRow["state"], error: string | null, extra: Partial<typeof pairingRequests.$inferInsert> = {}): void {
		this.deps.db.update(pairingRequests).set({ state, error, updatedAt: new Date(this.now()).toISOString(), ...extra }).where(eq(pairingRequests.id, id)).run();
		this.publishRequest(id);
	}

	private setJoinState(id: string, state: JoinRow["state"], error: string | null, extra: Partial<typeof pairingJoins.$inferInsert> = {}): void {
		this.deps.db.update(pairingJoins).set({ state, error, updatedAt: new Date(this.now()).toISOString(), ...extra }).where(eq(pairingJoins.id, id)).run();
		this.publishJoin(id);
	}

	private failJoin(id: string, error: string): void {
		this.setJoinState(id, "failed", error);
	}

	// ------------------------------------------------------------------------------------------ dispatch

	/** `POST /api/v1/node/pair` (unauthenticated by headers: authenticated by the code proof or the transcript signature). */
	async handlePair(request: wire.PairRequest): Promise<unknown> {
		return request.step === "hello" ? this.handleHello(request) : this.handleConfirm(request);
	}

	// ------------------------------------------------------------------------------------------ inviter

	async handleHello(req: wire.PairHelloRequest): Promise<wire.PairHelloResponse> {
		return this.locks.run(req.invitationId, async () => {
			const { db, invitations, identity } = this.deps;
			const invitation = invitations.row(req.invitationId);
			if (!invitation) throw notFound();

			const existing = db.select().from(pairingRequests).where(eq(pairingRequests.invitationId, invitation.id)).get();
			if (existing) {
				// The same hello retried (the answer was lost in transit) gets the same answer; anything else is "not found".
				const sameJoiner = existing.remoteNodeId === req.node.nodeId && existing.nonceJoiner === req.nonce;
				if (sameJoiner && (existing.state === "awaiting_approval" || existing.state === "confirming")) return existing.helloResponse as wire.PairHelloResponse;
				throw notFound();
			}
			if (invitations.stateOf(invitation) !== "pending") throw notFound();

			// Counted before it is checked: a crash or a timeout never hands out a free guess.
			invitations.registerAttempt(invitation.id);
			const codeKey = await invitations.loadCodeKey(invitation.id);
			const proofOk =
				codeKey !== null &&
				verifyPairingProof(
					codeKey,
					"hello",
					helloProofParts({ invitationId: invitation.id, inviterId: identity.nodeId, joinerId: req.node.nodeId, joinerPub: req.node.publicKey, nonceJoiner: req.nonce }),
					req.proof,
				);
			if (!proofOk || !codeKey) {
				await invitations.lockIfExhausted(invitation.id);
				invitations.publish(invitation.id);
				throw notFound();
			}

			// From here on the joiner has proven it knows the code, so specific errors are not an oracle.
			const joinerUrl = normalizePeerUrl(req.node.publicUrl, { allowLoopbackHttp: this.deps.allowLoopbackPeers });
			if (!joinerUrl) throw ApiError.badRequest("node.publicUrl must be an https:// URL");
			const known = this.deps.peers.row(req.node.nodeId);
			if (known && known.status !== "revoked") throw ApiError.conflict("This node is already paired");
			const workspace = db.select().from(workspaces).where(eq(workspaces.id, invitation.workspaceId)).get();
			if (!workspace) throw notFound();
			const publicUrl = this.deps.selfUrl();
			if (!publicUrl) throw ApiError.unavailable("This node has no public URL (start its tunnel) and cannot complete pairing");

			const nonceInviter = generatePairingNonce();
			const reply = wire.PairHelloResponse.parse({
				step: "hello",
				node: { nodeId: identity.nodeId, name: this.deps.nodeName(), publicKey: publicKeyToWire(identity.publicKey), publicUrl },
				nonce: nonceInviter,
				proof: pairingProof(
					codeKey,
					"reply",
					replyProofParts({
						invitationId: invitation.id,
						inviterId: identity.nodeId,
						inviterPub: identity.publicKey,
						joinerId: req.node.nodeId,
						joinerPub: req.node.publicKey,
						nonceJoiner: req.nonce,
						nonceInviter,
					}),
				),
				status: "pending_user_approval",
				workspaceId: workspace.id,
				workspaceName: workspace.name,
				expiresAt: invitation.expiresAt,
			});
			const id = `prq_${nonceInviter.slice(0, 16).replace(/[^A-Za-z0-9]/g, "x")}`;
			const nowIso = new Date(this.now()).toISOString();
			db.insert(pairingRequests)
				.values({
					id,
					invitationId: invitation.id,
					workspaceId: workspace.id,
					remoteNodeId: req.node.nodeId,
					remoteName: req.node.name,
					remotePublicKey: publicKeyToBase64(req.node.publicKey),
					remoteFingerprint: fingerprintOfPublicKey(publicKeyToBase64(req.node.publicKey)),
					remoteUrl: joinerUrl,
					nonceInviter,
					nonceJoiner: req.nonce,
					helloResponse: reply,
					state: "awaiting_approval",
					correlationId: `pair_${invitation.id}`,
					requestedAt: nowIso,
					updatedAt: nowIso,
				})
				.run();
			// The code key's only job was this proof; the rest of the handshake is signatures.
			await invitations.dropCodeKey(invitation.id);
			invitations.publish(invitation.id);
			this.publishRequest(id);
			return reply;
		});
	}

	/** The user of this (inviter) node approves with the capabilities to grant, then the signed confirm goes to the joiner. */
	async approve(requestId: string, capabilitiesInput: readonly string[]): Promise<PairingRequest> {
		const capabilities = capabilitiesOf(capabilitiesInput);
		const row = this.requestRow(requestId);
		const state = this.requestState(row);
		if (state === "expired") {
			this.setRequestState(row.id, "expired", "The invitation expired before it was approved");
			throw new ApiError(409, "pairing_expired", "This pairing request expired; create a new invitation");
		}
		if (state !== "awaiting_approval") throw ApiError.conflict(`This pairing request is already ${state}`);
		// Re-pairing a revoked peer: its old row would refuse the peer's very first signed request (see forgetRevoked).
		this.deps.peers.forgetRevoked(row.remoteNodeId);
		this.setRequestState(row.id, "confirming", null, { capabilities });
		await this.confirmWithJoiner(row.id);
		return this.toPairingRequest(this.requestRow(row.id));
	}

	async reject(requestId: string): Promise<PairingRequest> {
		const row = this.requestRow(requestId);
		const state = this.requestState(row);
		if (state !== "awaiting_approval") throw ApiError.conflict(`This pairing request is already ${state}`);
		this.setRequestState(row.id, "rejected", null);
		await this.deps.invitations.finish(row.invitationId, "revoked");
		void this.notifyRejection(row.id);
		return this.toPairingRequest(this.requestRow(row.id));
	}

	private transcriptFor(row: RequestRow, capabilities: readonly string[]): Uint8Array {
		return transcriptHash({
			inviterId: this.deps.identity.nodeId,
			inviterPub: this.deps.identity.publicKey,
			joinerId: row.remoteNodeId,
			joinerPub: row.remotePublicKey,
			nonceInviter: row.nonceInviter,
			nonceJoiner: row.nonceJoiner,
			invitationId: row.invitationId,
			capabilities: [...capabilities],
		});
	}

	/** Best effort: tell the joiner the user said no (signed, so nobody else can cancel its wait). */
	private async notifyRejection(requestId: string): Promise<void> {
		const row = this.requestRow(requestId);
		try {
			await this.deps.client.request(row.remoteUrl, {
				method: "POST",
				path: "/node/pair",
				signed: false,
				body: {
					step: "confirm",
					invitationId: row.invitationId,
					status: "rejected",
					capabilities: [],
					signature: signTranscript(this.deps.signer, this.transcriptFor(row, REJECTED_MARKER)),
					reason: "The other node's user rejected the pairing request",
				},
				idempotencyKey: `pair-reject-${row.id}`,
				correlationId: row.correlationId,
				retry: CONFIRM_ATTEMPTS,
			});
		} catch (error) {
			this.deps.log.warn({ err: errorText(error), requestId }, "could not tell the joiner about the rejection");
		}
	}

	/**
	 * Send the signed confirm and, on the joiner's counter-signature, pin it. A permanent refusal fails the pairing; an
	 * unreachable joiner leaves it `confirming` for the housekeeping loop to retry.
	 */
	private async confirmWithJoiner(requestId: string): Promise<void> {
		await this.locks.run(`confirm:${requestId}`, async () => {
			const row = this.requestRow(requestId);
			if (row.state !== "confirming" || !row.capabilities) return;
			this.lastConfirmAttempt.set(row.id, this.now());
			const capabilities = row.capabilities;
			const hash = this.transcriptFor(row, capabilities);
			let response: wire.PairConfirmResponse;
			try {
				const result = await this.deps.client.request<unknown>(row.remoteUrl, {
					method: "POST",
					path: "/node/pair",
					signed: false,
					body: {
						step: "confirm",
						invitationId: row.invitationId,
						status: "approved",
						capabilities,
						signature: signTranscript(this.deps.signer, hash),
					},
					idempotencyKey: `pair-confirm-${row.id}`,
					correlationId: row.correlationId,
					retry: CONFIRM_ATTEMPTS,
				});
				const parsed = wire.PairConfirmResponse.safeParse(result.body);
				if (!parsed.success) throw new NetworkError("The other node answered the confirmation with an unexpected payload", { code: "invalid_response", status: result.status });
				response = parsed.data;
			} catch (error) {
				const permanent = error instanceof NetworkError && !error.retryable && error.status !== null;
				const message = error instanceof NetworkError ? error.message : errorText(error);
				if (permanent) this.setRequestState(row.id, "failed", `The other node refused to complete pairing: ${message}`);
				else this.setRequestState(row.id, "confirming", `Could not reach the other node yet (${message}); retrying`);
				return;
			}
			if (!verifyTranscript(row.remotePublicKey, hash, response.signature)) {
				this.setRequestState(row.id, "failed", "The other node's confirmation signature is invalid");
				return;
			}
			const received = response.grantedCapabilities.filter(isCapability);
			this.deps.db.transaction((tx) => {
				this.deps.peers.addPaired(
					{
						id: row.remoteNodeId,
						name: row.remoteName,
						fingerprint: row.remoteFingerprint,
						publicKey: row.remotePublicKey,
						keyId: row.remoteFingerprint.slice(0, 16),
						url: row.remoteUrl,
						grantedCapabilities: capabilities as Capability[],
						receivedCapabilities: received,
						workspaceId: row.workspaceId,
						role: "member",
					},
					tx,
				);
				tx.update(pairingInvitations).set({ state: "consumed", consumedAt: new Date(this.now()).toISOString(), consumedBy: row.remoteNodeId }).where(eq(pairingInvitations.id, row.invitationId)).run();
				tx.update(pairingRequests).set({ state: "paired", error: null, updatedAt: new Date(this.now()).toISOString() }).where(eq(pairingRequests.id, row.id)).run();
			});
			await this.deps.invitations.dropCodeKey(row.invitationId);
			this.deps.invitations.publish(row.invitationId);
			this.publishRequest(row.id);
			this.deps.bus.publish("network", { type: "directory_changed" });
			this.deps.onPaired(row.remoteNodeId);
		});
	}

	// ------------------------------------------------------------------------------------------ joiner

	/** `GET /node/info` of the inviter, with its self-consistency verified (node id and fingerprint derive from the key). */
	private async fetchNodeInfo(baseUrl: string): Promise<wire.NodeInfo> {
		let body: unknown;
		try {
			body = (await this.deps.client.request<unknown>(baseUrl, { method: "GET", path: "/node/info", signed: false, retry: { attempts: 2, baseDelayMs: 300, maxDelayMs: 1500 } })).body;
		} catch (error) {
			throw remoteError(error, `Could not reach ${baseUrl}`);
		}
		const parsed = wire.NodeInfo.safeParse(body);
		if (!parsed.success) throw new ApiError(502, "peer_invalid_response", "That address does not look like a CL Agent Mesh node");
		if (!parsed.data.protocolVersions.includes(1)) {
			throw new ApiError(409, "unsupported_version", `That node speaks protocol versions ${parsed.data.protocolVersions.join(", ")}; this node speaks 1`);
		}
		return parsed.data;
	}

	private normalizeUrl(url: string): string {
		const origin = normalizePeerUrl(url, { allowLoopbackHttp: this.deps.allowLoopbackPeers });
		if (!origin) {
			throw ApiError.badRequest(
				this.deps.allowLoopbackPeers ? "The node address must be an https:// URL" : "The node address must be an https:// URL (plain http is only allowed for loopback with CLAM_ALLOW_LOOPBACK_PEERS=1)",
			);
		}
		return origin;
	}

	/** Step 1 of joining: show the user which node (and fingerprint) the address belongs to, before any secret is used. */
	async preview(url: string): Promise<NodePreview> {
		const info = await this.fetchNodeInfo(this.normalizeUrl(url));
		return { nodeId: info.nodeId, name: info.name, fingerprint: info.fingerprint, publicUrl: info.publicUrl, version: info.appVersion, protocolVersions: info.protocolVersions };
	}

	async join(body: z.infer<typeof JoinBody>): Promise<OutgoingPairing> {
		const { db, identity } = this.deps;
		const url = this.normalizeUrl(body.url);
		let invitationId: string;
		let codeKey: Uint8Array;
		try {
			const code = normalizeInvitationCode(body.code);
			invitationId = invitationIdFromCode(code);
			codeKey = deriveCodeKey(code, invitationId);
		} catch {
			throw ApiError.badRequest("That is not a valid invitation code (8 letters and digits, e.g. ABCD-EFGH)");
		}
		const expected = normalizeFingerprint(body.expectedFingerprint);
		if (expected.length !== 64) throw ApiError.badRequest("expectedFingerprint must be the inviter's full SHA-256 fingerprint (64 hex characters)");

		const info = await this.fetchNodeInfo(url);
		if (info.fingerprint !== expected) {
			throw new ApiError(409, "fingerprint_mismatch", "The node at that address presented a different fingerprint than the one you verified. Pairing was not attempted.", {
				presented: info.fingerprint,
			});
		}
		if (info.nodeId === identity.nodeId) throw ApiError.badRequest("That address is this node");
		const known = this.deps.peers.row(info.nodeId);
		if (known && known.status !== "revoked") throw ApiError.conflict("This node is already paired");
		const publicUrl = this.deps.selfUrl();
		if (!publicUrl) throw new ApiError(409, "no_public_url", "Start the Cloudflare Tunnel first: the other node must be able to reach this one to finish pairing");
		const active = db.select().from(pairingJoins).where(and(eq(pairingJoins.invitationId, invitationId), inArray(pairingJoins.state, ["hello_sent", "awaiting_remote_approval"]))).get();
		if (active && Date.parse(active.expiresAt) > this.now()) throw ApiError.conflict("A join with this invitation is already in progress");

		const nonceJoiner = generatePairingNonce();
		const id = `join_${nonceJoiner.slice(0, 16).replace(/[^A-Za-z0-9]/g, "x")}`;
		const nowMs = this.now();
		const nowIso = new Date(nowMs).toISOString();
		const infoPublicKey = publicKeyToBase64(info.publicKey);
		const preview: NodePreview = { nodeId: info.nodeId, name: info.name, fingerprint: info.fingerprint, publicUrl: info.publicUrl, version: info.appVersion, protocolVersions: info.protocolVersions };
		db.insert(pairingJoins)
			.values({
				id,
				url,
				invitationId,
				remoteNodeId: info.nodeId,
				remoteName: info.name,
				remotePublicKey: infoPublicKey,
				remoteFingerprint: info.fingerprint,
				remotePreview: preview,
				nonceJoiner,
				grantedCapabilities: DEFAULT_PEER_CAPABILITIES,
				state: "hello_sent",
				correlationId: `pair_${invitationId}`,
				expiresAt: new Date(nowMs + 10 * 60_000).toISOString(),
				createdAt: nowIso,
				updatedAt: nowIso,
			})
			.run();
		this.publishJoin(id);

		let reply: wire.PairHelloResponse;
		try {
			const result = await this.deps.client.request<unknown>(url, {
				method: "POST",
				path: "/node/pair",
				signed: false,
				body: {
					step: "hello",
					invitationId,
					node: { nodeId: identity.nodeId, name: this.deps.nodeName(), publicKey: publicKeyToWire(identity.publicKey), publicUrl },
					nonce: nonceJoiner,
					proof: pairingProof(codeKey, "hello", helloProofParts({ invitationId, inviterId: info.nodeId, joinerId: identity.nodeId, joinerPub: identity.publicKey, nonceJoiner })),
				},
				idempotencyKey: `pair-hello-${id}`,
				correlationId: `pair_${invitationId}`,
				retry: JOIN_FIRST_ATTEMPT,
			});
			const parsed = wire.PairHelloResponse.safeParse(result.body);
			if (!parsed.success) throw new ApiError(502, "peer_invalid_response", "The other node answered the pairing request with an unexpected payload");
			reply = parsed.data;
		} catch (error) {
			const mapped = remoteError(error, "Pairing request failed");
			this.failJoin(id, mapped.message);
			throw mapped;
		}

		// The inviter must prove it knows the code too (mutual possession) and must be the node whose fingerprint was verified.
		const sameNode = reply.node.nodeId === info.nodeId && publicKeyToBase64(reply.node.publicKey) === infoPublicKey;
		const proofOk =
			sameNode &&
			verifyPairingProof(
				codeKey,
				"reply",
				replyProofParts({ invitationId, inviterId: info.nodeId, inviterPub: infoPublicKey, joinerId: identity.nodeId, joinerPub: identity.publicKey, nonceJoiner, nonceInviter: reply.nonce }),
				reply.proof,
			);
		if (!proofOk) {
			const message = "The other node could not prove it knows the invitation code. Pairing was aborted: do not retry with this address.";
			this.failJoin(id, message);
			throw new ApiError(422, "inviter_proof_invalid", message);
		}
		this.setJoinState(id, "awaiting_remote_approval", null, {
			nonceInviter: reply.nonce,
			workspaceId: reply.workspaceId,
			workspaceName: reply.workspaceName,
			expiresAt: reply.expiresAt,
		});
		return this.toOutgoing(db.select().from(pairingJoins).where(eq(pairingJoins.id, id)).get() as JoinRow);
	}

	/** The inviter's signed confirm (or rejection) arrives on our network listener. */
	async handleConfirm(req: wire.PairConfirmRequest): Promise<unknown> {
		const row = this.deps.db.select().from(pairingJoins).where(eq(pairingJoins.invitationId, req.invitationId)).orderBy(desc(pairingJoins.createdAt)).get();
		if (!row || !row.nonceInviter) throw notFound();
		return this.locks.run(`join:${row.id}`, async () => {
			const fresh = this.deps.db.select().from(pairingJoins).where(eq(pairingJoins.id, row.id)).get();
			if (!fresh || !fresh.nonceInviter) throw notFound();
			const hashFor = (capabilities: readonly string[]) =>
				transcriptHash({
					inviterId: fresh.remoteNodeId,
					inviterPub: fresh.remotePublicKey,
					joinerId: this.deps.identity.nodeId,
					joinerPub: this.deps.identity.publicKey,
					nonceInviter: fresh.nonceInviter as string,
					nonceJoiner: fresh.nonceJoiner,
					invitationId: fresh.invitationId,
					capabilities: [...capabilities],
				});

			if (req.status === "rejected") {
				if (!verifyTranscript(fresh.remotePublicKey, hashFor(REJECTED_MARKER), req.signature)) throw new ApiError(401, "bad_signature", "Signature verification failed");
				if (fresh.state === "awaiting_remote_approval") this.setJoinState(fresh.id, "rejected", req.reason ?? "The other node's user rejected the pairing request");
				return { ok: true };
			}

			const capabilities = capabilitiesOf(req.capabilities);
			const hash = hashFor(capabilities);
			if (!verifyTranscript(fresh.remotePublicKey, hash, req.signature)) throw new ApiError(401, "bad_signature", "Signature verification failed");
			const counter = (): wire.PairConfirmResponse => ({
				step: "confirm",
				signature: signTranscript(this.deps.signer, hash),
				grantedCapabilities: fresh.grantedCapabilities,
				status: "paired",
			});
			if (fresh.state === "paired") return counter(); // the inviter did not get our answer last time
			if (fresh.state !== "awaiting_remote_approval") throw notFound();
			if (Date.parse(fresh.expiresAt) <= this.now()) {
				this.setJoinState(fresh.id, "expired", "The invitation expired before the other node approved it");
				throw notFound();
			}

			const workspaceId = fresh.workspaceId;
			const workspaceName = fresh.workspaceName;
			if (!workspaceId || !workspaceName) throw notFound();
			const grantedByUs = fresh.grantedCapabilities as Capability[];
			this.deps.db.transaction((tx) => {
				this.ensureSharedWorkspace(tx, workspaceId, workspaceName, fresh.remoteName);
				this.deps.peers.addPaired(
					{
						id: fresh.remoteNodeId,
						name: fresh.remoteName,
						fingerprint: fresh.remoteFingerprint,
						publicKey: fresh.remotePublicKey,
						keyId: fresh.remoteFingerprint.slice(0, 16),
						url: fresh.url,
						grantedCapabilities: grantedByUs,
						receivedCapabilities: capabilities,
						workspaceId,
						role: "owner",
					},
					tx,
				);
				tx.update(pairingJoins).set({ state: "paired", error: null, receivedCapabilities: capabilities, updatedAt: new Date(this.now()).toISOString() }).where(eq(pairingJoins.id, fresh.id)).run();
			});
			this.publishJoin(fresh.id);
			this.deps.bus.publish("network", { type: "directory_changed" });
			this.deps.onPaired(fresh.remoteNodeId);
			return counter();
		});
	}

	/**
	 * The joiner gets a local workspace with the inviter's workspace id and name. If this node already has a workspace
	 * of that name, the new one is suffixed with the inviter's name so local names stay unique. `owner_id` must point at
	 * this node's own row (foreign key); the inviter is the workspace owner in `workspace_members`.
	 */
	private ensureSharedWorkspace(tx: Pick<ClamDb, "select" | "insert">, id: string, name: string, inviterName: string): void {
		const existing = tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, id)).get();
		if (existing) return;
		const taken = (candidate: string) => tx.select({ id: workspaces.id }).from(workspaces).where(sql`lower(${workspaces.name}) = lower(${candidate})`).get() !== undefined;
		let finalName = name;
		if (taken(finalName)) finalName = `${name} (${inviterName})`;
		for (let n = 2; taken(finalName); n++) finalName = `${name} (${inviterName} ${n})`;
		const now = new Date(this.now()).toISOString();
		tx.insert(workspaces).values({ id, name: finalName, ownerNodeId: this.deps.identity.nodeId, createdAt: now, updatedAt: now }).run();
		tx.insert(workspaceMembers).values({ workspaceId: id, memberId: this.deps.identity.nodeId, role: "member", grantedBy: this.deps.identity.nodeId, createdAt: now }).run();
	}
}

export { API_PREFIX };
