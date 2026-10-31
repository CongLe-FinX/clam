import { z } from "zod";
import type { MessageKind } from "./messages.ts";

export interface HostToolSpec {
	name: string;
	label: string;
	description: string;
	parameters: Record<string, unknown>;
	loadMode?: "essential" | "discoverable";
}

export const HOST_TOOL_DEFINITIONS: readonly HostToolSpec[] = [
	{
		name: "mesh_agents",
		label: "Mesh: list agents",
		description:
			"List this node and every paired peer node in the CL Agent Mesh, with each node's status (online/offline), the agents available on it, and whether each accepts delegated tasks (acceptsTasks). Call this before mesh_delegate to find a valid node and agent name. Takes no arguments.",
		parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
		loadMode: "essential",
	},
	{
		name: "mesh_delegate",
		label: "Mesh: delegate task",
		description:
			"Delegate a task to an agent on another node. The task is created from this session's project (same repository) and offered to the target node, where a human or policy accepts it. Returns the new taskId and its status immediately; it does not wait for the work. Use mesh_task to check progress, mesh_message to discuss. Give complete, self-contained instructions: the executor has no access to this conversation. Results arrive later as a message beginning [CL Agent Mesh] — end your turn rather than polling.",
		parameters: {
			type: "object",
			properties: {
				node: { type: "string", description: "Target node name or id (see mesh_agents)." },
				agent: { type: "string", description: "Target agent name or id on that node. Omit to let the node choose." },
				title: { type: "string", description: "Short task title (max 200 chars)." },
				instructions: { type: "string", description: "Full instructions for the executing agent (max 50000 chars)." },
				deliverAs: {
					type: "string",
					enum: ["summary", "branch"],
					description: "'branch' (default): changes are committed and pushed to a work branch. 'summary': no git changes, answer in text.",
				},
				baseBranch: { type: "string", description: "Branch to base the work on. Defaults to the project's current branch." },
				maxCostUsd: { type: "number", description: "Optional cost ceiling in USD for the executor." },
			},
			required: ["node", "title", "instructions"],
			additionalProperties: false,
		},
		loadMode: "essential",
	},
	{
		name: "mesh_message",
		label: "Mesh: message on task",
		description:
			"Send a message on a delegated task to the other party. kind: 'question' (ask for clarification), 'answer' (reply to a question), 'note' (FYI, default), 'instruction' (only the task's sender may instruct). After sending a question, END YOUR TURN to wait: the reply arrives as a new message beginning [CL Agent Mesh]. Loop guard: each agent may send at most 12 messages on a task until a human writes on it; do not chat back and forth needlessly — be concise and only message when it moves the task forward.",
		parameters: {
			type: "object",
			properties: {
				taskId: { type: "string", description: "The task id." },
				text: { type: "string", description: "Message text (max 20000 chars)." },
				kind: { type: "string", enum: ["question", "answer", "note", "instruction"], description: "Message kind, default 'note'." },
			},
			required: ["taskId", "text"],
			additionalProperties: false,
		},
		loadMode: "essential",
	},
	{
		name: "mesh_task",
		label: "Mesh: task status",
		description:
			"Get the current status, result and recent messages of a delegated task by taskId (works for tasks you delegated and tasks you are executing). Use it to check progress once; do not poll in a loop — completion is announced to you as a message beginning [CL Agent Mesh].",
		parameters: {
			type: "object",
			properties: { taskId: { type: "string", description: "The task id." } },
			required: ["taskId"],
			additionalProperties: false,
		},
		loadMode: "essential",
	},
	{
		name: "mesh_complete",
		label: "Mesh: complete task",
		description:
			"Report the outcome of the delegated task you are executing. Only for the agent executing a delegated task. outcome: 'succeeded' (done), 'failed' (could not do it), 'blocked' (need input you could not get). Summary should state what was done or what is missing. For deliverAs=branch, CL Agent Mesh commits and pushes your working-tree changes afterwards. Call it once, as your last action, then end your turn.",
		parameters: {
			type: "object",
			properties: {
				taskId: { type: "string", description: "The task id. Optional if you are executing exactly one task." },
				outcome: { type: "string", enum: ["succeeded", "failed", "blocked"], description: "Outcome of the task." },
				summary: { type: "string", description: "What was done / why it failed or blocked (max 20000 chars)." },
			},
			required: ["outcome", "summary"],
			additionalProperties: false,
		},
		loadMode: "essential",
	},
];

export type HostToolCall =
	| { name: "mesh_agents"; args: {} }
	| {
			name: "mesh_delegate";
			args: {
				node: string;
				agent?: string;
				title: string;
				instructions: string;
				deliverAs: "summary" | "branch";
				baseBranch?: string;
				maxCostUsd?: number;
			};
	  }
	| { name: "mesh_message"; args: { taskId: string; text: string; kind: MessageKind } }
	| { name: "mesh_task"; args: { taskId: string } }
	| { name: "mesh_complete"; args: { taskId?: string; outcome: "succeeded" | "failed" | "blocked"; summary: string } };

const req = (tool: string, field: string, max: number) =>
	z
		.string({ error: `${tool}: ${field} is required and must be a string` })
		.trim()
		.min(1, `${tool}: ${field} must not be empty`)
		.max(max, `${tool}: ${field} must be at most ${max} characters`);
const opt = (tool: string, field: string, max = 500) =>
	z
		.string({ error: `${tool}: ${field} must be a string` })
		.trim()
		.max(max, `${tool}: ${field} must be at most ${max} characters`)
		.transform((s) => (s === "" ? undefined : s))
		.optional();

const SCHEMAS = {
	mesh_agents: z.object({}).strict(),
	mesh_delegate: z
		.object({
			node: req("mesh_delegate", "node", 200),
			agent: opt("mesh_delegate", "agent", 200),
			title: req("mesh_delegate", "title", 200),
			instructions: req("mesh_delegate", "instructions", 50000),
			deliverAs: z.enum(["summary", "branch"], { error: "mesh_delegate: deliverAs must be 'summary' or 'branch'" }).default("branch"),
			baseBranch: opt("mesh_delegate", "baseBranch"),
			maxCostUsd: z
				.number({ error: "mesh_delegate: maxCostUsd must be a number" })
				.positive("mesh_delegate: maxCostUsd must be positive")
				.finite()
				.optional(),
		})
		.strict(),
	mesh_message: z
		.object({
			taskId: req("mesh_message", "taskId", 200),
			text: req("mesh_message", "text", 20000),
			kind: z
				.enum(["question", "answer", "note", "instruction"], {
					error: "mesh_message: kind must be one of question, answer, note, instruction",
				})
				.default("note"),
		})
		.strict(),
	mesh_task: z.object({ taskId: req("mesh_task", "taskId", 200) }).strict(),
	mesh_complete: z
		.object({
			taskId: opt("mesh_complete", "taskId", 200),
			outcome: z.enum(["succeeded", "failed", "blocked"], { error: "mesh_complete: outcome must be one of succeeded, failed, blocked" }),
			summary: req("mesh_complete", "summary", 20000),
		})
		.strict(),
} as const;

function stripUndefined<T extends Record<string, unknown>>(o: T): T {
	for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
	return o;
}

export function parseHostToolCall(
	name: string,
	raw: unknown,
): { ok: true; call: HostToolCall } | { ok: false; error: string } {
	if (!Object.hasOwn(SCHEMAS, name)) {
		return { ok: false, error: `unknown tool '${name}'; available: ${Object.keys(SCHEMAS).join(", ")}` };
	}
	const key = name as keyof typeof SCHEMAS;
	const input = raw === undefined || raw === null ? {} : raw;
	const r = SCHEMAS[key].safeParse(input);
	if (!r.success) {
		const issue = r.error.issues[0];
		let msg = issue?.message ?? "invalid arguments";
		if (issue?.code === "unrecognized_keys") msg = `${name}: unknown argument(s) ${issue.keys.join(", ")}`;
		else if (issue && !msg.startsWith(name)) {
			const field = issue.path.join(".");
			msg = `${name}: ${field ? `${field}: ` : ""}${msg}`;
		}
		return { ok: false, error: msg };
	}
	return { ok: true, call: { name: key, args: stripUndefined({ ...(r.data as Record<string, unknown>) }) } as HostToolCall };
}
