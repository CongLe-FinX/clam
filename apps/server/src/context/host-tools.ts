import type { HostToolCall, HostToolDefinition, HostToolResult } from "@clam/agent-runtime";
import { ContextType } from "@clam/contracts";
import { searchContexts } from "@clam/context-engine";
import { agentSessions, agents } from "@clam/database";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { HostToolSet } from "../services/host-tool-registry.ts";
import { projectKeyOf, projectRow } from "./project-keys.ts";
import type { ContextService } from "./service.ts";
import type { ContextRow } from "./store.ts";

export const CONTEXT_HOST_TOOLS = ["mesh_memory", "mesh_remember"] as const;

/** `mesh_remember` limits: what one session may write, how long a note is, how many notes agents may keep per project. */
export const REMEMBER_PER_SESSION = 12;
export const REMEMBER_MAX_BODY = 20_000;
export const AGENT_CONTEXT_CAP = 200;
const READ_MAX_CHARS = 12_000;

const DEFINITIONS: HostToolDefinition[] = [
	{
		name: "mesh_memory",
		label: "Mesh: project memory",
		description:
			"Search or read the project memory of this session's workspace: lasting facts (memory), decisions, plans, summaries and notes that people and agents saved for this project or the whole workspace — coding conventions, architecture choices, how to run things. action 'search' (default when `query` is given) ranks matches and shows excerpts; 'read' returns one item in full by `id`; 'list' shows the newest items. Check it before asking the user something the team may already have written down.",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["search", "read", "list"], description: "Default: 'search' when query is given, else 'list'." },
				query: { type: "string", description: "Words to look for (prefix match; quote a phrase for an exact one)." },
				id: { type: "string", description: "Context id for action 'read' (ctx_…)." },
				type: { type: "string", enum: ["memory", "plan", "decision", "summary", "note"], description: "Only this kind." },
				limit: { type: "integer", description: "Maximum results (1-20, default 8)." },
			},
			required: [],
			additionalProperties: false,
		},
		loadMode: "essential",
	},
	{
		name: "mesh_remember",
		label: "Mesh: remember",
		description: `Save a durable fact, decision or plan for this project so future sessions (yours and other agents') find it with mesh_memory. What you save is PRIVATE to this node: it never leaves it until a person marks it shareable in the Shared Context page. Save only lasting, non-sensitive knowledge (never credentials or tokens); keep it short (at most ${REMEMBER_MAX_BODY} characters). Give \`id\` to update a note you saved earlier (shared notes are edited by people only). At most ${REMEMBER_PER_SESSION} saves per session.`,
		parameters: {
			type: "object",
			properties: {
				title: { type: "string", description: "Short title (max 200 characters)." },
				body: { type: "string", description: "Markdown text." },
				type: { type: "string", enum: ["memory", "plan", "decision", "summary", "note"], description: "Default 'memory'. Use 'decision' for a choice and its reason." },
				scope: { type: "string", enum: ["project", "workspace"], description: "'project' (default) for this project only, 'workspace' for every project of the workspace." },
				id: { type: "string", description: "Existing context id to update instead of creating a new one." },
			},
			required: ["title", "body"],
			additionalProperties: false,
		},
		loadMode: "essential",
	},
];

const MemoryArgs = z
	.object({
		action: z.enum(["search", "read", "list"]).optional(),
		query: z.string().trim().max(500).optional(),
		id: z.string().trim().max(64).optional(),
		type: ContextType.optional(),
		limit: z.number().int().min(1).max(20).optional(),
	})
	.strict();
const RememberArgs = z
	.object({
		title: z.string().trim().min(1, "title must not be empty").max(200, "title must be at most 200 characters"),
		body: z.string().min(1, "body must not be empty").max(REMEMBER_MAX_BODY, `body must be at most ${REMEMBER_MAX_BODY} characters`),
		type: ContextType.default("memory"),
		scope: z.enum(["project", "workspace"]).default("project"),
		id: z.string().trim().max(64).optional(),
	})
	.strict();

class ToolError extends Error {}

const flat = (s: string, max: number): string => {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * `mesh_memory` (search/read the project's contexts) and `mesh_remember` (save a private context): the agent's side of
 * the context feature. Registered for every session; a session is mapped to its project and workspace, and an agent only
 * ever sees the contexts of its own workspace that belong to its project or to the whole workspace.
 */
export class ContextHostTools implements HostToolSet {
	readonly names: readonly string[] = CONTEXT_HOST_TOOLS;
	private readonly saved = new Map<string, number>();

	constructor(private readonly hub: ContextService) {}

	definitions(_sessionId: string): HostToolDefinition[] {
		return DEFINITIONS.map((d) => ({ ...d }));
	}

	async execute(call: HostToolCall): Promise<HostToolResult> {
		try {
			const args = call.arguments === undefined || call.arguments === null ? {} : call.arguments;
			if (call.toolName === "mesh_memory") return { text: this.memory(call.sessionId, this.parse(MemoryArgs, "mesh_memory", args)) };
			if (call.toolName === "mesh_remember") return { text: this.remember(call.sessionId, this.parse(RememberArgs, "mesh_remember", args)) };
			return { text: `Unknown tool ${call.toolName}`, isError: true };
		} catch (error) {
			if (error instanceof ToolError) return { text: error.message, isError: true };
			throw error;
		}
	}

	private parse<S extends z.ZodType>(schema: S, tool: string, raw: unknown): z.infer<S> {
		const parsed = schema.safeParse(raw);
		if (parsed.success) return parsed.data;
		const issue = parsed.error.issues[0];
		let message = issue?.message ?? "invalid arguments";
		if (issue?.code === "unrecognized_keys") message = `unknown argument(s) ${issue.keys.join(", ")}`;
		else if (issue && issue.path.length > 0) message = `${issue.path.join(".")}: ${message}`;
		throw new ToolError(`${tool}: ${message}`);
	}

	/** The session's project, workspace and agent. */
	private scopeOf(sessionId: string): { projectId: string; projectKey: string; workspaceId: string; agentName: string | null } {
		const { db } = this.hub.ctx;
		const session = db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).get();
		const project = session ? projectRow(db, session.projectId) : undefined;
		if (!session || !project) throw new ToolError("This session does not belong to a project, so there is no project memory.");
		const agent = db.select({ name: agents.name }).from(agents).where(eq(agents.id, session.agentId)).get();
		return { projectId: project.id, projectKey: projectKeyOf(project), workspaceId: project.workspaceId, agentName: agent?.name ?? null };
	}

	private inScope(row: ContextRow, scope: { projectId: string; projectKey: string; workspaceId: string }): boolean {
		if (row.workspaceId !== scope.workspaceId || row.deletedAt !== null) return false;
		if (row.projectId === scope.projectId) return true;
		if (row.projectId === null && (row.projectKey === null || row.projectKey === scope.projectKey)) return true;
		return false;
	}

	// ------------------------------------------------------------------ mesh_memory

	private memory(sessionId: string, args: z.infer<typeof MemoryArgs>): string {
		const scope = this.scopeOf(sessionId);
		const action = args.action ?? (args.query ? "search" : args.id ? "read" : "list");
		const limit = args.limit ?? 8;
		if (action === "read") {
			if (!args.id) throw new ToolError("mesh_memory: action 'read' needs `id`");
			const row = this.hub.store.find(args.id);
			if (!row || !this.inScope(row, scope)) throw new ToolError(`No context ${args.id} in this project's memory.`);
			const head = this.hub.store.head(row);
			const text = head.body.length > READ_MAX_CHARS ? `${head.body.slice(0, READ_MAX_CHARS)}\n… (truncated)` : head.body;
			const where = row.projectId === null ? "workspace-wide" : "this project";
			const state = row.conflict ? `; IN CONFLICT with a version from ${row.conflict.fromNodeName} (a person must resolve it)` : "";
			return `[${row.type}] ${row.title} — ${row.id}, version ${row.version}, ${where}, ${row.shareable ? "shared with the workspace" : "private to this node"}${state}\n\n${text}`;
		}
		if (action === "search") {
			if (!args.query) throw new ToolError("mesh_memory: action 'search' needs `query`");
			const hits = searchContexts(this.hub.ctx.db.$client, args.query, {
				workspaceId: scope.workspaceId,
				project: { id: scope.projectId, key: scope.projectKey },
				includeWorkspaceWide: true,
				...(args.type && { type: args.type }),
				limit,
			});
			if (hits.length === 0) return `No project memory matches "${flat(args.query, 80)}".`;
			const rows = new Map(this.hub.store.byIds(hits.map((h) => h.id)).map((r) => [r.id, r]));
			return [`${hits.length} match${hits.length === 1 ? "" : "es"} (best first; read one in full with action 'read' and its id):`, ...hits.flatMap((h) => {
				const row = rows.get(h.id);
				return row ? [`- [${row.type}] ${row.title} — ${row.id}: ${flat(h.snippet, 220)}`] : [];
			})].join("\n");
		}
		const rows = this.hub.store.rows({ workspaceId: scope.workspaceId, project: { id: scope.projectId, key: scope.projectKey, includeWorkspaceWide: true }, ...(args.type && { type: args.type }), limit });
		if (rows.length === 0) return "This project has no saved memory yet. Save a lasting fact or decision with mesh_remember.";
		return [`${rows.length} newest item${rows.length === 1 ? "" : "s"}:`, ...rows.map((r) => `- [${r.type}] ${r.title} — ${r.id}`)].join("\n");
	}

	// ------------------------------------------------------------------ mesh_remember

	private remember(sessionId: string, args: z.infer<typeof RememberArgs>): string {
		const scope = this.scopeOf(sessionId);
		const used = this.saved.get(sessionId) ?? 0;
		if (used >= REMEMBER_PER_SESSION) {
			throw new ToolError(`mesh_remember: this session already saved ${REMEMBER_PER_SESSION} items, the limit. Put what is left in your answer; a person can save it.`);
		}
		const author = this.hub.agentAuthor(scope.agentName);
		if (args.id !== undefined) {
			const row = this.hub.store.find(args.id);
			if (!row || !this.inScope(row, scope)) throw new ToolError(`No context ${args.id} in this project's memory.`);
			if (row.shareable) throw new ToolError(`Context ${args.id} is shared with the workspace; only a person edits shared items. Save your change as a new item (omit \`id\`) or describe it in your answer.`);
			if (row.conflict) throw new ToolError(`Context ${args.id} is in conflict; a person must resolve it first.`);
			const updated = this.hub.update(row.id, { baseVersion: row.version, title: args.title, body: args.body }, author);
			this.saved.set(sessionId, used + 1);
			return `Updated "${updated.title}" (${updated.id}, now version ${updated.version}). It is private to this node until a person shares it.`;
		}
		const projectId = args.scope === "workspace" ? null : scope.projectId;
		if (this.hub.store.countAgentAuthored(scope.workspaceId, projectId) >= AGENT_CONTEXT_CAP) {
			throw new ToolError(`mesh_remember: agents already saved ${AGENT_CONTEXT_CAP} items here; ask a person to clean up, or update one with \`id\`.`);
		}
		const created = this.hub.create({ workspaceId: scope.workspaceId, ...(projectId !== null && { projectId }), type: args.type, title: args.title, body: args.body, shareable: false }, author);
		this.saved.set(sessionId, used + 1);
		return `Saved ${created.type} "${created.title}" (${created.id}) for ${projectId === null ? "the whole workspace" : "this project"}. It is private to this node until a person marks it shareable.`;
	}
}
