import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { wire } from "@clam/agent-network";
import type { DecideHandoffBody, HandoffFailureCode, HandoffState, SetupDecisionBody } from "@clam/contracts";
import { projects, workspaceMembers, workspaces } from "@clam/database";
import { buildResumePrompt, canTransition, checkHandoffEpochs, HandoffManifest, hasPassed, makeFencingToken, restoreDeadlineFrom, type SetupReport, TARGET_STEPS, verifyReceivedManifest } from "@clam/handoff-engine";
import { formatAuthor, strictestApprovalMode, type MessageKind } from "@clam/task-engine";
import { and, eq, isNull } from "drizzle-orm";
import type { z } from "zod";
import { ApiError } from "../http/errors.ts";
import { errorText } from "../network/util.ts";
import { deleteManagedFolder, type ProjectRow } from "../services/project-folders.ts";
import { readNodeSettings } from "../services/settings.ts";
import { restoreContexts } from "./context-restore.ts";
import { FaultInjected } from "./fault.ts";
import { type HandoffHub, type HandoffOutboxItem, HandoffStepError, RETRYABLE_TARGET_FAILURES, type TargetApi } from "./hub.ts";
import { resolveTargetAgent, resolveTargetProject } from "./projects.ts";
import { discardGitRestore, downloadManifestArtifacts, restoreFilesBundle, restoreGit, runGit } from "./restore.ts";
import { type HandoffInsert, type HandoffRow, isTerminalState } from "./store.ts";
import { acquireTaskRow, classifyTask, discardCreatedProject, discardTaskRow, persistTaskRow } from "./target-task.ts";

/** What one step reports: the state it reaches and what is persisted with it. `wait` leaves the step running (a user decision is pending). */
interface StepResult {
	to: HandoffState;
	summary: string;
	detail?: string;
	skipped?: boolean;
	patch?: Partial<HandoffInsert>;
	enqueue?: HandoffOutboxItem[];
	wait?: boolean;
}

type Next = "next" | "stop";

/** Failures the user can fix on the target and run again (`retry`): the failed step is reset and re-entered; nothing is cleaned up. */
const RETRYABLE = RETRYABLE_TARGET_FAILURES;
/** Handoff states in which this node still has no ownership: a source cancel / reclaim / expiry may end the handoff. */
const BEFORE_OWNER: readonly HandoffState[] = ["received", "accepted", "persisted", "files_restored", "context_restored", "deps_ready", "validated", "session_created", "acked"];
const HOLDING_SLOT: readonly HandoffState[] = ["accepted", "persisted", "files_restored", "context_restored", "deps_ready", "validated", "session_created", "acked"];
const RESUME_ATTEMPTS = 3;
const THREAD_PROMPT_CHARS = 30_000;

const stateMoved = (error: unknown): boolean => error instanceof ApiError && error.status === 409 && (error.code === "conflict" || error.code === "illegal_transition");

/**
 * Target side of a task handoff (docs/handoff-protocol.md §3.2, §4 steps 1–10, §6.2). Every step is driven from the persisted state
 * (`resume`), serialized per handoff with `hub.lock`, and re-entrant: the work of a step checks what is already done before acting, then the
 * step is marked done and the state moves. A step that throws a `HandoffStepError` (or anything else, mapped to the most fitting code)
 * ends the handoff as `failed(code)` and tells the source; failures the user can fix on this node stay re-enterable (`retry`).
 */
export class TargetFlow implements TargetApi {
	private readonly jobs = new Set<Promise<unknown>>();
	private readonly graceTimers = new Map<string, NodeJS.Timeout>();

	constructor(private readonly hub: HandoffHub) {}

	// ------------------------------------------------------------------ background work

	private track(work: Promise<unknown>): void {
		const job: Promise<unknown> = work
			.catch((error: unknown) => {
				if (error instanceof FaultInjected) this.hub.log.warn({ err: errorText(error) }, "handoff target work stopped by an injected fault");
				else this.hub.log.error({ err: errorText(error) }, "handoff target work failed");
			})
			.finally(() => this.jobs.delete(job));
		this.jobs.add(job);
	}

	private start(id: string): void {
		this.track(this.resume(id));
	}

	async stop(): Promise<void> {
		for (const timer of this.graceTimers.values()) clearTimeout(timer);
		this.graceTimers.clear();
		await Promise.allSettled([...this.jobs]);
	}

	// ------------------------------------------------------------------ step 1: receive

	async receive(peerId: string, request: wire.HandoffOfferRequest): Promise<{ row: HandoffRow; created: boolean }> {
		const { hub } = this;
		const { store, ctx } = hub;
		// No await before the insert: a concurrent duplicate delivery cannot interleave between the lookup and the insert.
		const existing = store.find(request.handoffId);
		if (existing) {
			if (existing.peerId !== peerId || existing.role !== "target") throw new ApiError(409, "idempotency_conflict", "That handoff id belongs to another handoff");
			return { row: existing, created: false };
		}
		const peer = ctx.network.peers.row(peerId);
		if (!peer || peer.status === "revoked") throw new ApiError(403, "forbidden", "The source is not a paired peer");
		// The target answers the source with accept / ack / state calls, which need handoff.receive granted by the source.
		hub.assertPeerCapable(peerId, "received");

		const verified = verifyReceivedManifest(request.manifest, { expectedSha256: request.manifestSha256, selfNodeId: ctx.identity.nodeId });
		if (!verified.ok) throw new ApiError(verified.code === "expired" ? 409 : 422, verified.code === "expired" ? "offer_expired" : verified.code, verified.detail);
		const manifest = verified.manifest;
		if (manifest.handoffId !== request.handoffId || manifest.task.id !== request.taskId || manifest.fromEpoch !== request.fromEpoch || manifest.toEpoch !== request.toEpoch || manifest.expiresAt !== request.expiresAt) {
			throw new ApiError(422, "manifest_invalid", "The offer does not match its manifest");
		}
		if (manifest.source.nodeId !== peerId) throw new ApiError(403, "forbidden", "The manifest names another node as its source than the one offering it");

		const classified = classifyTask(hub, manifest);
		if ("conflict" in classified) throw ApiError.conflict(classified.conflict);
		const epochs = checkHandoffEpochs(manifest.fromEpoch, manifest.toEpoch, classified.knownEpoch);
		// A sender's mirror of the epoch may lag behind the executor's (the executor change notice is still on its way): tolerated for `home`.
		if (!epochs.ok && !(epochs.reason === "epoch_ahead" && classified.mode === "home")) {
			throw new ApiError(409, "stale_epoch", `This node knows the task at epoch ${epochs.knownEpoch}, the offer starts from ${manifest.fromEpoch}`, { currentEpoch: epochs.knownEpoch });
		}

		const row = store.transaction(() => {
			const inserted = store.insert({
				id: manifest.handoffId,
				kind: "task",
				role: "target",
				state: "received",
				peerId,
				subjectId: manifest.task.id,
				title: manifest.task.title,
				workspaceId: manifest.workspaceId,
				sourceNodeId: manifest.source.nodeId,
				sourceNodeName: manifest.source.name,
				sourceAgentId: manifest.source.agentId,
				targetNodeId: ctx.identity.nodeId,
				targetNodeName: hub.nodeName(),
				targetAgentId: manifest.target.agentId,
				fromEpoch: manifest.fromEpoch,
				toEpoch: manifest.toEpoch,
				vcs: manifest.vcs,
				includeTranscript: manifest.transcript !== null,
				manifest: request.manifest,
				manifestSha256: request.manifestSha256.toLowerCase(),
				conversationSummary: manifest.conversationSummary.text,
				environment: manifest.environment,
				expiresAt: manifest.expiresAt,
				deadlineAt: manifest.deadlineAt,
				correlationId: manifest.correlationId,
			});
			store.initTargetSteps(inserted.id);
			store.setStep(inserted.id, 1, "running");
			store.appendEvent(inserted.id, { state: "received", summary: `Offer received from ${manifest.source.name}: “${manifest.task.title}” (epoch ${manifest.fromEpoch} → ${manifest.toEpoch})` });
			return inserted;
		});
		hub.changed(row.id);

		const refusal = this.policyRefusal(row, manifest, classified.mode);
		if (refusal) {
			hub.setStep(row.id, 1, "failed", refusal.detail);
			hub.transition(row.id, "rejected", { from: ["received"], summary: `Refused: ${refusal.detail}`, failure: { code: refusal.code, detail: refusal.detail, step: 1 } });
			return { row: store.get(row.id), created: true };
		}
		hub.setStep(row.id, 1, "done", "Offer verified (signature, manifest hash, epochs, policy)");
		hub.faultPoint(row.id); // `received` is entered by the insert above, not by a transition: this is its crash point

		if (readNodeSettings(ctx.db).autoAcceptHandoffs) {
			try {
				this.accept(row.id, {});
				this.start(row.id);
			} catch (error) {
				if (!(error instanceof ApiError)) throw error;
				hub.note(row.id, `Not accepted automatically: ${error.message}`);
			}
		}
		return { row: store.get(row.id), created: true };
	}

	/** Node policy: capacity, and the task's sender must be someone this node can report to. A refusal is recorded and shown, not thrown. */
	private policyRefusal(row: HandoffRow, manifest: HandoffManifest, mode: string): { code: HandoffFailureCode; detail: string } | null {
		const { ctx, store } = this.hub;
		const settings = readNodeSettings(ctx.db);
		const inFlight = store.nonTerminal().filter((h) => h.id !== row.id && h.role === "target" && h.kind === "task" && HOLDING_SLOT.includes(h.state as HandoffState)).length;
		const running = ctx.tasks.store.taskCounts().running;
		if (running + inFlight >= settings.maxConcurrentRuntimes) {
			return { code: "capacity", detail: `This node is at its limit of ${settings.maxConcurrentRuntimes} agent session(s) (${running} running, ${inFlight} handoff(s) restoring)` };
		}
		if (!ctx.db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, manifest.workspaceId)).get()) {
			return { code: "policy_denied", detail: "The task's workspace does not exist on this node" };
		}
		const sender = manifest.task.sender;
		if (!sender) return { code: "policy_denied", detail: "The manifest names no sender for the task" };
		if (sender.nodeId === ctx.identity.nodeId) {
			return mode === "home" ? null : { code: "policy_denied", detail: "This node is named as the task's sender but never delegated that task" };
		}
		const senderPeer = ctx.network.peers.row(sender.nodeId);
		if (!senderPeer || senderPeer.status === "revoked") return { code: "policy_denied", detail: `The task's sender (${sender.nodeName}) is not a paired node of this node` };
		const member = ctx.db
			.select()
			.from(workspaceMembers)
			.where(and(eq(workspaceMembers.workspaceId, manifest.workspaceId), eq(workspaceMembers.memberId, sender.nodeId), isNull(workspaceMembers.revokedAt)))
			.get();
		if (!member) return { code: "policy_denied", detail: `The task's sender (${sender.nodeName}) is not a member of that workspace on this node` };
		if (!(senderPeer.receivedCapabilities as string[]).includes("tasks.receive")) {
			return { code: "policy_denied", detail: `The task's sender (${sender.nodeName}) has not granted this node tasks.receive, so results and events could not be reported to it` };
		}
		return null;
	}

	// ------------------------------------------------------------------ the user's decisions

	decide(id: string, body: z.infer<typeof DecideHandoffBody>): Promise<HandoffRow> {
		return this.hub.lock.run(id, async () => {
			const row = this.target(id);
			if (row.state !== "received") throw ApiError.conflict(`Handoff is ${row.state}; only a received offer can be accepted or rejected`, { state: row.state });
			if (body.decision === "reject") {
				return this.hub.transition(id, "rejected", { from: ["received"], summary: `Rejected: ${body.reason}`, failure: { code: "policy_denied", detail: body.reason, step: 1 } });
			}
			const accepted = this.accept(id, { projectId: body.projectId, agentId: body.agentId });
			this.start(id);
			return accepted;
		});
	}

	/** `received → accepted` with the resolved project and agent, and the accept call queued in the same transaction. Synchronous. */
	private accept(id: string, choice: { projectId?: string | undefined; agentId?: string | undefined }): HandoffRow {
		const { hub } = this;
		const { ctx } = hub;
		const row = this.target(id);
		if (row.state !== "received") throw ApiError.conflict(`Handoff is ${row.state}, not a received offer`, { state: row.state });
		if (hasPassed(Date.now(), row.expiresAt)) throw new ApiError(409, "offer_expired", "The offer has expired");
		const manifest = this.manifestOf(row);
		const agent = resolveTargetAgent(ctx, { agentId: choice.agentId ?? row.targetAgentId });
		const { project, created } = resolveTargetProject(ctx, manifest, { projectId: choice.projectId, existingProjectId: row.projectId });
		const at = new Date();
		const body: wire.HandoffAcceptRequest = { epoch: row.toEpoch, targetAgentId: agent.id, targetAgentName: agent.name, acceptedAt: at.toISOString() };
		try {
			return hub.transition(id, "accepted", {
				from: ["received"],
				summary: `Accepted: restoring into ${project.name} with agent ${agent.name}`,
				patch: {
					projectId: project.id,
					targetAgentId: agent.id,
					targetAgentName: agent.name,
					deadlineAt: restoreDeadlineFrom(at, hub.timings.restoreDeadlineMs),
					meta: { ...row.meta, ...(created && { createdProjectId: project.id }) },
				},
				enqueue: [{ kind: "handoff.accept", path: `/handoffs/${id}/accept`, body }],
			});
		} catch (error) {
			// A simulated crash (FaultInjected) happens AFTER the accepted row (which names this project) is durable: nothing to undo.
			if (created && !(error instanceof FaultInjected)) {
				ctx.db.delete(projects).where(eq(projects.id, project.id)).run();
				void deleteManagedFolder(ctx, project);
			}
			throw error;
		}
	}

	async setupDecision(id: string, body: z.infer<typeof SetupDecisionBody>): Promise<HandoffRow> {
		const row = this.target(id);
		if (isTerminalState(row)) throw ApiError.conflict(`Handoff is ${row.state}`, { state: row.state });
		this.hub.setup.decide(id, body);
		this.start(id);
		return this.hub.store.get(id);
	}

	async retry(id: string): Promise<HandoffRow> {
		const { hub } = this;
		const reopened = await hub.lock.run(id, async () => {
			const row = this.target(id);
			const code = row.failureCode as HandoffFailureCode | null;
			const step = row.failureStep;
			if (row.state !== "failed" || code === null || !RETRYABLE.includes(code) || step === null || step < 2 || step > 8) {
				throw ApiError.conflict("This handoff cannot be retried", { state: row.state, code });
			}
			if (hasPassed(Date.now(), row.deadlineAt)) throw ApiError.conflict("The restore deadline has passed; ask the source for a new offer");
			const previous = step === 2 ? "accepted" : (TARGET_STEPS[step - 2]?.doneState ?? "accepted");
			try {
				// `failed` has no way out in the engine's table; a failure the user can fix reopens the SAME row at the state before the failed step.
				hub.store.transaction(() => {
					hub.store.update(id, { state: previous, failureCode: null, failureDetail: null, failureStep: null });
					hub.store.setStep(id, step, "pending", null);
					hub.store.appendEvent(id, { state: previous, summary: `Retrying step ${step} (${TARGET_STEPS[step - 1]?.name ?? step})` });
				});
			} catch (error) {
				if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
					throw new ApiError(409, "competing_handoff", "Another handoff of this work already holds that ownership epoch");
				}
				throw error;
			}
			hub.changed(id);
			return true;
		});
		if (reopened) this.start(id);
		return hub.store.get(id);
	}

	async cancel(id: string): Promise<HandoffRow> {
		const row = this.target(id);
		if (isTerminalState(row)) return row;
		if (!BEFORE_OWNER.includes(row.state as HandoffState)) throw ApiError.conflict("This node already took the task over; cancel the task instead", { state: row.state });
		// Not under the handoff lock: a running step (a long install) must not delay the user. The step finds the state moved and stops.
		this.endNow(row, "cancelled", "Cancelled on this node");
		return this.hub.store.get(id);
	}

	// ------------------------------------------------------------------ source → target notices

	receiveState(peerId: string, id: string, request: wire.HandoffStateRequest): wire.HandoffStateAccepted {
		const { hub } = this;
		const row = this.target(id);
		if (row.peerId !== peerId) throw ApiError.notFound("Handoff");
		const answer: wire.HandoffStateAccepted = { handoffId: id, state: request.state, accepted: true };
		const state = row.state as HandoffState;
		switch (request.state) {
			case "extended":
				if (request.deadlineAt && !isTerminalState(row)) {
					hub.store.update(id, { deadlineAt: request.deadlineAt });
					hub.note(id, `The source extended the restore deadline to ${request.deadlineAt}`);
				}
				break;
			case "expired":
				if (state === "received" || state === "accepted") this.endNow(row, "timeout", request.summary ?? "The offer expired on the source");
				break;
			case "cancelled":
				if (BEFORE_OWNER.includes(state)) this.endNow(row, "cancelled", request.summary ?? "The source cancelled the handoff");
				break;
			case "reclaimed":
				if (BEFORE_OWNER.includes(state)) this.endNow(row, "superseded", request.summary ?? "The source reclaimed the task (stale epoch)");
				else if (!isTerminalState(row)) hub.note(id, "The source reports it reclaimed the task after this node took over; the epoch fence decides the owner");
				break;
			case "released":
				if (state === "resumed") {
					hub.transition(id, "completed", { from: ["resumed"], summary: "The source released the task; the handoff is complete" });
				} else if (state === "owner") {
					hub.store.patchMeta(id, { sourceReleased: true });
				} else if (state === "acked") {
					// The source only releases after it holds our ack: the answer to the ack was lost, ownership may be acquired now.
					this.track(this.ackConfirmed(id));
				}
				break;
			default:
				break;
		}
		return answer;
	}

	/** End a handoff that has not reached ownership (`failed(code)`, or `cancelled` where the table has that edge) and clean up in the background. */
	private endNow(row: HandoffRow, code: HandoffFailureCode, summary: string): void {
		const state = row.state as HandoffState;
		const to: HandoffState = code === "cancelled" && canTransition("target", state, "cancelled") ? "cancelled" : "failed";
		try {
			this.hub.transition(row.id, to, { from: [state], summary, failure: { code, detail: summary, step: null } });
		} catch (error) {
			if (stateMoved(error)) return;
			throw error;
		}
		this.track(this.cleanup(row.id));
	}

	// ------------------------------------------------------------------ driving the steps

	resume(id: string): Promise<void> {
		return this.hub.lock.run(id, async () => {
			this.target(id);
			for (;;) {
				const row = this.hub.store.get(id);
				if (isTerminalState(row)) return;
				if ((await this.advance(row)) === "stop") return;
			}
		});
	}

	private async advance(row: HandoffRow): Promise<Next> {
		let manifest: HandoffManifest;
		try {
			manifest = this.manifestOf(row);
		} catch (error) {
			return this.failStep(row, 2, error);
		}
		switch (row.state as HandoffState) {
			case "accepted":
				return this.step(row, 2, () => this.persist(row, manifest));
			case "persisted":
				return this.step(row, 3, () => this.restoreFiles(row, manifest));
			case "files_restored":
				return this.step(row, 4, () => this.restoreContext(row, manifest));
			case "context_restored":
				return this.step(row, 5, () => this.setupDependencies(row, manifest));
			case "deps_ready":
				return this.step(row, 6, () => this.validate(row, manifest));
			case "validated":
				return this.step(row, 7, () => this.createSession(row, manifest));
			case "session_created":
				return this.step(row, 8, () => this.writeAck(row, manifest));
			case "owner":
				return this.resumeWork(row, manifest);
			case "resumed":
				this.completeAfterResume(row);
				return "stop";
			case "received":
				return this.reevaluate(row, manifest);
			default:
				// received: waits for the user's decision; acked: waits for the source's answer to the ack (`ackConfirmed`).
				return "stop";
		}
	}

	/**
	 * `received` after a restart (docs §6.2): step 1 is re-run when it did not finish, then the acceptance policy is applied again. With
	 * auto-accept the offer moves on exactly as it would have in `receive`; otherwise it keeps waiting for the user's decision.
	 */
	private reevaluate(row: HandoffRow, manifest: HandoffManifest): Next {
		const { hub } = this;
		const { store, ctx } = hub;
		if (store.steps(row.id).find((s) => s.n === 1)?.state !== "done") {
			const classified = classifyTask(hub, manifest);
			const refusal = "conflict" in classified ? { code: "superseded" as const, detail: classified.conflict } : this.policyRefusal(row, manifest, classified.mode);
			if (refusal) {
				hub.setStep(row.id, 1, "failed", refusal.detail);
				hub.transition(row.id, "rejected", { from: ["received"], summary: `Refused: ${refusal.detail}`, failure: { code: refusal.code, detail: refusal.detail, step: 1 } });
				return "stop";
			}
			hub.setStep(row.id, 1, "done", "Offer verified (signature, manifest hash, epochs, policy)");
		}
		if (!readNodeSettings(ctx.db).autoAcceptHandoffs) return "stop";
		try {
			this.accept(row.id, {});
		} catch (error) {
			if (!(error instanceof ApiError)) throw error;
			hub.note(row.id, `Not accepted automatically: ${error.message}`);
			return "stop";
		}
		return "next";
	}

	private async step(row: HandoffRow, n: number, work: () => Promise<StepResult>): Promise<Next> {
		const { hub } = this;
		hub.setStep(row.id, n, "running");
		let out: StepResult;
		try {
			out = await work();
		} catch (error) {
			return this.failStep(row, n, error);
		}
		if (out.wait) {
			hub.changed(row.id);
			return "stop";
		}
		hub.setStep(row.id, n, out.skipped ? "skipped" : "done", out.detail ?? null);
		try {
			hub.transition(row.id, out.to, { from: [row.state as HandoffState], summary: out.summary, ...(out.patch && { patch: out.patch }), ...(out.enqueue && { enqueue: out.enqueue }) });
		} catch (error) {
			if (stateMoved(error)) return "stop"; // cancelled / superseded while the step ran
			throw error;
		}
		return "next";
	}

	private failStep(row: HandoffRow, n: number, error: unknown): Next {
		if (error instanceof FaultInjected) throw error;
		const { hub } = this;
		const failure = this.stepFailure(row, n, error);
		const current = hub.store.get(row.id);
		if (isTerminalState(current)) return "stop"; // cancelled / superseded while the step ran: that outcome stands
		hub.setStep(row.id, n, "failed", failure.message);
		try {
			hub.transition(row.id, "failed", { from: [current.state as HandoffState], summary: `Step ${n} (${TARGET_STEPS[n - 1]?.name ?? n}) failed: ${failure.message}`, failure: { code: failure.code, detail: failure.message, step: failure.step ?? n } });
		} catch (moved) {
			if (stateMoved(moved)) return "stop";
			throw moved;
		}
		// Runs after this step released the lock. Failures the user may fix keep their work for the retry.
		if (!RETRYABLE.includes(failure.code)) this.track(this.cleanup(row.id));
		return "stop";
	}

	private stepFailure(row: HandoffRow, n: number, error: unknown): HandoffStepError {
		if (error instanceof HandoffStepError) return error;
		if (error instanceof Error && "code" in error && error.code === "ENOSPC") return new HandoffStepError("disk_full", "The disk is full", n);
		const byStep: Record<number, HandoffFailureCode> = { 2: "manifest_invalid", 3: row.vcs === "git" ? "git_unavailable" : "manifest_invalid", 4: "manifest_invalid", 5: "deps_failed", 6: "validation_failed", 7: "session_failed", 8: "session_failed" };
		return new HandoffStepError(byStep[n] ?? "manifest_invalid", errorText(error), n);
	}

	// ------------------------------------------------------------------ steps 2–8

	private async persist(row: HandoffRow, manifest: HandoffManifest): Promise<StepResult> {
		await downloadManifestArtifacts(this.hub, row, manifest);
		const project = this.project(row);
		const agent = { id: row.targetAgentId ?? "", name: row.targetAgentName ?? "" };
		if (agent.id === "") throw new HandoffStepError("manifest_invalid", "No agent was chosen for the handoff", 2);
		const mode = persistTaskRow(this.hub, row, manifest, project, agent);
		const files = this.hub.store.artifacts(row.id).length;
		return { to: "persisted", summary: `Stored the task (${mode === "new" ? "new task record" : mode === "home" ? "the task returned to its sender" : "taken back after an earlier handoff"}) and ${files} file(s) of the handoff`, detail: `${files} artifact(s) verified` };
	}

	private async restoreFiles(row: HandoffRow, manifest: HandoffManifest): Promise<StepResult> {
		if (manifest.vcs === "none") return { to: "files_restored", summary: "Nothing to restore (no project files were handed over)", skipped: true, detail: "vcs none" };
		const project = this.project(row);
		if (manifest.vcs === "git") {
			const restored = await restoreGit(this.hub, row, manifest, project);
			if (manifest.task.deliverAs === "branch") this.hub.ctx.tasks.store.patchExecState(manifest.task.id, { prepared: restored.prepared });
			return { to: "files_restored", summary: `Files restored: ${restored.detail}`, detail: restored.detail };
		}
		const detail = await restoreFilesBundle(this.hub, row, manifest, project);
		return { to: "files_restored", summary: `Files restored: ${detail}`, detail };
	}

	private async restoreContext(row: HandoffRow, manifest: HandoffManifest): Promise<StepResult> {
		if (manifest.contexts.length === 0) return { to: "context_restored", summary: "No shared context was referenced", skipped: true };
		const detail = await restoreContexts(this.hub, row, manifest);
		return { to: "context_restored", summary: `Context restored: ${detail}`, detail };
	}

	private async setupDependencies(row: HandoffRow, manifest: HandoffManifest): Promise<StepResult> {
		const { hub } = this;
		const outcome = await hub.setup.setupAndValidate(row.id, {
			dir: this.project(row).path,
			environment: manifest.environment,
			requiredFiles: manifest.requiredFiles,
			gitCommit: manifest.git?.commit ?? null,
			checkCommand: null,
			phase: "setup",
		});
		if (outcome.status === "waiting") {
			const waitingFor = JSON.stringify(outcome.pending);
			if (row.meta.waitingFor !== waitingFor) {
				hub.store.patchMeta(row.id, { waitingFor });
				hub.note(row.id, `Waiting for approval of ${outcome.pending.length} setup command(s)`);
			}
			return { to: "deps_ready", summary: "Waiting for setup approval", wait: true };
		}
		hub.store.patchMeta(row.id, { setupReport: outcome.report, waitingFor: undefined });
		const detail = `${outcome.report.ran.length} command(s) ran, ${outcome.report.skipped.length} skipped`;
		return { to: "deps_ready", summary: `Dependencies ready: ${detail}`, detail };
	}

	private async validate(row: HandoffRow, manifest: HandoffManifest): Promise<StepResult> {
		const { hub } = this;
		const outcome = await hub.setup.setupAndValidate(row.id, {
			dir: this.project(row).path,
			environment: manifest.environment,
			requiredFiles: manifest.requiredFiles,
			gitCommit: manifest.git?.commit ?? null,
			checkCommand: null,
			phase: "validate",
		});
		if (outcome.status === "waiting") {
			hub.note(row.id, `Waiting for approval of ${outcome.pending.length} setup command(s)`);
			return { to: "validated", summary: "Waiting for setup approval", wait: true };
		}
		hub.store.patchMeta(row.id, { setupReport: outcome.report });
		const detail = outcome.report.validation ?? "validated";
		return { to: "validated", summary: `Workspace validated: ${detail}`, detail };
	}

	/** Step 7: a NEW session for the new owner (never the source's), opened but not prompted. */
	private async createSession(row: HandoffRow, manifest: HandoffManifest): Promise<StepResult> {
		const { hub } = this;
		const { ctx } = hub;
		const project = this.project(row);
		let sessionId = row.targetSessionId;
		if (sessionId) {
			try {
				ctx.sessions.get(sessionId);
			} catch {
				sessionId = null; // gone (cleanup of an earlier attempt): create a fresh one
			}
		}
		if (!sessionId) {
			sessionId = ctx.sessions.create({ projectId: project.id, title: `Task: ${manifest.task.title}`.slice(0, 120) }, { agentId: row.targetAgentId }).id;
			hub.store.update(row.id, { targetSessionId: sessionId });
		}
		ctx.tasks.store.update(manifest.task.id, { executorSessionId: sessionId });
		// The runtime process is spawned with the task's approval mode and cost cap from its first moment.
		const approvalMode = strictestApprovalMode(readNodeSettings(ctx.db).approvalMode, manifest.task.constraints.approvalMode);
		ctx.sessions.setSpawnOverrides(sessionId, manifest.task.constraints.maxCostUsd === undefined ? { approvalMode } : { approvalMode, maxCostUsd: manifest.task.constraints.maxCostUsd });
		await ctx.sessions.runtime(sessionId);
		return { to: "session_created", summary: `New agent session ${sessionId} created on ${hub.nodeName()} (nothing was sent to it yet)`, detail: sessionId, patch: { targetSessionId: sessionId } };
	}

	/** Step 8: the fencing token, then ONE transaction: state `acked` + `ackAt` + token + the queued `handoff.ack` call. */
	private async writeAck(row: HandoffRow, manifest: HandoffManifest): Promise<StepResult> {
		const { hub } = this;
		const { ctx } = hub;
		if (!row.targetSessionId || row.manifestSha256 === null) throw new HandoffStepError("session_failed", "The new session or the manifest hash is missing", 8);
		const fencingToken = makeFencingToken({ taskId: manifest.task.id, epoch: row.toEpoch, handoffId: row.id, manifestSha256: row.manifestSha256, sign: (message) => ctx.identity.sign(message) });
		const ackedAt = new Date().toISOString();
		const body: wire.HandoffAckRequest = {
			epoch: row.toEpoch,
			targetSessionId: row.targetSessionId,
			manifestSha256: row.manifestSha256,
			validation: { gitCommit: manifest.git?.commit ?? null, workspaceClean: await this.workspaceMatches(row, manifest), depsOk: true },
			ackedAt,
			fencingToken,
		};
		return {
			to: "acked",
			summary: "Acknowledgement written; sending it to the source",
			detail: `ack at ${ackedAt}`,
			patch: { ackAt: ackedAt, fencingToken },
			enqueue: [{ kind: "handoff.ack", path: `/handoffs/${row.id}/ack`, body }],
		};
	}

	/** The restored tree holds exactly what the manifest says: no tracked change beyond the files of the applied patch. */
	private async workspaceMatches(row: HandoffRow, manifest: HandoffManifest): Promise<boolean> {
		if (manifest.vcs !== "git" || !manifest.git || !row.projectId) return true;
		try {
			const { dir } = await this.hub.ctx.gitService.resolve(row.projectId);
			const changed = (await runGit(dir, ["status", "--porcelain", "--untracked-files=no"])).stdout
				.split("\n")
				.filter((l) => l.trim() !== "")
				.map((l) => l.slice(3).split(" -> ").pop() ?? "");
			const allowed = new Set(manifest.git.patchArtifact?.files ?? []);
			return changed.every((p) => allowed.has(p));
		} catch {
			return false;
		}
	}

	// ------------------------------------------------------------------ steps 9–10

	/**
	 * Step 9, called when the source answered the ack (or by recovery once the deadline passed, §6.4): the task row takes the new epoch and
	 * this node's executor columns, then `acked → owner` is persisted together with the notice to the task's sender.
	 */
	ackConfirmed(id: string, response?: wire.HandoffAckResponse): Promise<void> {
		return this.hub.lock.run(id, async () => {
			const { hub } = this;
			const row = this.target(id);
			if (row.state !== "acked") {
				// Already owner (a repeated confirmation), or ended (superseded): nothing to acquire.
				if (row.state === "owner") this.start(id);
				return;
			}
			const manifest = this.manifestOf(row);
			const base = this.eventSeqBase(row, manifest, response);
			acquireTaskRow(hub, row, manifest, base);
			const sender = manifest.task.sender;
			const enqueue: HandoffOutboxItem[] = [];
			if (sender && row.fencingToken && row.manifestSha256 && sender.nodeId !== hub.ctx.identity.nodeId) {
				const notice: wire.TaskExecutorChange = {
					epoch: row.toEpoch,
					handoffId: row.id,
					manifestSha256: row.manifestSha256,
					fencingToken: row.fencingToken,
					fromNodeId: manifest.source.nodeId,
					agentId: row.targetAgentId,
					agentName: row.targetAgentName,
					sessionId: row.targetSessionId,
					eventSeqBase: base,
					at: new Date().toISOString(),
				};
				enqueue.push({ kind: "task.executor", path: `/tasks/${manifest.task.id}/executor`, body: notice, peerId: sender.nodeId, idempotencyKey: `task.executor:${row.id}` });
			}
			hub.setStep(id, 9, "done", `epoch ${row.toEpoch} acquired`);
			hub.transition(id, "owner", { from: ["acked"], summary: `Ownership acquired at epoch ${row.toEpoch}${response ? " (the source confirmed the ack)" : ""}`, enqueue });
			if (row.meta.pendingCancel === true) {
				this.track(hub.ctx.tasks.executor.cancel(manifest.task.id, { reason: "The sender cancelled the task while it was being handed over", by: "sender" }));
			}
			this.start(id);
		});
	}

	/** The seq the previous executor ended at; fixed once so a re-entry (crash between the task update and the state) uses the same value. */
	private eventSeqBase(row: HandoffRow, manifest: HandoffManifest, response?: wire.HandoffAckResponse): number {
		const known = row.meta.eventSeqBase;
		if (typeof known === "number") return known;
		const base = Math.max(manifest.task.lastEventSeq, response?.sourceLastEventSeq ?? 0);
		this.hub.store.patchMeta(row.id, { eventSeqBase: base });
		return base;
	}

	/** Step 10: the resume prompt in the new session (idempotent per client id, and not at all when the session already has turns). */
	private async resumeWork(row: HandoffRow, manifest: HandoffManifest): Promise<Next> {
		const { hub } = this;
		const { ctx } = hub;
		const sessionId = row.targetSessionId;
		if (!sessionId) throw new Error("The handoff owns the task but has no session");
		acquireTaskRow(hub, row, manifest, this.eventSeqBase(row, manifest)); // idempotent: re-adopts after a restart between steps 9 and 10
		hub.setStep(row.id, 10, "running");
		let sent = false;
		for (let attempt = 1; attempt <= RESUME_ATTEMPTS && !sent; attempt += 1) {
			try {
				const page = await ctx.sessions.messages(sessionId, { limit: 1 });
				if (page.total === 0) {
					const transcriptPath = await this.unpackTranscript(row, manifest);
					const message = await this.resumeMessage(row, manifest, transcriptPath);
					await ctx.sessions.prompt(sessionId, { message, clientId: `handoff_${row.id}_resume` });
					hub.fence.unblockResume(manifest.task.id); // the resume prompt IS the continuation: no restart-recovery prompt on top of it
				} else if (hub.fence.blockedResume(manifest.task.id)) {
					// The session already has turns (the prompt went out before a crash): ordinary task recovery takes over, which boot held back.
					await ctx.tasks.executor.resumeInDoubt(manifest.task.id);
				}
				sent = true;
			} catch (error) {
				if (error instanceof FaultInjected) throw error;
				hub.log.warn({ handoffId: row.id, attempt, err: errorText(error) }, "sending the handoff resume prompt failed");
				if (attempt === RESUME_ATTEMPTS) {
					hub.note(row.id, `The resume prompt could not be sent (${errorText(error)}); it is retried when the handoff is resumed again`);
					return "stop";
				}
			}
		}
		for (const m of ctx.tasks.store.messages(manifest.task.id)) if (m.injectedSessionId === null) ctx.tasks.store.markInjected(m.id, sessionId);
		hub.setStep(row.id, 10, "done", "Resume prompt sent");
		try {
			const resumed = hub.transition(row.id, "resumed", { from: ["owner"], summary: `Resume prompt sent in session ${sessionId}; the task continues on ${hub.nodeName()}` });
			this.completeAfterResume(resumed);
		} catch (error) {
			if (!stateMoved(error)) throw error;
		}
		return "stop";
	}

	private async resumeMessage(row: HandoffRow, manifest: HandoffManifest, transcriptPath: string | undefined): Promise<string> {
		const setupReport = (row.meta.setupReport ?? { ran: [], skipped: [] }) as SetupReport;
		const base = buildResumePrompt(manifest, { localPaths: { workDir: this.project(row).path, ...(transcriptPath && { transcriptPath }) }, setupReport });
		const thread = this.hub.ctx.tasks.store.messages(manifest.task.id);
		if (thread.length === 0) return base;
		let lines = thread.map((m) => `- ${formatAuthor({ kind: m.authorKind as "human" | "agent" | "system", agentName: m.authorAgentName, nodeName: m.authorNodeName })} (${m.kind as MessageKind}, ${m.createdAt}): ${m.text.replace(/\n/g, "\n  ")}`);
		while (lines.length > 1 && lines.join("\n").length > THREAD_PROMPT_CHARS) lines = lines.slice(1);
		return `${base}\n\n## Discussion thread so far\nThe task's discussion continues here; these messages are already part of this brief.\n${lines.join("\n")}`;
	}

	/** Best effort: the old transcript (opt-in) unpacked into a reference folder of its own, never into the project. */
	private async unpackTranscript(row: HandoffRow, manifest: HandoffManifest): Promise<string | undefined> {
		const { hub } = this;
		const known = hub.store.get(row.id).meta.transcriptPath;
		if (typeof known === "string") return known;
		if (!manifest.transcript) return undefined;
		const pack = hub.store.artifact(row.id, manifest.transcript.artifactId);
		if (!pack) return undefined;
		try {
			const cwd = path.join(hub.dir(row.id), "transcript");
			mkdirSync(cwd, { recursive: true });
			const { sessionFile } = await hub.ctx.ompCli.sessionUnpack(pack.path, cwd);
			hub.store.patchMeta(row.id, { transcriptPath: sessionFile });
			return sessionFile;
		} catch (error) {
			hub.log.warn({ handoffId: row.id, err: errorText(error) }, "the old transcript could not be unpacked; continuing without it");
			return undefined;
		}
	}

	// ------------------------------------------------------------------ resumed → completed

	/** The source's `released` (or the grace period) completes the handoff: it has been effective since the ack. */
	private completeAfterResume(row: HandoffRow): void {
		const { hub } = this;
		if (hub.store.get(row.id).meta.sourceReleased === true) {
			hub.transition(row.id, "completed", { from: ["resumed"], summary: "The source had released the task; the handoff is complete" });
			return;
		}
		if (this.graceTimers.has(row.id)) return;
		const timer = setTimeout(() => {
			this.graceTimers.delete(row.id);
			this.track(
				hub.lock.run(row.id, async () => {
					if (hub.store.get(row.id).state === "resumed") hub.transition(row.id, "completed", { from: ["resumed"], summary: "Grace period passed; the handoff has been effective since the ack" });
				}),
			);
		}, hub.timings.completeGraceMs);
		timer.unref();
		this.graceTimers.set(row.id, timer);
	}

	// ------------------------------------------------------------------ cleanup (§6.3)

	/** Remove only what this handoff created, after it ended without ownership. Idempotent; runs under the handoff lock, after any running step. */
	cleanup(id: string): Promise<void> {
		const { hub } = this;
		return hub.lock.run(id, async () => {
			const row = hub.store.get(id);
			if (row.meta.cleanedUp === true) return;
			const notes: string[] = [];
			const task = hub.ctx.tasks.store.find(row.subjectId);
			const frozenHere = task !== undefined && task.execState.handoffId === id;
			if (task && row.targetSessionId && frozenHere) {
				try {
					hub.ctx.tasks.store.update(task.id, { executorSessionId: null });
					await hub.ctx.sessions.remove(row.targetSessionId);
					hub.store.update(id, { targetSessionId: null });
					notes.push("discarded the unused session");
				} catch (error) {
					notes.push(`could not discard the session (${errorText(error)})`);
				}
			}
			const parsed = HandoffManifest.safeParse(row.manifest);
			try {
				const text = await discardTaskRow(hub, row);
				if (text) notes.push(text.toLowerCase());
				if (parsed.success && parsed.data.vcs === "git") {
					const git = await discardGitRestore(hub, row, parsed.data);
					if (git) notes.push(git.charAt(0).toLowerCase() + git.slice(1));
				}
				const project = await discardCreatedProject(hub, row);
				if (project) notes.push(project.charAt(0).toLowerCase() + project.slice(1));
				await rm(hub.dir(id), { recursive: true, force: true });
				notes.push("removed the downloaded files");
			} catch (error) {
				notes.push(`cleanup stopped early (${errorText(error)})`);
			}
			hub.store.patchMeta(id, { cleanedUp: true });
			hub.note(id, `Cleaned up: ${notes.join("; ")}`);
		});
	}

	// ------------------------------------------------------------------ small helpers

	private target(id: string): HandoffRow {
		const row = this.hub.store.get(id);
		if (row.role !== "target" || row.kind !== "task") throw ApiError.conflict("This is not a task handoff received by this node");
		return row;
	}

	private manifestOf(row: HandoffRow): HandoffManifest {
		const parsed = HandoffManifest.safeParse(row.manifest);
		if (!parsed.success) throw new HandoffStepError("manifest_invalid", "The stored manifest is not valid", 2);
		return parsed.data;
	}

	private project(row: HandoffRow): ProjectRow {
		if (!row.projectId) throw new HandoffStepError("manifest_invalid", "No project was chosen for the handoff", 2);
		const project = this.hub.ctx.db.select().from(projects).where(eq(projects.id, row.projectId)).get();
		if (!project) throw new HandoffStepError("checkout_conflict", "The project chosen for the handoff no longer exists on this node", 3);
		return project;
	}
}
