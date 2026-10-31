import { z } from "zod";
import { IsoDate } from "./common.ts";

/**
 * Local UI contracts for M4 (delegation, task engine, agent-to-agent discussion).
 * Wire protocol: docs/agent-network-protocol.md §5.5–5.8, §5.14, §6–9.
 *
 * A task always has exactly one SENDER node (the node that delegated it) and one EXECUTOR node
 * (the node whose agent runs it). Both nodes keep a copy; the executor is the source of truth for
 * status, events and results (it allocates event `seq`), the sender mirrors them.
 */

export const TaskStatus = z.enum([
	"offered", // received, waiting for a human (or policy) on the executor to accept
	"accepted", // accepted, queued behind other work on the same project
	"rejected",
	"running",
	"blocked", // running but waiting on input (question to the sender, dirty tree, approval)
	"succeeded",
	"failed",
	"cancelled",
	"handed_off", // M6
]);
export type TaskStatus = z.infer<typeof TaskStatus>;
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ["rejected", "succeeded", "failed", "cancelled", "handed_off"];

export const TaskDirection = z.enum(["outgoing", "incoming"]);
export type TaskDirection = z.infer<typeof TaskDirection>;

export const TaskParty = z.object({
	nodeId: z.string(),
	nodeName: z.string(),
	agentId: z.string().nullable(),
	agentName: z.string().nullable(),
	/** Local agent session on THIS node (delegating session on the sender, executing session on the executor); null on the other side. */
	sessionId: z.string().nullable(),
});
export type TaskParty = z.infer<typeof TaskParty>;

export const TaskResult = z.object({
	/** The executing agent's own summary (via `mesh_complete`) or its final answer. */
	summary: z.string(),
	/** True when the summary was taken from the final answer because the agent never called `mesh_complete`. */
	autoCompleted: z.boolean(),
	branch: z.string().nullable(),
	commit: z.string().nullable(),
	pushed: z.boolean(),
	/** GitHub compare URL for the pushed branch, when known. */
	compareUrl: z.string().nullable(),
	artifacts: z.array(z.object({ artifactId: z.string(), name: z.string(), sha256: z.string(), size: z.number().int() })),
});
export type TaskResult = z.infer<typeof TaskResult>;

export const TaskDeliverAs = z.enum([
	"summary", // answer only, no git changes expected
	"branch", // executor works on a task branch, commits + pushes it (patch artifact if it cannot push)
]);
export type TaskDeliverAs = z.infer<typeof TaskDeliverAs>;

export const TaskConstraints = z.object({
	maxCostUsd: z.number().positive().max(1000).optional(),
	deadline: IsoDate.optional(),
	/** Advisory: the executor may only make approvals STRICTER than its own node setting. */
	approvalMode: z.enum(["always-ask", "always-ask-cached", "write", "yolo"]).optional(),
});
export type TaskConstraints = z.infer<typeof TaskConstraints>;

export const Task = z.object({
	id: z.string(),
	direction: TaskDirection,
	workspaceId: z.string(),
	title: z.string(),
	description: z.string(),
	status: TaskStatus,
	/** Ownership epoch / fencing token (docs §9). 0 for a fresh task. */
	epoch: z.number().int(),
	repo: z.object({ url: z.string(), branch: z.string().nullable(), commit: z.string().nullable() }),
	/** Local project this task belongs to on THIS node (origin project on the sender, execution project on the executor). */
	projectId: z.string().nullable(),
	sender: TaskParty,
	executor: TaskParty,
	deliverAs: TaskDeliverAs,
	constraints: TaskConstraints,
	/** Why it was rejected / failed / blocked. */
	reason: z.string().nullable(),
	result: TaskResult.nullable(),
	/** Executor-reported spend for this task (USD), when known. */
	cost: z.number().nullable(),
	/** Sender side: delivery of the task itself to the executor (outbox). */
	delivery: z.object({ state: z.enum(["pending", "delivered", "failed"]), attempts: z.number().int(), lastError: z.string().nullable() }),
	/** Agent-authored messages left before the discussion needs a human (loop guard). */
	agentMessageBudget: z.number().int(),
	unreadMessages: z.number().int(),
	retryOf: z.string().nullable(),
	lastEventSeq: z.number().int(),
	createdAt: IsoDate,
	updatedAt: IsoDate,
	startedAt: IsoDate.nullable(),
	finishedAt: IsoDate.nullable(),
});
export type Task = z.infer<typeof Task>;

export const TaskEventType = z.enum(["status", "progress", "tool", "message", "result", "note"]);
export const TaskEvent = z.object({
	seq: z.number().int(),
	type: TaskEventType,
	at: IsoDate,
	/** Human-readable one-liner for timelines. */
	summary: z.string(),
	payload: z.unknown(),
});
export type TaskEvent = z.infer<typeof TaskEvent>;

export const TaskMessageAuthor = z.object({
	kind: z.enum(["human", "agent", "system"]),
	nodeId: z.string(),
	nodeName: z.string(),
	agentId: z.string().nullable(),
	agentName: z.string().nullable(),
});
export const TaskMessage = z.object({
	id: z.string(),
	taskId: z.string(),
	author: TaskMessageAuthor,
	kind: z.enum(["instruction", "question", "answer", "note"]),
	text: z.string(),
	createdAt: IsoDate,
	/** Delivery to the other node (outbox) — only meaningful for messages authored on this node. */
	delivery: z.enum(["local", "pending", "delivered", "failed"]),
	/** Whether the message was injected into an agent session on this node (steer / follow-up). */
	injectedIntoSession: z.boolean(),
});
export type TaskMessage = z.infer<typeof TaskMessage>;

export const TaskDetail = z.object({
	task: Task,
	events: z.array(TaskEvent),
	messages: z.array(TaskMessage),
});
export type TaskDetail = z.infer<typeof TaskDetail>;

// ---------------------------------------------------------------- requests

export const CreateTaskBody = z.object({
	targetNodeId: z.string().min(1),
	/** Omit to let the executor choose its agent. */
	targetAgentId: z.string().optional(),
	/** Local project whose linked GitHub repository the executor will work on. */
	projectId: z.string().min(1),
	title: z.string().trim().min(1).max(200),
	description: z.string().trim().min(1).max(50_000),
	deliverAs: TaskDeliverAs.default("branch"),
	/** Base branch for the executor (defaults to the repo's default branch). */
	baseBranch: z.string().optional(),
	constraints: TaskConstraints.default({}),
});

export const PostTaskMessageBody = z.object({
	text: z.string().trim().min(1).max(20_000),
	kind: z.enum(["instruction", "answer", "note"]).default("note"),
});

/** Executor side: decide an `offered` task. */
export const DecideTaskBody = z.discriminatedUnion("decision", [
	z.object({
		decision: z.literal("accept"),
		/** Local project to run in; required when the repo maps to zero or several local projects. */
		projectId: z.string().optional(),
		agentId: z.string().optional(),
	}),
	z.object({ decision: z.literal("reject"), reason: z.string().trim().min(1).max(2000) }),
]);

export const CancelTaskBody = z.object({ reason: z.string().max(2000).optional() });

export const TaskListQuery = z.object({
	direction: TaskDirection.optional(),
	status: z.string().optional(), // comma-separated TaskStatus values
	peerId: z.string().optional(),
	projectId: z.string().optional(),
	workspaceId: z.string().optional(),
});

export const ActivityItem = z.object({
	id: z.string(),
	at: IsoDate,
	kind: z.enum(["task", "message", "peer", "node"]),
	taskId: z.string().nullable(),
	workspaceId: z.string().nullable(),
	nodeName: z.string(),
	summary: z.string(),
});
export type ActivityItem = z.infer<typeof ActivityItem>;

/** Events on topic `tasks` (list-level) and `task:<id>` (detail-level). */
export type TaskTopicEvent =
	| { type: "task"; task: Task }
	| { type: "event"; taskId: string; event: TaskEvent }
	| { type: "message"; taskId: string; message: TaskMessage };

/**
 * Names of the host tools CL Agent Mesh registers in every OMP runtime (`set_host_tools`).
 * Agents use them to discover peers, delegate, discuss and report — docs/architecture.md (M4).
 */
export const MESH_HOST_TOOLS = ["mesh_agents", "mesh_delegate", "mesh_message", "mesh_task", "mesh_complete"] as const;
