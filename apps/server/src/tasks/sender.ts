import { ulid, type wire } from "@clam/agent-network";
import { agents, agentSessions, peerAgents, projects, workspaceMembers } from "@clam/database";
import { isTerminalStatus, normalizeRepoUrl } from "@clam/task-engine";
import type { TaskStatus } from "@clam/contracts";
import { and, eq, isNull } from "drizzle-orm";
import { ApiError } from "../http/errors.ts";
import type { CreateOutgoingInput, SenderApi, TaskHub } from "./hub.ts";
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
		if (peer.status === "revoked") throw new ApiError(409, "peer_revoked", `${peer.name} is revoked; pair again to delegate tasks to it`);
		if (!(peer.receivedCapabilities as string[]).includes("tasks.send")) {
			throw new ApiError(409, "capability_missing", `${peer.name} has not granted this node tasks.send, so tasks cannot be delegated to it`, { missing: ["tasks.send"] });
		}

		const project = db.select().from(projects).where(eq(projects.id, input.projectId)).get();
		if (!project) throw ApiError.notFound("Project");
		const repo = project.repository ? normalizeRepoUrl(project.repository.htmlUrl) : null;
		if (!repo) throw new ApiError(409, "project_not_linked", "Link the project to its GitHub repository first: the other node finds the project by repository");
		const member = db
			.select()
			.from(workspaceMembers)
			.where(and(eq(workspaceMembers.workspaceId, project.workspaceId), eq(workspaceMembers.memberId, peer.id), isNull(workspaceMembers.revokedAt)))
			.get();
		if (!member) throw new ApiError(409, "workspace_not_shared", `The project's workspace is not shared with ${peer.name}`);

		// The directory cache is only a hint: an empty cache (never fetched) accepts any agent id and the executor decides.
		const known = db.select().from(peerAgents).where(eq(peerAgents.peerId, peer.id)).all();
		const targetAgent = input.targetAgentId ? known.find((a) => a.agentId === input.targetAgentId) : undefined;
		if (input.targetAgentId && known.length > 0 && !targetAgent) throw new ApiError(400, "unknown_agent", `${peer.name} has no agent ${input.targetAgentId}`);

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
		const body: wire.CreateTaskRequest = {
			taskId: id,
			workspaceId: project.workspaceId,
			projectRef: { repoUrl: repo.url, ...(input.baseBranch ? { branch: input.baseBranch } : {}) },
			title: input.title,
			description: input.description,
			...(input.targetAgentId ? { targetAgentId: input.targetAgentId } : {}),
			deliverAs: input.deliverAs,
			constraints: input.constraints,
			epoch: 0,
			correlationId,
			sender: { agentId: sender?.id ?? null, agentName: sender?.name ?? null },
		};
		// The row and its delivery are one decision: either both exist or neither.
		const row = db.transaction(() => {
			const created = hub.store.insert({
				id,
				direction: "outgoing",
				peerId: peer.id,
				workspaceId: project.workspaceId,
				projectId: project.id,
				title: input.title,
				description: input.description,
				status: "offered",
				epoch: 0,
				repoUrl: repo.url,
				repoBranch: input.baseBranch ?? null,
				deliverAs: input.deliverAs,
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
			hub.store.enqueue({ peerId: peer.id, taskId: id, kind: "task.create", path: "/tasks", body, correlationId });
			return created;
		});
		hub.outbox.kick(peer.id);
		hub.changed(id);
		return row;
	}

	async cancel(taskId: string, reason: string | null): Promise<TaskRow> {
		const { hub } = this;
		const { store } = hub;
		const row = store.get(taskId);
		if (row.direction !== "outgoing") throw ApiError.conflict("Only the node that delegated a task can cancel it from here");
		if (isTerminalStatus(row.status as TaskStatus)) return row;

		const queued = store.outboxOfTask(taskId);
		const create = queued.find((item) => item.kind === "task.create");
		if (create?.state === "pending" && create.attempts === 0) {
			// Never on the wire: the executor does not know the task, so nothing needs to reach it.
			const { event } = hub.ctx.db.transaction(() => {
				for (const item of queued) {
					if (item.state !== "pending") continue;
					store.updateOutbox(item.id, { state: "cancelled", lastError: "Cancelled before delivery" });
					if (item.kind === "task.message" && item.refId) store.setMessageDelivery(item.refId, "failed");
				}
				return store.transition(taskId, "cancelled", { from: ["offered"], reason });
			});
			hub.changed(taskId, { events: [event], notifyPeer: false });
			return store.get(taskId);
		}

		const peer = hub.ctx.network.peers.row(row.peerId);
		if (!peer || peer.status === "revoked") throw new ApiError(409, "peer_unavailable", "The other node of this task is no longer a paired peer");
		if (!(peer.receivedCapabilities as string[]).includes("tasks.cancel")) {
			throw new ApiError(409, "capability_missing", `${peer.name} has not granted this node tasks.cancel, so the task cannot be cancelled remotely`, { missing: ["tasks.cancel"] });
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
		if (row.direction !== "outgoing") throw ApiError.conflict("Only the node that delegated a task can retry it");
		if (!RETRYABLE_STATUSES.includes(row.status)) throw ApiError.conflict(`Only a finished task can be retried; this one is ${row.status}`);
		if (!row.projectId) throw ApiError.conflict("The project this task was delegated from no longer exists");
		return this.create({
			targetNodeId: row.peerId,
			targetAgentId: row.executorAgentId,
			projectId: row.projectId,
			title: row.title,
			description: row.description,
			deliverAs: row.deliverAs === "summary" ? "summary" : "branch",
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

	start(): void {
		this.mirror.start();
	}

	stop(): Promise<void> {
		return this.mirror.stop();
	}
}
