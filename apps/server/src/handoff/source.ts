import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { NetworkError, ulid, wire } from "@clam/agent-network";
import type { RuntimeSession } from "@clam/agent-runtime";
import { type CreateTaskHandoffBody, HandoffFailureCode, type HandoffState, type I18nMessage, i18nMsg, plainMsg } from "@clam/contracts";
import { peerAgents, projects, workspaceMembers } from "@clam/database";
import { scanForSecrets } from "@clam/git-engine";
import { computeDeadlines, detectEnvironment, extendDeadline, type ManifestArtifactRef, restoreDeadlineFrom, sealManifest, verifyFencingToken } from "@clam/handoff-engine";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { z } from "zod";
import { ApiError } from "../http/errors.ts";
import { errorText } from "../network/util.ts";
import { MAX_ARTIFACT_BYTES } from "../tasks/artifacts.ts";
import type { TaskRow } from "../tasks/store.ts";
import { FaultInjected } from "./fault.ts";
import { type HandoffHub, type HandoffOutboxItem, RETRYABLE_TARGET_FAILURES, type SourceApi } from "./hub.ts";
import { HandoffPreparer, PrepareFailure } from "./source-prepare.ts";
import { isTerminalState, newHandoffId, type HandoffRow } from "./store.ts";

/** The preparation was overtaken (cancelled, restarted): stop quietly, whoever did that owns the row now. */
class PrepareAborted extends Error {}

const nowIso = (): string => new Date().toISOString();
const sleep = (ms: number): Promise<void> => {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
};

/** A turn that does not stop within this long fails the preparation (`timeout`). */
const SETTLE_TIMEOUT_MS = 60_000;
const SETTLE_POLL_MS = 100;
const STATUS_QUERY_TIMEOUT_MS = 10_000;
const SUMMARY_MAX_CHARS = 60_000;
const FALLBACK_MESSAGES = 3;
const FALLBACK_MESSAGE_CHARS = 1500;
const FINISHED_TODO = new Set(["completed", "abandoned", "done", "cancelled"]);
/** Target states that mean it holds a durable ack for this handoff. */
const ACKED_PEER_STATES = new Set(["acked", "owner", "resumed", "completed"]);
const PROGRESS_STATES = new Set(["persisted", "files_restored", "context_restored", "deps_ready", "validated", "session_created"]);
const PRE_ACK_STATES: readonly HandoffState[] = ["accepted", "awaiting_ack", "ack_timeout"];
const AFTER_ACK_STATES: readonly HandoffState[] = ["acked", "released", "completed"];

/**
 * Source side of a task handoff (docs/handoff-protocol.md §1–4, §6.1): validates and starts the handoff, builds the sealed package in the
 * background (summary, git/files/none, environment, contexts, thread), tracks accept/ack/progress of the target, releases the task only after
 * a valid durable ack, and lets the user cancel, extend, reclaim or retry. Every state goes through `hub.transition`/`hub.advance`
 * (persisted before the side effect); the task is frozen from `preparing` until the handoff ends without a release.
 */
export class SourceFlow implements SourceApi {
	private readonly jobs = new Set<Promise<void>>();
	private readonly preparer: HandoffPreparer;

	constructor(private readonly hub: HandoffHub) {
		this.preparer = new HandoffPreparer(hub);
	}

	private get ctx() {
		return this.hub.ctx;
	}

	private get store() {
		return this.hub.store;
	}

	private get tasks() {
		return this.hub.ctx.tasks;
	}

	// ------------------------------------------------------------------ lifecycle

	/** Background work (preparation, release): failures are logged; a simulated crash (`FaultInjected`) just ends the job. */
	private track(work: Promise<void>): void {
		const tracked = work
			.catch((error: unknown) => {
				if (error instanceof FaultInjected) this.hub.log.warn({ point: error.point }, "handoff source job stopped by a simulated crash");
				else this.hub.log.error({ err: errorText(error) }, "handoff source work failed");
			})
			.finally(() => this.jobs.delete(tracked));
		this.jobs.add(tracked);
	}

	async stop(): Promise<void> {
		while (this.jobs.size > 0) await Promise.allSettled([...this.jobs]);
	}

	// ------------------------------------------------------------------ create

	async create(body: z.infer<typeof CreateTaskHandoffBody>): Promise<HandoffRow> {
		const task = this.tasks.store.find(body.taskId);
		if (!task) throw ApiError.notFound("Task");
		this.assertHandable(task);
		const peer = this.ctx.network.peers.row(body.targetNodeId);
		if (!peer || peer.status === "revoked") throw ApiError.notFound("Peer");
		this.hub.assertPeerCapable(peer.id, "received");
		this.assertSenderReachable(task, peer.id, peer.name);
		const agentName = this.targetAgentName(peer.id, body.targetAgentId);
		this.assertTurnPolicy(task, body.stopRunning);

		// Everything up to the freeze is synchronous: no prompt can slip in between the busy check and the freeze.
		const id = newHandoffId();
		this.hub.fence.freeze(task.id, id);
		let row: HandoffRow;
		try {
			this.store.insert({
				id,
				kind: "task",
				role: "source",
				state: "draft",
				peerId: peer.id,
				subjectId: task.id,
				title: task.title,
				workspaceId: task.workspaceId,
				projectId: task.projectId,
				sourceNodeId: this.ctx.identity.nodeId,
				sourceNodeName: this.hub.nodeName(),
				sourceAgentId: task.executorAgentId,
				sourceAgentName: task.executorAgentName,
				sourceSessionId: task.executorSessionId,
				targetNodeId: peer.id,
				targetNodeName: peer.name,
				targetAgentId: body.targetAgentId ?? null,
				targetAgentName: agentName,
				fromEpoch: task.epoch,
				toEpoch: task.epoch + 1,
				vcs: "none",
				includeTranscript: body.includeTranscript,
				correlationId: ulid(),
				meta: { setupCommands: body.setupCommands, checkCommand: body.checkCommand ?? null, stopRunning: body.stopRunning },
			});
			this.store.appendEvent(id, { state: "draft", summary: i18nMsg("Handoff of \"{title}\" to {peer} created", { title: task.title, peer: peer.name }) });
			row = this.hub.advance(id, "preparing", { summary: i18nMsg("Preparing the handoff package for {peer}", { peer: peer.name }) });
		} catch (error) {
			if (!(error instanceof FaultInjected)) this.hub.fence.unfreeze(task.id, id);
			throw error;
		}
		this.track(this.hub.lock.run(id, () => this.prepare(id)));
		return row;
	}

	private assertHandable(task: TaskRow): void {
		if (task.direction !== "incoming" || task.executorNodeId !== this.ctx.identity.nodeId) {
			throw new ApiError(409, "not_executor", i18nMsg("Only the node that executes a task can hand it off"));
		}
		if (task.status !== "running" && task.status !== "blocked") {
			throw new ApiError(409, "task_not_active", i18nMsg("The task is {status}; only a running or blocked task can be handed off", { status: task.status }), { status: task.status });
		}
		if (this.hub.fence.isFenced(task.id)) throw new ApiError(409, "task_fenced", i18nMsg("This node no longer owns the task"));
		// A handoff whose preparation failed holds nothing: the user may start another one (or retry that one).
		const live = this.store.bySubject(task.id, "source").find((r) => !isTerminalState(r) && r.state !== "prepare_failed");
		if (live || this.hub.fence.isFrozen(task.id)) {
			throw new ApiError(409, "competing_handoff", i18nMsg("Another handoff of this task is already in progress"), { holderId: live?.id ?? null });
		}
	}

	/** The task's sender must stay reachable for the target: either it IS the sender, or both are members of the task's workspace here (the target re-checks at its step 1). */
	private assertSenderReachable(task: TaskRow, targetId: string, targetName: string): void {
		if (targetId === task.senderNodeId) return;
		const members = this.ctx.db
			.select({ id: workspaceMembers.memberId })
			.from(workspaceMembers)
			.where(and(eq(workspaceMembers.workspaceId, task.workspaceId), inArray(workspaceMembers.memberId, [targetId, task.senderNodeId]), isNull(workspaceMembers.revokedAt)))
			.all()
			.map((r) => r.id);
		const missing = [targetId, task.senderNodeId].filter((m) => !members.includes(m));
		if (missing.length > 0) {
			const who = missing.map((m) => (m === targetId ? targetName : task.senderNodeName)).join(" and ");
			throw new ApiError(409, "sender_unreachable", i18nMsg("{who} must be a member of the task's workspace so that {target} can report to {sender}, who delegated the task", { who, target: targetName, sender: task.senderNodeName }), { missing });
		}
	}

	/** The requested agent must be one the target advertises when this node knows its agent list; returns its name. */
	private targetAgentName(peerId: string, agentId: string | undefined): string | null {
		if (!agentId) return null;
		const cached = this.ctx.db.select().from(peerAgents).where(eq(peerAgents.peerId, peerId)).all();
		if (cached.length === 0) return null;
		const found = cached.find((a) => a.agentId === agentId);
		if (!found) throw new ApiError(400, "unknown_agent", i18nMsg("The target node does not offer that agent"));
		return found.name;
	}

	private assertTurnPolicy(task: TaskRow, stopRunning: boolean): void {
		const sessionId = task.executorSessionId;
		if (sessionId && !stopRunning && this.ctx.sessions.isTurnRunning(sessionId)) {
			throw new ApiError(409, "session_busy", i18nMsg("The agent is in the middle of a turn. Let it finish, or hand off with stopRunning to abort the turn first"));
		}
	}

	// ------------------------------------------------------------------ preparation

	private checkpoint(id: string): void {
		const row = this.store.find(id);
		if (!row || row.state !== "preparing") throw new PrepareAborted();
	}

	private async prepare(id: string): Promise<void> {
		const row = this.store.find(id);
		if (!row || row.state !== "preparing") return;
		try {
			await this.build(row);
		} catch (error) {
			if (error instanceof FaultInjected) throw error;
			if (error instanceof PrepareAborted) return;
			const failure = error instanceof PrepareFailure ? error : new PrepareFailure("manifest_invalid", plainMsg(errorText(error, 500)));
			this.hub.log.warn({ handoffId: id, code: failure.code, detail: failure.detail }, "handoff preparation failed");
			this.failPreparation(id, failure);
		}
	}

	private failPreparation(id: string, failure: PrepareFailure): void {
		const current = this.store.find(id);
		if (!current || current.state !== "preparing") return;
		const row = this.hub.transition(id, "prepare_failed", { from: ["preparing"], summary: i18nMsg("Preparation failed: {detail}", { detail: failure.detail.text }), failure: { code: failure.code, detail: failure.detail, step: null }, notify: false });
		this.endWithoutRelease(row, i18nMsg("Handoff {id} was not completed ({detail}); {node} stays the executor", { id, detail: failure.detail.text, node: row.sourceNodeName }));
	}

	private async build(row: HandoffRow): Promise<void> {
		const id = row.id;
		let task = this.tasks.store.get(row.subjectId);
		const peer = this.ctx.network.peers.row(row.peerId);
		if (!peer || peer.status === "revoked") throw new PrepareFailure("manifest_invalid", i18nMsg("The target node is no longer paired with this node"));
		const meta = row.meta;
		const sessionId = task.executorSessionId;

		// A restarted/retried preparation starts clean: nothing of an earlier attempt may leak into the package.
		await rm(this.hub.dir(id), { recursive: true, force: true });
		this.store.deleteArtifacts(id);
		const dir = this.hub.dir(id);

		if (meta.stopRunning === true && sessionId && this.ctx.sessions.isTurnRunning(sessionId)) {
			await this.ctx.sessions.abort(sessionId);
			if (!(await this.settle(sessionId, SETTLE_TIMEOUT_MS))) throw new PrepareFailure("timeout", i18nMsg("The agent did not stop within {seconds} s after the abort", { seconds: SETTLE_TIMEOUT_MS / 1000 }));
		}
		this.checkpoint(id);

		// The one timeline event of the source: after it the task is frozen and `lastEventSeq` is final.
		if (typeof this.store.get(id).meta.taskNoteSeq !== "number") {
			const event = this.tasks.store.appendEvent(task.id, { type: "note", summary: i18nMsg("Handing over to {peer} (handoff {id})", { peer: peer.name, id }), payload: { handoffId: id, toNodeId: peer.id } });
			this.store.patchMeta(id, { taskNoteSeq: event.seq });
			this.tasks.changed(task.id, { events: [event] });
		}
		task = this.tasks.store.get(task.id);
		const lastEventSeq = task.lastEventSeq;

		// Conversation summary, plan and model from the live session.
		const live = await this.liveFacts(id, task);
		this.checkpoint(id);

		const project = task.projectId ? this.ctx.db.select().from(projects).where(eq(projects.id, task.projectId)).get() : undefined;
		const outcome = await this.preparer.prepare({ row, task, project, targetName: peer.name });
		for (const note of outcome.notes) this.hub.note(id, note);
		this.checkpoint(id);

		const setupCommands = Array.isArray(meta.setupCommands) ? (meta.setupCommands as string[]) : [];
		const checkCommand = typeof meta.checkCommand === "string" ? meta.checkCommand : null;
		const environment = await detectEnvironment(outcome.dir ?? dir, { setupCommands, checkCommand });

		const contexts = this.ctx.contexts
			.list({ workspaceId: task.workspaceId, shareable: "true" })
			.filter((c) => c.projectId === null || c.projectId === task.projectId)
			.map((c) => ({ id: c.id, version: c.version, sha256: c.sha256 }));
		const thread = this.tasks.store.messages(task.id).map((m) => ({
			id: m.id,
			authorKind: m.authorKind as "human" | "agent" | "system",
			authorNodeId: m.authorNodeId,
			authorNodeName: m.authorNodeName,
			authorAgentId: m.authorAgentId,
			authorAgentName: m.authorAgentName,
			kind: m.kind,
			text: m.text,
			createdAt: m.createdAt,
		}));
		const plan = await this.readPlan(outcome.dir, task.id);

		let transcript: ManifestArtifactRef | null = null;
		if (row.includeTranscript && sessionId) transcript = await this.packTranscript(id, sessionId, dir);
		this.checkpoint(id);

		const deadlines = computeDeadlines(Date.now(), { offerExpiryMs: this.hub.timings.offerExpiryMs, restoreDeadlineMs: this.hub.timings.restoreDeadlineMs });
		const sealed = sealManifest({
			schemaVersion: 1,
			handoffId: id,
			correlationId: row.correlationId,
			createdAt: deadlines.createdAt,
			expiresAt: deadlines.expiresAt,
			deadlineAt: deadlines.deadlineAt,
			task: {
				id: task.id,
				title: task.title,
				description: task.description,
				deliverAs: task.deliverAs === "summary" ? "summary" : task.deliverAs === "files" ? "files" : "branch",
				acceptanceCriteria: [],
				status: task.status === "blocked" ? "blocked" : "running",
				plan,
				todos: live.todos,
				remaining: live.todos.filter((t) => !FINISHED_TODO.has(t.status)).map((t) => (t.phase ? `${t.phase}: ${t.content}` : t.content)),
				sender: { nodeId: task.senderNodeId, nodeName: task.senderNodeName, agentId: task.senderAgentId, agentName: task.senderAgentName },
				constraints: task.constraints,
				taskCorrelationId: task.correlationId,
				lastEventSeq,
				repo: task.repoUrl === null ? null : { url: task.repoUrl, branch: task.repoBranch, commit: task.repoCommit },
				thread,
			},
			workspaceId: task.workspaceId,
			projectId: task.projectId,
			fromEpoch: row.fromEpoch,
			toEpoch: row.toEpoch,
			source: { nodeId: this.ctx.identity.nodeId, name: this.hub.nodeName(), fingerprint: this.ctx.identity.fingerprint, agentId: task.executorAgentId },
			target: { nodeId: peer.id, name: peer.name, fingerprint: peer.fingerprint, agentId: row.targetAgentId },
			vcs: outcome.vcs,
			git: outcome.git,
			files: outcome.files,
			contexts,
			conversationSummary: { text: live.summary.text, generatedBy: live.summary.generatedBy, scanned: true },
			transcript,
			environment,
			requiredFiles: outcome.requiredFiles,
			execution: { ...(live.lastModel && { lastModel: live.lastModel }), progress: {} },
			artifacts: [],
		});
		if (!sealed.ok) {
			if (sealed.code === "secret_detected") {
				throw new PrepareFailure("secret_detected", i18nMsg("Possible secrets were found in the handoff package ({findings}); nothing was sent. Remove them from the conversation or files and retry", { findings: sealed.findings.slice(0, 5).map((f) => `${f.rule} at ${f.path}:${f.line}`).join("; ") }));
			}
			throw new PrepareFailure("manifest_invalid", i18nMsg("The handoff package is invalid: {issues}", { issues: sealed.issues.slice(0, 5).join("; ") }));
		}
		this.checkpoint(id);

		// The canonical JSON is what the target hashes as delivered.
		const manifest = JSON.parse(sealed.canonical) as Record<string, unknown>;
		const offer: wire.HandoffOfferRequest = { handoffId: id, taskId: task.id, fromEpoch: row.fromEpoch, toEpoch: row.toEpoch, manifest, manifestSha256: sealed.sha256, expiresAt: deadlines.expiresAt };
		this.hub.transition(id, "offered", {
			from: ["preparing"],
			summary: i18nMsg("Offered to {peer} ({kind}, manifest {hash})", { peer: peer.name, kind: outcome.vcs === "git" ? "git" : outcome.vcs === "files" ? "folder bundle" : "summary only", hash: sealed.sha256.slice(0, 12) }),
			patch: {
				manifest,
				manifestSha256: sealed.sha256,
				environment,
				conversationSummary: live.summary.text,
				vcs: outcome.vcs,
				includeTranscript: transcript !== null,
				expiresAt: deadlines.expiresAt,
				deadlineAt: deadlines.deadlineAt,
			},
			enqueue: [{ kind: "handoff.offer", path: "/handoffs", body: offer }],
		});
	}

	/** Wait until the session's agent is idle again. */
	private async settle(sessionId: string, timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (this.ctx.sessions.isTurnRunning(sessionId)) {
			if (Date.now() > deadline) return false;
			await sleep(SETTLE_POLL_MS);
		}
		return true;
	}

	/** Todo phases, model and the summary: OMP's own handoff document when it can make one, else one built from the last assistant messages. */
	private async liveFacts(id: string, task: TaskRow): Promise<{ todos: Array<{ phase: string; content: string; status: string }>; lastModel: string | null; summary: { text: string; generatedBy: "omp-handoff" | "clam" } }> {
		const sessionId = task.executorSessionId;
		let runtime: RuntimeSession | null = null;
		let why = "the task has no agent session";
		if (sessionId) {
			try {
				runtime = await this.ctx.sessions.runtime(sessionId);
			} catch (error) {
				why = `the agent runtime could not be opened: ${errorText(error)}`;
			}
		}
		let todos: Array<{ phase: string; content: string; status: string }> = [];
		let lastModel: string | null = null;
		let summary: { text: string; generatedBy: "omp-handoff" | "clam" } | null = null;
		if (runtime) {
			try {
				const state = await runtime.getState();
				todos = state.todoPhases.flatMap((phase) => phase.tasks.map((t) => ({ phase: phase.name, content: t.content, status: t.status })));
				lastModel = state.model ? `${state.model.provider}/${state.model.id}` : null;
			} catch (error) {
				this.hub.log.warn({ handoffId: id, err: errorText(error) }, "could not read the live state of the session for the handoff");
			}
			try {
				const result = await runtime.handoffSummary();
				if (result.text) summary = { text: result.text, generatedBy: "omp-handoff" };
				else why = "the agent runtime produced no handoff document";
			} catch (error) {
				why = errorText(error);
			}
		}
		if (!summary) {
			this.hub.note(id, i18nMsg("The conversation summary was built by CL Agent Mesh from the last assistant messages ({why})", { why }));
			summary = { text: await this.fallbackSummary(task, why), generatedBy: "clam" };
		}
		if (summary.text.length > SUMMARY_MAX_CHARS) summary = { ...summary, text: `${summary.text.slice(0, SUMMARY_MAX_CHARS)}\n\n[summary truncated at ${SUMMARY_MAX_CHARS} characters]` };
		return { todos, lastModel, summary };
	}

	private async fallbackSummary(task: TaskRow, why: string): Promise<string> {
		const lines = [`Summary built by CL Agent Mesh from the last assistant messages (${why}).`, "", `Task: ${task.title}`];
		const sessionId = task.executorSessionId;
		if (sessionId) {
			try {
				const page = await this.ctx.sessions.messages(sessionId, { limit: 40 });
				const answers = page.messages
					.filter((m) => m.role === "assistant")
					.map((m) => m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim())
					.filter((t) => t !== "")
					.slice(-FALLBACK_MESSAGES);
				if (answers.length === 0) lines.push("", "The agent has not written anything yet.");
				for (const answer of answers) lines.push("", answer.length > FALLBACK_MESSAGE_CHARS ? `${answer.slice(0, FALLBACK_MESSAGE_CHARS)}…` : answer);
			} catch (error) {
				lines.push("", `The conversation could not be read (${errorText(error)}).`);
			}
		}
		return lines.join("\n");
	}

	private async readPlan(dir: string | null, taskId: string): Promise<{ planPath: string | null; text: string | null }> {
		if (!dir) return { planPath: null, text: null };
		const relative = `.clmesh/plans/${taskId}.md`;
		const text = await readFile(path.join(dir, relative), "utf8").catch(() => null);
		if (text === null) return { planPath: null, text: null };
		return { planPath: relative, text: text.length > SUMMARY_MAX_CHARS ? `${text.slice(0, SUMMARY_MAX_CHARS)}\n\n[plan truncated]` : text };
	}

	/** Opt-in transcript for reading: `omp session pack` while the runtime is released, size-capped and credential-scanned (best effort). A problem leaves it out, never fails the handoff. */
	private async packTranscript(id: string, sessionId: string, dir: string): Promise<ManifestArtifactRef | null> {
		const target = path.join(dir, "session-pack.tar");
		try {
			await this.ctx.sessions.withConversationFile(sessionId, async (file) => {
				await this.ctx.ompCli.sessionPack(file, target);
			});
			const { size } = await stat(target);
			if (size > MAX_ARTIFACT_BYTES) throw new Error(`the pack is ${size} bytes, over the limit for handoff files`);
			const findings = scanForSecrets((await readFile(target)).toString("utf8"), "session-pack.tar");
			if (findings.length > 0) throw new Error(`it looks like it contains credentials (${[...new Set(findings.map((f) => f.rule))].join(", ")})`);
			return await this.preparer.addArtifact(id, target, "session-pack.tar", "session-pack");
		} catch (error) {
			await rm(target, { force: true });
			this.hub.note(id, i18nMsg("The transcript was left out of the handoff: {error}", { error: errorText(error) }));
			return null;
		}
	}

	// ------------------------------------------------------------------ accept / ack / state from the target

	receiveAccept(peerId: string, id: string, request: wire.HandoffAcceptRequest): wire.HandoffAcceptResponse {
		const row = this.requireSource(id, peerId);
		if (request.epoch !== row.toEpoch) throw this.staleEpoch(row);
		const state = row.state as HandoffState;
		if (state === "offered") {
			this.hub.transition(id, "accepted", {
				from: ["offered"],
				summary: request.targetAgentName ? i18nMsg("{node} accepted the handoff (agent {agent})", { node: row.targetNodeName, agent: request.targetAgentName }) : i18nMsg("{node} accepted the handoff", { node: row.targetNodeName }),
				patch: { targetAgentId: request.targetAgentId ?? row.targetAgentId, targetAgentName: request.targetAgentName ?? row.targetAgentName },
				notify: false,
			});
			return this.toAwaitingAck(id);
		}
		if (state === "accepted") return this.toAwaitingAck(id);
		if (state === "awaiting_ack" || state === "ack_timeout" || AFTER_ACK_STATES.includes(state)) {
			return { handoffId: id, state: "accepted", ...(row.deadlineAt && { deadlineAt: row.deadlineAt }) };
		}
		return { handoffId: id, state: "rejected", reason: `The handoff is ${state}; it no longer wants a target` };
	}

	private toAwaitingAck(id: string): wire.HandoffAcceptResponse {
		const deadlineAt = restoreDeadlineFrom(Date.now(), this.hub.timings.restoreDeadlineMs);
		const row = this.hub.transition(id, "awaiting_ack", { from: ["accepted"], summary: i18nMsg("Waiting for {node} to restore the work and acknowledge", { node: this.store.get(id).targetNodeName }), patch: { deadlineAt }, notify: false });
		return { handoffId: id, state: "accepted", deadlineAt: row.deadlineAt ?? deadlineAt };
	}

	async receiveAck(peerId: string, id: string, request: wire.HandoffAckRequest): Promise<wire.HandoffAckResponse> {
		const row = this.requireSource(id, peerId);
		const state = row.state as HandoffState;
		if (AFTER_ACK_STATES.includes(state)) {
			if (request.epoch === row.toEpoch && request.manifestSha256 === row.manifestSha256 && request.fencingToken === row.fencingToken) return this.ackResponse(row);
			throw new ApiError(409, "ack_mismatch", "This handoff was already acknowledged with different data");
		}
		if (!PRE_ACK_STATES.includes(state)) {
			if (state === "offered") throw new ApiError(409, "not_accepted", i18nMsg("The handoff was not accepted yet"));
			throw this.staleEpoch(row);
		}
		const acked = this.persistAck(row, request);
		this.track(this.finishRelease(id));
		return this.ackResponse(acked);
	}

	/** Verify an ack (hash, epoch, pinned key, fencing token, local ownership) and persist `acked` FIRST. Synchronous: nothing interleaves between the checks and the write. */
	private persistAck(row: HandoffRow, ack: { epoch: number; manifestSha256: string; targetSessionId: string; fencingToken: string; ackedAt: string }): HandoffRow {
		if (ack.epoch !== row.toEpoch) throw this.staleEpoch(row);
		if (!row.manifestSha256 || ack.manifestSha256 !== row.manifestSha256) throw new ApiError(409, "hash_mismatch", "The acknowledgement is for a different manifest than the one offered");
		const task = this.tasks.store.find(row.subjectId);
		if (!task || task.epoch !== row.fromEpoch || task.fenced) throw this.staleEpoch(row);
		const peer = this.ctx.network.peers.row(row.peerId);
		if (!peer || peer.status === "revoked") throw new ApiError(403, "forbidden", i18nMsg("The target is no longer a paired peer"));
		const verdict = verifyFencingToken(ack.fencingToken, { publicKey: peer.publicKey, handoffId: row.id, manifestSha256: row.manifestSha256, taskId: row.subjectId, epoch: row.toEpoch });
		if (!verdict.ok) throw new ApiError(403, "invalid_fencing_token", `The fencing token of the acknowledgement does not verify (${verdict.reason})`);
		return this.hub.advance(row.id, "acked", {
			summary: i18nMsg("{node} acknowledged: the work is restored and its session {session} is ready", { node: row.targetNodeName, session: ack.targetSessionId }),
			patch: { ackAt: ack.ackedAt, fencingToken: ack.fencingToken, targetSessionId: ack.targetSessionId, meta: { ...row.meta, sourceLastEventSeq: task.lastEventSeq } },
			notify: false,
		});
	}

	private ackResponse(row: HandoffRow): wire.HandoffAckResponse {
		const recorded = row.meta.sourceLastEventSeq;
		const task = this.tasks.store.find(row.subjectId);
		return { handoffId: row.id, state: "acked", fencingToken: row.fencingToken as string, sourceLastEventSeq: typeof recorded === "number" ? recorded : (task?.lastEventSeq ?? 0) };
	}

	private staleEpoch(row: HandoffRow): ApiError {
		const task = this.tasks.store.find(row.subjectId);
		return new ApiError(409, "stale_epoch", i18nMsg("Handoff {id} is {state} at epoch {epoch}; the task is at epoch {current}", { id: row.id, state: row.state, epoch: row.toEpoch, current: task?.epoch ?? row.fromEpoch }), { currentEpoch: task?.epoch ?? row.fromEpoch });
	}

	receiveState(peerId: string, id: string, request: wire.HandoffStateRequest): wire.HandoffStateAccepted {
		const accepted: wire.HandoffStateAccepted = { handoffId: id, state: request.state, accepted: true };
		const row = this.store.find(id);
		if (!row || row.role !== "source" || row.peerId !== peerId) {
			this.hub.log.warn({ handoffId: id, peerId, state: request.state }, "state notice for a handoff this node does not hold as source");
			return accepted;
		}
		if (request.epoch !== row.toEpoch) {
			this.hub.log.debug({ handoffId: id, state: request.state, epoch: request.epoch }, "state notice of another epoch ignored");
			return accepted;
		}
		const state = request.state;
		const who = row.targetNodeName;
		if (state === "rejected" || state === "failed" || state === "cancelled") {
			this.targetEnded(row, request);
		} else if (PROGRESS_STATES.has(state)) {
			if (!AFTER_ACK_STATES.includes(row.state as HandoffState) && !this.isEnded(row)) this.hub.note(id, i18nMsg("{node}: {summary}", { node: who, summary: request.summary ?? state.replaceAll("_", " ") }));
		} else if (state === "owner") {
			this.hub.note(id, request.summary ? i18nMsg("{node}: {summary}", { node: who, summary: request.summary }) : i18nMsg("{node}: it owns the task now", { node: who }));
			if (PRE_ACK_STATES.includes(row.state as HandoffState)) this.reconcileLater(peerId);
		} else if (state === "resumed" || state === "completed") {
			this.targetResumed(row, request);
		} else {
			this.hub.log.debug({ handoffId: id, state }, "unknown state notice from the target accepted without effect");
		}
		return accepted;
	}

	private isEnded(row: HandoffRow): boolean {
		return ["rejected", "expired", "cancelled", "reclaimed", "failed", "prepare_failed"].includes(row.state);
	}

	/** The target will not take the task: the source stays the owner and continues. */
	private targetEnded(row: HandoffRow, request: wire.HandoffStateRequest): void {
		const state = row.state as HandoffState;
		const code = HandoffFailureCode.safeParse(request.failure?.code);
		const cancelled = request.state === "cancelled";
		const peerText = request.failure?.detail ?? request.summary;
		const peerI18n = request.failure ? request.failure.i18n : request.summaryI18n;
		const failure = {
			code: code.success ? code.data : cancelled ? ("cancelled" as const) : ("validation_failed" as const),
			detail: peerText !== undefined ? { text: peerText, i18n: peerI18n } : cancelled ? i18nMsg("{node} cancelled the handoff", { node: row.targetNodeName }) : i18nMsg("{node} {state} the handoff", { node: row.targetNodeName, state: request.state }),
			step: request.failure?.step ?? null,
		};
		if (request.state === "failed" && PRE_ACK_STATES.includes(state) && RETRYABLE_TARGET_FAILURES.includes(failure.code)) {
			// The target's user can retry this step: keep waiting (frozen, still the owner); cancel, the ack or the deadline decide.
			const key = `${failure.code}|${request.at}`;
			if (row.meta.lastRetryableFailure !== key) {
				this.store.patchMeta(row.id, { lastRetryableFailure: key });
				this.hub.note(row.id, i18nMsg("{node} reports {code}: {detail}; waiting for it to retry — the restore deadline still applies", { node: row.targetNodeName, code: failure.code, detail: failure.detail.text }));
			}
			return;
		}
		let ended: HandoffRow;
		if (state === "offered") {
			ended = this.hub.transition(row.id, "rejected", { from: ["offered"], summary: i18nMsg("{node} refused the handoff: {detail}", { node: row.targetNodeName, detail: failure.detail.text }), failure, notify: false });
		} else if (PRE_ACK_STATES.includes(state)) {
			ended = this.hub.advance(row.id, "failed", { summary: i18nMsg("{node} could not take over: {detail}", { node: row.targetNodeName, detail: failure.detail.text }), failure, notify: false });
		} else {
			this.hub.note(row.id, i18nMsg("{node} reported {reported} after the handoff was {state}: {detail}", { node: row.targetNodeName, reported: request.state, state, detail: failure.detail.text }));
			return;
		}
		this.endWithoutRelease(ended, i18nMsg("Handoff {id} ended ({detail}); {node} stays the executor", { id: row.id, detail: failure.detail.text, node: ended.sourceNodeName }));
	}

	private targetResumed(row: HandoffRow, request: wire.HandoffStateRequest): void {
		const state = row.state as HandoffState;
		const who = row.targetNodeName;
		if (state === "released") {
			this.hub.advance(row.id, "completed", { summary: i18nMsg("{node} resumed the task; the handoff is complete", { node: who }), nodeId: row.peerId });
		} else if (state === "acked") {
			this.store.patchMeta(row.id, { targetResumed: true });
			this.hub.note(row.id, i18nMsg("{node}: {summary}", { node: who, summary: request.summary ?? "resumed the task" }));
		} else if (PRE_ACK_STATES.includes(state)) {
			// The target claims ownership but this node saw no ack: ask it (status + fencing token) instead of trusting a notice.
			this.hub.note(row.id, i18nMsg("{node} reports it {state} the task; checking its acknowledgement", { node: who, state: request.state }));
			this.reconcileLater(row.peerId);
		}
	}

	private reconcileLater(peerId: string): void {
		this.track(this.hub.recovery.reconcilePeer(peerId));
	}

	// ------------------------------------------------------------------ release

	async finishRelease(id: string): Promise<void> {
		await this.hub.lock.run(id, async () => {
			const row = this.store.get(id);
			this.requireSourceRow(row);
			if (row.state === "released" || row.state === "completed") return;
			if (row.state !== "acked") throw ApiError.conflict(i18nMsg("The handoff is {state}; the task is released only after a valid acknowledgement", { state: row.state }), { state: row.state });
			const task = this.tasks.store.find(row.subjectId);
			const sessionId = task?.executorSessionId ?? null;
			if (task) {
				this.hub.fence.fence(task.id, row.toEpoch, `Handed off to ${row.targetNodeName} (handoff ${id})`);
				if (sessionId) await this.stopRuntime(sessionId, task.id);
				// No status event and no event append: the timeline stays exactly as sealed.
				this.tasks.store.update(task.id, {
					status: "handed_off",
					fenced: true,
					highestSeenEpoch: Math.max(task.highestSeenEpoch, row.toEpoch),
					executorNodeId: row.targetNodeId,
					executorNodeName: row.targetNodeName,
					executorAgentId: row.targetAgentId,
					executorAgentName: row.targetAgentName,
					reason: `Handed off to ${row.targetNodeName} (handoff ${id})`,
					finishedAt: task.finishedAt ?? nowIso(),
				});
				this.tasks.changed(task.id, { notifyPeer: false });
				this.tasks.executor.released(task.id);
				if (sessionId) await this.markSessionMoved(id, sessionId, row.targetNodeName);
			}
			const released = this.hub.advance(id, "released", { summary: i18nMsg("Released: {node} owns the task from epoch {epoch}; this node no longer runs it", { node: row.targetNodeName, epoch: row.toEpoch }) });
			if (released.meta.targetResumed === true) this.hub.advance(id, "completed", { summary: i18nMsg("{node} resumed the task; the handoff is complete", { node: row.targetNodeName }) });
		});
	}

	/** Abort, wait for the agent to settle and stop the process (the conversation stays on disk). */
	private async stopRuntime(sessionId: string, taskId: string): Promise<void> {
		try {
			await this.ctx.sessions.abort(sessionId);
		} catch (error) {
			this.hub.log.warn({ err: errorText(error), taskId }, "aborting the session of a handed-off task failed");
		}
		if (!(await this.settle(sessionId, SETTLE_TIMEOUT_MS / 4))) this.hub.log.warn({ taskId }, "the session of a handed-off task did not settle; stopping its runtime anyway");
		this.ctx.sessions.setSpawnOverrides(sessionId, null);
		await this.ctx.runtime.stop(sessionId);
	}

	/** `omp session moved` so a later resume of the old conversation forks. Best effort: a failure is a timeline note. */
	private async markSessionMoved(id: string, sessionId: string, targetName: string): Promise<void> {
		try {
			const file = this.ctx.sessions.get(sessionId).runtimeSessionFile;
			if (!file) throw new Error("the session has no conversation file");
			await this.ctx.ompCli.sessionMoved(file, targetName);
		} catch (error) {
			this.hub.note(id, i18nMsg("omp session moved did not run: {error}", { error: errorText(error) }));
		}
	}

	// ------------------------------------------------------------------ user actions

	async cancel(id: string): Promise<HandoffRow> {
		const row = this.requireSource(id);
		const state = row.state as HandoffState;
		if (state === "cancelled") return row;
		if (state === "preparing") {
			const failed = this.hub.transition(id, "prepare_failed", {
				from: ["preparing"],
				summary: i18nMsg("Cancelled while preparing"),
				failure: { code: "cancelled", detail: i18nMsg("Cancelled by the user while the handoff package was being prepared"), step: null },
				notify: false,
			});
			this.endWithoutRelease(failed, i18nMsg("Handoff {id} was cancelled; {node} stays the executor", { id, node: failed.sourceNodeName }));
			return failed;
		}
		if (state === "offered" || state === "accepted" || state === "awaiting_ack") {
			const cancelled = this.hub.advance(id, "cancelled", { summary: state === "awaiting_ack" ? i18nMsg("Cancelled by the user; {node} is told to stop restoring", { node: row.targetNodeName }) : i18nMsg("Cancelled by the user") });
			this.endWithoutRelease(cancelled, i18nMsg("Handoff {id} was cancelled; {node} stays the executor", { id, node: cancelled.sourceNodeName }));
			return cancelled;
		}
		if (state === "ack_timeout") throw ApiError.conflict(i18nMsg("The acknowledgement is overdue: extend the deadline or reclaim the task"), { state });
		if (AFTER_ACK_STATES.includes(state)) throw ApiError.conflict(i18nMsg("The target already acknowledged the handoff; it cannot be cancelled any more"), { state });
		throw ApiError.conflict(i18nMsg("The handoff is {state}", { state }), { state });
	}

	async extend(id: string, minutes: number): Promise<HandoffRow> {
		const row = this.requireSource(id);
		const state = row.state as HandoffState;
		if (state !== "awaiting_ack" && state !== "ack_timeout") throw ApiError.conflict(i18nMsg("Only a handoff that waits for the acknowledgement can be extended, not one that is {state}", { state }), { state });
		const deadlineAt = extendDeadline(row.deadlineAt ?? Date.now(), minutes);
		const summary = i18nMsg("Deadline extended by {minutes} min, until {deadline}", { minutes, deadline: deadlineAt });
		const notice = (current: HandoffRow): HandoffOutboxItem => {
			const body: wire.HandoffStateRequest = { epoch: current.toEpoch, state: "extended", summary: summary.text, summaryI18n: summary.i18n, deadlineAt, at: nowIso() };
			return { kind: "handoff.state", path: `/handoffs/${current.id}/state`, body, idempotencyKey: `handoff.state:${current.id}:source:extended:${deadlineAt}` };
		};
		if (state === "ack_timeout") return this.hub.transition(id, "awaiting_ack", { from: ["ack_timeout"], summary, patch: { deadlineAt }, enqueue: [notice(row)], notify: false });
		this.store.transaction(() => {
			this.store.update(id, { deadlineAt });
			this.store.appendEvent(id, { state: "awaiting_ack", summary });
			this.hub.enqueue(row, notice(row));
		});
		this.hub.changed(id);
		return this.store.get(id);
	}

	async reclaim(id: string, override: boolean): Promise<HandoffRow> {
		return this.hub.lock.run(id, async () => {
			let row = this.requireSource(id);
			if (row.state === "reclaimed") return row;
			if (row.state !== "ack_timeout") throw ApiError.conflict(i18nMsg("Only a handoff whose acknowledgement is overdue can be reclaimed, not one that is {state}", { state: row.state }), { state: row.state });
			const probe = await this.queryTarget(row);
			const status = probe.status;
			if (status && ACKED_PEER_STATES.has(status.state)) {
				// The ack arrived but its answer (or the notice) was lost: release instead of reclaiming.
				if (!status.fencingToken || !status.targetSessionId || !status.manifestSha256) {
					throw new ApiError(409, "ack_unverified", i18nMsg("{node} reports it acknowledged the handoff but gave no verifiable proof; reclaiming would risk running the task twice", { node: row.targetNodeName }));
				}
				row = this.persistAck(row, { epoch: status.toEpoch, manifestSha256: status.manifestSha256, targetSessionId: status.targetSessionId, fencingToken: status.fencingToken, ackedAt: status.ackAt ?? nowIso() });
				this.track(this.finishRelease(id));
				return row;
			}
			if (!probe.reachable && !override) {
				const warning = i18nMsg("{node} could not be reached, so there is no proof that it did not acknowledge the handoff. If it did, reclaiming makes both nodes run the task. Reclaim only if you accept that risk.", { node: row.targetNodeName });
				throw new ApiError(409, "override_required", warning, { warning: warning.text });
			}
			// Tombstone epoch: monotonic and never reused, so a late ack of this handoff is refused (stale_epoch).
			const task = this.tasks.store.find(row.subjectId);
			if (task && task.epoch < row.toEpoch) this.tasks.store.update(task.id, { epoch: row.toEpoch, highestSeenEpoch: Math.max(task.highestSeenEpoch, row.toEpoch) });
			const reclaimed = this.hub.transition(id, "reclaimed", {
				from: ["ack_timeout"],
				summary: probe.reachable
					? i18nMsg("Reclaimed by the user ({node} confirmed it did not acknowledge); epoch {epoch} is retired", { node: row.targetNodeName, epoch: row.toEpoch })
					: i18nMsg("Reclaimed by the user (reclaimed on the user's override without reaching the target); epoch {epoch} is retired", { epoch: row.toEpoch }),
			});
			this.endWithoutRelease(reclaimed, i18nMsg("Handoff {id} was reclaimed; {node} continues at epoch {epoch}", { id, node: reclaimed.sourceNodeName, epoch: reclaimed.toEpoch }));
			return reclaimed;
		});
	}

	/** `GET /handoffs/:id` of the target: reachable + its side of the handoff (undefined when it answered but does not know it). */
	private async queryTarget(row: HandoffRow): Promise<{ reachable: boolean; status?: wire.HandoffStatusResponse }> {
		const peer = this.ctx.network.peers.row(row.peerId);
		if (!peer || peer.status === "revoked") return { reachable: false };
		try {
			const response = await this.ctx.network.client.request<unknown>(peer.url, { method: "GET", path: `/handoffs/${row.id}`, retry: false, signal: AbortSignal.timeout(STATUS_QUERY_TIMEOUT_MS) });
			const parsed = wire.HandoffStatusResponse.safeParse(response.body);
			if (!parsed.success) return { reachable: false };
			return { reachable: true, status: parsed.data };
		} catch (error) {
			if (error instanceof NetworkError && error.status === 404) return { reachable: true };
			this.hub.log.debug({ handoffId: row.id, err: errorText(error) }, "the target could not be asked about the handoff");
			return { reachable: false };
		}
	}

	async retry(id: string): Promise<HandoffRow> {
		const row = this.requireSource(id);
		if (row.state !== "prepare_failed") throw ApiError.conflict(i18nMsg("Only a handoff whose preparation failed can be retried, not one that is {state}", { state: row.state }), { state: row.state });
		const task = this.tasks.store.get(row.subjectId);
		this.assertHandable(task);
		const peer = this.ctx.network.peers.row(row.peerId);
		if (!peer || peer.status === "revoked") throw ApiError.notFound("Peer");
		this.hub.assertPeerCapable(peer.id, "received");
		this.assertTurnPolicy(task, row.meta.stopRunning === true);
		this.hub.fence.freeze(task.id, id);
		try {
			this.hub.transition(id, "draft", { from: ["prepare_failed"], summary: i18nMsg("Retrying the handoff"), patch: { failureCode: null, failureDetail: null, failureStep: null, meta: { ...row.meta, taskNoteSeq: undefined } }, notify: false });
			const preparing = this.hub.transition(id, "preparing", { from: ["draft"], summary: i18nMsg("Preparing the handoff package for {peer}", { peer: peer.name }), notify: false });
			this.track(this.hub.lock.run(id, () => this.prepare(id)));
			return preparing;
		} catch (error) {
			if (!(error instanceof FaultInjected)) this.hub.fence.unfreeze(task.id, id);
			throw error;
		}
	}

	// ------------------------------------------------------------------ boot recovery

	async resume(id: string): Promise<void> {
		const row = this.store.find(id);
		if (!row || row.role !== "source" || row.kind !== "task") return;
		switch (row.state as HandoffState) {
			case "preparing":
				this.hub.fence.freeze(row.subjectId, id);
				await this.hub.lock.run(id, () => this.prepare(id));
				return;
			case "offered":
				this.resendOffer(row);
				return;
			case "accepted":
				this.toAwaitingAck(id);
				return;
			case "acked":
				await this.finishRelease(id);
				return;
			case "released":
				if (row.meta.targetResumed === true) this.hub.advance(id, "completed", { summary: i18nMsg("{node} resumed the task; the handoff is complete", { node: row.targetNodeName }) });
				return;
			default:
		}
	}

	/** The offer is idempotent by key: queue it again when the outbox lost it, and revive it when it died before the row learned. */
	private resendOffer(row: HandoffRow): void {
		const existing = this.tasks.store.outboxByKey(row.peerId, `handoff.offer:${row.id}`);
		if (existing?.state === "pending" || existing?.state === "sent") return;
		if (existing) {
			this.tasks.store.updateOutbox(existing.id, { state: "pending", attempts: 0, nextAttemptAt: nowIso() });
			this.tasks.outbox.kick(row.peerId);
			return;
		}
		if (!row.manifest || !row.manifestSha256 || !row.expiresAt) return;
		const offer: wire.HandoffOfferRequest = { handoffId: row.id, taskId: row.subjectId, fromEpoch: row.fromEpoch, toEpoch: row.toEpoch, manifest: row.manifest as Record<string, unknown>, manifestSha256: row.manifestSha256, expiresAt: row.expiresAt };
		this.hub.enqueue(row, { kind: "handoff.offer", path: "/handoffs", body: offer });
	}

	// ------------------------------------------------------------------ shared helpers

	private requireSourceRow(row: HandoffRow): HandoffRow {
		if (row.role !== "source" || row.kind !== "task") throw ApiError.conflict(i18nMsg("This is not a task handoff of this node's source side"));
		return row;
	}

	/** The source row `id`; `peerId` (the wire caller) must be the target. */
	private requireSource(id: string, peerId?: string): HandoffRow {
		const row = this.requireSourceRow(this.store.get(id));
		if (peerId !== undefined && row.peerId !== peerId) throw ApiError.notFound("Handoff");
		return row;
	}

	/**
	 * The handoff ended without moving the task: the task runs here again. Say so on its timeline (only when the sealing note exists), then
	 * unfreeze it; the executor re-prompts an idle agent whose turn the handoff stopped.
	 */
	private endWithoutRelease(row: HandoffRow, why: I18nMessage): void {
		const fresh = this.store.get(row.id);
		if (typeof fresh.meta.taskNoteSeq === "number" && this.tasks.store.find(fresh.subjectId)) {
			const event = this.tasks.store.appendEvent(fresh.subjectId, { type: "note", summary: why, payload: { handoffId: fresh.id, state: fresh.state } });
			this.tasks.changed(fresh.subjectId, { events: [event] });
		}
		this.hub.fence.unfreeze(fresh.subjectId, fresh.id);
	}
}
