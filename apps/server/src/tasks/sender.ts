import { ulid, type wire } from "@clam/agent-network";
import { rm } from "node:fs/promises";
import { agents, agentSessions, peerAgents, projects, workspaceMembers, workspaces } from "@clam/database";
import { isTerminalStatus, normalizeRepoUrl } from "@clam/task-engine";
import { i18nMsg, type TaskDeliverAs, type TaskStatus } from "@clam/contracts";
import { and, eq, isNull } from "drizzle-orm";
import { ApiError } from "../http/errors.ts";
import { followExecutor } from "./follow.ts";
import type { CreateOutgoingInput, SenderApi, TaskHub } from "./hub.ts";
import type { TaskFiles } from "./files.ts";
import { TaskMirror } from "./mirror.ts";
import { newTaskId, type TaskRow } from "./store.ts";

const RETRYABLE_STATUSES: readonly string[] = ["failed", "rejected", "cancelled", "succeeded"];

/**
 * The delegating side of a task: validates and queues `task.create`, cancels, retries, and (through `TaskMirror`)
 * follows the executor, which is the source of truth for status, events and result. Nothing here waits for the peer.
 */
export class TaskSender implements SenderApi {
	private readonly mirror: TaskMirror;

	constructor(private readonly hub: TaskHub) {
		this.mirror = new TaskMirror(hub);
	}

	async create(input: CreateOutgoingInput): Promise<TaskRow> {
		const { hub } = this;
		const { db, network, identity } = hub.ctx;
		const peer = network.peers.row(input.targetNodeId);
		if (!peer) throw ApiError.notFound("Peer");
		if (peer.status === "revoked") throw new ApiError(409, "peer_revoked", i18nMsg("{name} is revoked; pair again to delegate tasks to it", { name: peer.name }));
		if (!(peer.receivedCapabilities as string[]).includes("tasks.send")) {
			throw new ApiError(409, "capability_missing", i18nMsg("{name} has not granted this node tasks.send, so tasks cannot be delegated to it", { name: peer.name }), { missing: ["tasks.send"] });
		}

		const project = input.projectId ? db.select().from(projects).where(eq(projects.id, input.projectId)).get() : undefined;
		if (input.projectId && !project) throw ApiError.notFound("Project");
		const linked = project?.repository ? normalizeRepoUrl(project.repository.htmlUrl) : null;
		const deliverAs: TaskDeliverAs = input.deliverAs ?? (linked ? "branch" : "files");
		if (deliverAs === "branch" && !linked) {
			throw new ApiError(409, "project_not_linked", project ? i18nMsg("Link the project to its GitHub repository first: the other node finds the project by repository (or deliver the result as files)") : i18nMsg("A task delivered as a branch needs a project linked to its GitHub repository (or deliver the result as files)"));
		}
		const inputPaths = input.inputPaths ?? [];
		if (inputPaths.length > 0 && !project) throw ApiError.badRequest(i18nMsg("inputPaths need the project they are taken from (projectId)"));
		// The other node finds its project by repository for branch/summary tasks; a files task runs in a folder of its own there.
		const repo = deliverAs === "files" ? null : linked;
		const workspaceId = this.workspaceFor(input, project?.workspaceId ?? null, peer);
		const member = db
			.select()
			.from(workspaceMembers)
			.where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.memberId, peer.id), isNull(workspaceMembers.revokedAt)))
			.get();
		if (!member) throw new ApiError(409, "workspace_not_shared", i18nMsg("The task's workspace is not shared with {name}", { name: peer.name }));

		// The directory cache is only a hint: an empty cache (never fetched) accepts any agent id and the executor decides.
		const known = db.select().from(peerAgents).where(eq(peerAgents.peerId, peer.id)).all();
		const targetAgent = input.targetAgentId ? known.find((a) => a.agentId === input.targetAgentId) : undefined;
		if (input.targetAgentId && known.length > 0 && !targetAgent) throw new ApiError(400, "unknown_agent", i18nMsg("{name} has no agent {agentId}", { name: peer.name, agentId: input.targetAgentId }));

		const sender = input.senderSessionId
			? db
					.select({ id: agents.id, name: agents.name })
					.from(agentSessions)
					.innerJoin(agents, eq(agents.id, agentSessions.agentId))
					.where(eq(agentSessions.id, input.senderSessionId))
					.get()
			: undefined;

		const id = newTaskId();
		const correlationId = ulid();
		// The input bundle is built (and its file placed) before the row exists; the row and the artifact are inserted together below.
		let inputs: Awaited<ReturnType<TaskFiles["bundleInputs"]>> | null = null;
		if (input.reuseInputsOf) {
			const source = hub.store.find(input.reuseInputsOf);
			inputs = source ? await hub.files.copyInputs(source, id) : null;
		} else if (inputPaths.length > 0 && project) {
			inputs = await hub.files.bundleInputs(id, project, inputPaths);
		}
		const body: wire.CreateTaskRequest = {
			taskId: id,
			workspaceId,
			...(repo && { projectRef: { repoUrl: repo.url, ...(input.baseBranch ? { branch: input.baseBranch } : {}) } }),
			...(inputs && { inputFiles: inputs.announced }),
			title: input.title,
			description: input.description,
			...(input.targetAgentId ? { targetAgentId: input.targetAgentId } : {}),
			deliverAs,
			constraints: input.constraints,
			epoch: 0,
			correlationId,
			sender: { agentId: sender?.id ?? null, agentName: sender?.name ?? null },
		};
		// The row and its delivery are one decision: either both exist or neither.
		let row: TaskRow;
		try {
			row = db.transaction(() => {
			const created = hub.store.insert({
				id,
				direction: "outgoing",
				peerId: peer.id,
				workspaceId,
				projectId: project?.id ?? null,
				title: input.title,
				description: input.description,
				status: "offered",
				epoch: 0,
				repoUrl: repo?.url ?? null,
				repoBranch: input.baseBranch ?? null,
				deliverAs,
				inputFiles: inputs?.announced ?? null,
				constraints: input.constraints,
				senderNodeId: identity.nodeId,
				senderNodeName: hub.nodeName(),
				senderAgentId: sender?.id ?? null,
				senderAgentName: sender?.name ?? null,
				senderSessionId: input.senderSessionId ?? null,
				executorNodeId: peer.id,
				executorNodeName: peer.name,
				executorAgentId: targetAgent?.agentId ?? null,
				executorAgentName: targetAgent?.name ?? null,
				retryOf: input.retryOf ?? null,
				correlationId,
			});
			if (inputs) hub.store.insertArtifact(inputs.artifact);
			hub.store.enqueue({ peerId: peer.id, taskId: id, kind: "task.create", path: "/tasks", body, correlationId });
			return created;
			});
		} catch (error) {
			if (inputs) await rm(hub.artifacts.taskDir(id), { recursive: true, force: true });
			throw error;
		}
		hub.outbox.kick(peer.id);
		hub.changed(id);
		return row;
	}

	/** The workspace of a task: the one asked for, else the project's, else the only workspace this node shares with the executor. */
	private workspaceFor(input: CreateOutgoingInput, projectWorkspaceId: string | null, peer: { id: string; name: string }): string {
		const { db } = this.hub.ctx;
		if (input.workspaceId && projectWorkspaceId && input.workspaceId !== projectWorkspaceId) throw ApiError.badRequest(i18nMsg("The project belongs to another workspace than workspaceId"));
		const chosen = input.workspaceId ?? projectWorkspaceId;
		if (chosen) {
			if (!db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, chosen)).get()) throw ApiError.notFound("Workspace");
			return chosen;
		}
		const shared = db
			.select({ id: workspaceMembers.workspaceId })
			.from(workspaceMembers)
			.where(and(eq(workspaceMembers.memberId, peer.id), isNull(workspaceMembers.revokedAt)))
			.all();
		if (shared.length === 1) return (shared[0] as { id: string }).id;
		throw new ApiError(409, "workspace_required", shared.length === 0 ? i18nMsg("No workspace is shared with {name}", { name: peer.name }) : i18nMsg("{name} is a member of several workspaces; choose one (workspaceId)", { name: peer.name }), { workspaces: shared.map((w) => w.id) });
	}

	async cancel(taskId: string, reason: string | null): Promise<TaskRow> {
		const { hub } = this;
		const { store } = hub;
		const row = store.get(taskId);
		if (row.direction !== "outgoing") throw ApiError.conflict(i18nMsg("Only the node that delegated a task can cancel it from here"));
		if (isTerminalStatus(row.status as TaskStatus)) return row;

		const queued = store.outboxOfTask(taskId);
		const create = queued.find((item) => item.kind === "task.create");
		if (create?.state === "pending" && create.attempts === 0) {
			// Never on the wire: the executor does not know the task, so nothing needs to reach it.
			const { event } = hub.ctx.db.transaction(() => {
				for (const item of queued) {
					if (item.state !== "pending") continue;
					store.updateOutbox(item.id, { state: "cancelled", lastError: "Cancelled before delivery", lastErrorI18n: i18nMsg("Cancelled before delivery").i18n });
					if (item.kind === "task.message" && item.refId) store.setMessageDelivery(item.refId, "failed");
				}
				return store.transition(taskId, "cancelled", { from: ["offered"], reason });
			});
			hub.changed(taskId, { events: [event], notifyPeer: false });
			return store.get(taskId);
		}

		const peer = hub.ctx.network.peers.row(row.peerId);
		if (!peer || peer.status === "revoked") throw new ApiError(409, "peer_unavailable", i18nMsg("The other node of this task is no longer a paired peer"));
		if (!(peer.receivedCapabilities as string[]).includes("tasks.cancel")) {
			throw new ApiError(409, "capability_missing", i18nMsg("{name} has not granted this node tasks.cancel, so the task cannot be cancelled remotely", { name: peer.name }), { missing: ["tasks.cancel"] });
		}
		const body: wire.CancelTaskRequest = { epoch: row.epoch, ...(reason ? { reason: reason.slice(0, 2000) } : {}) };
		const item = store.enqueue({ peerId: peer.id, taskId, kind: "task.cancel", path: `/tasks/${taskId}/cancel`, body, idempotencyKey: `task.cancel:${taskId}`, correlationId: row.correlationId });
		// A cancel that died (e.g. the grant was missing then) is asked for again when the user cancels again.
		if (item.state === "dead") store.updateOutbox(item.id, { state: "pending", attempts: 0, nextAttemptAt: new Date().toISOString(), lastError: null, lastStatus: null, body });
		hub.outbox.kick(peer.id);
		hub.changed(taskId);
		return store.get(taskId);
	}

	async retry(taskId: string): Promise<TaskRow> {
		const row = this.hub.store.get(taskId);
		if (row.direction !== "outgoing") throw ApiError.conflict(i18nMsg("Only the node that delegated a task can retry it"));
		if (!RETRYABLE_STATUSES.includes(row.status)) throw ApiError.conflict(i18nMsg("Only a finished task can be retried; this one is {status}", { status: row.status }));
		if (!row.projectId && row.repoUrl) throw ApiError.conflict(i18nMsg("The project this task was delegated from no longer exists"));
		return this.create({
			targetNodeId: row.peerId,
			targetAgentId: row.executorAgentId,
			projectId: row.projectId,
			workspaceId: row.workspaceId,
			title: row.title,
			description: row.description,
			deliverAs: row.deliverAs as TaskDeliverAs,
			reuseInputsOf: row.inputFiles ? row.id : null,
			baseBranch: row.repoBranch,
			constraints: row.constraints,
			senderSessionId: row.senderSessionId,
			retryOf: taskId,
		});
	}

	syncTask(taskId: string): Promise<void> {
		return this.mirror.syncTask(taskId);
	}

	syncPeer(peerId: string): Promise<void> {
		return this.mirror.syncPeer(peerId);
	}

	followExecutor(taskId: string, callerId: string, change: wire.TaskExecutorChange): Promise<TaskRow> {
		return followExecutor(this.hub, { taskId, callerId, change, syncOld: () => this.mirror.syncTask(taskId) });
	}

	start(): void {
		this.mirror.start();
	}

	stop(): Promise<void> {
		return this.mirror.stop();
	}
}
