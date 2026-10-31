import { rm } from "node:fs/promises";
import { wire } from "@clam/agent-network";
import { HandoffFailureCode, type HandoffRole, type HandoffState } from "@clam/contracts";
import { COMPLETED_GRACE_MS, HandoffManifest, hasPassed, type RecoveryDecision, type RecoveryFacts, recoveryAction, type StepStatus, type TargetState, verifyFencingToken } from "@clam/handoff-engine";
import { isTerminalStatus } from "@clam/task-engine";
import type { TaskStatus } from "@clam/contracts";
import { errorText } from "../network/util.ts";
import { FaultInjected } from "./fault.ts";
import { type HandoffHub, RETRYABLE_TARGET_FAILURES, type RecoveryApi } from "./hub.ts";
import { type HandoffRow, isTerminalState } from "./store.ts";

/** How long boot recovery / a sweep waits for one peer's `GET /handoffs/:id`; an unreachable peer is asked once per run. */
const PEER_QUERY_TIMEOUT_MS = 3_000;

/** Target states in which the target holds a valid ack (and the new epoch). */
const ACKED_TARGET_STATES: readonly string[] = ["acked", "owner", "resumed", "completed"];
const PRE_ACK_TARGET_STATES: readonly string[] = ["received", "accepted", "persisted", "files_restored", "context_restored", "deps_ready", "validated", "session_created"];

type Mode = "boot" | "sweep" | "reconcile";

/** Per-run memory: a peer that did not answer is not asked again by the same run. */
interface Run {
	down: Set<string>;
}

interface Peek {
	reachable: boolean;
	status: wire.HandoffStatusResponse | null;
}

/** What a source learned about the target's valid ack that it has not persisted yet. */
interface LearnedAck {
	fencingToken: string;
	ackAt: string;
	targetSessionId: string | null;
}

interface Gathered {
	facts: RecoveryFacts;
	ack: LearnedAck | null;
	status: wire.HandoffStatusResponse | null;
}

const FaultGuard = (error: unknown): void => {
	if (error instanceof FaultInjected) throw error;
};

/**
 * Crash/outage recovery (docs/handoff-protocol.md §6, §8), the timers of §7 and the peer-reconnect reconcile. The decisions come from the
 * engine's pure table (`recoveryAction`); this unit gathers the facts, persists every state hop BEFORE the side effect, and performs the
 * side effect through the other units (never rebuilding what they do). Everything is idempotent: a crash during recovery re-runs safely.
 *
 * Choices worth knowing:
 * - `acked → released` is NOT persisted here: `source.finishRelease` owns that hop (it stops the runtime and fences the task first, then
 *   records `released`); recovery only brings the row to `acked` (persisting the peer's verified ack if the source never saw it) and fences.
 * - A target row with only metadata (no stored manifest) cannot re-fetch it (there is no wire call for the manifest, the offer body is
 *   persisted with the row): it fails as `manifest_invalid`.
 * - Rows of `kind: session` belong to the session-kind unit and are never touched.
 */
export class RecoveryService implements RecoveryApi {
	private readonly tracked = new Set<Promise<unknown>>();
	private readonly driving = new Set<string>();
	private readonly reconciling = new Map<string, { again: boolean }>();
	private timer: ReturnType<typeof setInterval> | undefined;
	private off: (() => void) | null = null;
	private sweeping = false;
	private stopped = false;

	constructor(private readonly hub: HandoffHub) {}

	// ------------------------------------------------------------------ lifecycle

	start(): void {
		if (this.timer) return;
		this.stopped = false;
		this.track(this.recover().catch((error: unknown) => this.hub.log.warn({ err: errorText(error) }, "handoff boot recovery stopped")));
		this.timer = setInterval(() => this.track(this.sweep().catch((error: unknown) => this.hub.log.warn({ err: errorText(error) }, "handoff sweep stopped"))), this.hub.timings.sweepMs);
		this.timer.unref();
		this.off = this.hub.ctx.network.peers.onChange((change) => {
			if (change.type === "online" || change.type === "url_changed") this.track(this.reconcilePeer(change.peerId));
		});
	}

	async stop(): Promise<void> {
		this.stopped = true;
		clearInterval(this.timer);
		this.timer = undefined;
		this.off?.();
		this.off = null;
		while (this.tracked.size > 0) await Promise.allSettled([...this.tracked]);
	}

	private track<T>(work: Promise<T>): void {
		const entry: Promise<unknown> = work.then(
			() => undefined,
			() => undefined,
		);
		this.tracked.add(entry);
		void entry.finally(() => this.tracked.delete(entry));
	}

	// ------------------------------------------------------------------ boot

	async recover(): Promise<void> {
		const run: Run = { down: new Set() };
		const rows = this.hub.store.nonTerminal().filter((row) => row.kind === "task");
		const results = await Promise.allSettled(rows.map((row) => this.drive(row.id, "boot", run)));
		for (const result of results) if (result.status === "rejected") throw result.reason;
	}

	// ------------------------------------------------------------------ timers (§7)

	private isDue(row: HandoffRow, now: number): boolean {
		const state = row.state;
		if (row.role === "source") {
			switch (state) {
				case "offered":
					return hasPassed(now, row.expiresAt);
				case "accepted":
				case "awaiting_ack":
					return hasPassed(now, row.deadlineAt);
				case "released":
					return now - this.stateSince(row) >= COMPLETED_GRACE_MS;
				default:
					return false;
			}
		}
		if (PRE_ACK_TARGET_STATES.includes(state) || state === "acked") return hasPassed(now, row.deadlineAt);
		if (state === "resumed") return now - this.stateSince(row) >= this.hub.timings.completeGraceMs;
		return false;
	}

	private async sweep(): Promise<void> {
		if (this.sweeping || this.stopped) return;
		this.sweeping = true;
		try {
			const now = Date.now();
			const run: Run = { down: new Set() };
			const due = this.hub.store.nonTerminal().filter((row) => row.kind === "task" && this.isDue(row, now));
			const results = await Promise.allSettled(due.map((row) => this.drive(row.id, "sweep", run)));
			for (const result of results) if (result.status === "rejected") this.hub.log.warn({ err: errorText(result.reason) }, "handoff sweep step stopped");
		} finally {
			this.sweeping = false;
		}
	}

	/** When the row entered its current state (last timeline event of that state), else its last update. */
	private stateSince(row: HandoffRow): number {
		const events = this.hub.store.events(row.id);
		for (let i = events.length - 1; i >= 0; i--) {
			const event = events[i];
			if (event && event.state === row.state && event.nodeId === this.hub.store.nodeId) return Date.parse(event.at);
		}
		return Date.parse(row.updatedAt);
	}

	// ------------------------------------------------------------------ peer reconnect (§6, §8.2)

	async reconcilePeer(peerId: string): Promise<void> {
		const running = this.reconciling.get(peerId);
		if (running) {
			running.again = true;
			return;
		}
		const state = { again: false };
		this.reconciling.set(peerId, state);
		try {
			do {
				state.again = false;
				if (this.stopped) break;
				await this.reconcileOnce(peerId);
			} while (state.again);
		} catch (error) {
			this.hub.log.warn({ peerId, err: errorText(error) }, "handoff reconcile with a peer stopped");
		} finally {
			this.reconciling.delete(peerId);
		}
	}

	private async reconcileOnce(peerId: string): Promise<void> {
		const run: Run = { down: new Set() };
		const rows = this.hub.store.nonTerminal().filter((row) => row.kind === "task" && row.peerId === peerId);
		const results = await Promise.allSettled(rows.map((row) => this.drive(row.id, "reconcile", run)));
		for (const result of results) if (result.status === "rejected") this.hub.log.warn({ peerId, err: errorText(result.reason) }, "handoff reconcile step stopped");
		await this.followReleased(peerId, run);
	}

	/**
	 * Returning-source reconcile (§8.2) for handoffs this node already released: if the peer reports a higher epoch than the task row
	 * shows (the release never finished adopting it), confirm the fence and adopt the new executor.
	 */
	private async followReleased(peerId: string, run: Run): Promise<void> {
		const tasks = this.hub.ctx.tasks.store;
		const rows = this.hub.store.list({ role: "source", kind: "task" }).filter((row) => row.peerId === peerId && (row.state === "released" || row.state === "completed") && row.fencingToken !== null);
		for (const row of rows) {
			try {
				const task = tasks.find(row.subjectId);
				if (!task || (task.fenced && task.highestSeenEpoch >= row.toEpoch && task.executorNodeId === row.targetNodeId)) continue;
				const peek = await this.peek(row, run);
				const status = peek.status;
				if (!status || status.role !== "target" || !ACKED_TARGET_STATES.includes(status.state) || status.taskEpoch <= task.epoch) continue;
				await this.hub.lock.run(row.id, async () => this.follow(row, status.taskEpoch));
			} catch (error) {
				FaultGuard(error);
				this.hub.log.warn({ handoffId: row.id, err: errorText(error) }, "could not reconcile a released handoff with its target");
			}
		}
	}

	// ------------------------------------------------------------------ one handoff

	private async drive(id: string, mode: Mode, run: Run): Promise<void> {
		if (this.driving.has(id) || (this.stopped && mode !== "boot")) return;
		this.driving.add(id);
		try {
			const first = this.hub.store.find(id);
			if (!first || first.kind !== "task" || isTerminalState(first)) return;
			const gathered = await this.gather(first, mode, run);
			const outcome = await this.hub.lock.run(id, async () => this.decide(first, gathered));
			if (outcome) await this.perform(outcome.row, outcome.decision, gathered);
		} catch (error) {
			FaultGuard(error);
			this.hub.log.warn({ handoffId: id, mode, err: errorText(error) }, "handoff recovery step failed");
		} finally {
			this.driving.delete(id);
		}
	}

	// ------------------------------------------------------------------ facts

	private wantsPeer(row: HandoffRow, mode: Mode, now: number): boolean {
		const state = row.state;
		if (row.role === "source") {
			switch (state) {
				case "accepted":
				case "awaiting_ack":
					return mode !== "sweep" || hasPassed(now, row.deadlineAt);
				case "ack_timeout":
				case "released":
					return mode !== "sweep";
				default:
					return false;
			}
		}
		if (PRE_ACK_TARGET_STATES.includes(state)) return mode !== "sweep";
		if (state === "acked") return mode !== "sweep" || hasPassed(now, row.deadlineAt);
		return false;
	}

	private async gather(row: HandoffRow, mode: Mode, run: Run): Promise<Gathered> {
		const now = Date.now();
		const facts: RecoveryFacts = { now, expiresAt: row.expiresAt, deadlineAt: row.deadlineAt };
		let ack: LearnedAck | null = null;
		let status: wire.HandoffStatusResponse | null = null;

		if (row.role === "source") {
			facts.ackRecorded = row.fencingToken !== null && row.ackAt !== null;
			const task = this.hub.ctx.tasks.store.find(row.subjectId);
			if (task) facts.localEpoch = task.epoch;
			if (row.state === "released") facts.graceElapsed = now - this.stateSince(row) >= COMPLETED_GRACE_MS;
			if (this.wantsPeer(row, mode, now)) {
				const peek = await this.peek(row, run);
				facts.targetReachable = peek.reachable;
				status = peek.status;
				if (status && status.role === "target") {
					const acked = ACKED_TARGET_STATES.includes(status.state);
					let verified = !acked;
					if (acked) {
						if (row.fencingToken) verified = true;
						else {
							ack = this.verifyLearnedAck(row, status);
							verified = ack !== null;
						}
					}
					if (verified) {
						// A retryable failure (the target's user may retry) is "still restoring" to the source: keep waiting until the deadline.
						const failureCode = status.failure?.code;
						const retryable = status.state === "failed" && RETRYABLE_TARGET_FAILURES.some((code) => code === failureCode);
						facts.targetState = retryable ? null : (status.state as TargetState);
						if (acked) facts.peerEpoch = status.taskEpoch;
						if (status.state === "resumed" || status.state === "completed") facts.resumeConfirmed = true;
					} else {
						facts.targetState = null;
					}
				}
			}
			return { facts, ack, status };
		}

		facts.manifestStored = HandoffManifest.safeParse(row.manifest).success;
		facts.steps = this.hub.store.steps(row.id).map((s) => ({ n: s.n, state: s.state as StepStatus }));
		const meta = row.meta;
		const fromSource = this.hub.store.events(row.id).filter((e) => e.nodeId === row.sourceNodeId);
		facts.sourceReclaimed = meta.sourceReclaimed === true || fromSource.some((e) => e.state === "reclaimed");
		facts.sourceCancelled = meta.sourceCancelled === true || fromSource.some((e) => e.state === "cancelled" || e.state === "expired");
		if (row.state === "acked") {
			facts.ackResponseReceived = this.hub.ctx.tasks.store.outboxByKey(row.peerId, `handoff.ack:${row.id}`)?.state === "sent";
		}
		if (row.state === "owner") facts.sessionHasTurns = await this.sessionHasTurns(row);
		if (row.state === "resumed") facts.graceElapsed = now - this.stateSince(row) >= this.hub.timings.completeGraceMs;
		if (this.wantsPeer(row, mode, now)) {
			const peek = await this.peek(row, run);
			status = peek.status;
			if (status && status.role === "source") {
				if (status.state === "reclaimed") facts.sourceReclaimed = true;
				else if (status.state === "cancelled" || status.state === "expired" || status.state === "failed") facts.sourceCancelled = true;
				else if (status.state === "acked" || status.state === "released" || status.state === "completed") facts.ackResponseReceived = true;
				if (status.state === "released" || status.state === "completed") facts.resumeConfirmed = true;
			}
		}
		return { facts, ack, status };
	}

	/** The target's ack as the source would have verified it itself: hash-bound token signed with the pinned key of the peer. */
	private verifyLearnedAck(row: HandoffRow, status: wire.HandoffStatusResponse): LearnedAck | null {
		const peer = this.hub.ctx.network.peers.row(row.peerId);
		if (!peer || !status.fencingToken || !row.manifestSha256) return null;
		if (status.manifestSha256 && status.manifestSha256 !== row.manifestSha256) return null;
		const verdict = verifyFencingToken(status.fencingToken, { publicKey: peer.publicKey, handoffId: row.id, manifestSha256: row.manifestSha256, taskId: row.subjectId, epoch: row.toEpoch });
		if (!verdict.ok) {
			this.hub.log.warn({ handoffId: row.id, reason: verdict.reason }, "the target reports an ack whose fencing token does not verify; not releasing");
			return null;
		}
		return { fencingToken: status.fencingToken, ackAt: status.ackAt ?? new Date().toISOString(), targetSessionId: status.targetSessionId ?? null };
	}

	private async sessionHasTurns(row: HandoffRow): Promise<boolean | undefined> {
		if (!row.targetSessionId) return false;
		try {
			const page = await this.hub.ctx.sessions.messages(row.targetSessionId, { limit: 1 });
			return page.total > 0;
		} catch (error) {
			this.hub.log.warn({ handoffId: row.id, err: errorText(error) }, "could not read the new session's transcript to decide on the resume prompt");
			return undefined;
		}
	}

	/** `GET /handoffs/:id` on the other node. An unreachable peer is remembered for the rest of the run. */
	private async peek(row: HandoffRow, run: Run): Promise<Peek> {
		if (run.down.has(row.peerId)) return { reachable: false, status: null };
		const peer = this.hub.ctx.network.peers.row(row.peerId);
		if (!peer || peer.status === "revoked" || !peer.url) {
			run.down.add(row.peerId);
			return { reachable: false, status: null };
		}
		try {
			const reply = await this.hub.ctx.network.client.request<unknown>(peer.url, { method: "GET", path: `/handoffs/${row.id}`, retry: false, signal: AbortSignal.timeout(PEER_QUERY_TIMEOUT_MS) });
			const parsed = wire.HandoffStatusResponse.safeParse(reply.body);
			if (!parsed.success) {
				this.hub.log.warn({ handoffId: row.id, peerId: row.peerId }, "a peer answered a handoff status query with something unreadable");
				return { reachable: true, status: null };
			}
			return { reachable: true, status: parsed.data };
		} catch (error) {
			const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
			if (typeof status === "number" && status > 0) {
				// The peer answered (404: it has no such handoff, 403: capability revoked ...): reachable, but no state to learn.
				this.hub.log.debug({ handoffId: row.id, peerId: row.peerId, status }, "handoff status query was refused");
				return { reachable: true, status: null };
			}
			this.hub.log.debug({ handoffId: row.id, peerId: row.peerId, err: errorText(error) }, "peer unreachable for a handoff status query");
			run.down.add(row.peerId);
			return { reachable: false, status: null };
		}
	}

	// ------------------------------------------------------------------ decide (under the handoff lock)

	/** Re-read the row, apply the decision table and persist the state hops BEFORE any side effect. `null` = the state moved meanwhile. */
	private decide(seen: HandoffRow, gathered: Gathered): { row: HandoffRow; decision: RecoveryDecision } | null {
		let row = this.hub.store.find(seen.id);
		if (!row || row.state !== seen.state || isTerminalState(row)) return null;
		const decision = recoveryAction(row.role as HandoffRole, row.state as HandoffState, gathered.facts);
		let next = decision.nextState;
		// `acked → released` is source.finishRelease's own hop.
		if (decision.action === "finish_release" && next === "released") next = undefined;
		if (decision.action === "finish_release" && row.state !== "acked" && !row.fencingToken && !gathered.ack) {
			return { row, decision: { action: "none", reason: "no valid durable ack: the source never releases on silence" } };
		}
		if (next && next !== row.state) {
			const summary = `Recovery: ${decision.reason}`;
			const failure = this.failureOf(row, decision, gathered);
			row = this.hub.advance(row.id, next, {
				summary,
				...(failure && { failure }),
				...(next === "acked" && gathered.ack && !row.fencingToken && { patch: { fencingToken: gathered.ack.fencingToken, ackAt: gathered.ack.ackAt, ...(gathered.ack.targetSessionId && { targetSessionId: gathered.ack.targetSessionId }) } }),
			});
		}
		return { row, decision };
	}

	private failureOf(row: HandoffRow, decision: RecoveryDecision, gathered: Gathered): { code: HandoffFailureCode; detail: string; step: number | null } | undefined {
		if (decision.nextState !== "failed") return undefined;
		if (decision.failureCode) return { code: decision.failureCode, detail: decision.reason, step: null };
		// Source side: the target ended the handoff; keep its reason.
		const reported = HandoffFailureCode.safeParse(gathered.status?.failure?.code);
		const code: HandoffFailureCode = reported.success ? reported.data : gathered.facts.targetState === "cancelled" ? "cancelled" : "session_failed";
		return { code, detail: gathered.status?.failure?.detail || decision.reason, step: gathered.status?.failure?.step ?? null };
	}

	// ------------------------------------------------------------------ perform

	private async perform(row: HandoffRow, decision: RecoveryDecision, gathered: Gathered): Promise<void> {
		const { hub } = this;
		this.hub.log.debug({ handoffId: row.id, role: row.role, state: row.state, action: decision.action, reason: decision.reason }, "handoff recovery");
		if (row.role === "source") {
			switch (decision.action) {
				case "restart_prepare":
					await hub.source.resume(row.id);
					return;
				case "resend_offer":
					if (!this.requeue(row, "handoff.offer")) await hub.source.resume(row.id);
					return;
				case "expire":
				case "mark_failed":
					await this.unfreeze(row);
					return;
				case "finish_release":
					hub.fence.fence(row.subjectId, row.toEpoch, "the target holds a valid ack");
					await hub.source.finishRelease(row.id);
					return;
				case "fence_and_follow_owner":
					await hub.lock.run(row.id, async () => this.follow(row, gathered.facts.peerEpoch ?? row.toEpoch));
					return;
				default:
					// none, await_user, enter_ack_timeout (the row stays frozen and owner), mark_completed, query_target: nothing beyond the persisted state.
					return;
			}
		}
		switch (decision.action) {
			case "refetch_manifest":
				// The offer body is persisted with the row, so a row without a manifest cannot be repaired (no wire call returns it).
				hub.advance(row.id, "failed", { summary: "Recovery: the manifest was not stored and cannot be fetched again", failure: { code: "manifest_invalid", detail: "Only the offer metadata was stored before the restart; ask the source to offer again.", step: null } });
				await this.cleanup(row);
				return;
			case "reevaluate_acceptance":
			case "resend_resume_if_no_turns":
				await hub.target.resume(row.id);
				return;
			case "resume_step":
				if (decision.step?.n === 9 && row.state === "acked") await hub.target.ackConfirmed(row.id);
				else await hub.target.resume(row.id);
				return;
			case "resend_ack":
				if (!this.requeue(row, "handoff.ack")) await hub.target.resume(row.id);
				return;
			case "acquire_after_deadline":
				// §6.4(b): retried until the deadline, no reclaim seen: the durable hash-bound ack makes this node the owner at the new epoch.
				hub.note(row.id, "Ack unanswered until the deadline and no reclaim seen: acquiring ownership at the new epoch");
				await hub.target.ackConfirmed(row.id);
				return;
			case "mark_failed":
				await this.stopSession(row);
				await this.cleanup(row);
				return;
			case "cleanup":
				await this.cleanup(row);
				return;
			default:
				// owner → resumed (the new session already has turns): ordinary task recovery, which the boot fence scan held back for this handoff.
				if (decision.nextState === "resumed" && hub.fence.blockedResume(row.subjectId)) await hub.ctx.tasks.executor.resumeInDoubt(row.subjectId);
				return;
		}
	}

	/** Put the call of `kind` back in the outbox queue: a dead/cancelled row goes back to pending. `false` when it was never queued. */
	private requeue(row: HandoffRow, kind: "handoff.offer" | "handoff.ack"): boolean {
		const store = this.hub.ctx.tasks.store;
		const item = store.outboxByKey(row.peerId, `${kind}:${row.id}`);
		if (!item) return false;
		if (item.state === "dead" || item.state === "cancelled") {
			store.updateOutbox(item.id, { state: "pending", attempts: 0, nextAttemptAt: new Date().toISOString(), lastError: null, lastStatus: null });
		}
		if (item.state !== "sent") this.hub.ctx.tasks.outbox.kick(row.peerId);
		return true;
	}

	/** The handoff ended without a release: the source stays owner. Lift the freeze and, if boot left the task in doubt, resume its session. */
	private async unfreeze(row: HandoffRow): Promise<void> {
		try {
			this.hub.fence.unfreeze(row.subjectId, row.id);
			if (this.hub.fence.blockedResume(row.subjectId)) await this.hub.ctx.tasks.executor.resumeInDoubt(row.subjectId);
		} catch (error) {
			FaultGuard(error);
			this.hub.log.warn({ handoffId: row.id, err: errorText(error) }, "could not unfreeze the task after the handoff ended");
		}
	}

	/** §8.2: confirm the task fenced, adopt the peer's owner/epoch on the task row (`handed_off`, executor columns), stop its runtime. Idempotent. */
	private async follow(row: HandoffRow, peerEpoch: number): Promise<void> {
		const tasks = this.hub.ctx.tasks.store;
		const task = tasks.find(row.subjectId);
		if (!task) return;
		const adopted = task.fenced && task.highestSeenEpoch >= peerEpoch && task.executorNodeId === row.targetNodeId && (task.status === "handed_off" || isTerminalStatus(task.status as TaskStatus));
		if (adopted) return;
		this.hub.fence.fence(task.id, peerEpoch, `the task continues on ${row.targetNodeName} at epoch ${peerEpoch}`);
		tasks.update(task.id, {
			executorNodeId: row.targetNodeId,
			executorNodeName: row.targetNodeName,
			executorAgentId: row.targetAgentId,
			executorAgentName: row.targetAgentName,
			...(!isTerminalStatus(task.status as TaskStatus) && { status: "handed_off" }),
		});
		if (task.executorSessionId) {
			try {
				await this.hub.ctx.runtime.stop(task.executorSessionId);
			} catch (error) {
				this.hub.log.debug({ handoffId: row.id, err: errorText(error) }, "the fenced task's runtime was already stopped");
			}
		}
		this.hub.note(row.id, `Task continues on ${row.targetNodeName}`);
		this.hub.changed(row.id);
	}

	private async stopSession(row: HandoffRow): Promise<void> {
		if (!row.targetSessionId) return;
		try {
			await this.hub.ctx.runtime.stop(row.targetSessionId);
		} catch (error) {
			this.hub.log.debug({ handoffId: row.id, err: errorText(error) }, "the new session of a failed handoff was not running");
		}
	}

	/** §6.3 cleanup of what this node created for the handoff: its artifact directory. Never touches the user's checkout or folders. */
	private async cleanup(row: HandoffRow): Promise<void> {
		try {
			// A task target also has a frozen task row, an unused session and restored files to remove (only what the handoff created).
			if (row.role === "target" && row.kind === "task") await this.hub.target.cleanup(row.id);
			await rm(this.hub.dir(row.id), { recursive: true, force: true });
			this.hub.store.patchMeta(row.id, { cleanedUp: true });
			this.hub.changed(row.id);
		} catch (error) {
			FaultGuard(error);
			this.hub.log.warn({ handoffId: row.id, err: errorText(error) }, "handoff cleanup failed");
		}
	}
}
