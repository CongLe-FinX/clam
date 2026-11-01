import { Buffer } from "node:buffer";
import { deriveCodeKey, generateInvitationCode, hashInvitationCode, invitationIdFromCode } from "@clam/agent-network";
import { i18nMsg, type Capability, type CreateInvitationBody, type Invitation } from "@clam/contracts";
import { pairingInvitations, workspaces } from "@clam/database";
import type { ClamDb } from "@clam/database";
import type { SecretStore } from "@clam/secret-store";
import { desc, eq } from "drizzle-orm";
import type { z } from "zod";
import type { EventBus } from "../context.ts";
import { ApiError } from "../http/errors.ts";

type InvitationRow = typeof pairingInvitations.$inferSelect;

const CODE_KEY_PREFIX = "pairing.codekey.";
const LIST_LIMIT = 50;

export interface InvitationServiceDeps {
	db: ClamDb;
	secrets: SecretStore;
	bus: EventBus;
	fingerprint: string;
	selfUrl(): string | null;
	now?: () => number;
}

/**
 * Invitations issued by this node. The plain code is returned once at creation; afterwards only `code_hash` exists in
 * SQLite, and the HKDF-derived code key (needed to verify the joiner's proof) lives in the secret store until the
 * handshake's hello has been verified, the invitation ends, or it expires.
 */
export class InvitationService {
	private readonly now: () => number;

	constructor(private readonly deps: InvitationServiceDeps) {
		this.now = deps.now ?? Date.now;
	}

	row(id: string): InvitationRow | undefined {
		return this.deps.db.select().from(pairingInvitations).where(eq(pairingInvitations.id, id)).get();
	}

	/** Stored state; a pending invitation past its expiry reads as `expired` even before the sweep records it. */
	stateOf(row: InvitationRow): Invitation["state"] {
		if (row.state === "consumed" || row.state === "revoked" || row.state === "locked" || row.state === "expired") return row.state;
		return Date.parse(row.expiresAt) <= this.now() ? "expired" : "pending";
	}

	toInvitation(row: InvitationRow, code?: string): Invitation {
		return {
			id: row.id,
			workspaceId: row.workspaceId,
			capabilities: row.capabilities as Capability[],
			state: this.stateOf(row),
			attempts: row.attempts,
			expiresAt: row.expiresAt,
			createdAt: row.createdAt,
			url: this.deps.selfUrl(),
			fingerprint: this.deps.fingerprint,
			...(code !== undefined && { code }),
		};
	}

	list(): Invitation[] {
		return this.deps.db.select().from(pairingInvitations).orderBy(desc(pairingInvitations.createdAt)).limit(LIST_LIMIT).all().map((row) => this.toInvitation(row));
	}

	publish(id: string): void {
		const row = this.row(id);
		if (row) this.deps.bus.publish("network", { type: "invitation", invitation: this.toInvitation(row) });
	}

	async create(body: z.infer<typeof CreateInvitationBody>): Promise<Invitation> {
		const workspace = this.deps.db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, body.workspaceId)).get();
		if (!workspace) throw ApiError.notFound("Workspace");
		const capabilities = [...new Set(body.capabilities)];
		let code = generateInvitationCode();
		let id = invitationIdFromCode(code);
		// The id is derived from the code, so a (1 in 2^40) collision with a live invitation is regenerated.
		for (let attempt = 0; this.row(id) !== undefined && attempt < 8; attempt++) {
			code = generateInvitationCode();
			id = invitationIdFromCode(code);
		}
		if (this.row(id) !== undefined) throw ApiError.unavailable(i18nMsg("Could not generate a unique invitation code; try again"));
		const now = this.now();
		this.deps.db
			.insert(pairingInvitations)
			.values({
				id,
				workspaceId: body.workspaceId,
				codeHash: hashInvitationCode(code, id),
				capabilities,
				state: "pending",
				expiresAt: new Date(now + body.ttlMinutes * 60_000).toISOString(),
				createdAt: new Date(now).toISOString(),
			})
			.run();
		await this.deps.secrets.set(`${CODE_KEY_PREFIX}${id}`, Buffer.from(deriveCodeKey(code, id)).toString("base64"));
		const row = this.row(id);
		if (!row) throw ApiError.unavailable(i18nMsg("Invitation could not be stored"));
		this.publish(id);
		return this.toInvitation(row, code);
	}

	/** The code key for the hello proof; null once dropped (or if the secret store lost it). */
	async loadCodeKey(id: string): Promise<Uint8Array | null> {
		const stored = await this.deps.secrets.get(`${CODE_KEY_PREFIX}${id}`);
		return stored ? new Uint8Array(Buffer.from(stored, "base64")) : null;
	}

	async dropCodeKey(id: string): Promise<void> {
		await this.deps.secrets.delete(`${CODE_KEY_PREFIX}${id}`);
	}

	/** Count a guess *before* it is checked, so a crash or a timeout cannot hand out free attempts. Returns the new count. */
	registerAttempt(id: string): number {
		const row = this.row(id);
		if (!row) return 0;
		const attempts = row.attempts + 1;
		this.deps.db.update(pairingInvitations).set({ attempts }).where(eq(pairingInvitations.id, id)).run();
		return attempts;
	}

	/** After a failed guess: lock the invitation once the attempt budget is spent. */
	async lockIfExhausted(id: string): Promise<void> {
		const row = this.row(id);
		if (!row || row.state !== "pending" || row.attempts < row.maxAttempts) return;
		this.deps.db.update(pairingInvitations).set({ state: "locked" }).where(eq(pairingInvitations.id, id)).run();
		await this.dropCodeKey(id);
		this.publish(id);
	}

	async finish(id: string, state: "consumed" | "revoked" | "expired", by?: string): Promise<void> {
		this.deps.db
			.update(pairingInvitations)
			.set({ state, ...(state === "consumed" && { consumedAt: new Date(this.now()).toISOString(), consumedBy: by ?? null }) })
			.where(eq(pairingInvitations.id, id))
			.run();
		await this.dropCodeKey(id);
		this.publish(id);
	}

	/** Revoke a pending invitation. Already-ended invitations are a no-op; a consumed one cannot be revoked. */
	async revoke(id: string): Promise<void> {
		const row = this.row(id);
		if (!row) throw ApiError.notFound("Invitation");
		const state = this.stateOf(row);
		if (state === "consumed") throw ApiError.conflict(i18nMsg("This invitation was already used; revoke the peer instead"));
		if (state !== "pending") return;
		await this.finish(id, "revoked");
	}

	/** Record expiry (once) and drop the code key of invitations that ran out without being used up. */
	async sweep(): Promise<void> {
		const rows = this.deps.db.select().from(pairingInvitations).where(eq(pairingInvitations.state, "pending")).all();
		for (const row of rows) {
			if (this.stateOf(row) === "expired") await this.finish(row.id, "expired");
		}
	}
}
