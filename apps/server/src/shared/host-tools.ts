import type { HostToolCall, HostToolDefinition, HostToolResult } from "@clam/agent-runtime";
import type { SharedMessage } from "@clam/contracts";
import { agentSessions, agents } from "@clam/database";
import { formatAuthor, parseSharedHostToolCall, SHARED_HOST_TOOL_DEFINITIONS, SHARED_HOST_TOOLS } from "@clam/task-engine";
import { eq } from "drizzle-orm";
import { ApiError } from "../http/errors.ts";
import { errorText } from "../network/util.ts";
import type { HostToolSet } from "../services/host-tool-registry.ts";
import type { SharedHub } from "./hub.ts";
import type { SharedRow } from "./store.ts";

const EXCERPT_CHARS = 200;

/** A tool failure the agent should read and act on (never thrown past `execute`). */
class ToolError extends Error {}

/**
 * `mesh_team` and `mesh_say`: the agent's side of a shared session. They are registered for every session (a session can
 * become shared after its runtime started) and answer with a clear error when the calling session is not the driving
 * session or the participant agent session of an active shared session.
 */
export class SharedHostTools implements HostToolSet {
	readonly names: readonly string[] = SHARED_HOST_TOOLS;

	constructor(private readonly hub: SharedHub) {}

	definitions(_sessionId: string): HostToolDefinition[] {
		return SHARED_HOST_TOOL_DEFINITIONS.map((definition) => ({ ...definition }));
	}

	async execute(call: HostToolCall): Promise<HostToolResult> {
		const parsed = parseSharedHostToolCall(call.toolName, call.arguments);
		if (!parsed.ok) return { text: parsed.error, isError: true };
		try {
			if (call.signal.aborted) return { text: "the call was cancelled", isError: true };
			const shared = this.sharedOf(call.sessionId);
			const tool = parsed.call;
			if (tool.name === "mesh_team") return { text: this.team(shared) };
			return { text: await this.say(shared, call.sessionId, tool.args) };
		} catch (error) {
			if (!(error instanceof ToolError) && !(error instanceof ApiError)) this.hub.log.warn({ err: errorText(error), tool: call.toolName }, "a shared host tool failed");
			return { text: errorText(error, 1000), isError: true };
		}
	}

	/** The shared session this session works for: its driving session (while this node drives) or this node's participant agent session. */
	private sharedOf(sessionId: string): SharedRow {
		const row = this.hub.ctx.db.select({ movedTo: agentSessions.movedTo, kind: agentSessions.kind }).from(agentSessions).where(eq(agentSessions.id, sessionId)).get();
		const shared = this.hub.store.bySession(sessionId) ?? this.hub.store.byAgentSession(sessionId);
		if (!row || !shared || shared.state !== "active") {
			throw new ToolError("this session does not belong to a shared session; mesh_team and mesh_say only work in sessions that are part of one (add a participant to the session from the Shared tab first)");
		}
		if (row.kind === "mirror") throw new ToolError("this is a read-only live copy of another node's session; use the participant agent session of the shared session to talk to the team");
		if (row.movedTo) throw new ToolError(`this session moved to ${row.movedTo.nodeName}; the work continues there`);
		const driving = shared.localRole === "driver" && shared.localSessionId === sessionId;
		const participating = shared.localRole !== "driver" && this.hub.store.participant(shared.id, this.hub.ctx.identity.nodeId)?.agentSessionId === sessionId;
		if (!driving && !participating) throw new ToolError("this session is not the driving session nor this node's participant session of the shared session");
		return shared;
	}

	private team(shared: SharedRow): string {
		const view = this.hub.views.shared(shared);
		const driver = view.participants.find((p) => p.role === "driver");
		const lines = [
			`Shared session ${shared.id} · "${shared.title}" (a group chat: every member node keeps the same log; the final text of each of your turns is posted to it; an at-sign right before an agent name, a node name or the word all wakes them)`,
			`Epoch ${shared.epoch}; shared branch ${shared.branch} (${shared.repoUrl})`,
			`This node: ${this.hub.nodeName()} — ${shared.localRole === "driver" ? "you are the LEAD (driving session)" : "you are a participant agent"}`,
			`Driver: ${driver ? formatAuthor({ kind: "agent", agentName: driver.agentName, nodeName: driver.nodeName }) : shared.driverNodeName}${driver ? ` (${driver.nodeStatus})` : ""}`,
			"",
			"Participants:",
		];
		for (const p of view.participants) {
			const who = p.agentName ? `${p.agentName}@${p.nodeName}` : p.nodeName;
			lines.push(`- ${who}: ${p.role === "driver" ? "lead (driver)" : "participant"}, ${p.state}, node ${p.nodeStatus}${p.agentName ? " — can be mentioned by its agent name or its node name" : " — no agent"}`);
		}
		const last = view.lastCheckpoint;
		lines.push("", last ? `Last checkpoint: #${last.seq}${last.commit ? ` commit ${last.commit.slice(0, 12)}` : ""}${last.pushed ? " (pushed)" : " (not pushed)"}, ${last.snapshot ? `session snapshot held by ${last.deliveredTo.length} participant(s)` : "no session snapshot"}, ${last.at}` : "No checkpoint has been taken yet.");
		const thread = this.hub.store.messages(shared.id).filter((m) => m.authorKind !== "system").slice(-6);
		if (thread.length > 0) {
			lines.push("", `Last ${thread.length} message(s) in the group chat:`);
			for (const m of thread) {
				const text = m.text.replace(/\s+/g, " ").trim();
				const author = formatAuthor({ kind: m.authorKind as "human" | "agent" | "system", agentName: m.authorAgentName, nodeName: m.authorNodeName });
				lines.push(`- ${author} (${m.kind}): ${text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS - 1)}…` : text}`);
			}
		}
		lines.push("", `Messages your node's agents may still post that wake another agent: ${view.agentMessageBudget}`);
		return lines.join("\n");
	}

	private async say(shared: SharedRow, sessionId: string, args: { text: string; kind: "question" | "answer" | "note" | "instruction" }): Promise<string> {
		const agent = this.hub.ctx.db
			.select({ id: agents.id, name: agents.name })
			.from(agentSessions)
			.innerJoin(agents, eq(agents.id, agentSessions.agentId))
			.where(eq(agentSessions.id, sessionId))
			.get();
		const posted = await this.hub.discussion.post(shared.id, { text: args.text, kind: args.kind, author: { kind: "agent", agentId: agent?.id ?? null, agentName: agent?.name ?? null } });
		const remaining = this.hub.store.budget(shared.id, shared.agentMessageLimit).remaining;
		const woken = this.woken(shared, posted.to);
		const lines = [`Posted to the group chat (id ${posted.id}, kind ${args.kind}); every member node keeps it. ${woken ? `Woken: ${woken}.` : "Nobody was woken: to wake an agent, write an at-sign right before its agent name or node name (or before the word all) in the text."} You can post ${remaining} more waking messages before a human must write.`];
		if (args.kind === "question" && woken) lines.push('End your turn now; the answer arrives as a message starting "[CL Agent Mesh]".');
		return lines.join("\n");
	}

	/** Names of the other agents a message wakes (empty = nobody). */
	private woken(shared: SharedRow, to: SharedMessage["to"]): string {
		const self = this.hub.ctx.identity.nodeId;
		const others = this.hub.views.shared(shared).participants.filter((p) => p.state === "active" && p.nodeId !== self && p.agentId !== null);
		const named = to.mode === "all" ? others : to.mode === "agents" ? others.filter((p) => to.agents.some((a) => a.nodeId === p.nodeId)) : [];
		return named.map((p) => formatAuthor({ kind: "agent", agentName: p.agentName, nodeName: p.nodeName })).join(", ");
	}
}
