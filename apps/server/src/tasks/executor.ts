import { ulid } from "@clam/agent-network";
import type { SessionEvent, TaskResult, TaskStatus } from "@clam/contracts";
import { agents, projects, workspaceMembers } from "@clam/database";
import { buildBrief, buildCompletionReminder, buildResumePrompt, formatAuthor, hasPendingQuestion, isTerminalStatus, normalizeRepoUrl, strictestApprovalMode, type MessageKind } from "@clam/task-engine";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { wire } from "@clam/agent-network";
import { ApiError } from "../http/errors.ts";
import { createManagedProject } from "../services/project-folders.ts";
import { MAX_ARTIFACT_BYTES } from "./artifacts.ts";
import { errorText, KeyedLock } from "../network/util.ts";
import { readNodeSettings } from "../services/settings.ts";
import { execState, type BlockedFor, type ExecState } from "./exec-state.ts";
import type { DecideInput, ExecutorApi, TaskHub } from "./hub.ts";
import type { TaskMessageRow, TaskRow } from "./store.ts";
import type { PreparedFolder } from "./files.ts";
import { TaskBlockedError, TaskFailedError, TaskGit, type PreparedBranch, type ProjectRef } from "./task-git.ts";

type Completion = NonNullable<ExecState["completion"]>;

const NO_SUMMARY = "The agent finished without a summary.";
/** A message that arrived this recently and is not in the session yet is about to start another turn (see `onSettled`). */
const INJECTION_GRACE_MS = 30_000;
/** Messages that unblock a task which waits for the discussion (not for an approval or for the human fixing the tree). */
const UNBLOCKED_BY_MESSAGE: readonly BlockedFor[] = ["question", "agent", "aborted"];

/**
 * Executor side of the task engine: accepts delegated tasks, queues them per project working tree, runs each in a
 * normal agent session of this node and finalises it from `mesh_complete` (or the session's last answer). All
 * decisions on a running task are serialised per task id (`lock`), so runtime events, `mesh_complete`, messages and
 * cancellation never interleave halfway through a transition.
 */
export class TaskExecutor implements ExecutorApi {
	private readonly lock = new KeyedLock();
	/** In-flight runs and recoveries, awaited by `stop()`. */
	private readonly runs = new Set<Promise<void>>();
	private readonly sessionTasks = new Map<string, string>();
	private readonly finalising = new Set<string>();
	/** Fenced tasks whose agent ended a turn successfully after the fence: the next `settled` is its late result. */
	private readonly finishedWhileFenced = new Set<string>();
	/** Distinguishes the resume prompt of this boot from earlier ones (prompt idempotency is per client id). */
	private readonly bootId = ulid();
	private unsubscribe: (() => void) | null = null;
	private taskGit: TaskGit | null = null;
	private stopped = true;

	constructor(private readonly hub: TaskHub) {}

	private get store() {
		return this.hub.store;
	}

	private get ctx() {
		return this.hub.ctx;
	}

	private get fence() {
		return this.ctx.handoffs.fence;
	}

	private git(): TaskGit {
		this.taskGit ??= new TaskGit({ gitService: this.ctx.gitService, git: this.ctx.git, artifacts: this.hub.artifacts, nodeName: () => this.hub.nodeName(), log: this.hub.log, assertOwner: (taskId) => this.fence.assertOwner(taskId) });
		return this.taskGit;
	}

	// ------------------------------------------------------------------ lifecycle

	async start(): Promise<void> {
		this.stopped = false;
		this.unsubscribe = this.ctx.runtime.onEvent((sessionId, event) => this.onRuntimeEvent(sessionId, event));
		for (const task of this.store.list({ direction: "incoming", statuses: ["running", "blocked"] })) {
			// A fenced task is never started, resumed or retried.
			if (task.fenced) continue;
			if (this.fence.isFrozen(task.id) || (task.executorSessionId && this.fence.blockedResume(task.id))) {
				// A handoff holds the task, or one is in doubt (§8.3): only the spawn settings survive; nothing is prompted until it is settled.
				if (task.executorSessionId) this.registerOverrides(task, task.executorSessionId);
				continue;
			}
			const state = execState(task);
			if (task.status === "running" || state.blockedFor === "approval") {
				this.track(this.recover(task));
			} else if (task.executorSessionId) {
				// Waiting for a message or for the human: only the spawn settings must survive the restart.
				this.registerOverrides(task, task.executorSessionId);
			}
		}
		this.drain();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.unsubscribe?.();
		this.unsubscribe = null;
		await Promise.allSettled([...this.runs]);
	}

	private track(work: Promise<void>): void {
		const tracked = work
			.catch((error: unknown) => this.hub.log.error({ err: errorText(error) }, "task executor work failed"))
			.finally(() => this.runs.delete(tracked));
		this.runs.add(tracked);
	}

	// ------------------------------------------------------------------ receiving and deciding

	async receive(peerId: string, request: wire.CreateTaskRequest): Promise<{ row: TaskRow; created: boolean }> {
		// No await before the insert: a concurrent duplicate delivery cannot interleave between the lookup and the insert.
		const existing = this.store.find(request.taskId);
		if (existing) {
			if (existing.peerId !== peerId || existing.direction !== "incoming") throw new ApiError(409, "idempotency_conflict", "That task id belongs to another task");
			return { row: existing, created: false };
		}
		const peer = this.ctx.network.peers.row(peerId);
		if (!peer || peer.status === "revoked") throw new ApiError(403, "forbidden", "The sender is not a paired peer");
		const member = this.ctx.db
			.select()
			.from(workspaceMembers)
			.where(and(eq(workspaceMembers.workspaceId, request.workspaceId), eq(workspaceMembers.memberId, peerId), isNull(workspaceMembers.revokedAt)))
			.get();
		if (!member) throw new ApiError(403, "forbidden", "The sender is not a member of that workspace on this node");
		const ref = request.projectRef ?? null;
		const repo = ref ? normalizeRepoUrl(ref.repoUrl) : null;
		if (ref && !repo) throw ApiError.badRequest("projectRef.repoUrl is not a GitHub repository URL");
		if (!ref && request.deliverAs === "branch") throw ApiError.badRequest("A task delivered as a branch needs projectRef (the GitHub repository)");
		if (request.inputFiles && request.inputFiles.size > MAX_ARTIFACT_BYTES) throw new ApiError(413, "input_too_large", "The input files are larger than this node accepts");
		const agent = request.targetAgentId ? this.ompAgent(request.targetAgentId) : null;
		if (request.targetAgentId && !agent) throw new ApiError(400, "unknown_agent", "The requested agent does not exist on this node");

		const row = this.store.insert({
			id: request.taskId,
			direction: "incoming",
			peerId,
			workspaceId: request.workspaceId,
			title: request.title,
			description: request.description,
			status: "offered",
			epoch: request.epoch,
			repoUrl: repo?.url ?? null,
			repoBranch: ref?.branch ?? null,
			repoCommit: ref?.commit ?? null,
			deliverAs: request.deliverAs,
			inputFiles: request.inputFiles ?? null,
			constraints: request.constraints,
			senderNodeId: peerId,
			senderNodeName: peer.name,
			senderAgentId: request.sender.agentId ?? null,
			senderAgentName: request.sender.agentName ?? null,
			executorNodeId: this.ctx.identity.nodeId,
			executorNodeName: this.hub.nodeName(),
			executorAgentId: agent?.id ?? null,
			executorAgentName: agent?.name ?? null,
			correlationId: request.correlationId,
		});
		const event = this.store.appendEvent(row.id, { type: "status", summary: `Offered by ${peer.name}`, payload: { from: null, to: "offered", reason: null } });
		const candidates = repo ? this.candidateProjects(repo.key) : [];
		const onlyCandidate = candidates.length === 1 ? candidates[0] : undefined;
		// A task without a repository needs no matching project: auto-accepting gives it a folder of its own.
		if (peer.autoAcceptTasks && (!repo || onlyCandidate)) {
			try {
				this.accept(row, onlyCandidate ? { projectId: onlyCandidate.id } : {});
			} catch (error) {
				this.hub.log.warn({ err: errorText(error), taskId: row.id }, "auto-accepting a delegated task failed; it stays offered");
			}
		}
		this.hub.changed(row.id, { events: [event] });
		return { row: this.store.get(row.id), created: true };
	}

	async decide(taskId: string, body: DecideInput): Promise<TaskRow> {
		const task = this.store.get(taskId);
		if (task.direction !== "incoming") throw ApiError.conflict("Only the node that executes a task can accept or reject it");
		if (body.decision === "reject") {
			const { event } = this.store.transition(taskId, "rejected", { reason: body.reason, from: ["offered"] });
			this.hub.changed(taskId, { events: [event] });
			return this.store.get(taskId);
		}
		return this.accept(task, { projectId: body.projectId, agentId: body.agentId });
	}

	/** `offered` (or tree-`blocked`) → `accepted` in a resolved project, then start whatever the queue allows. Synchronous. */
	private accept(task: TaskRow, choice: { projectId?: string; agentId?: string }): TaskRow {
		const reaccept = task.status === "blocked";
		if (task.status !== "offered" && !(reaccept && execState(task).blockedFor === "tree")) {
			throw ApiError.conflict(`Task is ${task.status}; only an offered task (or one blocked on its working tree) can be accepted`, { status: task.status });
		}
		const project = task.repoUrl === null ? this.folderProject(task, choice.projectId) : this.repoProject(task, choice.projectId);
		const agentId = choice.agentId ?? task.executorAgentId;
		const agent = agentId ? this.ompAgent(agentId) : this.ctx.db.select().from(agents).where(eq(agents.runtime, "omp")).orderBy(asc(agents.createdAt)).get();
		if (!agent) throw agentId ? new ApiError(400, "unknown_agent", "The agent does not exist on this node") : ApiError.unavailable("This node has no OMP agent configured");

		const { event } = this.store.transition(task.id, "accepted", {
			patch: { projectId: project.id, executorAgentId: agent.id, executorAgentName: agent.name },
			from: ["offered", "blocked"],
		});
		this.store.patchExecState(task.id, { blockedFor: undefined });
		this.hub.changed(task.id, { events: [event] });
		this.drain();
		return this.store.get(task.id);
	}

	/** Project of a task linked to a GitHub repository: the one asked for, else the only local project of that repository. */
	private repoProject(task: TaskRow, chosen: string | undefined) {
		const key = normalizeRepoUrl(task.repoUrl ?? "")?.key ?? "";
		const candidates = this.candidateProjects(key);
		const projectId = chosen ?? task.projectId ?? (candidates.length === 1 ? candidates[0]?.id : undefined);
		if (!projectId) {
			throw new ApiError(409, "project_required", candidates.length === 0 ? "No local project is linked to this repository; choose a project explicitly" : "Several local projects match this repository; choose one", {
				candidates: candidates.map((p) => p.id),
			});
		}
		const project = this.ctx.db.select().from(projects).where(eq(projects.id, projectId)).get();
		if (!project) throw ApiError.notFound("Project");
		if (!project.repository || `${project.repository.owner}/${project.repository.name}`.toLowerCase() !== key) {
			throw new ApiError(409, "project_mismatch", "That project is not linked to the task's repository");
		}
		return project;
	}

	/**
	 * Project of a task without a repository: a local project the human chose (of the task's workspace), the one already
	 * assigned, or a fresh managed folder created for this task only.
	 */
	private folderProject(task: TaskRow, chosen: string | undefined) {
		const projectId = chosen ?? task.projectId;
		if (projectId) {
			const project = this.ctx.db.select().from(projects).where(eq(projects.id, projectId)).get();
			if (!project) throw ApiError.notFound("Project");
			if (project.workspaceId !== task.workspaceId) throw new ApiError(409, "project_mismatch", "That project belongs to another workspace than the task");
			return project;
		}
		return createManagedProject(this.ctx, { workspaceId: task.workspaceId, name: `Task ${task.id.slice(-6)}: ${task.title}`.slice(0, 80) });
	}

	private ompAgent(id: string) {
		return this.ctx.db.select().from(agents).where(and(eq(agents.id, id), eq(agents.runtime, "omp"))).get();
	}

	private candidateProjects(key: string) {
		return this.ctx.db
			.select()
			.from(projects)
			.all()
			.filter((p) => p.repository && `${p.repository.owner}/${p.repository.name}`.toLowerCase() === key);
	}

	// ------------------------------------------------------------------ queue

	/**
	 * Start the oldest `accepted` task of every project whose working tree is free. Synchronous end to end (the
	 * `accepted → running` transition claims the tree before anything is awaited), so concurrent callers cannot start two.
	 */
	private drain(): void {
		if (this.stopped) return;
		const busy = new Set<string | null>();
		for (const task of this.store.list({ direction: "incoming", statuses: ["running", "blocked"] })) {
			// A fenced task only holds the tree while its old agent is still running (until `release`).
			if (task.fenced ? execState(task).holdsTree : task.status === "running" || execState(task).holdsTree) busy.add(task.projectId);
		}
		const queued = this.store
			.list({ direction: "incoming", statuses: ["accepted"] })
			.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
		// A task a handoff holds (target steps 2–8) occupies its project's tree already: its restore checked out a branch there.
		for (const task of queued) if (task.projectId && this.fence.isFrozen(task.id)) busy.add(task.projectId);
		for (const task of queued) {
			if (task.fenced || this.fence.isFrozen(task.id) || !task.projectId || busy.has(task.projectId)) continue;
			busy.add(task.projectId);
			const { row, event } = this.store.transition(task.id, "running", { from: ["accepted"] });
			this.hub.changed(task.id, { events: [event] });
			this.track(this.run(row).catch((error: unknown) => this.failTask(task.id, `The task could not be started: ${errorText(error)}`)));
		}
	}

	// ------------------------------------------------------------------ running

	private async run(task: TaskRow): Promise<void> {
		const project = task.projectId ? this.ctx.db.select().from(projects).where(eq(projects.id, task.projectId)).get() : undefined;
		const agent = task.executorAgentId ? this.ompAgent(task.executorAgentId) : undefined;
		if (!project || !agent) {
			await this.failTask(task.id, "The project or agent of this task no longer exists on this node");
			return;
		}
		const ref: ProjectRef = { id: project.id, path: project.path, repository: project.repository ?? null };
		let prepared: PreparedBranch | null = null;
		let folder: PreparedFolder | null = null;
		if (task.repoUrl === null) {
			// No repository: the input files go into the folder first, and its state is the base of the result.
			try {
				folder = await this.hub.files.prepareFolder(task, project.path);
			} catch (error) {
				await this.failTask(task.id, `The task folder could not be prepared: ${errorText(error)}`);
				return;
			}
		}
		if (task.deliverAs === "branch") {
			try {
				prepared = await this.git().prepare(task, ref);
			} catch (error) {
				if (error instanceof TaskBlockedError) {
					await this.lock.run(task.id, async () => this.blockIfRunning(task.id, "tree", error.message));
					return;
				}
				if (error instanceof TaskFailedError) {
					await this.failTask(task.id, error.message);
					return;
				}
				throw error;
			}
		}
		const current = this.store.get(task.id);
		if (current.status !== "running") return; // cancelled while the branch was prepared
		this.store.patchExecState(task.id, { holdsTree: true, prepared: prepared ?? undefined, blockedFor: undefined });

		let sessionId = current.executorSessionId;
		if (!sessionId) {
			sessionId = this.ctx.sessions.create({ projectId: project.id, title: `Task: ${task.title}`.slice(0, 120) }, { agentId: agent.id }).id;
			this.store.update(task.id, { executorSessionId: sessionId });
		}
		this.sessionTasks.set(sessionId, task.id);
		this.registerOverrides(current, sessionId);
		const thread = this.store.messages(task.id);
		const message = buildBrief({
			taskId: task.id,
			title: task.title,
			description: task.description,
			delegator: { agentName: task.senderAgentName, nodeName: task.senderNodeName },
			executorNodeName: task.executorNodeName,
			repo: task.repoUrl === null ? null : { url: task.repoUrl, branch: task.repoBranch, commit: task.repoCommit },
			baseBranch: prepared?.baseBranch ?? null,
			workBranch: prepared?.workBranch ?? null,
			deliverAs: task.deliverAs === "summary" ? "summary" : task.deliverAs === "files" ? "files" : "branch",
			inputFiles: folder,
			constraints: task.constraints,
			priorMessages: thread.map((m) => ({
				author: formatAuthor({ kind: m.authorKind as "human" | "agent" | "system", agentName: m.authorAgentName, nodeName: m.authorNodeName }),
				kind: m.kind as MessageKind,
				text: m.text,
			})),
			canAskDelegator: true,
		});
		await this.ctx.sessions.prompt(sessionId, { message, clientId: `task_${task.id}_start` });
		// The brief carries the thread so far: those messages have reached the agent and must not be injected a second time.
		for (const m of thread) if (m.injectedSessionId === null) this.store.markInjected(m.id, sessionId);
		this.store.patchExecState(task.id, { sessionStarted: true });
		const event = this.store.appendEvent(task.id, { type: "progress", summary: `Agent session started${prepared ? ` on ${prepared.workBranch}` : ""}` });
		this.hub.changed(task.id, { events: [event] });
	}

	/** Approval mode (stricter of node and task) and `--max-cost` for the session's process; must be in place before the runtime is opened. */
	private registerOverrides(task: TaskRow, sessionId: string): void {
		const approvalMode = strictestApprovalMode(readNodeSettings(this.ctx.db).approvalMode, task.constraints.approvalMode);
		this.ctx.sessions.setSpawnOverrides(sessionId, task.constraints.maxCostUsd === undefined ? { approvalMode } : { approvalMode, maxCostUsd: task.constraints.maxCostUsd });
	}

	/** Caller holds the task lock (or is the only actor). */
	private blockIfRunning(taskId: string, blockedFor: BlockedFor, reason: string, patch: Partial<ExecState> = {}): void {
		const task = this.store.get(taskId);
		if (task.status !== "running") return;
		const { event } = this.store.transition(taskId, "blocked", { reason, from: ["running"] });
		this.store.patchExecState(taskId, { blockedFor, ...(blockedFor === "tree" && { holdsTree: false }), ...patch });
		this.hub.changed(taskId, { events: [event] });
	}

	// ------------------------------------------------------------------ runtime events

	private taskIdOfSession(sessionId: string): string | undefined {
		const cached = this.sessionTasks.get(sessionId);
		if (cached) return cached;
		const task = this.store.byExecutorSession(sessionId);
		if (task) this.sessionTasks.set(sessionId, task.id);
		return task?.id;
	}

	private onRuntimeEvent(sessionId: string, event: SessionEvent): void {
		if (event.type !== "settled" && event.type !== "prompt_result" && event.type !== "ui_request" && event.type !== "ui_request_resolved") return;
		const taskId = this.taskIdOfSession(sessionId);
		if (!taskId) return;
		this.track(this.lock.run(taskId, () => this.handleEvent(taskId, sessionId, event)));
	}

	private async handleEvent(taskId: string, sessionId: string, event: SessionEvent): Promise<void> {
		const task = this.store.find(taskId);
		if (!task) return;
		if (task.fenced) return this.handleFencedEvent(task, sessionId, event);
		// Frozen: a handoff holds the task, the run is sealed. Nothing is recorded, no status changes, nothing completes.
		if (isTerminalStatus(task.status as TaskStatus) || this.fence.isFrozen(taskId)) return;
		const state = execState(task);
		switch (event.type) {
			case "prompt_result":
				if (task.status !== "running") return;
				if (event.status === "error") this.store.patchExecState(taskId, { promptError: event.error ?? "the run ended with an error" });
				else if (event.status === "aborted" && !state.cancelling) this.store.patchExecState(taskId, { aborted: true });
				return;
			case "ui_request":
				this.blockIfRunning(taskId, "approval", event.method === "ask" ? `Waiting for an answer on ${this.hub.nodeName()}` : `Waiting for approval on ${this.hub.nodeName()}`);
				return;
			case "ui_request_resolved": {
				if (task.status !== "blocked" || state.blockedFor !== "approval") return;
				if ((this.ctx.runtime.get(sessionId)?.pendingUiRequests().length ?? 0) > 0) return;
				const { event: changed } = this.store.transition(taskId, "running", { from: ["blocked"] });
				this.store.patchExecState(taskId, { blockedFor: undefined });
				this.hub.changed(taskId, { events: [changed] });
				return;
			}
			case "settled":
				if (task.status === "running") await this.onSettled(task, sessionId);
				return;
			default:
				return;
		}
	}

	/** The completion rule: what a settled session of a running task means. Runs under the task lock. */
	private async onSettled(task: TaskRow, sessionId: string): Promise<void> {
		if (this.finalising.has(task.id)) return;
		try {
			const stats = await this.ctx.runtime.get(sessionId)?.getStats();
			if (stats) this.store.update(task.id, { cost: stats.cost });
		} catch (error) {
			this.hub.log.warn({ err: errorText(error), taskId: task.id }, "could not read the session cost");
		}
		const current = this.store.get(task.id);
		if (current.status !== "running" || current.fenced || this.fence.isFrozen(task.id)) return;
		const state = execState(current);

		// The settle event is stale when work arrived while we were handling it (the other node's answer is fast on
		// loopback): the session is busy again, or a message is about to be injected. The turn that follows settles again.
		if (this.ctx.runtime.get(sessionId)?.status().state === "busy" || this.hasMessageAboutToBeInjected(current.id)) return;

		if (state.completion) return this.finalize(current, state.completion.outcome, state.completion.summary, false);
		if (state.promptError) return this.failTask(task.id, `The agent run failed: ${state.promptError}`, { holdsLock: true });
		if (state.aborted) {
			this.blockIfRunning(task.id, "aborted", "The run was aborted on this node; send a message to resume", { aborted: undefined });
			return;
		}
		const thread = this.store.messages(task.id).map((m) => ({ id: m.id, kind: m.kind as MessageKind, authorNodeId: m.authorNodeId, createdAt: m.createdAt }));
		if (hasPendingQuestion(thread, this.ctx.identity.nodeId)) {
			this.blockIfRunning(task.id, "question", `Waiting for an answer from ${current.senderNodeName}`);
			return;
		}
		if (!state.reminderSent) {
			this.store.patchExecState(task.id, { reminderSent: true });
			try {
				await this.ctx.sessions.prompt(sessionId, { message: buildCompletionReminder({ taskId: task.id }), clientId: `task_${task.id}_reminder` });
				return;
			} catch (error) {
				// The agent cannot be reminded (runtime gone); its last answer is all there is.
				this.hub.log.warn({ err: errorText(error), taskId: task.id }, "could not send the completion reminder; completing from the last answer");
			}
		}
		await this.finalize(this.store.get(task.id), "succeeded", await this.lastAssistantText(sessionId), true);
	}

	private hasMessageAboutToBeInjected(taskId: string): boolean {
		const self = this.ctx.identity.nodeId;
		const horizon = Date.now() - INJECTION_GRACE_MS;
		return this.store.messages(taskId).some((m) => m.injectedSessionId === null && (m.authorNodeId !== self || m.authorKind === "human") && Date.parse(m.receivedAt) > horizon);
	}

	private async lastAssistantText(sessionId: string): Promise<string> {
		try {
			const page = await this.ctx.sessions.messages(sessionId, { limit: 20 });
			for (const message of [...page.messages].reverse()) {
				if (message.role !== "assistant") continue;
				const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n").trim();
				if (text) return text;
			}
		} catch (error) {
			this.hub.log.warn({ err: errorText(error), sessionId }, "could not read the session transcript for the task summary");
		}
		return NO_SUMMARY;
	}

	// ------------------------------------------------------------------ completion

	async complete(sessionId: string, input: { taskId?: string; outcome: Completion["outcome"]; summary: string }): Promise<string> {
		const found = this.store.byExecutorSession(sessionId);
		if (!found) throw new ApiError(409, "not_a_task_session", "This session is not executing a CL Agent Mesh task, so mesh_complete does not apply");
		if (input.taskId !== undefined && input.taskId !== found.id) {
			throw new ApiError(409, "wrong_task", `This session executes task ${found.id}, not ${input.taskId}; call mesh_complete with taskId "${found.id}"`);
		}
		return this.lock.run(found.id, async () => {
			const task = this.store.get(found.id);
			if (this.lostOwnership(task.id)) {
				// This node no longer owns the task: what the agent finished is kept for a human to review, never merged into the outcome (§8.6).
				this.recordLateResult(task.id, input.outcome, input.summary);
				return `Task ${task.id} continues on another node and this node no longer owns it. Your result was stored for review only. End your turn now.`;
			}
			const handoffId = execState(task).handoffId;
			if (handoffId !== undefined) throw new ApiError(409, "handoff_in_progress", `Task ${task.id} is being handed over (handoff ${handoffId}); mesh_complete is refused. End your turn now.`, { handoffId });
			if (task.status !== "running" && task.status !== "blocked") {
				throw new ApiError(409, "task_not_active", `Task ${task.id} is ${task.status}; mesh_complete only applies to a running task. Stop working on it and end your turn.`);
			}
			const completion: Completion = { outcome: input.outcome, summary: input.summary, at: new Date().toISOString() };
			this.store.patchExecState(task.id, { completion });
			const event = this.store.appendEvent(task.id, { type: "note", summary: `Agent reported ${input.outcome}: ${input.summary.replace(/\s+/g, " ").trim().slice(0, 140)}`, payload: { outcome: input.outcome } });
			this.hub.changed(task.id, { events: [event] });
			return `Completion recorded (${input.outcome}). End your turn now; CL Agent Mesh finalises the task.`;
		});
	}

	/** Caller holds the task lock; the task is `running` (or `blocked` during recovery). */
	private async finalize(task: TaskRow, outcome: Completion["outcome"], summary: string, autoCompleted: boolean): Promise<void> {
		if (this.finalising.has(task.id)) return;
		this.finalising.add(task.id);
		try {
			if (this.lostOwnership(task.id)) {
				this.recordLateResult(task.id, outcome, summary);
				await this.release(task.id);
				return;
			}
			if (this.fence.isFrozen(task.id)) return;
			if (outcome === "blocked") {
				if (task.status === "blocked") return;
				// The agent's own verdict is spent: the next completion must come from a fresh run after a message.
				this.blockIfRunning(task.id, "agent", summary, { completion: undefined });
				return;
			}
			if (outcome === "failed") {
				await this.failTask(task.id, summary, { holdsLock: true, summary, autoCompleted });
				return;
			}
			const result = await this.deliver(task, summary, autoCompleted);
			if (result) await this.conclude(task.id, "succeeded", null, result);
		} finally {
			this.finalising.delete(task.id);
		}
	}

	/** The result of a successful run: the delivery for `branch`, just the summary otherwise. Null when delivering failed the task. */
	private async deliver(task: TaskRow, summary: string, autoCompleted: boolean): Promise<TaskResult | null> {
		if (task.deliverAs === "files") return this.deliverFiles(task, summary, autoCompleted);
		if (task.deliverAs !== "branch") return { summary, autoCompleted, branch: null, commit: null, pushed: false, compareUrl: null, artifacts: [], files: null };
		const prepared = execState(task).prepared;
		const project = task.projectId ? this.ctx.db.select().from(projects).where(eq(projects.id, task.projectId)).get() : undefined;
		if (!prepared || !project) {
			await this.failTask(task.id, "The task branch or its project is gone, so the result could not be delivered", { holdsLock: true });
			return null;
		}
		try {
			const delivery = await this.git().deliver(task, { id: project.id, path: project.path, repository: project.repository ?? null }, prepared, { sessionId: task.executorSessionId });
			const event = this.store.appendEvent(task.id, { type: "progress", summary: delivery.note, payload: { branch: delivery.branch, pushed: delivery.pushed } });
			this.hub.changed(task.id, { events: [event] });
			return { summary, autoCompleted, branch: delivery.branch, commit: delivery.commit, pushed: delivery.pushed, compareUrl: delivery.compareUrl, artifacts: delivery.artifacts, files: null };
		} catch (error) {
			await this.failTask(task.id, `Delivering the result failed: ${errorText(error)}`, { holdsLock: true });
			return null;
		}
	}

	/** `deliverAs: files`: bundle what the agent created or changed in the task folder. Null when delivering failed the task. */
	private async deliverFiles(task: TaskRow, summary: string, autoCompleted: boolean): Promise<TaskResult | null> {
		const project = task.projectId ? this.ctx.db.select().from(projects).where(eq(projects.id, task.projectId)).get() : undefined;
		if (!project) {
			await this.failTask(task.id, "The task folder is gone, so the result files could not be delivered", { holdsLock: true });
			return null;
		}
		try {
			const { files, withheld } = await this.hub.files.collectResult(task, project.path);
			const note = files ? `Result files bundled: ${files.fileCount} file(s).` : "The agent created or changed no files.";
			const withheldNote = withheld.length > 0 ? ` Not returned: ${withheld.slice(0, 10).map((w) => `${w.path} (${w.reason})`).join("; ")}.` : "";
			const event = this.store.appendEvent(task.id, { type: "progress", summary: `${note}${withheldNote}`, payload: { files: files?.fileCount ?? 0, withheld: withheld.length } });
			this.hub.changed(task.id, { events: [event] });
			return { summary: withheld.length > 0 ? `${summary}\n\n(Files not returned: ${withheld.map((w) => `${w.path} — ${w.reason}`).join("; ")})` : summary, autoCompleted, branch: null, commit: null, pushed: false, compareUrl: null, artifacts: [], files };
		} catch (error) {
			await this.failTask(task.id, `Delivering the result files failed: ${errorText(error)} The files are still in the task folder on ${this.hub.nodeName()}.`, { holdsLock: true });
			return null;
		}
	}

	// ------------------------------------------------------------------ terminal states

	/** What a failed or cancelled run leaves behind (branch, dirty tree), for the reason and the result. Never throws. */
	private async leftovers(task: TaskRow): Promise<{ branch: string | null; note: string }> {
		const prepared = execState(task).prepared ?? null;
		if (task.deliverAs !== "branch" || !prepared || !task.projectId) return { branch: null, note: "" };
		try {
			const project = this.ctx.db.select().from(projects).where(eq(projects.id, task.projectId)).get();
			if (!project) return { branch: prepared.workBranch, note: "" };
			const found = await this.git().describeLeftovers(task, { id: project.id, path: project.path, repository: project.repository ?? null }, prepared);
			return { branch: found.branch, note: found.note };
		} catch (error) {
			this.hub.log.warn({ err: errorText(error), taskId: task.id }, "could not describe what the task left behind");
			return { branch: prepared.workBranch, note: "" };
		}
	}

	/**
	 * Fail an active task, recording what it left behind. Takes the task lock itself unless the caller already
	 * `holdsLock`. A task that already ended is left alone.
	 */
	private async failTask(taskId: string, reason: string, o: { holdsLock?: boolean; summary?: string; autoCompleted?: boolean } = {}): Promise<void> {
		const body = async () => {
			const task = this.store.find(taskId);
			if (!task || (task.status !== "running" && task.status !== "blocked")) return;
			const left = await this.leftovers(task);
			const text = left.note ? `${reason}; ${left.note}` : reason;
			await this.conclude(taskId, "failed", text, { summary: o.summary ?? reason, autoCompleted: o.autoCompleted ?? false, branch: left.branch, commit: null, pushed: false, compareUrl: null, artifacts: [], files: null });
		};
		if (o.holdsLock) await body();
		else await this.lock.run(taskId, body);
	}

	private async conclude(taskId: string, to: "succeeded" | "failed", reason: string | null, result: TaskResult): Promise<void> {
		if (this.lostOwnership(taskId)) {
			// Fenced while the run finished: the outcome is for human review only, the task's status and result stay as they are.
			this.recordLateResult(taskId, to, result.summary);
			await this.release(taskId);
			return;
		}
		const { event } = this.store.transition(taskId, to, { reason, patch: { result }, from: ["running", "blocked"] });
		const resultEvent = this.store.appendEvent(taskId, { type: "result", summary: `Result: ${result.summary.replace(/\s+/g, " ").trim().slice(0, 300)}`, payload: result });
		this.hub.changed(taskId, { events: [event, resultEvent] });
		// A task that came home has no mirror row polling for its end: the delegating session is told directly.
		if (this.store.isSelfPeer(this.store.get(taskId))) void this.hub.injector.injectStatusNote(this.store.get(taskId));
		await this.release(taskId);
	}

	/** The task no longer runs: free its working tree and runtime slot (the conversation stays on disk) and start the next one. */
	private async release(taskId: string): Promise<void> {
		const task = this.store.get(taskId);
		this.store.patchExecState(taskId, { holdsTree: false });
		const sessionId = task.executorSessionId;
		if (sessionId) {
			this.ctx.sessions.setSpawnOverrides(sessionId, null);
			try {
				await this.ctx.runtime.stop(sessionId);
			} catch (error) {
				this.hub.log.warn({ err: errorText(error), taskId }, "could not stop the runtime of a finished task");
			}
			this.sessionTasks.delete(sessionId);
		}
		this.drain();
	}

	async cancel(taskId: string, options: { reason: string | null; by: "sender" | "local" | "handoff" }): Promise<TaskRow> {
		const first = this.store.get(taskId);
		if (isTerminalStatus(first.status as TaskStatus)) return first;
		if (options.by !== "handoff") this.assertNotMoving(first);
		const why = options.reason ?? (options.by === "sender" ? `Cancelled by ${first.senderNodeName}` : options.by === "handoff" ? `Cancelled by the handoff of this task on ${this.hub.nodeName()}` : `Cancelled on ${this.hub.nodeName()}`);
		return this.lock.run(taskId, async () => {
			const task = this.store.get(taskId);
			if (isTerminalStatus(task.status as TaskStatus)) return task;
			if (options.by !== "handoff") this.assertNotMoving(task);
			if (task.status === "offered" || task.status === "accepted") {
				const { event } = this.store.transition(taskId, "cancelled", { reason: why, from: ["offered", "accepted"] });
				this.hub.changed(taskId, { events: [event] });
				return this.store.get(taskId);
			}
			this.store.patchExecState(taskId, { cancelling: true });
			if (task.executorSessionId) {
				try {
					await this.ctx.sessions.abort(task.executorSessionId);
				} catch (error) {
					this.hub.log.warn({ err: errorText(error), taskId }, "aborting the session of a cancelled task failed");
				}
			}
			const left = await this.leftovers(this.store.get(taskId));
			const { event } = this.store.transition(taskId, "cancelled", { reason: left.note ? `${why}; ${left.note}` : why, from: ["running", "blocked"] });
			this.hub.changed(taskId, { events: [event] });
			await this.release(taskId);
			return this.store.get(taskId);
		});
	}

	// ------------------------------------------------------------------ messages

	async messageInjected(task: TaskRow, _message: TaskMessageRow): Promise<void> {
		await this.lock.run(task.id, async () => {
			const current = this.store.get(task.id);
			if (current.fenced || this.fence.isFrozen(task.id)) return;
			const blockedFor = execState(current).blockedFor;
			if (current.status !== "blocked" || !blockedFor || !UNBLOCKED_BY_MESSAGE.includes(blockedFor)) return;
			const { event } = this.store.transition(task.id, "running", { from: ["blocked"] });
			this.store.patchExecState(task.id, { blockedFor: undefined, reminderSent: false, completion: undefined, promptError: undefined, aborted: undefined });
			this.hub.changed(task.id, { events: [event] });
		});
	}

	// ------------------------------------------------------------------ fencing and handoff

	/** 409 for the sender's or a human's request against a task that a handoff holds or that moved away. */
	private assertNotMoving(task: TaskRow): void {
		if (task.fenced) throw new ApiError(409, "task_fenced", `Task ${task.id} continues on another node (epoch ${Math.max(task.highestSeenEpoch, task.epoch)})`, { currentEpoch: Math.max(task.highestSeenEpoch, task.epoch) });
		const handoffId = execState(task).handoffId;
		if (handoffId !== undefined) throw new ApiError(409, "handoff_in_progress", `Task ${task.id} is being handed over (handoff ${handoffId}); cancel the handoff first`, { handoffId });
	}

	/** The local owner guard (`FenceApi.assertOwner`, re-reads the row): true when this node lost the task. */
	private lostOwnership(taskId: string): boolean {
		try {
			this.fence.assertOwner(taskId);
			return false;
		} catch (error) {
			if (error instanceof ApiError && error.code === "task_fenced") return true;
			throw error;
		}
	}

	/** Store what a fenced task's agent finished as a `late_result` event (once); status, result and the sender are untouched (§8.6). */
	private recordLateResult(taskId: string, outcome: string, summary: string): void {
		const task = this.store.get(taskId);
		if (execState(task).lateResultAt) return;
		this.store.patchExecState(taskId, { lateResultAt: new Date().toISOString() });
		const event = this.store.appendEvent(taskId, {
			type: "late_result",
			summary: `Late result (${outcome}) from ${this.hub.nodeName()}, which no longer owns this task: ${summary.replace(/\s+/g, " ").trim().slice(0, 200)}`,
			payload: { outcome, summary, epoch: task.epoch, currentEpoch: Math.max(task.highestSeenEpoch, task.epoch) },
		});
		this.hub.changed(taskId, { events: [event], notifyPeer: false });
	}

	/** A fenced task's runtime events: only a finished run matters (`late_result`), and only once the agent really ended a turn itself. */
	private async handleFencedEvent(task: TaskRow, sessionId: string, event: SessionEvent): Promise<void> {
		if (event.type === "prompt_result") {
			if (event.status === "completed") this.finishedWhileFenced.add(task.id);
			return;
		}
		if (event.type !== "settled" || !this.finishedWhileFenced.has(task.id)) return;
		this.finishedWhileFenced.delete(task.id);
		const state = execState(task);
		this.recordLateResult(task.id, state.completion?.outcome ?? "succeeded", state.completion?.summary ?? (await this.lastAssistantText(sessionId)));
		await this.release(task.id);
	}

	adoptHandedOver(taskId: string): void {
		const task = this.store.get(taskId);
		if (task.fenced) throw new ApiError(409, "task_fenced", `Task ${taskId} is fenced on this node and cannot be adopted`);
		const sessionId = task.executorSessionId;
		if (task.direction !== "incoming" || task.status !== "running" || !sessionId) {
			throw ApiError.conflict(`Task ${taskId} is ${task.status}${sessionId ? "" : " without an agent session"}; only a running task with a session can be adopted`, { status: task.status });
		}
		this.registerOverrides(task, sessionId);
		this.sessionTasks.set(sessionId, taskId);
		this.store.patchExecState(taskId, { holdsTree: true, sessionStarted: true, handoffId: undefined });
	}

	async thaw(taskId: string, handoffId: string): Promise<void> {
		await this.lock.run(taskId, async () => {
			const task = this.store.find(taskId);
			if (!task || task.direction !== "incoming" || task.fenced || this.fence.isFrozen(taskId) || this.stopped) return;
			// In doubt (boot): `resumeInDoubt` resumes the session once reconciled; a second prompt from here would double it.
			if (this.fence.blockedResume(taskId)) return;
			const sessionId = task.executorSessionId;
			if (task.status !== "running" || !sessionId) {
				this.drain();
				return;
			}
			// Mid-turn: the next `settled` event is handled normally.
			if (this.ctx.runtime.get(sessionId)?.status().state === "busy") return;
			this.sessionTasks.set(sessionId, taskId);
			this.registerOverrides(task, sessionId);
			const completion = execState(task).completion;
			if (completion) {
				await this.finalize(task, completion.outcome, completion.summary, false);
				return;
			}
			await this.ctx.sessions.prompt(sessionId, { message: buildResumePrompt({ taskId, title: task.title }), clientId: `task_${taskId}_thaw_${handoffId}` });
			const event = this.store.appendEvent(taskId, { type: "progress", summary: "The handoff ended without moving the task; the agent was asked to continue" });
			this.hub.changed(taskId, { events: [event] });
		});
		void this.hub.injector.retryPending();
	}

	async resumeInDoubt(taskId: string): Promise<void> {
		// A `thaw` queued by the unfreeze that preceded this call must see the block first and leave the prompt to us.
		await this.lock.run(taskId, async () => undefined);
		this.fence.unblockResume(taskId);
		const task = this.store.get(taskId);
		if (task.fenced || this.fence.isFrozen(taskId) || this.stopped) return;
		if (task.status === "running" || execState(task).blockedFor === "approval") await this.recover(task);
	}

	released(taskId: string): void {
		const task = this.store.find(taskId);
		if (task && execState(task).holdsTree) this.store.patchExecState(taskId, { holdsTree: false });
		this.drain();
	}

	// ------------------------------------------------------------------ restart recovery

	private async recover(task: TaskRow): Promise<void> {
		if (task.fenced || this.fence.isFrozen(task.id)) return;
		const state = execState(task);
		if (state.cancelling) {
			await this.cancel(task.id, { reason: "Cancelled before the node restarted", by: "local" });
			return;
		}
		const sessionId = task.executorSessionId;
		const projectExists = task.projectId !== null && this.ctx.db.select().from(projects).where(eq(projects.id, task.projectId)).get() !== undefined;
		let sessionExists = false;
		if (sessionId) {
			try {
				this.ctx.sessions.get(sessionId);
				sessionExists = true;
			} catch {
				sessionExists = false;
			}
		}
		if (!sessionId || !sessionExists || !projectExists) {
			await this.failTask(task.id, "The node restarted and the task's agent session or project no longer exists");
			return;
		}
		this.sessionTasks.set(sessionId, task.id);
		this.registerOverrides(task, sessionId);
		await this.lock.run(task.id, async () => {
			let current = this.store.get(task.id);
			if (current.status === "blocked") {
				// An approval waits for a process that is gone; the resumed agent will ask again if it still needs it.
				const { event } = this.store.transition(task.id, "running", { from: ["blocked"] });
				this.store.patchExecState(task.id, { blockedFor: undefined });
				this.hub.changed(task.id, { events: [event] });
				current = this.store.get(task.id);
			}
			if (current.status !== "running" || current.fenced || this.fence.isFrozen(task.id)) return;
			const completion = execState(current).completion;
			if (completion) {
				await this.finalize(current, completion.outcome, completion.summary, false);
				return;
			}
			await this.ctx.sessions.prompt(sessionId, { message: buildResumePrompt({ taskId: task.id, title: task.title }), clientId: `task_${task.id}_resume_${this.bootId}` });
			const event = this.store.appendEvent(task.id, { type: "progress", summary: "Node restarted; the agent was asked to continue" });
			this.hub.changed(task.id, { events: [event] });
		});
	}
}
