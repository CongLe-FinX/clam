import type { HandoffManifest } from "@clam/handoff-engine";
import { type HandoffHub, HandoffStepError } from "./hub.ts";
import type { HandoffRow } from "./store.ts";

/** Shared contexts the handoff points to (manifest `contexts`): the M6 store holds the exact version, or the step waits briefly for the sync to deliver it. */
const POLL_ROUNDS = 6;

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/**
 * Step 4. Every referenced context version must be held locally with the sha-256 the manifest names. A version that is missing is asked for
 * (a reconcile with the source peer) and awaited for a short while, best effort: the rest of the handoff does not depend on it, so what still
 * has not arrived is noted on the timeline and left to the ordinary sync. A version number we hold with a DIFFERENT hash is a failed
 * integrity check (`manifest_invalid`). Returns the step detail.
 */
export async function restoreContexts(hub: HandoffHub, row: HandoffRow, manifest: HandoffManifest): Promise<string> {
	if (manifest.contexts.length === 0) return "No shared contexts were referenced";
	const { store } = hub.ctx.contexts;

	const missing = (): string[] => {
		const out: string[] = [];
		for (const ref of manifest.contexts) {
			if (store.snapshot(ref.id, ref.version, ref.sha256)) continue;
			if (store.snapshots(ref.id).some((s) => s.version === ref.version)) {
				throw new HandoffStepError("manifest_invalid", `Context ${ref.id} version ${ref.version} differs from the one the source handed over (hash mismatch)`, 4);
			}
			out.push(`${ref.id}@v${ref.version}`);
		}
		return out;
	};

	let lacking = missing();
	if (lacking.length > 0) {
		hub.ctx.contexts.sync.reconcile(row.peerId);
		const pause = Math.max(50, Math.floor(hub.timings.ackRetryMs / 2));
		for (let round = 0; round < POLL_ROUNDS && lacking.length > 0; round += 1) {
			await sleep(pause);
			lacking = missing();
		}
	}
	if (lacking.length > 0) {
		hub.note(row.id, `Context not synced yet (${lacking.join(", ")}); continuing, the ordinary sync will bring it`);
		hub.store.patchMeta(row.id, { contextsMissing: lacking });
		return `${manifest.contexts.length - lacking.length} of ${manifest.contexts.length} context version(s) verified; ${lacking.length} still to sync`;
	}
	hub.store.patchMeta(row.id, { contextsMissing: undefined });
	return `${manifest.contexts.length} context version(s) verified`;
}
