import type { HostToolCall, HostToolDefinition, HostToolResult } from "@clam/agent-runtime";
import { agentSessions, agents, peerAgents, projects } from "@clam/database";
import { MESH_HOST_TOOLS } from "@clam/contracts";
import { formatAuthor, HOST_TOOL_DEFINITIONS, parseHostToolCall, type HostToolCall as ParsedCall } from "@clam/task-engine";
import { eq } from "drizzle-orm";
import { ApiError } from "../http/errors.ts";
import { errorText } from "../network/util.ts";
import type { HostToolSet } from "../services/host-tool-registry.ts";
import type { TaskHub } from "./hub.ts";
import type { TaskRow } from "./store.ts";

const EXCERPT_CHARS = 300;
const THREAD_MESSAGES = 5;

interface CallerSession {
	sessionId: string;
	agentId: string;
	agentName: string;
	projectId: string;
}

type Args<N extends ParsedCall["name"]> = Extract<ParsedCall, { name: N }>["args"];

/** A tool failure the agent should read and act on (never thrown past `execute`). */
class ToolError extends Error {}

/**
 * The `mesh_*` host tools every agent runtime gets. Results are short plain text an LLM can act on; every failure
 * is an error result, so a refusal (loop guard, capability, finished task) never breaks the agent's turn.
 */
export class MeshHostTools implements HostToolSet {
	readonly names: readonly string[] = MESH_HOST_TOOLS;

	constructor(private readonly hub: TaskHub) {}

	definitions(_sessionId: string): HostToolDefinition[] {
		return HOST_TOOL_DEFINITIONS.map((definition) => ({ ...definition }));
	}

	async execute(call: HostToolCall): Promise<HostToolResult> {
		const parsed = parseHostToolCall(call.toolName, call.arguments);
		if (!parsed.ok) return { text: parsed.error, isError: true };
		try {
			if (call.signal.aborted) return { text: "the call was cancelled", isError: true };
			const session = this.session(call.sessionId);
			const tool = parsed.call;
			switch (tool.name) {
				case "mesh_agents":
					return { text: this.agents() };
				case "mesh_delegate":
					return { text: await this.delegate(session, tool.args) };
				case "mesh_message":
					return { text: await this.message(session, tool.args) };
				case "mesh_task":
					return { text: this.task(session, tool.args) };
				case "mesh_complete":
					return { text: await this.hub.executor.complete(session.sessionId, tool.args) };
			}
		} catch (error) {
			if (!(error instanceof ToolError) && !(error instanceof ApiError)) this.hub.log.warn({ err: errorText(error), tool: call.toolName }, "a mesh host tool failed");
			return { text: errorText(error, 1000), isError: true };
		}
	}

	private session(sessionId: string): CallerSession {
		const row = this.hub.ctx.db
			.select({ agentId: agents.id, agentName: agents.name, projectId: projects.id })
			.from(agentSessions)
			.innerJoin(agents, eq(agents.id, agentSessions.agentId))
			.innerJoin(projects, eq(projects.id, agentSessions.projectId))
			.where(eq(agentSessions.id, sessionId))
			.get();
		if (!row) throw new ToolError(`session ${sessionId} is not known on this node`);
		return { sessionId, ...row };
	}

	// ------------------------------------------------------------------ mesh_agents

	private agents(): string {
		const { identity, network } = this.hub.ctx;
		const directory = network.directory.list();
		const lines = [`This node: ${this.hub.nodeName()} (${identity.nodeId})`];
		const local = directory.filter((a) => a.nodeStatus === "self");
		for (const agent of local) lines.push(`  - ${agent.name} (${agent.agentId})${agent.role ? ` ${agent.role}` : ""}, ${agent.status}`);
		const peers = network.peers.activeRows();
		if (peers.length === 0) {
			lines.push("", "No peer nodes are paired, so there is nobody to delegate to.");
			return lines.join("\n");
		}
		for (const peer of peers) {
			const mayDelegate = (peer.receivedCapabilities as string[]).includes("tasks.send");
			lines.push("", `${peer.name} (${peer.id}) — ${peer.status}; tasks: ${mayDelegate ? "you may delegate" : "not allowed (missing tasks.send)"}`);
			const theirs = directory.filter((a) => a.nodeId === peer.id);
			if (theirs.length === 0) lines.push("  (no agents known)");
			for (const agent of theirs) lines.push(`  - ${agent.name} (${agent.agentId})${agent.role ? ` ${agent.role}` : ""}, ${agent.status}, acceptsTasks: ${agent.status !== "offline"}`);
		}
		return lines.join("\n");
	}

	// ------------------------------------------------------------------ mesh_delegate

	private async delegate(session: CallerSession, args: Args<"mesh_delegate">): Promise<string> {
		const peer = this.resolvePeer(args.node);
		let agent: { agentId: string; name: string } | null = null;
		if (args.agent) {
			const known = this.hub.ctx.db.select({ agentId: peerAgents.agentId, name: peerAgents.name }).from(peerAgents).where(eq(peerAgents.peerId, peer.id)).all();
			const wanted = args.agent.toLowerCase();
			const matches = known.filter((a) => a.agentId === args.agent);
			if (matches.length === 0) matches.push(...known.filter((a) => a.name.toLowerCase() === wanted));
			const listing = known.length === 0 ? `${peer.name} has no known agents` : `agents on ${peer.name}: ${known.map((a) => `${a.name} (${a.agentId})`).join(", ")}`;
			if (matches.length === 0) throw new ToolError(`no agent "${args.agent}" on ${peer.name}; ${listing}`);
			if (matches.length > 1) throw new ToolError(`"${args.agent}" matches several agents on ${peer.name}; use an id. ${listing}`);
			agent = matches[0] as { agentId: string; name: string };
		}
		const row = await this.hub.sender.create({
			targetNodeId: peer.id,
			targetAgentId: agent?.agentId ?? null,
			projectId: session.projectId,
			title: args.title,
			description: args.instructions,
			deliverAs: args.deliverAs,
			baseBranch: args.baseBranch ?? null,
			constraints: args.maxCostUsd ? { maxCostUsd: args.maxCostUsd } : {},
			senderSessionId: session.sessionId,
		});
		const reachable = this.hub.ctx.network.peers.row(peer.id)?.status !== "offline";
		return [
			`Delegated: task ${row.id} to ${agent?.name ?? "any agent"}@${peer.name} (${args.deliverAs === "branch" ? "result as a pushed branch" : "result as a summary"}).`,
			reachable ? "It is being delivered now." : `${peer.name} is offline; the task is queued and is delivered as soon as it is back.`,
			`Replies, questions and the completion note arrive as messages that start with "[CL Agent Mesh] task ${row.id}".`,
			"Use mesh_message (taskId) to talk to it and mesh_task to check status; end your turn to wait for it instead of polling.",
		].join("\n");
	}

	/** The paired node a name or id refers to; ids win over names. */
	private resolvePeer(node: string) {
		const peers = this.hub.ctx.network.peers.activeRows();
		const byId = peers.find((p) => p.id === node);
		if (byId) return byId;
		const matches = peers.filter((p) => p.name.toLowerCase() === node.toLowerCase());
		const known = peers.map((p) => `${p.name} (${p.id})`).join(", ");
		if (matches.length === 1) return matches[0] as (typeof peers)[number];
		if (matches.length > 1) throw new ToolError(`"${node}" matches several nodes; use an id. Nodes: ${known}`);
		throw new ToolError(peers.length === 0 ? "no peer nodes are paired" : `no paired node "${node}". Nodes: ${known}`);
	}

	// ------------------------------------------------------------------ mesh_message / mesh_task

	/** A task is visible to the session that delegated it (sender) or executes it (executor), nobody else. */
	private taskOf(session: CallerSession, taskId: string): TaskRow {
		const task = this.hub.store.find(taskId);
		if (!task) throw new ToolError(`task ${taskId} not found`);
		const own = task.direction === "outgoing" ? task.senderSessionId : task.executorSessionId;
		if (own !== session.sessionId) throw new ToolError(`this session is not part of task ${taskId}`);
		return task;
	}

	private async message(session: CallerSession, args: Args<"mesh_message">): Promise<string> {
		const task = this.taskOf(session, args.taskId);
		const posted = await this.hub.postMessage(task.id, { text: args.text, kind: args.kind, author: { kind: "agent", agentId: session.agentId, agentName: session.agentName } });
		const peerName = task.direction === "outgoing" ? task.executorNodeName : task.senderNodeName;
		const remaining = this.hub.store.budget(task.id).remaining;
		const lines = [`Message sent to ${peerName} (id ${posted.id}, kind ${args.kind}). You can send ${remaining} more messages on this task before a human must continue.`];
		if (args.kind === "question") lines.push('End your turn now; the answer arrives as a message starting "[CL Agent Mesh]".');
		return lines.join("\n");
	}

	private task(session: CallerSession, args: Args<"mesh_task">): string {
		const row = this.taskOf(session, args.taskId);
		const task = this.hub.store.toTask(row);
		const role = this.hub.roleOf(row);
		const peerNode = role === "sender" ? task.executor : task.sender;
		const peerAgent = peerNode.agentName ? `${peerNode.agentName}@${peerNode.nodeName}` : peerNode.nodeName;
		const lines = [
			`Task ${task.id} · "${task.title}"`,
			`Your role: ${role === "sender" ? "delegating agent (sender)" : "executing agent (executor)"}`,
			`Status: ${task.status}${task.reason ? ` (${task.reason})` : ""}`,
			`${role === "sender" ? "Executor" : "Delegated by"}: ${role === "sender" && !peerNode.agentName ? `${peerNode.nodeName} (agent not chosen yet)` : peerAgent}`,
		];
		if (role === "sender") {
			const d = task.delivery;
			lines.push(`Delivery: ${d.state === "delivered" ? "delivered to the executor" : d.state === "pending" ? "queued, not delivered yet" : "failed"}${d.lastError ? ` (${d.lastError})` : ""}`);
		}
		const result = task.result;
		if (result) {
			if (result.branch) lines.push(`Branch: ${result.branch}${result.commit ? ` @ ${result.commit.slice(0, 12)}` : ""}${result.pushed ? " (pushed)" : " (not pushed)"}`);
			if (result.compareUrl) lines.push(`Compare: ${result.compareUrl}`);
			if (result.artifacts.length > 0) lines.push(`Artifacts: ${result.artifacts.map((a) => a.name).join(", ")}`);
			lines.push(`Summary${result.autoCompleted ? " (auto-completed, the agent never called mesh_complete)" : ""}: ${result.summary}`);
		}
		lines.push(`Messages you may still send: ${task.agentMessageBudget}`);
		const thread = this.hub.store.messages(row.id).slice(-THREAD_MESSAGES);
		if (thread.length > 0) {
			lines.push("", `Last ${thread.length} message(s):`);
			for (const m of thread) {
				const text = m.text.replace(/\s+/g, " ").trim();
				const author = formatAuthor({ kind: m.authorKind as "human" | "agent" | "system", agentName: m.authorAgentName, nodeName: m.authorNodeName });
				lines.push(`- ${author} (${m.kind}): ${text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS - 1)}…` : text}`);
			}
		}
		return lines.join("\n");
	}
}
