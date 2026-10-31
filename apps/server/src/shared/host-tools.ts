import type { HostToolCall, HostToolDefinition, HostToolResult } from "@clam/agent-runtime";
import { ATTACHMENT_MAX_BYTES, type SharedMessage } from "@clam/contracts";
import { agentSessions, agents } from "@clam/database";
import { formatAuthor, parseSharedHostToolCall, SHARED_HOST_TOOL_DEFINITIONS, SHARED_HOST_TOOLS } from "@clam/task-engine";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { ApiError } from "../http/errors.ts";
import { errorText } from "../network/util.ts";
import type { HostToolSet } from "../services/host-tool-registry.ts";
import type { SharedHub } from "./hub.ts";
import type { SharedRow } from "./store.ts";

const EXCERPT_CHARS = 200;

const SHARE_FILE_TOOL = "mesh_share_file";

const SHARE_FILE_DEFINITION: HostToolDefinition = {
	name: SHARE_FILE_TOOL,
	label: "Mesh: share a file in the group chat",
	description: `Post a file from your working folder into the group chat of the shared session as an attachment, so the human and every agent (on any node) can open, preview and download it: a report (md, pdf, docx), an image, audio, a video, a spreadsheet, a zip of results. Use it to DELIVER what you produced; the file is copied as it is now (later edits are not shared). Every member node stores it and the other agents get it copied into their own working folder. \`path\` is relative to your working folder (an absolute path inside it also works) and must name a regular file of at most ${Math.floor(ATTACHMENT_MAX_BYTES / 1024 ** 3)} GB. \`caption\` is an optional message shown with it (an at-sign mention in it wakes that agent, like in mesh_say).`,
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "File to share, relative to your working folder." },
			caption: { type: "string", description: "Optional text posted with the file (max 2000 chars)." },
		},
		required: ["path"],
		additionalProperties: false,
	},
	loadMode: "essential",
};

const ShareFileArgs = z
	.object({
		path: z.string({ error: "mesh_share_file: path is required" }).trim().min(1, "mesh_share_file: path must not be empty").max(4096),
		caption: z.string().trim().max(2000, "mesh_share_file: caption must be at most 2000 characters").optional(),
	})
	.strict();

/** A tool failure the agent should read and act on (never thrown past `execute`). */
class ToolError extends Error {}

/**
 * `mesh_team` and `mesh_say`: the agent's side of a shared session. They are registered for every session (a session can
 * become shared after its runtime started) and answer with a clear error when the calling session is not the driving
 * session or the participant agent session of an active shared session.
 */
export class SharedHostTools implements HostToolSet {
	readonly names: readonly string[] = [...SHARED_HOST_TOOLS, SHARE_FILE_TOOL];

	constructor(private readonly hub: SharedHub) {}

	definitions(_sessionId: string): HostToolDefinition[] {
		return [...SHARED_HOST_TOOL_DEFINITIONS.map((definition) => ({ ...definition })), { ...SHARE_FILE_DEFINITION }];
	}

	async execute(call: HostToolCall): Promise<HostToolResult> {
		if (call.toolName === SHARE_FILE_TOOL) return this.shareFile(call);
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

	private async shareFile(call: HostToolCall): Promise<HostToolResult> {
		const args = ShareFileArgs.safeParse(call.arguments ?? {});
		if (!args.success) return { text: args.error.issues[0]?.message ?? "invalid arguments", isError: true };
		try {
			if (call.signal.aborted) return { text: "the call was cancelled", isError: true };
			const shared = this.sharedOf(call.sessionId);
			const agent = this.hub.ctx.db
				.select({ id: agents.id, name: agents.name })
				.from(agentSessions)
				.innerJoin(agents, eq(agents.id, agentSessions.agentId))
				.where(eq(agentSessions.id, call.sessionId))
				.get();
			const posted = await this.hub.attachments.shareFile(shared.id, call.sessionId, { path: args.data.path, caption: args.data.caption, agent: { id: agent?.id ?? null, name: agent?.name ?? null } });
			return { text: `Posted ${posted.attachment.name} (${posted.attachment.mimeType}, ${posted.attachment.size} bytes) to the group chat (message ${posted.messageId}); every member node keeps it.` };
		} catch (error) {
			if (!(error instanceof ToolError) && !(error instanceof ApiError)) this.hub.log.warn({ err: errorText(error), tool: call.toolName }, "mesh_share_file failed");
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
			shared.vcs === "files" ? `Epoch ${shared.epoch}; no git repository: the driver's working folder travels as a bundle at every checkpoint`: `Epoch ${shared.epoch}; shared branch ${shared.branch} (${shared.repoUrl})`,
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
		lines.push("", last ? `Last checkpoint: #${last.seq}${last.files ? ` folder bundle of ${last.files.fileCount} file(s)` : last.commit ? ` commit ${last.commit.slice(0, 12)}` : ""}${last.files ? "" : last.pushed ? " (pushed)" : " (not pushed)"}, ${last.snapshot ? `session snapshot held by ${last.deliveredTo.length} participant(s)` : "no session snapshot"}, ${last.at}` : "No checkpoint has been taken yet.");
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
