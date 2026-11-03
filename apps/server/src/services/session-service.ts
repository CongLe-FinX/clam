import { mkdir, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { ApprovalMode, RuntimeSession } from "@clam/agent-runtime";
import { placeSessionFile, readSubagentRoster, readSubagentTranscript, standardizeProjectDir } from "@clam/agent-runtime/omp";
import {
	type AgentSession,
	type PendingUiRequest,
	type MessagesPage,
	type CreateSessionBody,
	type RuntimeStatus,
	type SessionEvent,
	type SessionLiveState,
	type SessionStats,
	type SetModelBody,
	type SetThinkingBody,
	type CompactBody,
	type UpdateSessionBody,
	type CancelSubagentResult,
	type SubagentMessagesPage,
	type SubagentsPage,
	type UiResponseBody,
	type PromptBody,
	checkoutIdOf as joinCheckoutId,
	i18nMsg,
} from "@clam/contracts";
import type { z } from "zod";
import { agentSessions, agents, nodeEvents, projects, providerUsage, sharedSessions } from "@clam/database";
import { and, desc, eq, sql } from "drizzle-orm";
import type { ServerContext } from "../context.ts";
import { ApiError } from "../http/errors.ts";
import { CHAT_RENDERING_GUIDANCE } from "./agent-guidance.ts";
import { newId } from "./ids.ts";
import { deleteManagedFolder } from "./project-folders.ts";
import { resolveCheckout } from "./checkouts.ts";
import { drivesGitShare, ensureSharedCheckout, hasWorktree, removeWorktree } from "../shared/worktrees.ts";

type SessionRow = typeof agentSessions.$inferSelect;

const DEFAULT_TITLE = "New session";
const MAX_TITLE = 60;
const IDEMPOTENCY_WINDOW = 256;
const COST_EPSILON = 1e-9;

/** Per-session runtime settings applied whenever the session's process is (re)spawned: set by the task engine for executing sessions. */
export interface SpawnOverrides {
	approvalMode?: ApprovalMode;
	maxCostUsd?: number;
}

/**
 * Serves the sessions that have no runtime on this node: mirrors (live read-only copies of a session that runs on another
 * node) and moved copies (the work continued elsewhere; their transcript is frozen). Implemented by the shared-session
 * feature, which owns the stored transcripts.
 */
export interface SessionViews {
	status(sessionId: string): AgentSession["status"];
	messages(sessionId: string, query: { cursor?: string; limit?: number }): MessagesPage;
	state(sessionId: string): SessionLiveState;
	/** The questions/approvals the driver's agent is waiting for, as replicated to this mirror (none for a moved copy). */
	pendingRequests(sessionId: string): PendingUiRequest[];
	/** A person on this machine answers one of them: forwarded to the driver, which validates it and answers its runtime. Rejects `409 already_answered` when somebody was first. */
	respond(sessionId: string, input: UiResponseInput): Promise<void>;
}

/** Refuses a session that is about to be deleted while it is still part of an active shared session. */
export type SessionRemoveGuard = (row: { id: string; kind: string; sharedSessionId: string | null }) => void;

/** Refuses a prompt to a session that must not change now (the driving session while its hand-over checkpoint is being taken). */
export type SessionPromptGuard = (row: { id: string; kind: string; sharedSessionId: string | null }, input: { clientId: string }) => void;

export type CreateSessionInput = z.infer<typeof CreateSessionBody>;
export type UpdateSessionInput = z.infer<typeof UpdateSessionBody>;
export type PromptInput = z.infer<typeof PromptBody>;
export type SetModelInput = z.infer<typeof SetModelBody>;
export type SetThinkingInput = z.infer<typeof SetThinkingBody>;
export type CompactInput = z.infer<typeof CompactBody>;
export type UiResponseInput = z.infer<typeof UiResponseBody>;

function liveStatus(state: RuntimeStatus["state"] | undefined): AgentSession["status"] {
	switch (state) {
		case "busy":
		case "starting":
		case "restarting":
			return "running";
		case "ready":
			return "idle";
		case "crashed":
			return "error";
		default:
			return "stopped";
	}
}

function titleFromPrompt(message: string): string {
	const line = message.trim().split("\n", 1)[0]?.trim() ?? "";
	if (line.length === 0) return DEFAULT_TITLE;
	return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1).trimEnd()}…` : line;
}

function splitSelector(selector: string | null): { provider: string; model: string } {
	if (selector) {
		const slash = selector.indexOf("/");
		if (slash > 0) return { provider: selector.slice(0, slash), model: selector.slice(slash + 1) };
	}
	return { provider: "unknown", model: "unattributed" };
}

/**
 * Session lifecycle on top of the provider-agnostic `AgentRuntime`: persistence of CLAM sessions,
 * on-demand runtime start, prompt idempotency, bus fan-out of runtime events and per-run usage accounting.
 */
export class SessionService {
	private readonly ctx: ServerContext;
	private readonly sessionsRoot: string;
	private readonly promptsByClientId = new Map<string, Map<string, Promise<{ promptId: string }>>>();
	private readonly usageChains = new Map<string, Promise<void>>();
	private readonly disposers: Array<() => void> = [];
	private readonly spawnOverrides = new Map<string, SpawnOverrides>();
	/** Conversations being moved to a new folder (`relocateConversation`): concurrent openers wait for the one move. */
	private readonly relocating = new Map<string, Promise<void>>();
	private started = false;
	private views: SessionViews | null = null;
	private removeGuard: SessionRemoveGuard | null = null;
	private promptGuard: SessionPromptGuard | null = null;
	/** Further guards (the handoff fence refuses prompts for sessions of fenced tasks); all must pass. */
	private readonly extraPromptGuards: SessionPromptGuard[] = [];

	constructor(ctx: ServerContext) {
		this.ctx = ctx;
		this.sessionsRoot = path.resolve(ctx.config.dataDir, "sessions");
	}

	/** Install the provider of mirror and moved-copy transcripts (the shared-session service). */
	setViews(views: SessionViews | null): void {
		this.views = views;
	}

	setRemoveGuard(guard: SessionRemoveGuard | null): void {
		this.removeGuard = guard;
	}

	setPromptGuard(guard: SessionPromptGuard | null): void {
		this.promptGuard = guard;
	}

	/** Add a guard that runs next to the one `setPromptGuard` installs. */
	addPromptGuard(guard: SessionPromptGuard): void {
		this.extraPromptGuards.push(guard);
	}

	// ------------------------------------------------------------------ wiring

	/** Forward runtime events/status to the bus and apply their persistence side effects. Idempotent. */
	start(): void {
		if (this.started) return;
		this.started = true;
		// Every process is gone at boot, whatever the previous run left behind.
		this.ctx.db.update(agentSessions).set({ status: "stopped" }).run();
		this.ctx.turnOutputs.start();
		this.disposers.push(
			this.ctx.runtime.onEvent((sessionId, event) => this.onRuntimeEvent(sessionId, event)),
			this.ctx.runtime.onStatus((status) => this.onRuntimeStatus(status)),
		);
	}

	dispose(): void {
		for (const dispose of this.disposers.splice(0)) dispose();
		this.ctx.turnOutputs.dispose();
		this.started = false;
	}

	/** Runtime settings (approval mode, `--max-cost`) for the session's process from now on; they apply at spawn, so a running process is not changed. `null` clears. */
	setSpawnOverrides(sessionId: string, overrides: SpawnOverrides | null): void {
		if (overrides === null) this.spawnOverrides.delete(sessionId);
		else this.spawnOverrides.set(sessionId, overrides);
	}

	/** Resolves when queued usage flushes are done (shutdown / tests). */
	async drainUsage(): Promise<void> {
		await Promise.all([...this.usageChains.values()]);
	}

	private onRuntimeEvent(sessionId: string, event: SessionEvent): void {
		this.ctx.bus.publish(`session:${sessionId}`, event);
		if (event.type === "settled") {
			this.touch(sessionId);
			this.queueUsageFlush(sessionId);
		} else if (event.type === "state") {
			this.persistFromState(sessionId, event.state);
		} else if (event.type === "ui_request" || event.type === "ui_request_resolved") {
			// The badge in session lists follows the pending count.
			this.publishUpsert(sessionId);
		}
	}

	private onRuntimeStatus(status: RuntimeStatus): void {
		this.ctx.bus.publish("runtime", { type: "status", status });
		const row = this.find(status.sessionId);
		if (!row) return;
		this.ctx.db
			.update(agentSessions)
			.set({ status: liveStatus(status.state) })
			.where(eq(agentSessions.id, row.id))
			.run();
		this.publishUpsert(row.id);
		if (status.state === "crashed") {
			this.ctx.db
				.insert(nodeEvents)
				.values({
					nodeId: this.ctx.identity.nodeId,
					type: "runtime.crashed",
					level: "error",
					payload: { sessionId: row.id, error: status.lastError, restarts: status.restarts },
				})
				.run();
		}
	}

	// ------------------------------------------------------------------ rows

	private find(id: string): SessionRow | undefined {
		return this.ctx.db.select().from(agentSessions).where(eq(agentSessions.id, id)).get();
	}

	get(id: string): SessionRow {
		const row = this.find(id);
		if (!row) throw ApiError.notFound("Session");
		return row;
	}

	/** The git-mode shared session `row` belongs to, when that share works in `row`'s project on this node. */
	private gitShareOf(row: SessionRow): typeof sharedSessions.$inferSelect | undefined {
		if (!row.sharedSessionId) return undefined;
		const shared = this.ctx.db.select().from(sharedSessions).where(eq(sharedSessions.id, row.sharedSessionId)).get();
		return shared && shared.vcs !== "files" && shared.localProjectId === row.projectId ? shared : undefined;
	}

	/**
	 * The git-mode shared session whose worktree `row` runs in: the session that drives it on this node (the worktree is created on
	 * demand, see `workdir`), and every other local session of the share while this node keeps its worktree — the former driver's
	 * session mid-hand-over and this node's participant agent, which then works on the shared branch beside the lead. Undefined for
	 * every other session: a participant on a node without the worktree works in the project folder.
	 */
	private worktreeShare(row: SessionRow): typeof sharedSessions.$inferSelect | undefined {
		if (this.isViewed(row)) return undefined;
		const shared = this.gitShareOf(row);
		return shared && (drivesGitShare(shared) || hasWorktree(this.ctx, shared.id)) ? shared : undefined;
	}

	/**
	 * Which folder the session shows and works in, as a checkout id: `<projectId>~<sharedId>` when it belongs to a git-mode shared session
	 * whose worktree exists on this node, otherwise `<projectId>` (the project's own folder). For a session that runs here this is the
	 * runtime's folder (`worktreeShare`, see `workdir`); a live copy of another node's session and a session that moved to another node
	 * run nothing here and show the worktree too (the shared branch as this node last had it), never the project folder.
	 */
	checkoutIdOf(row: SessionRow): string {
		const shared = this.gitShareOf(row);
		return shared && hasWorktree(this.ctx, shared.id) ? joinCheckoutId(row.projectId, shared.id) : row.projectId;
	}

	checkoutIdOfSession(id: string): string | null {
		const row = this.find(id);
		return row ? this.checkoutIdOf(row) : null;
	}

	/**
	 * The directory the session works in. A driver of a share made before worktrees existed gets its worktree created here, on demand;
	 * when that is impossible the project folder is used as it was (a problem is logged, never thrown).
	 */
	async workdir(row: SessionRow): Promise<{ dir: string; checkoutId: string }> {
		const shared = this.worktreeShare(row);
		if (shared) {
			try {
				const checkout = await ensureSharedCheckout(this.ctx, shared);
				if (checkout.worktree) return { dir: (await resolveCheckout(this.ctx, checkout.checkoutId)).dir, checkoutId: checkout.checkoutId };
			} catch (error) {
				this.ctx.log.warn({ err: error instanceof Error ? error.message : String(error), sessionId: row.id, sharedId: shared.id }, "could not prepare the worktree of a shared session; working in the project folder");
			}
		}
		const project = this.ctx.db.select().from(projects).where(eq(projects.id, row.projectId)).get();
		if (!project) throw ApiError.notFound("Project");
		return { dir: project.path, checkoutId: project.id };
	}

	/** The session's folder may have changed (it started driving a shared session): publish it and move an idle runtime there. */
	async refreshWorkdir(id: string): Promise<void> {
		this.publishUpsert(id);
		if (this.ctx.runtime.get(id)) await this.runtime(id);
	}

	toSession(row: SessionRow): AgentSession {
		return {
			id: row.id,
			projectId: row.projectId,
			agentId: row.agentId,
			title: row.title,
			runtimeSessionId: row.runtimeSessionId,
			runtimeSessionFile: row.runtimeSessionFile,
			model: row.model,
			thinkingLevel: row.thinkingLevel,
			status: this.isViewed(row) && this.views ? this.views.status(row.id) : liveStatus(this.ctx.runtime.get(row.id)?.status().state),
			stats: row.stats ?? null,
			archived: row.archived,
			kind: row.kind === "mirror" ? "mirror" : "local",
			sharedSessionId: row.sharedSessionId,
			checkoutId: this.checkoutIdOf(row),
			movedTo: row.movedTo ?? null,
			pendingRequests: this.isViewed(row) ? (this.views?.pendingRequests(row.id).length ?? 0) : (this.ctx.runtime.get(row.id)?.pendingUiRequests().length ?? 0),
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		};
	}

	private publishUpsert(id: string): void {
		const row = this.find(id);
		if (row) this.ctx.bus.publish("sessions", { type: "upsert", session: this.toSession(row) });
	}

	private touch(id: string): void {
		this.ctx.db.update(agentSessions).set({ updatedAt: new Date().toISOString() }).where(eq(agentSessions.id, id)).run();
		this.publishUpsert(id);
	}

	list(filter: { projectId?: string; archived: boolean }): AgentSession[] {
		const conditions = [eq(agentSessions.archived, filter.archived)];
		if (filter.projectId) conditions.push(eq(agentSessions.projectId, filter.projectId));
		return this.ctx.db
			.select()
			.from(agentSessions)
			.where(and(...conditions))
			.orderBy(desc(agentSessions.updatedAt))
			.all()
			.map((row) => this.toSession(row));
	}

	// ------------------------------------------------------------------ CRUD

	/** `options.agentId` picks a specific local agent (delegated tasks run under the agent the sender chose); default: the node's first OMP agent. */
	create(input: CreateSessionInput & { projectId: string }, options: { agentId?: string | null; sharedSessionId?: string | null } = {}): AgentSession {
		const project = this.ctx.db.select().from(projects).where(eq(projects.id, input.projectId)).get();
		if (!project) throw ApiError.notFound("Project");
		const agent = options.agentId
			? this.ctx.db.select().from(agents).where(and(eq(agents.runtime, "omp"), eq(agents.id, options.agentId))).get()
			: this.ctx.db.select().from(agents).where(eq(agents.runtime, "omp")).orderBy(agents.createdAt).get();
		if (!agent) throw options.agentId ? ApiError.notFound("Agent") : ApiError.unavailable(i18nMsg("This node has no OMP agent configured"));
		const id = newId("ses");
		const now = new Date().toISOString();
		this.ctx.db
			.insert(agentSessions)
			.values({
				id,
				agentId: agent.id,
				projectId: project.id,
				title: input.title?.trim() || DEFAULT_TITLE,
				sessionDir: path.join(this.sessionsRoot, id),
				model: input.model ?? null,
				sharedSessionId: options.sharedSessionId ?? null,
				status: "stopped",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		const session = this.toSession(this.get(id));
		this.ctx.bus.publish("sessions", { type: "upsert", session });
		if (input.prompt?.trim()) {
			const message = input.prompt;
			void this.prompt(id, { message, clientId: `init_${id}` }).catch((error: unknown) => {
				const say = i18nMsg("Could not send the first prompt: {error}", { error: error instanceof Error ? error.message : String(error) });
				this.ctx.bus.publish(`session:${id}`, { type: "notice", level: "error", message: say.text, i18n: say.i18n } satisfies SessionEvent);
			});
		}
		return session;
	}

	/** Mirrors and moved copies have no runtime; their transcript and state come from the shared-session views. */
	private isViewed(row: { kind: string; movedTo: unknown }): boolean {
		return row.kind === "mirror" || row.movedTo !== null;
	}

	private readOnlyError(row: SessionRow): ApiError {
		if (row.kind === "mirror") {
			return new ApiError(409, "session_read_only", i18nMsg("This is a live copy of a session that runs on another node; it cannot take prompts here. Open the session on its driver node, or take over from the shared session."));
		}
		const message = row.movedTo
			? i18nMsg("The work of this session continued on {node}; this copy is read-only.", { node: row.movedTo.nodeName })
			: i18nMsg("The work of this session continued; this copy is read-only.");
		return new ApiError(409, "session_moved", message, row.movedTo ?? undefined);
	}

	private localAgent(agentId: string | null | undefined) {
		const agent = agentId
			? this.ctx.db.select().from(agents).where(and(eq(agents.runtime, "omp"), eq(agents.id, agentId))).get()
			: this.ctx.db.select().from(agents).where(eq(agents.runtime, "omp")).orderBy(agents.createdAt).get();
		if (!agent) throw agentId ? ApiError.notFound("Agent") : ApiError.unavailable(i18nMsg("This node has no OMP agent configured"));
		return agent;
	}

	/** A read-only live copy of a session that runs on another node: a row without runtime and without conversation files. */
	createMirror(input: { projectId: string; agentId?: string | null; title: string; sharedSessionId: string }): AgentSession {
		const project = this.ctx.db.select().from(projects).where(eq(projects.id, input.projectId)).get();
		if (!project) throw ApiError.notFound("Project");
		const agent = this.localAgent(input.agentId);
		const id = newId("ses");
		const now = new Date().toISOString();
		this.ctx.db
			.insert(agentSessions)
			.values({ id, agentId: agent.id, projectId: project.id, title: input.title.slice(0, 120), sessionDir: path.join(this.sessionsRoot, id), status: "stopped", kind: "mirror", sharedSessionId: input.sharedSessionId, createdAt: now, updatedAt: now })
			.run();
		const session = this.toSession(this.get(id));
		this.ctx.bus.publish("sessions", { type: "upsert", session });
		return session;
	}

	/**
	 * A NEW local session bound to a conversation that was unpacked from a snapshot (`omp session unpack`): the unpacked
	 * file (and its artifacts) is moved into this session's own directory, so the session resumes it like any other.
	 */
	async adopt(input: { projectId: string; agentId?: string | null; title: string; sharedSessionId: string; sessionFile: string }): Promise<AgentSession> {
		const project = this.ctx.db.select().from(projects).where(eq(projects.id, input.projectId)).get();
		if (!project) throw ApiError.notFound("Project");
		const agent = this.localAgent(input.agentId);
		const id = newId("ses");
		const sessionDir = path.join(this.sessionsRoot, id);
		const placed = await placeSessionFile(input.sessionFile, sessionDir);
		const now = new Date().toISOString();
		this.ctx.db
			.insert(agentSessions)
			.values({ id, agentId: agent.id, projectId: project.id, title: input.title.slice(0, 120), sessionDir, runtimeSessionFile: placed, status: "stopped", sharedSessionId: input.sharedSessionId, createdAt: now, updatedAt: now })
			.run();
		const session = this.toSession(this.get(id));
		this.ctx.bus.publish("sessions", { type: "upsert", session });
		return session;
	}

	/** The work continued on another node: stop the runtime and make this copy read-only. */
	async markMoved(id: string, movedTo: NonNullable<AgentSession["movedTo"]>): Promise<AgentSession> {
		this.get(id);
		await this.ctx.runtime.stop(id);
		this.ctx.db.update(agentSessions).set({ movedTo, status: "stopped", updatedAt: new Date().toISOString() }).where(eq(agentSessions.id, id)).run();
		this.promptsByClientId.delete(id);
		const session = this.toSession(this.get(id));
		this.ctx.bus.publish("sessions", { type: "upsert", session });
		return session;
	}

	/** Attach (or detach with null) a session to a shared session. */
	setSharedSession(id: string, sharedSessionId: string | null): AgentSession {
		this.get(id);
		this.ctx.db.update(agentSessions).set({ sharedSessionId, updatedAt: new Date().toISOString() }).where(eq(agentSessions.id, id)).run();
		const session = this.toSession(this.get(id));
		this.ctx.bus.publish("sessions", { type: "upsert", session });
		return session;
	}

	/** The session's agent is mid-turn (or starting). */
	isBusy(id: string): boolean {
		const state = this.ctx.runtime.get(id)?.status().state;
		return state === "busy" || state === "starting" || state === "restarting";
	}

	/** The session's agent is in the middle of a turn (a runtime that is only starting or restarting is not). */
	isTurnRunning(id: string): boolean {
		return this.ctx.runtime.get(id)?.status().state === "busy";
	}

	/**
	 * Run `work` with the conversation file while no process holds it (`omp session pack|moved` refuse a session another
	 * process writes): the runtime waits for the agent to settle, stops, runs `work` and reopens in the background. A prompt
	 * that arrives meanwhile waits for the reopened runtime.
	 */
	async withConversationFile<T>(id: string, work: (sessionFile: string) => Promise<T>, options: { idleTimeoutMs?: number } = {}): Promise<T> {
		let row = this.get(id);
		if (this.isViewed(row)) throw this.readOnlyError(row);
		if (!row.runtimeSessionFile && !this.ctx.runtime.get(id)) {
			await this.runtime(id); // learns the conversation file of a session that never ran
			row = this.get(id);
		}
		const file = this.ctx.runtime.get(id)?.binding().runtimeSessionFile ?? row.runtimeSessionFile;
		if (!file) throw ApiError.conflict(i18nMsg("The session has no conversation file yet"));
		return this.ctx.runtime.withReleased(id, () => work(file), options);
	}

	update(id: string, input: UpdateSessionInput): AgentSession {
		this.get(id);
		const set: Partial<typeof agentSessions.$inferInsert> = { updatedAt: new Date().toISOString() };
		if (input.title !== undefined) set.title = input.title;
		if (input.archived !== undefined) set.archived = input.archived;
		this.ctx.db.update(agentSessions).set(set).where(eq(agentSessions.id, id)).run();
		if (input.archived) {
			void this.ctx.runtime
				.stop(id)
				.catch((error: unknown) => this.ctx.log.warn({ err: error, sessionId: id }, "failed to stop runtime of archived session"));
		}
		const session = this.toSession(this.get(id));
		this.ctx.bus.publish("sessions", { type: "upsert", session });
		return session;
	}

	/**
	 * Delete a session. When it was the last session of a chat's own working folder (project origin `chat`), that folder goes
	 * too: the project row and its managed folder, or with `keepFiles` the project becomes a normal one (origin `user`) so the files stay reachable.
	 */
	async remove(id: string, options: { keepFiles?: boolean } = {}): Promise<void> {
		const row = this.get(id);
		this.removeGuard?.(row);
		await this.ctx.runtime.stop(id);
		await this.drainUsageFor(id);
		this.ctx.db.delete(agentSessions).where(eq(agentSessions.id, id)).run();
		this.promptsByClientId.delete(id);
		const dir = path.resolve(row.sessionDir);
		const rel = path.relative(this.sessionsRoot, dir);
		if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) await rm(dir, { recursive: true, force: true });
		await this.releaseSharedWorktree(row.sharedSessionId);
		await this.releaseChatProject(row.projectId, options.keepFiles === true);
		this.ctx.bus.publish("sessions", { type: "remove", sessionId: id });
	}

	/** The worktree of a shared session goes (never forced, never its branch) once no session of this node that works in it is left. */
	private async releaseSharedWorktree(sharedId: string | null): Promise<void> {
		if (!sharedId || !hasWorktree(this.ctx, sharedId)) return;
		const remaining = this.ctx.db
			.select({ id: agentSessions.id })
			.from(agentSessions)
			.where(and(eq(agentSessions.sharedSessionId, sharedId), eq(agentSessions.kind, "local")))
			.get();
		if (!remaining) await removeWorktree(this.ctx, sharedId);
	}

	private async releaseChatProject(projectId: string, keepFiles: boolean): Promise<void> {
		const project = this.ctx.db.select().from(projects).where(eq(projects.id, projectId)).get();
		if (!project || project.origin !== "chat") return;
		const others = this.ctx.db.select({ id: agentSessions.id }).from(agentSessions).where(eq(agentSessions.projectId, projectId)).get();
		if (others) return;
		if (keepFiles) {
			this.ctx.db.update(projects).set({ origin: "user", updatedAt: new Date().toISOString() }).where(eq(projects.id, projectId)).run();
			return;
		}
		this.ctx.db.delete(projects).where(eq(projects.id, projectId)).run();
		await deleteManagedFolder(this.ctx, project);
	}

	// ------------------------------------------------------------------ runtime access

	/** Live runtime for the session, starting the process (and resuming its conversation) if needed. */
	async runtime(id: string): Promise<RuntimeSession> {
		const row = this.get(id);
		if (this.isViewed(row)) throw this.readOnlyError(row);
		const { dir: cwd } = await this.workdir(row);
		await mkdir(row.sessionDir, { recursive: true });
		// A live process keeps the directory it started in: when the session's folder changed (it became a shared session's driver) an idle one restarts there.
		const live = this.ctx.runtime.get(id);
		if (live && live.spec.cwd !== cwd && !this.isBusy(id)) await this.ctx.runtime.stop(id);
		if (!this.ctx.runtime.get(id)) {
			let moving = this.relocating.get(id);
			if (!moving) {
				moving = this.relocateConversation(row, cwd).finally(() => this.relocating.delete(id));
				this.relocating.set(id, moving);
			}
			await moving;
		}
		const session = await this.ctx.runtime.open({
			sessionId: id,
			cwd,
			sessionDir: row.sessionDir,
			// Only a brand-new conversation takes the requested model; a resumed one keeps what it was using.
			model: row.runtimeSessionId ? null : row.model,
			appendSystemPrompt: CHAT_RENDERING_GUIDANCE,
			...this.spawnOverrides.get(id),
		});
		this.persistBinding(row, session);
		return session;
	}

	/**
	 * omp resumes a conversation only in the directory recorded in its header. When the session's folder changed (a share made before
	 * worktrees, now driven from its worktree) the conversation is moved there with `omp session pack` + `unpack --cwd`; the old file and
	 * its artifacts are kept aside in `<sessionDir>/.relocated-<time>/`, never deleted. Caller: no runtime of the session is running.
	 */
	private async relocateConversation(row: SessionRow, cwd: string): Promise<void> {
		const file = row.runtimeSessionFile;
		if (!file) return;
		const recorded = await recordedCwd(file);
		const target = standardizeProjectDir(cwd);
		if (recorded === null) return;
		// Same folder under another spelling (macOS `/private/var` vs `/var`, a symlink): nothing to move.
		const [from, to] = await Promise.all([recorded, cwd].map((p) => realpath(p).catch(() => path.resolve(p))));
		if (from === to) return;
		const scratch = path.join(row.sessionDir, `.relocate-${Date.now()}.tar`);
		let unpacked: string;
		try {
			await this.ctx.ompCli.sessionPack(file, scratch);
			unpacked = (await this.ctx.ompCli.sessionUnpack(scratch, target)).sessionFile;
		} finally {
			await rm(scratch, { force: true });
		}
		const aside = path.join(row.sessionDir, `.relocated-${Date.now()}`);
		await mkdir(aside, { recursive: true });
		const name = path.basename(file, ".jsonl");
		await rename(file, path.join(aside, path.basename(file)));
		await rename(path.join(path.dirname(file), name), path.join(aside, name)).catch(() => undefined);
		const placed = await placeSessionFile(unpacked, row.sessionDir);
		this.ctx.db.update(agentSessions).set({ runtimeSessionFile: placed }).where(eq(agentSessions.id, row.id)).run();
		this.ctx.log.info({ sessionId: row.id, from: recorded, to: target }, "moved the conversation to the session's new folder");
	}

	private persistBinding(row: SessionRow, session: RuntimeSession): void {
		const binding = session.binding();
		if (binding.runtimeSessionId === row.runtimeSessionId && binding.runtimeSessionFile === row.runtimeSessionFile) return;
		this.ctx.db
			.update(agentSessions)
			.set({ runtimeSessionId: binding.runtimeSessionId, runtimeSessionFile: binding.runtimeSessionFile })
			.where(eq(agentSessions.id, row.id))
			.run();
	}

	private persistFromState(sessionId: string, state: SessionLiveState): void {
		const row = this.find(sessionId);
		if (!row) return;
		const model = state.model ? `${state.model.provider}/${state.model.id}` : row.model;
		if (model === row.model && state.thinkingLevel === row.thinkingLevel) return;
		this.ctx.db
			.update(agentSessions)
			.set({ model, thinkingLevel: state.thinkingLevel })
			.where(eq(agentSessions.id, sessionId))
			.run();
		this.publishUpsert(sessionId);
	}

	// ------------------------------------------------------------------ operations

	state(id: string): Promise<SessionLiveState> {
		const row = this.get(id);
		if (this.isViewed(row)) return this.views ? Promise.resolve(this.views.state(id)) : Promise.reject(ApiError.unavailable(i18nMsg("Shared sessions are not running")));
		return this.runtime(id).then((rt) => rt.getState());
	}

	async messages(id: string, query: { cursor?: string; limit?: number }): Promise<MessagesPage> {
		const row = this.get(id);
		if (this.isViewed(row)) {
			if (!this.views) throw ApiError.unavailable(i18nMsg("Shared sessions are not running"));
			return this.views.messages(id, query);
		}
		const rt = await this.runtime(id);
		return rt.messages(query);
	}

	/**
	 * Idempotent per `clientId`: a retry of the same prompt (same session + clientId) returns the original
	 * promptId instead of sending it twice, including while the first attempt is still being admitted.
	 */
	prompt(id: string, input: PromptInput): Promise<{ promptId: string }> {
		const row = this.get(id);
		try {
			this.promptGuard?.(row, input);
			for (const guard of this.extraPromptGuards) guard(row, input);
		} catch (error) {
			return Promise.reject(error);
		}
		let byClient = this.promptsByClientId.get(id);
		if (!byClient) {
			byClient = new Map();
			this.promptsByClientId.set(id, byClient);
		}
		const known = byClient.get(input.clientId);
		if (known) return known;
		const attempt = this.sendPrompt(row, input);
		byClient.set(input.clientId, attempt);
		while (byClient.size > IDEMPOTENCY_WINDOW) {
			const oldest = byClient.keys().next().value;
			if (oldest === undefined) break;
			byClient.delete(oldest);
		}
		attempt.catch(() => byClient.delete(input.clientId)); // a failed attempt may be retried
		return attempt;
	}

	private async sendPrompt(row: SessionRow, input: PromptInput): Promise<{ promptId: string }> {
		const rt = await this.runtime(row.id);
		// M6 project memory: the first prompt of a brand-new session carries the project's memory section (`ContextService.promptWithMemory`).
		const message = await this.ctx.contexts.promptWithMemory(row, rt, input.message);
		const accepted = await rt.prompt({ message, clientId: input.clientId, streamingBehavior: input.streamingBehavior, ...(input.images?.length ? { images: input.images } : {}) });
		const set: Partial<typeof agentSessions.$inferInsert> = { updatedAt: new Date().toISOString() };
		if (row.title === DEFAULT_TITLE) set.title = titleFromPrompt(input.message);
		this.ctx.db.update(agentSessions).set(set).where(eq(agentSessions.id, row.id)).run();
		this.publishUpsert(row.id);
		return accepted;
	}

	async abort(id: string): Promise<void> {
		const row = this.get(id);
		if (this.isViewed(row)) throw this.readOnlyError(row);
		await this.ctx.runtime.get(id)?.abort();
	}

	async setModel(id: string, input: SetModelInput): Promise<SessionLiveState> {
		const rt = await this.runtime(id);
		await rt.setModel(input.selector);
		const state = await rt.getState();
		this.ctx.db.update(agentSessions).set({ model: input.selector }).where(eq(agentSessions.id, id)).run();
		this.persistFromState(id, state);
		return state;
	}

	async setThinking(id: string, input: SetThinkingInput): Promise<SessionLiveState> {
		const rt = await this.runtime(id);
		await rt.setThinkingLevel(input.level);
		const state = await rt.getState();
		this.persistFromState(id, state);
		return state;
	}

	/**
	 * Summarise the conversation into the agent's context now (what auto-compaction does near the limit). Refused like a prompt while
	 * the session is being handed over or its task is fenced: the context must not change under a checkpoint.
	 */
	async compact(id: string, input: CompactInput): Promise<SessionLiveState> {
		const row = this.get(id);
		if (this.isViewed(row)) throw this.readOnlyError(row);
		this.promptGuard?.(row, { clientId: "compact" });
		for (const guard of this.extraPromptGuards) guard(row, { clientId: "compact" });
		const rt = await this.runtime(id);
		await rt.compact(input.instructions || undefined);
		const state = await rt.getState();
		this.persistFromState(id, state);
		return state;
	}

	async respondToUi(id: string, input: UiResponseInput): Promise<void> {
		const row = this.get(id);
		if (row.kind === "mirror" && row.movedTo === null) {
			if (!this.views) throw ApiError.unavailable(i18nMsg("Shared sessions are not running"));
			return this.views.respond(id, input);
		}
		if (this.isViewed(row)) throw this.readOnlyError(row);
		const rt = this.ctx.runtime.get(id);
		if (!rt) throw ApiError.conflict(i18nMsg("The session's agent runtime is not running"));
		await rt.respondToUiRequest(input);
	}

	pendingUiRequests(id: string): PendingUiRequest[] {
		if (this.isViewed(this.get(id))) return this.views?.pendingRequests(id) ?? [];
		return this.ctx.runtime.get(id)?.pendingUiRequests() ?? [];
	}

	// ------------------------------------------------------------------ subagents

	/** The session's subagents: the live roster of its runtime, or the last snapshot saved next to the conversation while it is stopped. */
	async subagents(id: string): Promise<SubagentsPage> {
		const row = this.get(id);
		if (this.isViewed(row)) return { subagents: [], live: false };
		const rt = this.ctx.runtime.get(id);
		if (rt) {
			const state = rt.status().state;
			return { subagents: rt.subagents(), live: state === "ready" || state === "busy" };
		}
		const roster = await readSubagentRoster(row.sessionDir);
		return { subagents: roster?.subagents.map((s) => s.subagent) ?? [], live: false };
	}

	/** The subagent's own transcript from `fromByte` on; served from the running process or, when it is gone, from the saved transcript file. */
	async subagentMessages(id: string, subagentId: string, fromByte: number): Promise<SubagentMessagesPage> {
		const row = this.get(id);
		if (this.isViewed(row)) throw ApiError.notFound("Subagent");
		const rt = this.ctx.runtime.get(id);
		if (rt) {
			if (!rt.subagents().some((s) => s.id === subagentId)) throw ApiError.notFound("Subagent");
			return rt.subagentMessages(subagentId, fromByte);
		}
		const found = (await readSubagentRoster(row.sessionDir))?.subagents.find((s) => s.subagent.id === subagentId);
		if (!found?.sessionFile) throw ApiError.notFound("Subagent");
		return readSubagentTranscript(found.sessionFile, fromByte);
	}

	/** Stop one running subagent; the parent turn goes on. Not running (or no process) answers `cancelled: false`. */
	async cancelSubagent(id: string, subagentId: string): Promise<CancelSubagentResult> {
		const row = this.get(id);
		if (this.isViewed(row)) throw this.readOnlyError(row);
		const rt = this.ctx.runtime.get(id);
		if (!rt || !rt.subagents().some((s) => s.id === subagentId)) return { cancelled: false };
		const state = rt.status().state;
		if (state !== "ready" && state !== "busy") return { cancelled: false };
		return rt.cancelSubagent(subagentId);
	}

	async steerSubagent(id: string, subagentId: string, message: string): Promise<void> {
		const row = this.get(id);
		if (this.isViewed(row)) throw this.readOnlyError(row);
		const rt = this.ctx.runtime.get(id);
		const state = rt?.status().state;
		if (!rt || (state !== "ready" && state !== "busy")) throw ApiError.conflict(i18nMsg("The session's agent runtime is not running"));
		if (!rt.subagents().some((s) => s.id === subagentId)) throw ApiError.notFound("Subagent");
		await rt.steerSubagent(subagentId, message);
	}

	/** Stop the session's runtime, or start it (reopening the conversation) when it is not running. */
	async restart(id: string): Promise<RuntimeStatus> {
		this.get(id);
		if (this.ctx.runtime.get(id)) return this.ctx.runtime.restart(id);
		return (await this.runtime(id)).status();
	}

	// ------------------------------------------------------------------ usage accounting

	private queueUsageFlush(sessionId: string): void {
		const previous = this.usageChains.get(sessionId) ?? Promise.resolve();
		const next = previous
			.then(() => this.flushUsage(sessionId))
			.catch((error: unknown) => this.ctx.log.warn({ err: error, sessionId }, "usage flush failed"))
			.finally(() => {
				if (this.usageChains.get(sessionId) === next) this.usageChains.delete(sessionId);
			});
		this.usageChains.set(sessionId, next);
	}

	private async drainUsageFor(sessionId: string): Promise<void> {
		await this.usageChains.get(sessionId);
	}

	/**
	 * After a run settles: persist the runtime's cumulative `get_session_stats` on the session and append to
	 * `provider_usage` what was spent since the last flush, attributed per model from the messages that
	 * finished. Anything the cumulative stats include beyond that (sub-agents, runs lost to a crash) is
	 * recorded once as a residual row under the session's current model, so totals always match OMP's own.
	 */
	private async flushUsage(sessionId: string): Promise<void> {
		const rt = this.ctx.runtime.get(sessionId);
		const row = this.find(sessionId);
		if (!rt || !row) return;
		const deltas = rt.takeUsage();
		let stats: (SessionStats & { sessionId: string | null }) | null = null;
		try {
			stats = await rt.getStats();
		} catch (error) {
			this.ctx.log.warn({ err: error, sessionId }, "get_session_stats failed; recording per-message usage only");
		}
		if (!this.find(sessionId)) return; // deleted while we were waiting

		const recordedAt = new Date().toISOString();
		const sums = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
		const rows: Array<typeof providerUsage.$inferInsert> = [];
		const base = { sessionId, projectId: row.projectId, agentId: row.agentId, source: "omp-recorded" as const, recordedAt };
		for (const d of deltas) {
			sums.input += d.tokens.input;
			sums.output += d.tokens.output;
			sums.cacheRead += d.tokens.cacheRead;
			sums.cacheWrite += d.tokens.cacheWrite;
			sums.cost += d.cost;
			rows.push({
				...base,
				provider: d.provider,
				model: d.model,
				inputTokens: d.tokens.input,
				outputTokens: d.tokens.output,
				cacheReadTokens: d.tokens.cacheRead,
				cacheWriteTokens: d.tokens.cacheWrite,
				cost: d.cost,
			});
		}
		if (stats) {
			const prior = this.ctx.db
				.select({
					input: sql<number>`coalesce(sum(${providerUsage.inputTokens}), 0)`,
					output: sql<number>`coalesce(sum(${providerUsage.outputTokens}), 0)`,
					cacheRead: sql<number>`coalesce(sum(${providerUsage.cacheReadTokens}), 0)`,
					cacheWrite: sql<number>`coalesce(sum(${providerUsage.cacheWriteTokens}), 0)`,
					cost: sql<number>`coalesce(sum(${providerUsage.cost}), 0)`,
				})
				.from(providerUsage)
				.where(eq(providerUsage.sessionId, sessionId))
				.get() ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
			const residual = {
				input: Math.max(0, stats.tokens.input - prior.input - sums.input),
				output: Math.max(0, stats.tokens.output - prior.output - sums.output),
				cacheRead: Math.max(0, stats.tokens.cacheRead - prior.cacheRead - sums.cacheRead),
				cacheWrite: Math.max(0, stats.tokens.cacheWrite - prior.cacheWrite - sums.cacheWrite),
				cost: Math.max(0, stats.cost - prior.cost - sums.cost),
			};
			if (residual.input + residual.output + residual.cacheRead + residual.cacheWrite > 0 || residual.cost > COST_EPSILON) {
				const { provider, model } = splitSelector(row.model);
				rows.push({
					...base,
					provider,
					model,
					inputTokens: residual.input,
					outputTokens: residual.output,
					cacheReadTokens: residual.cacheRead,
					cacheWriteTokens: residual.cacheWrite,
					cost: residual.cost,
				});
			}
		}
		this.ctx.db.transaction((tx) => {
			if (rows.length > 0) tx.insert(providerUsage).values(rows).run();
			if (stats) {
				const { sessionId: _ignored, ...persisted } = stats;
				tx.update(agentSessions).set({ stats: persisted }).where(eq(agentSessions.id, sessionId)).run();
			}
		});
		if (stats) this.publishUpsert(sessionId);
	}
}

/** The working directory a conversation file records in its `session` header (within the first lines), or null if none is found. */
async function recordedCwd(file: string): Promise<string | null> {
	const handle = await open(file, "r").catch(() => null);
	if (!handle) return null;
	try {
		const buffer = Buffer.alloc(8192);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		for (const line of buffer.subarray(0, bytesRead).toString("utf8").split("\n").slice(0, 8)) {
			try {
				const entry = JSON.parse(line) as { type?: unknown; cwd?: unknown };
				if (entry.type === "session" && typeof entry.cwd === "string") return entry.cwd;
			} catch {
				// a partial last line or a non-JSON line: keep looking
			}
		}
		return null;
	} finally {
		await handle.close();
	}
}
