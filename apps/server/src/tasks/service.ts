import path from "node:path";
import type { wire } from "@clam/agent-network";
import {
	ApplyFilesBody,
	TaskStatus,
	type FilesApplyResult,
	type FilesPreview,
	type CreateTaskBody,
	type Task,
	type TaskDetail,
	type TaskListQuery,
	type TaskMessage,
} from "@clam/contracts";
import { canSendKind, checkEpoch, formatAuthor, isTerminalStatus } from "@clam/task-engine";
import type { FastifyBaseLogger } from "fastify";
import type { z } from "zod";
import type { ServerContext } from "../context.ts";
import { ApiError } from "../http/errors.ts";
import { NODE_STREAM } from "../network/events.ts";
import { IdempotencyStore } from "../network/idempotency.ts";
import { errorText } from "../network/util.ts";
import { readNodeSettings } from "../services/settings.ts";
import { recordPeerActivity } from "./activity.ts";
import { ArtifactStore } from "./artifacts.ts";
import { execState } from "./exec-state.ts";
import { TaskFiles } from "./files.ts";
import { TaskExecutor } from "./executor.ts";
import { DEFAULT_TASK_TIMINGS, type ChangeInfo, type DecideInput, type ExecutorApi, type InjectorApi, type OutboxApi, type PostMessageInput, type SenderApi, type TaskHub, type TaskRole, type TaskTimings } from "./hub.ts";
import { MeshHostTools } from "./host-tools.ts";
import { TaskInjector } from "./injector.ts";
import { OutboxService, taskOutboxHandlers } from "./outbox.ts";
import { TaskSender } from "./sender.ts";
import { newMessageId, TaskStore, type TaskMessageRow, type TaskRow } from "./store.ts";

const PRUNE_IDEMPOTENCY_MS = 10 * 60_000;
const EVENT_SUMMARY_TEXT = 140;

/**
 * Composition root of the task engine and the behaviour both roles share: the discussion thread (authoring,
 * receiving, loop guard) and the publication of changes. Everything role-specific lives in the units it wires:
 * `TaskSender` (+ `OutboxService`), `TaskExecutor`, `TaskInjector` and the `MeshHostTools` provider.
 */
export interface TaskServiceOptions {
	timings?: Partial<TaskTimings>;
}

export class TaskService implements TaskHub {
	readonly store: TaskStore;
	/** The wire response store (protocol §6): generic per `(peer, key)`, shared with future mutating endpoints. */
	readonly idempotency: IdempotencyStore;
	readonly artifacts: ArtifactStore;
	readonly files: TaskFiles;
	readonly log: FastifyBaseLogger;
	readonly timings: TaskTimings;
	readonly sender: SenderApi;
	readonly executor: ExecutorApi;
	readonly injector: InjectorApi;
	readonly outbox: OutboxApi;
	readonly hostTools: MeshHostTools;
	private pruneTimer: NodeJS.Timeout | null = null;
	private stopPeerActivity: (() => void) | null = null;

	constructor(
		readonly ctx: ServerContext,
		options: TaskServiceOptions = {},
	) {
		this.log = ctx.log;
		this.timings = { ...DEFAULT_TASK_TIMINGS, ...options.timings };
		this.store = new TaskStore(ctx.db, { nodeId: ctx.identity.nodeId });
		this.idempotency = new IdempotencyStore(ctx.db);
		this.artifacts = new ArtifactStore(this.store, path.join(ctx.config.dataDir, "artifacts"));
		this.files = new TaskFiles(this);
		// Units only keep the hub; none may call another unit from its constructor.
		this.outbox = new OutboxService(this);
		this.injector = new TaskInjector(this);
		this.sender = new TaskSender(this);
		this.executor = new TaskExecutor(this);
		this.hostTools = new MeshHostTools(this);
	}

	nodeName(): string {
		return readNodeSettings(this.ctx.db).nodeName;
	}

	roleOf(task: Pick<TaskRow, "direction">): TaskRole {
		return task.direction === "outgoing" ? "sender" : "executor";
	}

	// ------------------------------------------------------------------ lifecycle

	async start(): Promise<void> {
		this.ctx.sessions.start();
		this.stopPeerActivity = recordPeerActivity(this.ctx);
		for (const [kind, handler] of Object.entries(taskOutboxHandlers(this))) this.outbox.register(kind, handler);
		// Registered before any runtime is (re)opened, so recovery sessions get the mesh tools too.
		this.ctx.hostTools.register(this.hostTools);
		this.ctx.shared.registerHostTools();
		// Outbox kinds, the prompt guard and the boot fence scan come before any runtime is (re)opened: a task this node released is never resumed.
		this.ctx.handoffs.prepare();
		this.ctx.runtime.setHostToolProvider(this.ctx.hostTools);
		this.injector.start();
		await this.executor.start();
		this.outbox.start();
		this.sender.start();
		// Shared sessions ride this outbox and these sessions: they start once both are up and stop before them.
		this.ctx.shared.start();
		this.ctx.contexts.start();
		// Boot recovery of every non-terminal handoff and the timers; the outbox and the executor run already.
		this.ctx.handoffs.start();
		void this.injector.retryPending();
		this.pruneTimer = setInterval(() => {
			try {
				this.idempotency.prune();
			} catch (error) {
				this.log.warn({ err: errorText(error) }, "pruning the idempotency store failed");
			}
		}, PRUNE_IDEMPOTENCY_MS);
		this.pruneTimer.unref();
	}

	async stop(): Promise<void> {
		clearInterval(this.pruneTimer ?? undefined);
		this.pruneTimer = null;
		this.stopPeerActivity?.();
		this.stopPeerActivity = null;
		await this.ctx.handoffs.stop();
		await this.ctx.contexts.stop();
		await this.ctx.shared.stop();
		await this.sender.stop();
		await this.outbox.stop();
		await this.executor.stop();
		this.injector.stop();
	}

	// ------------------------------------------------------------------ publication

	changed(taskId: string, info: ChangeInfo = {}): void {
		const row = this.store.find(taskId);
		if (!row) return;
		const task = this.store.toTask(row);
		this.ctx.bus.publish("tasks", { type: "task", task });
		this.ctx.bus.publish(`task:${taskId}`, { type: "task", task });
		for (const event of info.events ?? []) this.ctx.bus.publish(`task:${taskId}`, { type: "event", taskId, event: this.store.toEvent(event) });
		for (const message of info.messages ?? []) this.ctx.bus.publish(`task:${taskId}`, { type: "message", taskId, message: this.store.toMessage(message) });
		// A task that came home (peer = this node) has nobody to notify.
		if (row.direction === "incoming" && info.notifyPeer !== false && !this.store.isSelfPeer(row)) {
			// The sender polls authoritatively; this frame only makes it poll now (quick tunnels buffer SSE, so it may arrive late).
			this.ctx.network.events.append(NODE_STREAM, "task.updated", { taskId, seq: row.lastEventSeq, status: row.status }, row.peerId);
		}
		this.ctx.network.localAgentsChanged();
	}

	// ------------------------------------------------------------------ local API

	list(query: z.infer<typeof TaskListQuery>): Task[] {
		const statuses = (query.status ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean)
			.map((s) => TaskStatus.safeParse(s))
			.flatMap((parsed) => (parsed.success ? [parsed.data] : []));
		return this.store
			.list({ direction: query.direction, statuses, peerId: query.peerId, projectId: query.projectId, workspaceId: query.workspaceId })
			.map((row) => this.store.toTask(row));
	}

	detail(id: string): TaskDetail {
		const row = this.store.get(id);
		return {
			task: this.store.toTask(row),
			events: this.store.eventsSince(id, 0, 5000).map((e) => this.store.toEvent(e)),
			messages: this.store.messages(id).map((m) => this.store.toMessage(m)),
		};
	}

	async create(body: z.infer<typeof CreateTaskBody>): Promise<Task> {
		const row = await this.sender.create({ ...body, senderSessionId: null });
		return this.store.toTask(row);
	}

	filesPreview(id: string, projectId: string): Promise<FilesPreview> {
		return this.files.preview(id, projectId);
	}

	filesApply(id: string, body: z.infer<typeof ApplyFilesBody>): Promise<FilesApplyResult> {
		return this.files.apply(id, body);
	}

	async decide(id: string, body: DecideInput): Promise<Task> {
		const row = this.store.get(id);
		if (row.direction !== "incoming") throw ApiError.conflict("Only the node that executes a task can accept or reject it");
		return this.store.toTask(await this.executor.decide(id, body));
	}

	async cancel(id: string, reason: string | null): Promise<Task> {
		const row = this.store.get(id);
		const updated = row.direction === "outgoing" ? await this.sender.cancel(id, reason) : await this.executor.cancel(id, { reason, by: "local" });
		return this.store.toTask(updated);
	}

	async retry(id: string): Promise<Task> {
		const row = this.store.get(id);
		if (row.direction !== "outgoing") throw ApiError.conflict("Only the node that delegated a task can retry it");
		return this.store.toTask(await this.sender.retry(id));
	}

	markRead(id: string): void {
		this.store.get(id);
		if (this.store.markRead(id) > 0) this.changed(id, { notifyPeer: false });
	}

	// ------------------------------------------------------------------ discussion

	/** Author a message on this node. Human messages are also injected into this node's own session of the task. */
	async postMessage(taskId: string, input: PostMessageInput): Promise<TaskMessage> {
		const task = this.store.get(taskId);
		const role = this.roleOf(task);
		if (isTerminalStatus(task.status as TaskStatus)) throw new ApiError(409, "task_finished", `The task is ${task.status}; the discussion is closed`);
		// A task that came home (peer = this node) has the same person on both ends: it may instruct its own executor.
		const asSender = this.store.isSelfPeer(task) ? canSendKind("sender", input.author.kind, input.kind) : null;
		const allowed = asSender?.ok ? asSender : canSendKind(role, input.author.kind, input.kind);
		if (!allowed.ok) throw ApiError.badRequest(allowed.message);
		if (input.author.kind === "agent") {
			const budget = this.store.budget(taskId);
			if (budget.remaining <= 0) {
				throw new ApiError(
					429,
					"agent_message_limit",
					`Agent message limit reached for this task (${budget.limit} messages from this node's agents without a human message in between). A human must continue the discussion in the task thread.`,
					budget,
				);
			}
		}
		// Work that came home runs here: its thread never leaves this node, so no peer is involved.
		const selfPeer = this.store.isSelfPeer(task);
		if (!selfPeer) {
			const peer = this.ctx.network.peers.row(task.peerId);
			if (!peer || peer.status === "revoked") throw new ApiError(409, "peer_unavailable", "The other node of this task is no longer a paired peer");
			const needed = role === "sender" ? "tasks.send" : "tasks.receive";
			if (!(peer.receivedCapabilities as string[]).includes(needed)) {
				throw new ApiError(409, "capability_missing", `${peer.name} has not granted this node ${needed}, so messages cannot be delivered`, { missing: [needed] });
			}
		}
		const createdAt = new Date().toISOString();
		const { row: message } = this.store.insertMessage({
			id: newMessageId(),
			taskId,
			authorKind: input.author.kind,
			authorNodeId: this.ctx.identity.nodeId,
			authorNodeName: this.nodeName(),
			authorAgentId: input.author.agentId,
			authorAgentName: input.author.agentName,
			kind: input.kind,
			text: input.text,
			createdAt,
			delivery: selfPeer ? "local" : "pending",
		});
		const events = role === "executor" ? [this.recordMessageEvent(task, message)] : [];
		const body: wire.TaskMessageRequest = {
			messageId: message.id,
			epoch: task.epoch,
			kind: input.kind,
			body: input.text,
			author: { kind: input.author.kind, agentId: input.author.agentId, agentName: input.author.agentName },
			createdAt,
		};
		if (!selfPeer) {
			this.store.enqueue({ peerId: task.peerId, taskId, kind: "task.message", refId: message.id, path: `/tasks/${taskId}/messages`, body, correlationId: task.correlationId });
			this.outbox.kick(task.peerId);
		}
		this.changed(taskId, { events, messages: [message] });
		if (input.author.kind === "human") void this.deliverLocally(task, message);
		return this.store.toMessage(message);
	}

	/**
	 * `POST /tasks/:id/messages` handler (the caller has authenticated the peer and checked the capability for
	 * `roleOf(task)`). Idempotent by message id: a duplicate delivery changes nothing and answers the same way.
	 */
	async receiveMessage(peerId: string, taskId: string, request: wire.TaskMessageRequest): Promise<wire.TaskMessageAccepted> {
		const task = this.store.find(taskId);
		if (!task || task.peerId !== peerId) throw ApiError.notFound("Task");
		const moving = this.movingError(task);
		if (moving) throw moving;
		const epoch = checkEpoch(task.epoch, request.epoch);
		if (!epoch.ok) {
			throw new ApiError(409, epoch.reason === "stale" ? "stale_epoch" : "conflict", `The message carries epoch ${request.epoch}; the task is at epoch ${task.epoch}`, { currentEpoch: epoch.currentEpoch });
		}
		const authorRole: TaskRole = this.roleOf(task) === "executor" ? "sender" : "executor";
		const allowed = canSendKind(authorRole, request.author.kind, request.kind);
		if (!allowed.ok) throw ApiError.badRequest(allowed.message);

		const peer = this.ctx.network.peers.row(peerId);
		const { row: message, inserted } = this.store.insertMessage({
			id: request.messageId,
			taskId,
			authorKind: request.author.kind,
			authorNodeId: peerId,
			authorNodeName: peer?.name ?? (authorRole === "sender" ? task.senderNodeName : task.executorNodeName),
			authorAgentId: request.author.agentId ?? null,
			authorAgentName: request.author.agentName ?? null,
			kind: request.kind,
			text: request.body,
			createdAt: request.createdAt,
			delivery: "local",
		});
		if (message.taskId !== taskId || message.authorNodeId !== peerId) throw new ApiError(409, "idempotency_conflict", "That message id belongs to another task or author");
		if (!inserted) return { messageId: message.id, accepted: true, eventSeq: this.store.get(taskId).lastEventSeq };
		const events = this.roleOf(task) === "executor" ? [this.recordMessageEvent(task, message)] : [];
		this.changed(taskId, { events, messages: [message] });
		void this.deliverLocally(task, message);
		return { messageId: message.id, accepted: true, eventSeq: this.store.get(taskId).lastEventSeq };
	}

	/**
	 * What a wire call against `task` gets while the task is moving (docs/handoff-protocol.md §5): `503 handoff_in_progress` while a handoff holds it
	 * (the sealed manifest must not change), `503 handed_off` once this node released it or lost its epoch. Both are retryable: the sender's outbox
	 * keeps the call until it learned the new executor. Null for a task that is not moving (and for rows this node does not execute).
	 */
	movingError(task: TaskRow): ApiError | null {
		if (task.direction !== "incoming") return null;
		if (task.fenced || task.status === "handed_off") {
			return new ApiError(503, "handed_off", `Task ${task.id} moved to another node`, { executorNodeId: task.executorNodeId, currentEpoch: Math.max(task.highestSeenEpoch, task.epoch), retryAfterSeconds: 2 });
		}
		const handoffId = execState(task).handoffId;
		if (handoffId !== undefined) return new ApiError(503, "handoff_in_progress", `Task ${task.id} is being handed over`, { handoffId, retryAfterSeconds: 2 });
		return null;
	}

	private recordMessageEvent(task: TaskRow, message: { id: string; kind: string; text: string; authorKind: string; authorNodeName: string; authorAgentName: string | null }) {
		const author = formatAuthor({ kind: message.authorKind as "human" | "agent" | "system", agentName: message.authorAgentName, nodeName: message.authorNodeName });
		const text = message.text.replace(/\s+/g, " ").trim();
		return this.store.appendEvent(task.id, {
			type: "message",
			summary: `${author} (${message.kind}): ${text.length > EVENT_SUMMARY_TEXT ? `${text.slice(0, EVENT_SUMMARY_TEXT - 1)}…` : text}`,
			payload: { messageId: message.id, kind: message.kind, author },
		});
	}

	/** Inject into this node's session (if any). The injector tells the executor when it injected, which resumes a task waiting for an answer. */
	private async deliverLocally(task: TaskRow, message: TaskMessageRow): Promise<void> {
		try {
			await this.injector.injectMessage(task, message);
		} catch (error) {
			this.log.warn({ err: errorText(error), taskId: task.id, messageId: message.id }, "could not deliver a task message into the local session");
		}
	}
}
