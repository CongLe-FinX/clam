import type { wire } from "@clam/agent-network";
import type { DecideTaskBody, TaskConstraints, TaskDeliverAs, TaskMessage } from "@clam/contracts";
import type { z } from "zod";
import type { MessageKind } from "@clam/task-engine";
import type { FastifyBaseLogger } from "fastify";
import type { ServerContext } from "../context.ts";
import type { ArtifactStore } from "./artifacts.ts";
import type { OutboxHandler } from "./outbox.ts";
import type { TaskEventRow, TaskMessageRow, TaskRow, TaskStore } from "./store.ts";

/**
 * The seams between the units of the task engine (`docs/architecture.md`, "Task engine"). `TaskService` owns the
 * store and the shared behaviour (messages, change publication) and wires the units; every unit receives the hub
 * in its constructor and talks to the others only through these interfaces.
 *
 * Roles: the node that delegated a task is its SENDER (`task.direction === "outgoing"`), the node whose agent runs
 * it is its EXECUTOR (`"incoming"`). The executor is the source of truth for status, events and the result.
 */

export type TaskRole = "sender" | "executor";

export type DecideInput = z.infer<typeof DecideTaskBody>;

/** Timers of the task engine; tests shorten them (`TaskServiceOptions.timings`). */
export interface TaskTimings {
	/** Sender mirror: poll every active outgoing task this often (default 5 s; polling is authoritative, protocol §8). */
	mirrorIntervalMs: number;
	/** Outbox: look for due items this often (default 1 s). */
	outboxTickMs: number;
	/** Injector: retry a failed injection after this long (default 3 s), at most `injectRetries` times per message and boot. */
	injectRetryMs: number;
	injectRetries: number;
}

export const DEFAULT_TASK_TIMINGS: TaskTimings = { mirrorIntervalMs: 5_000, outboxTickMs: 1_000, injectRetryMs: 3_000, injectRetries: 5 };

export interface ChangeInfo {
	/** Events appended/mirrored by this change (published on `task:<id>`). */
	events?: readonly TaskEventRow[];
	/** Messages stored by this change (published on `task:<id>`). */
	messages?: readonly TaskMessageRow[];
	/** Executor side: append a `task.updated` event to the network event log so the sender polls now (default true). */
	notifyPeer?: boolean;
}

export interface PostMessageInput {
	text: string;
	kind: MessageKind;
	author: { kind: "human" | "agent"; agentId: string | null; agentName: string | null };
}

export interface CreateOutgoingInput {
	targetNodeId: string;
	targetAgentId?: string | null;
	/** Local project whose linked GitHub repository the executor works on. */
	projectId: string;
	title: string;
	description: string;
	deliverAs: TaskDeliverAs;
	baseBranch?: string | null;
	constraints: TaskConstraints;
	/** The delegating agent session on this node (host tool `mesh_delegate`); null for tasks created from the UI. */
	senderSessionId?: string | null;
	/** Set when this task retries another one. */
	retryOf?: string | null;
}

/** Sender side: creating, cancelling and mirroring tasks this node delegated. Implemented in `sender.ts`. */
export interface SenderApi {
	/**
	 * Validate (peer active, `tasks.send` granted to us, project linked to a repo), store the task as `offered`
	 * (outgoing) and queue its delivery in the outbox (`task.create`). Never waits for the peer.
	 */
	create(input: CreateOutgoingInput): Promise<TaskRow>;
	/**
	 * Cancel an outgoing task. Not delivered yet: the queued create is cancelled and the task becomes `cancelled`
	 * locally. Delivered: a `task.cancel` is queued; the mirrored status changes when the executor confirms.
	 */
	cancel(taskId: string, reason: string | null): Promise<TaskRow>;
	/** A NEW task with `retryOf = taskId` and the same parameters. Only for finished tasks. */
	retry(taskId: string): Promise<TaskRow>;
	/** Poll the executor now (`GET /tasks/:id?since=`) and apply what it reports. Never throws. */
	syncTask(taskId: string): Promise<void>;
	/** Poll every active outgoing task of the peer now (the peer just came online). Never throws. */
	syncPeer(peerId: string): Promise<void>;
	start(): void;
	stop(): Promise<void>;
}

/** Executor side: accepting, queueing and running tasks delegated to this node. Implemented in `executor.ts`. */
export interface ExecutorApi {
	/**
	 * `POST /tasks` handler. Idempotent by task id (a known id returns the existing row with `created: false`).
	 * Validates workspace membership, repository and agent; stores the task `offered`; auto-accepts when the peer's
	 * `autoAcceptTasks` policy applies and exactly one local project matches the repository.
	 */
	receive(peerId: string, request: wire.CreateTaskRequest): Promise<{ row: TaskRow; created: boolean }>;
	/** A human on this node accepts (choosing project/agent) or rejects an `offered` (or re-accepts a `blocked`) task. */
	decide(taskId: string, body: DecideInput): Promise<TaskRow>;
	/**
	 * Cancel a task this node executes: aborts the run, never destroys work. Terminal tasks are returned unchanged
	 * (idempotent). `by` is who asked: the sender over the wire, or the human on this node.
	 */
	cancel(taskId: string, options: { reason: string | null; by: "sender" | "local" }): Promise<TaskRow>;
	/** `mesh_complete` from the executing agent's session. Resolves with the text of the tool result. */
	complete(sessionId: string, input: { taskId?: string; outcome: "succeeded" | "failed" | "blocked"; summary: string }): Promise<string>;
	/** A message was injected into the executing session (an answer/instruction unblocks a task waiting for it). */
	messageInjected(task: TaskRow, message: TaskMessageRow): Promise<void>;
	/** Boot: re-open the sessions of running tasks (restart recovery) and start queued tasks. */
	start(): Promise<void>;
	stop(): Promise<void>;
}

/** Puts messages and status notes into agent sessions on this node. Implemented in `injector.ts`. */
export interface InjectorApi {
	/**
	 * Deliver a message into this node's session of the task (the executing session, or the delegating one on the
	 * sender) with the delivery mode of `deliveryMode` and mark it injected. False when there is no session, the task
	 * is finished, the message was authored by this node's own agent, or the session could not take it (retried
	 * later by `retryPending`). Never throws.
	 */
	injectMessage(task: TaskRow, message: TaskMessageRow): Promise<boolean>;
	/** Sender side: tell the delegating session the task ended / is blocked; once per status (`tasks.notified_status`). Never throws. */
	injectStatusNote(task: TaskRow): Promise<boolean>;
	/** Re-inject what could not be injected before (boot, session became available). Never throws. */
	retryPending(): Promise<void>;
	start(): void;
	stop(): void;
}

/** Durable at-least-once delivery of queued peer calls (`outbox` table). Implemented in `outbox.ts`. */
export interface OutboxApi {
	/** Attach what happens to queued calls of `kind` once delivery settles (see `OutboxHandler`). Kinds are plain strings. */
	register(kind: string, handler: OutboxHandler): void;
	/** New work was queued with `store.enqueue`: attempt delivery now (to this peer, or to every peer). */
	kick(peerId?: string): void;
	/** Attempt every due item now and resolve when the attempts finished (tests, shutdown). */
	drain(peerId?: string): Promise<void>;
	start(): void;
	stop(): Promise<void>;
}

export interface TaskHub {
	readonly ctx: ServerContext;
	readonly store: TaskStore;
	readonly artifacts: ArtifactStore;
	readonly log: FastifyBaseLogger;
	readonly timings: TaskTimings;
	readonly sender: SenderApi;
	readonly executor: ExecutorApi;
	readonly injector: InjectorApi;
	readonly outbox: OutboxApi;
	nodeName(): string;
	/** Which side of the task this node is. */
	roleOf(task: Pick<TaskRow, "direction">): TaskRole;
	/**
	 * Publish what changed: `tasks` and `task:<id>` bus events (`{type:"task"}`, plus `event`/`message` events on
	 * `task:<id>`), a `task.updated` network event for the peer (executor side) and an agent-directory refresh.
	 */
	changed(taskId: string, info?: ChangeInfo): void;
	/** Author a message on this node: stored, queued for the peer, injected locally when human-authored. Enforces kind rules and the loop guard. */
	postMessage(taskId: string, input: PostMessageInput): Promise<TaskMessage>;
}
