import type { wire } from "@clam/agent-network";
import type { CreateTaskHandoffBody, DecideHandoffBody, ExtendHandoffBody, Handoff, HandoffFailureCode, HandoffState, SetupDecisionBody } from "@clam/contracts";
import type { HandoffManifest, SetupReport } from "@clam/handoff-engine";
import type { FastifyBaseLogger } from "fastify";
import type { z } from "zod";
import type { ServerContext } from "../context.ts";
import type { KeyedLock } from "../network/util.ts";
import type { HandoffRow, HandoffStore, StepState, TransitionOptions } from "./store.ts";

/**
 * The seams between the units of the handoff engine (docs/architecture.md, "Handoff engine"). `HandoffService` owns the store,
 * the publication of changes, the outbox helper and the fault-injection seam, and wires the units; every unit receives the hub in
 * its constructor and talks to the others only through these interfaces. No unit may call another unit from its constructor.
 *
 * Roles: the node whose agent EXECUTES the task (or drives the shared session) and hands it away is the SOURCE; the node that takes
 * it over is the TARGET. Each node keeps its own `handoffs` row (`role`), with its own state machine from `@clam/handoff-engine`.
 */

/** Timers of the handoff engine; tests shorten them (`HandoffServiceOptions.timings`). */
export interface HandoffTimings {
	/** Offer lifetime (default 30 min). */
	offerExpiryMs: number;
	/** Accept → ack window (default 30 min). */
	restoreDeadlineMs: number;
	/** Per command / validation step (default 10 min). */
	stepTimeoutMs: number;
	/** The sweeper (offer expiry, restore deadline, source `ack_timeout`) and peer reconcile look at every non-terminal handoff this often (default 5 s). */
	sweepMs: number;
	/** Ack retry backoff base when the source is unreachable (default 1 s; capped at 30 s). */
	ackRetryMs: number;
	/** Target waits this long for the source's `released` before `resumed → completed` (default 5 s; the handoff is effective since the ack). */
	completeGraceMs: number;
}

export const DEFAULT_HANDOFF_TIMINGS: HandoffTimings = {
	offerExpiryMs: 30 * 60_000,
	restoreDeadlineMs: 30 * 60_000,
	stepTimeoutMs: 10 * 60_000,
	sweepMs: 5_000,
	ackRetryMs: 1_000,
	completeGraceMs: 5_000,
};

/** A signed peer call queued through the durable outbox (kind prefix `handoff.`; `task.executor` for the sender notice). */
export interface HandoffOutboxItem {
	kind: "handoff.offer" | "handoff.accept" | "handoff.ack" | "handoff.state" | "task.executor";
	/** Path relative to `/api/v1`. */
	path: string;
	body: unknown;
	/** Default: `<kind>:<handoffId>[:<state>]` — re-enqueueing the same logical call is a no-op. */
	idempotencyKey?: string;
	/** Defaults to the other node of the handoff row. */
	peerId?: string;
}

export interface HandoffTransitionOptions extends TransitionOptions {
	/** Calls queued in the SAME transaction as the state change (crash-safe: state and send intent are persisted together). */
	enqueue?: HandoffOutboxItem[];
	/** Tell the other node about this state with a `POST /handoffs/:id/state` (default: yes for the states in `NOTIFIED_STATES`). `false` = never. */
	notify?: boolean;
	/** Failure columns written with a `failed` / `rejected` / `prepare_failed` state. */
	failure?: { code: HandoffFailureCode; detail: string; step?: number | null };
	/** Sent as `deadlineAt` of the notice (source `extended`). */
	deadlineAt?: string;
}

/** Outcome of dependency setup + workspace validation (steps 5 and 6, shared with session-kind handoffs). */
export type SetupOutcome = { status: "ready"; report: SetupReport } | { status: "waiting"; pending: string[] };

export interface SetupInput {
	/** The folder the new session works in (the restored folder / the clone). */
	dir: string;
	/** Declared + detected environment of the work (the manifest's `environment`, or `detectEnvironment(dir)` for a session). */
	environment: HandoffManifest["environment"];
	/** Step 6: paths that must exist, git HEAD that must match, command to run. */
	requiredFiles: string[];
	gitCommit: string | null;
	checkCommand: string | null;
	/** `setup` = step 5 only, `validate` = step 6 only (task handoffs persist `deps_ready` in between); default `both` (session handoffs). */
	phase?: "setup" | "validate" | "both";
}

/** Dependency setup per the node's policy (`dependencySetup`: ask | auto | skip) + validation. Implemented in `setup.ts`. */
export interface SetupApi {
	/**
	 * Step 5 then step 6 for `handoffId` working in `input.dir`. Creates the `handoff_setup` rows (once, idempotent), applies the node
	 * policy, runs approved commands with `runSetupCommand` (per-command `STEP_TIMEOUT`), skips what `setupFingerprint` says is already
	 * done, records `handoffs.setup_fingerprint`. `ask` with unapproved commands → `{status:"waiting"}` (the row stays where it is; the user
	 * answers with `decide`, which re-runs this). Denied commands never fail the handoff: they are reported as skipped in the report
	 * (and thus in the resume prompt). A failing command → throws `HandoffStepError("deps_failed")`; failing validation →
	 * `HandoffStepError("validation_failed")`.
	 */
	setupAndValidate(handoffId: string, input: SetupInput): Promise<SetupOutcome>;
	/** `POST /handoffs/:id/setup` (approve / deny commands). Persists the decision; the caller re-runs the interrupted work. */
	decide(handoffId: string, body: z.infer<typeof SetupDecisionBody>): void;
}

/**
 * Target failures the local user can repair and retry on the target (`TargetApi.retry`): the target stays at its step and the SOURCE
 * keeps waiting (it stays `awaiting_ack`, frozen, owner of the epoch) instead of going `failed` — the restore deadline still applies.
 */
export const RETRYABLE_TARGET_FAILURES: readonly HandoffFailureCode[] = ["deps_failed", "validation_failed", "files_conflict", "checkout_conflict", "patch_failed", "git_unavailable", "disk_full", "session_failed"];

/** A step of the target failed: carries what the state machine records (`failed(code)`, the step number, a user-readable detail). */
export class HandoffStepError extends Error {
	constructor(
		readonly code: HandoffFailureCode,
		message: string,
		readonly step: number | null = null,
	) {
		super(message);
		this.name = "HandoffStepError";
	}
}

/** Source side of a task handoff. Implemented in `source.ts`. */
export interface SourceApi {
	/** `POST /api/local/handoffs`: validate, insert `draft`, move to `preparing`, run the preparation in the background. */
	create(body: z.infer<typeof CreateTaskHandoffBody>): Promise<HandoffRow>;
	/** Drive a persisted source row forward from its state (boot recovery, retry, a delivered accept): idempotent. */
	resume(id: string): Promise<void>;
	/** `POST /handoffs/:id/accept` handler (the target agreed or the offer is stale). */
	receiveAccept(peerId: string, id: string, request: wire.HandoffAcceptRequest): wire.HandoffAcceptResponse;
	/** `POST /handoffs/:id/ack` handler: verify, persist `acked` FIRST, answer, then release in the background. */
	receiveAck(peerId: string, id: string, request: wire.HandoffAckRequest): Promise<wire.HandoffAckResponse>;
	/** `POST /handoffs/:id/state` handler on the source (target progress, failure, rejection, resumed, completed ...). */
	receiveState(peerId: string, id: string, request: wire.HandoffStateRequest): wire.HandoffStateAccepted;
	/** "Source after ack" (docs §4): stop the runtime, fence the task at the old epoch, mark it `handed_off`, `omp session moved`, `released`. Idempotent. */
	finishRelease(id: string): Promise<void>;
	cancel(id: string): Promise<HandoffRow>;
	extend(id: string, minutes: number): Promise<HandoffRow>;
	reclaim(id: string, override: boolean): Promise<HandoffRow>;
	retry(id: string): Promise<HandoffRow>;
	/** Await the tracked background work (preparation, release) at shutdown. */
	stop(): Promise<void>;
}

/** Target side of a task handoff (steps 1–10). Implemented in `target.ts`. */
export interface TargetApi {
	/** `POST /handoffs` handler (step 1). Idempotent by handoff id. Rejects with an `ApiError` or records `rejected`. */
	receive(peerId: string, request: wire.HandoffOfferRequest): Promise<{ row: HandoffRow; created: boolean }>;
	/** `POST /api/local/handoffs/:id/decide`. */
	decide(id: string, body: z.infer<typeof DecideHandoffBody>): Promise<HandoffRow>;
	/** `POST /api/local/handoffs/:id/setup`: record the decision, then continue the steps. */
	setupDecision(id: string, body: z.infer<typeof SetupDecisionBody>): Promise<HandoffRow>;
	/** Re-run the failed step (`failed` target rows only where the failure is retryable). */
	retry(id: string): Promise<HandoffRow>;
	/** The local user abandons a restoring handoff (`failed(cancelled)` + notice to the source). */
	cancel(id: string): Promise<HandoffRow>;
	/** `POST /handoffs/:id/state` handler on the target (source cancelled / reclaimed / extended / expired / released). */
	receiveState(peerId: string, id: string, request: wire.HandoffStateRequest): wire.HandoffStateAccepted;
	/** The source answered the ack (2xx; `response` is its parsed body when there was one): acquire ownership (step 9) and resume (step 10). Called by the `handoff.ack` outbox handler. */
	ackConfirmed(id: string, response?: wire.HandoffAckResponse): Promise<void>;
	/** Drive a persisted target row forward from its state (boot recovery, approval, retry). Per-handoff serialized, idempotent. */
	resume(id: string): Promise<void>;
	/** Remove only what a target handoff created (§6.3: its unused session, frozen task row, dedicated branch/folder if untouched, downloaded artifacts). Idempotent; used after failures, cancels and recovery-driven timeouts. */
	cleanup(id: string): Promise<void>;
	/** Await the tracked background work (the step runner) at shutdown. */
	stop(): Promise<void>;
}

/** Local fencing of tasks (docs §5, §8). Implemented in `fence.ts`. */
export interface FenceApi {
	isFenced(taskId: string): boolean;
	/** The task is in a source handoff window (sealed manifest): its executor must not touch the timeline or the session. */
	isFrozen(taskId: string): boolean;
	/** Freeze: the executor stops reacting to the task (events, prompts, completion) until `unfreeze` or `fence`. */
	freeze(taskId: string, handoffId: string): void;
	unfreeze(taskId: string, handoffId: string): void;
	/** Mark fenced at `epoch` (`highestSeenEpoch` rises, `fenced = true`, no more spawn/prompt/retry of its sessions). Idempotent. */
	fence(taskId: string, epoch: number, reason: string): void;
	/** Throws `409 task_fenced` when the task is fenced or its epoch moved (local guard before commit/push/PR/result). */
	assertOwner(taskId: string, expectedEpoch?: number): void;
	/** Boot: fence scan before any runtime is spawned (`bootFenceDecision`). */
	bootScan(): void;
	/** Boot found an in-doubt handoff (target unreachable): the executor does not auto-resume this task's session until reconciled or overridden. */
	blockedResume(taskId: string): boolean;
	/** Reconcile result or user override: lift the in-doubt block. True when the task was blocked. The caller then resumes it (`executor.resumeInDoubt`). */
	unblockResume(taskId: string): boolean;
}

/** Crash/outage recovery (docs §6) and timers (§7). Implemented in `recovery.ts`. */
export interface RecoveryApi {
	/** Boot: scan every non-terminal handoff and drive it with `recoveryAction`. Persists each hop of `transitionPath` before the side effect. */
	recover(): Promise<void>;
	/** A peer came (back) online: reconcile its handoffs (status query, fence/follow owner). */
	reconcilePeer(peerId: string): Promise<void>;
	start(): void;
	stop(): Promise<void>;
}

/** M5 hand-over/takeover as `kind: session` records, plus steps 5–6 before the continuation prompt. Implemented in `session-kind.ts`. */
export interface SessionKindApi {
	/**
	 * Called on the node that CONTINUES a shared session (takeover/transfer target): record the handoff, run dependency setup + validation
	 * in `dir` per the node policy, resolve with the report once the continuation prompt may be sent. While commands wait for approval it
	 * stays pending (the prompt is blocked); a deny releases it with the commands reported as skipped. `continuation` is the note the caller
	 * will send as soon as this resolves; it is persisted so a restart while waiting can still deliver it (once, by `clientId`).
	 */
	beforeContinuation(input: { sharedSessionId: string; title: string; workspaceId: string; fromNodeId: string; fromNodeName: string; fromAgentName?: string | null; toEpoch: number; dir: string; projectId: string | null; sessionId: string | null; agentName: string | null; reason: "takeover" | "transfer"; vcs: "git" | "files"; headCommit?: string | null; continuation?: { text: string; clientId: string } }): Promise<SetupReport>;
	/** The continuation prompt was sent (or could not be): `resumed → completed` on the target row. Never throws. */
	continued(input: { sharedSessionId: string; toEpoch: number; error?: string }): void;
	/** Called on the node that gives the driver role away (transfer) or learns it lost it (takeover). */
	recordSource(input: { sharedSessionId: string; title: string; workspaceId: string; toNodeId: string; toNodeName: string; toAgentName?: string | null; fromEpoch: number; toEpoch: number; sessionId: string | null; agentName: string | null; reason: "takeover" | "transfer"; vcs: "git" | "files" }): HandoffRow;
	/** `POST /api/local/handoffs/:id/setup` for a `kind: session` row: record the decision and release the waiting continuation. */
	setupDecision(id: string, body: z.infer<typeof SetupDecisionBody>): Promise<HandoffRow>;
	/** Boot: re-arm session-kind rows that wait for a setup approval or whose continuation prompt was never sent. Called by `HandoffService.start()`. */
	start(): void;
}

export interface HandoffHub {
	readonly ctx: ServerContext;
	readonly store: HandoffStore;
	readonly log: FastifyBaseLogger;
	readonly timings: HandoffTimings;
	readonly lock: KeyedLock;
	readonly source: SourceApi;
	readonly target: TargetApi;
	readonly setup: SetupApi;
	readonly fence: FenceApi;
	readonly recovery: RecoveryApi;
	readonly sessionKind: SessionKindApi;
	nodeName(): string;
	/**
	 * Persist `to` (+ timeline event, + queued calls) in one transaction, publish `handoffs` / `handoff:<id>`, then run the fault-injection
	 * check (`CLAM_FAULT` / test seam: may throw `FaultInjected` or exit the process RIGHT AFTER the state is durable). Throws once the node
	 * has "crashed" (a fault fired): nothing else is persisted after that.
	 */
	transition(id: string, to: HandoffState, options: HandoffTransitionOptions): HandoffRow;
	/**
	 * Run the fault-injection check for the CURRENT state of `id` without a transition: for the one state that is entered by inserting the
	 * row (target `received`, once step 1 is stored). Throws like `transition` when the fault matches or the node already "crashed".
	 */
	faultPoint(id: string): void;
	/** Walk `transitionPath(role, current, target)`, persisting every hop (recovery: e.g. `ack_timeout → awaiting_ack → acked`). */
	advance(id: string, target: HandoffState, options: HandoffTransitionOptions): HandoffRow;
	/** Append a timeline note without a state change and publish it. */
	note(id: string, summary: string): void;
	/** Queue a signed peer call through the durable outbox (ordered per `(handoff, peer)`). No-op after a simulated crash. */
	enqueue(row: HandoffRow, item: HandoffOutboxItem): void;
	/** Persist the state of one step and publish the row (`handoffs` + `handoff:<id>`): the progress is live without waiting for the next transition. */
	setStep(id: string, n: number, state: StepState, detail?: string | null): void;
	/** Publish the row (`handoffs` + `handoff:<id>`). */
	changed(id: string): void;
	/** Throw if `peerId` is not an active peer that granted/holds `handoff.receive` (both directions) — shared by wire handlers and flows. */
	assertPeerCapable(peerId: string, direction: "granted" | "received"): void;
	/** This node's side of the handoff, for `GET /handoffs/:id` and recovery queries. */
	statusOf(row: HandoffRow): wire.HandoffStatusResponse;
	/** Absolute work directory for artifacts of a handoff on this node (`<dataDir>/handoffs/<id>/`), created on demand. */
	dir(id: string): string;
}

export type { Handoff };
