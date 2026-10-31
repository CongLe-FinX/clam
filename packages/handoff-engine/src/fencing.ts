import { verifySignature } from "@clam/node-identity";

/**
 * Ownership epochs and fencing tokens (docs/handoff-protocol.md §5, agent-network-protocol.md §9).
 * Token = `"<taskId>:<epoch>:<sig>"`, `sig` = base64url Ed25519 signature by the NEW owner (the target) over
 * `taskId|epoch|handoffId|manifestSha256`.
 */

export interface FencingInput {
	taskId: string;
	/** The new epoch (`toEpoch`). */
	epoch: number;
	handoffId: string;
	manifestSha256: string;
}

/**
 * Ed25519 signing primitive of the node key. Accepts both flavours in the repo: `NodeIdentity.sign`
 * (returns base64 text) and `Signer.sign` from `@clam/agent-network` (returns raw bytes).
 */
export type SignFn = (message: Uint8Array) => string | Uint8Array;

export function fencingMessage(input: FencingInput): string {
	for (const part of [input.taskId, input.handoffId, input.manifestSha256]) {
		if (part === "" || part.includes("|")) throw new TypeError("fencing parts must be non-empty and must not contain '|'");
	}
	if (!Number.isSafeInteger(input.epoch) || input.epoch < 0) throw new TypeError("epoch must be a non-negative integer");
	return `${input.taskId}|${input.epoch}|${input.handoffId}|${input.manifestSha256}`;
}

export function makeFencingToken(input: FencingInput & { sign: SignFn }): string {
	const { sign, ...fields } = input;
	const signature = sign(Buffer.from(fencingMessage(fields), "utf8"));
	const sig = typeof signature === "string" ? Buffer.from(signature, "base64") : Buffer.from(signature);
	return `${fields.taskId}:${fields.epoch}:${sig.toString("base64url")}`;
}

export interface ParsedFencingToken {
	taskId: string;
	epoch: number;
	/** base64url signature. */
	sig: string;
}

/** Splits on the LAST two colons, so task ids may themselves contain `:`. */
export function parseFencingToken(token: string): ParsedFencingToken | null {
	const second = token.lastIndexOf(":");
	const first = second > 0 ? token.lastIndexOf(":", second - 1) : -1;
	if (first <= 0) return null;
	const taskId = token.slice(0, first);
	const epochText = token.slice(first + 1, second);
	const sig = token.slice(second + 1);
	if (!/^\d{1,15}$/.test(epochText) || !/^[A-Za-z0-9_-]{16,}$/.test(sig)) return null;
	return { taskId, epoch: Number(epochText), sig };
}

export type FencingVerification =
	| { ok: true; taskId: string; epoch: number }
	| { ok: false; reason: "malformed" | "mismatch" | "bad_signature" };

export interface VerifyFencingOptions {
	/** The target's pinned raw Ed25519 public key (base64 or base64url). */
	publicKey: string;
	handoffId: string;
	manifestSha256: string;
	/** When given, the token must be for exactly this task / epoch. */
	taskId?: string;
	epoch?: number;
}

export function verifyFencingToken(token: string, opts: VerifyFencingOptions): FencingVerification {
	const parsed = parseFencingToken(token);
	if (!parsed) return { ok: false, reason: "malformed" };
	if ((opts.taskId !== undefined && opts.taskId !== parsed.taskId) || (opts.epoch !== undefined && opts.epoch !== parsed.epoch)) {
		return { ok: false, reason: "mismatch" };
	}
	let message: string;
	try {
		message = fencingMessage({ taskId: parsed.taskId, epoch: parsed.epoch, handoffId: opts.handoffId, manifestSha256: opts.manifestSha256 });
	} catch {
		return { ok: false, reason: "malformed" };
	}
	const good = verifySignature({
		publicKey: Buffer.from(opts.publicKey, "base64").toString("base64"),
		message,
		signature: Buffer.from(parsed.sig, "base64url").toString("base64"),
	});
	return good ? { ok: true, taskId: parsed.taskId, epoch: parsed.epoch } : { ok: false, reason: "bad_signature" };
}

export type EpochVerdict = "ok" | "stale" | "ahead";

/**
 * Receiver-side epoch gate (§5/§9): `incoming < current` → `stale` (answer `409 stale_epoch` with
 * `details.currentEpoch`); `incoming > current` → `ahead` (the receiver is the stale one and must reconcile).
 */
export function checkEpoch(incoming: number, current: number): EpochVerdict {
	if (incoming === current) return "ok";
	return incoming < current ? "stale" : "ahead";
}

export type HandoffEpochCheck = { ok: true } | { ok: false; reason: "bad_increment" | "stale_epoch" | "epoch_ahead"; knownEpoch: number | null };

/** Target step 1: `toEpoch === fromEpoch + 1` and `fromEpoch` equals the epoch known locally (or the task is unknown). */
export function checkHandoffEpochs(fromEpoch: number, toEpoch: number, knownEpoch: number | null): HandoffEpochCheck {
	if (toEpoch !== fromEpoch + 1) return { ok: false, reason: "bad_increment", knownEpoch };
	if (knownEpoch === null) return { ok: true };
	const verdict = checkEpoch(fromEpoch, knownEpoch);
	if (verdict === "ok") return { ok: true };
	return { ok: false, reason: verdict === "stale" ? "stale_epoch" : "epoch_ahead", knownEpoch };
}
