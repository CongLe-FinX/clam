import type { HandoffFailureCode, HandoffRole, HandoffState } from "@clam/contracts";
import {
	canTransition,
	nextTargetStep,
	type SourceState,
	type StepStatus,
	stepAfterState,
	TARGET_STEPS,
	type TargetState,
	type TargetStepDef,
	isSourceState,
	isTargetState,
	SOURCE_TERMINAL,
	TARGET_TERMINAL,
} from "./states.ts";
import { hasPassed, type TimeInput } from "./timeouts.ts";

/**
 * Crash/outage recovery as a pure decision table (docs/handoff-protocol.md §6.1, §6.2, §6.4, §8). The caller
 * gathers the facts (DB row, peer query, local session), calls {@link recoveryAction}, persists `nextState`
 * (if any) BEFORE performing the action's side effect, and performs it. Every action is idempotent.
 */

export type RecoveryActionName =
	/** Nothing to do (waiting, or terminal). */
	| "none"
	// source
	| "restart_prepare" // resume preparing or discard temp files; nothing was sent
	| "resend_offer" // POST /handoffs is idempotent
	| "expire" // offer lifetime passed → expired
	| "query_target" // GET /tasks/:id + handoff stream
	| "enter_ack_timeout" // restore deadline passed without ack
	| "mark_failed" // peer failed/rejected/cancelled (source stays owner) or target superseded
	| "finish_release" // "source after ack" §4: persist acked + token, stop runtime, fence, released
	| "mark_completed"
	| "await_user" // extend / reclaim / retry
	| "fence_and_follow_owner" // §8.2: epoch ahead → confirm fenced, adopt owner, session stopped
	// target
	| "refetch_manifest"
	| "reevaluate_acceptance"
	| "resume_step" // restart at `step`
	| "resend_ack" // idempotent
	| "acquire_after_deadline" // §6.4(b): publish owner event at the new epoch on its own stream
	| "resend_resume_if_no_turns" // only if the new session has no user/assistant turn yet
	| "cleanup"; // §6.3: remove only what the handoff created

export interface RecoveryFacts {
	/** Now, epoch ms / ISO string / Date. */
	now: TimeInput;
	/** Offer lifetime (absolute). */
	expiresAt?: TimeInput | null;
	/** Restore deadline (absolute). */
	deadlineAt?: TimeInput | null;

	// --- source
	/** Result of asking the target: true = answered, false = unreachable, undefined = not asked yet. */
	targetReachable?: boolean;
	/** Target state reported by the status query / handoff stream (only meaningful when reachable). */
	targetState?: TargetState | null;
	/** A valid ack (hash, epoch, pinned key, fencing token) is persisted locally. */
	ackRecorded?: boolean;
	/** The user explicitly accepted the duplicate-execution risk (§6.4, §8.3). */
	userOverride?: boolean;
	/** §8 reconcile: epoch persisted locally for the task vs. the one the peer reports. */
	localEpoch?: number;
	peerEpoch?: number;
	/** Target confirmed `resumed`/`completed`. */
	resumeConfirmed?: boolean;
	/** Completed-grace (§7) elapsed. */
	graceElapsed?: boolean;

	// --- target
	/** The full manifest (not just metadata) is stored. */
	manifestStored?: boolean;
	/** Source answered `stale_epoch` / reported `reclaimed`: the offer was superseded. */
	sourceReclaimed?: boolean;
	/** Source cancelled the handoff. */
	sourceCancelled?: boolean;
	/** The source's response to the ack has arrived. */
	ackResponseReceived?: boolean;
	/** `get_messages_page` total > 0 in the new session. */
	sessionHasTurns?: boolean;
	/** `handoff_steps` rows. */
	steps?: ReadonlyArray<{ n: number; state: StepStatus }>;
	/** Failure/cancel cleanup (§6.3) already ran. */
	cleanedUp?: boolean;
}

export interface RecoveryDecision {
	action: RecoveryActionName;
	reason: string;
	/** Persist this state first; it is reachable from the current one (see `transitionPath`, hops are persisted in order). */
	nextState?: HandoffState;
	failureCode?: HandoffFailureCode;
	/** Target: step to resume at. */
	step?: TargetStepDef;
	/** §8: the task must be fenced locally (never spawn/prompt/retry its sessions). */
	fenceTask?: boolean;
	/** §8.3: resuming the same OMP session is blocked until reconciled or the user overrides. */
	blockLocalResume?: boolean;
	/** Source `ack_timeout`: reclaim needs a reachability proof, otherwise an explicit override with a warning. */
	reclaimRequiresOverride?: boolean;
}

const ACKED_STATES: readonly TargetState[] = ["acked", "owner", "resumed", "completed"];
const PEER_GONE_STATES: readonly TargetState[] = ["failed", "rejected", "cancelled"];

export function recoveryAction(role: HandoffRole, state: HandoffState, facts: RecoveryFacts): RecoveryDecision {
	if (role === "source") {
		if (!isSourceState(state)) throw new RangeError(`unknown source handoff state: ${state}`);
		return sourceRecovery(state, facts);
	}
	if (!isTargetState(state)) throw new RangeError(`unknown target handoff state: ${state}`);
	return targetRecovery(state, facts);
}

function peerAhead(f: RecoveryFacts): boolean {
	return f.peerEpoch !== undefined && f.localEpoch !== undefined && f.peerEpoch > f.localEpoch;
}

function sourceRecovery(state: SourceState, f: RecoveryFacts): RecoveryDecision {
	const targetKnown = f.targetReachable === true ? (f.targetState ?? null) : null;
	const targetAcked = targetKnown !== null && ACKED_STATES.includes(targetKnown);
	const targetGone = targetKnown !== null && PEER_GONE_STATES.includes(targetKnown);
	const deadlinePassed = hasPassed(f.now, f.deadlineAt);

	switch (state) {
		case "draft":
			return { action: "none", reason: "nothing was sent; the source is still the owner" };
		case "preparing":
			return { action: "restart_prepare", reason: "resume preparing or discard temp files; nothing was sent, the source is still the owner" };
		case "prepare_failed":
			return { action: "await_user", reason: "preparation failed; the user retries (prepare_failed → draft)" };
		case "offered": {
			if (peerAhead(f)) {
				return { action: "fence_and_follow_owner", reason: "the task is already at a higher epoch elsewhere: abandon this offer", nextState: "cancelled", fenceTask: true };
			}
			if (hasPassed(f.now, f.expiresAt)) {
				return { action: "expire", reason: "expiresAt passed without a response", nextState: "expired" };
			}
			return { action: "resend_offer", reason: "POST /handoffs is idempotent (Idempotency-Key); resend", blockLocalResume: !f.userOverride };
		}
		case "accepted":
		case "awaiting_ack": {
			// §6.4: ack arrived but the response/state was lost — the target already holds epoch n+1.
			if (f.ackRecorded || targetAcked || peerAhead(f)) {
				return { action: "finish_release", reason: "the target acked (valid durable ack): run 'source after ack' — never release without it", nextState: "acked", fenceTask: true };
			}
			if (targetGone) {
				return { action: "mark_failed", reason: `target reports ${targetKnown}: the handoff failed, the source stays owner`, nextState: "failed" };
			}
			if (f.targetReachable === undefined) {
				return { action: "query_target", reason: "ask the target (GET /tasks/:id, handoff stream) before deciding", blockLocalResume: !f.userOverride };
			}
			if (deadlinePassed) {
				return { action: "enter_ack_timeout", reason: "restore deadline passed without an ack", nextState: "ack_timeout", blockLocalResume: !f.userOverride };
			}
			return {
				action: "none",
				reason: f.targetReachable
					? "target is still restoring; keep waiting — the source does not release on silence"
					: "target unreachable; remain awaiting_ack until the deadline — the source does not release on silence",
				nextState: state === "accepted" ? "awaiting_ack" : undefined,
				blockLocalResume: !f.userOverride,
			};
		}
		case "ack_timeout": {
			if (f.ackRecorded || targetAcked || peerAhead(f)) {
				return { action: "finish_release", reason: "the target did ack after all (learned before reclaiming): run 'source after ack'", nextState: "acked", fenceTask: true };
			}
			// Reclaim is safe only with proof the target did not ack; otherwise duplicate execution is possible.
			const proof = f.targetReachable === true && targetKnown !== null;
			return {
				action: "await_user",
				reason: proof
					? "decide: extend the deadline or reclaim (the target is reachable and has not acked)"
					: "decide: extend the deadline or reclaim — reclaiming without reaching the target risks duplicate execution",
				reclaimRequiresOverride: !proof,
				blockLocalResume: !f.userOverride && !proof,
			};
		}
		case "acked":
			return {
				action: "finish_release",
				reason: "crashed after persisting the ack: stop the runtime, fence the task, mark handed_off, release — never restart the session",
				nextState: "released",
				fenceTask: true,
			};
		case "released":
			if (f.resumeConfirmed || f.targetState === "resumed" || f.targetState === "completed" || f.graceElapsed) {
				return { action: "mark_completed", reason: "target resumed (or the grace period passed); the handoff is effective since the ack", nextState: "completed", fenceTask: true };
			}
			if (peerAhead(f)) return { action: "fence_and_follow_owner", reason: "peer owns a higher epoch: show 'task continues on node B'", fenceTask: true };
			return { action: "none", reason: "released; waiting for the target's resumed event", fenceTask: true };
		case "completed":
			return peerAhead(f)
				? { action: "fence_and_follow_owner", reason: "returning source: peer owns a higher epoch — confirm fenced, adopt owner/epoch, mark the local session stopped (handed_off)", fenceTask: true }
				: { action: "none", reason: "terminal", fenceTask: true };
		case "rejected":
		case "expired":
		case "cancelled":
		case "reclaimed":
		case "failed":
			return { action: "none", reason: "terminal" };
	}
}

function targetRecovery(state: TargetState, f: RecoveryFacts): RecoveryDecision {
	if (TARGET_TERMINAL.has(state)) {
		return f.cleanedUp === false
			? { action: "cleanup", reason: "terminal without cleanup: remove only what the handoff created (§6.3)" }
			: { action: "none", reason: "terminal" };
	}

	const preAck = TARGET_STEPS.findIndex((s) => s.doneState === state) <= TARGET_STEPS.findIndex((s) => s.doneState === "session_created");
	if (preAck && f.sourceReclaimed) {
		return fail(state, "superseded", "the source reclaimed the task (stale epoch): stop, discard the new session, never acquire");
	}
	if (preAck && f.sourceCancelled) {
		return fail(state, "cancelled", "the source cancelled the handoff: clean up what was created");
	}
	if (preAck && hasPassed(f.now, f.deadlineAt)) {
		return fail(state, "timeout", "restore deadline passed before the ack");
	}

	switch (state) {
		case "received":
			return f.manifestStored === false
				? { action: "refetch_manifest", reason: "only metadata was stored: fetch the manifest again" }
				: { action: "reevaluate_acceptance", reason: "re-run the acceptance policy (auto or ask the user)" };
		case "accepted":
			return f.manifestStored === false
				? { action: "refetch_manifest", reason: "only metadata was stored: fetch the manifest again" }
				: { action: "resume_step", reason: "continue with step 2 (persist)", step: TARGET_STEPS[1] };
		case "persisted":
		case "files_restored":
		case "context_restored":
		case "deps_ready":
		case "validated":
		case "session_created": {
			const step = (f.steps ? nextTargetStep(f.steps) : null) ?? stepAfterState(state) ?? undefined;
			return {
				action: "resume_step",
				reason:
					state === "session_created"
						? "re-open the session directory, confirm no prompt was sent, write the ack (step 8)"
						: "resume at the first step that is not done; steps 3–6 check 'already done' before acting",
				step,
			};
		}
		case "acked":
			if (f.sourceReclaimed) {
				return fail(state, "superseded", "the source reported stale_epoch (it reclaimed): stop, discard the new session's execution, never proceed to step 9");
			}
			if (f.ackResponseReceived) {
				return { action: "resume_step", reason: "the source confirmed the ack: acquire ownership (step 9)", step: TARGET_STEPS[8] };
			}
			if (hasPassed(f.now, f.deadlineAt)) {
				// §6.4(b): durable valid hash-bound ack + retried until the deadline + no reclaim ⇒ legitimate owner at n+1.
				return { action: "acquire_after_deadline", reason: "ack retried until the handoff deadline without a response and no reclaim seen: publish the owner event at the new epoch", step: TARGET_STEPS[8] };
			}
			return { action: "resend_ack", reason: "the ack row is durable but the send is unknown: resend (idempotent) until the deadline" };
		case "owner":
			return f.sessionHasTurns === true
				? { action: "none", reason: "the new session already has turns: continue as an ordinary local task", nextState: "resumed" }
				: { action: "resend_resume_if_no_turns", reason: "send the resume prompt only if the new session has no user/assistant turn (check get_messages_page total)", step: TARGET_STEPS[9] };
		case "resumed":
			return f.resumeConfirmed || f.graceElapsed
				? { action: "mark_completed", reason: "source confirmed (or the grace period passed)", nextState: "completed" }
				: { action: "none", reason: "ordinary task recovery: respawn runtime and open_session on the same directory" };
		case "completed":
		case "rejected":
		case "failed":
		case "cancelled":
			return { action: "none", reason: "terminal" };
	}
}

/** Failure on the target: `cancelled` where the table has that edge, otherwise `failed(code)`. */
function fail(state: TargetState, code: HandoffFailureCode, reason: string): RecoveryDecision {
	const nextState: TargetState = code === "cancelled" && canTransition("target", state, "cancelled") ? "cancelled" : "failed";
	return { action: "mark_failed", reason, nextState, failureCode: code };
}

// ------------------------------------------------------------------ §8 boot fence scan

export interface BootFenceFacts {
	/** The task's persisted owner epoch on this node. */
	localEpoch: number;
	/** Highest epoch this node has ever seen for the task (handoffs, events, peer replies). */
	highestSeenEpoch: number;
	/** This node's source-role handoff state for the task, if any non-archived one exists. */
	sourceState?: SourceState | null;
	/** Reconcile result: undefined = not asked yet, false = unreachable. */
	peerReachable?: boolean;
	peerEpoch?: number;
	userOverride?: boolean;
}

export type BootFenceVerdict =
	| { fence: true; reason: string }
	| { fence: false; blockResume: boolean; reason: string };

/**
 * §8.1/§8.3: before any runtime is spawned, decide per task whether it is fenced (never started, resumed or
 * retried), in doubt (own task, but resuming the same OMP session is blocked until reconciled), or free.
 */
export function bootFenceDecision(f: BootFenceFacts): BootFenceVerdict {
	if (f.sourceState === "acked" || f.sourceState === "released" || f.sourceState === "completed") {
		return { fence: true, reason: "a persisted acked handoff exists: this node released the task" };
	}
	if (f.localEpoch < f.highestSeenEpoch) {
		return { fence: true, reason: `owner epoch ${f.localEpoch} is lower than the highest seen epoch ${f.highestSeenEpoch}` };
	}
	if (f.peerEpoch !== undefined && f.peerEpoch > f.localEpoch) {
		return { fence: true, reason: `peer reports epoch ${f.peerEpoch} > ${f.localEpoch}: the task continues elsewhere` };
	}
	const pending = f.sourceState !== undefined && f.sourceState !== null && !SOURCE_TERMINAL.has(f.sourceState) && f.sourceState !== "draft" && f.sourceState !== "preparing" && f.sourceState !== "prepare_failed";
	if (pending && f.peerReachable !== true && !f.userOverride) {
		return { fence: false, blockResume: true, reason: "in-doubt handoff and the target is unreachable: do not auto-resume the same session until reconciled or overridden" };
	}
	return { fence: false, blockResume: false, reason: "this node owns the task" };
}
