import { type FSWatcher, watch } from "node:fs";
import { readdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import type {
	ClmeshInitResult,
	CloneProjectBody,
	CreatePullRequestBody,
	GitBranch,
	GitCommit,
	GitConflictReport,
	GitDiff,
	GitDiffQuery,
	GitIdentity,
	GitLogPage,
	GitOperation,
	GitPullResult,
	GitPushResult,
	GitStatus,
	Project,
	PullRequest,
	RepositoryRef,
} from "@clam/contracts";
import { agentSessions, agents, gitSyncStates, projects, settings, workspaces } from "@clam/database";
import { type GitAuth, initClmesh } from "@clam/git-engine";
import { and, eq } from "drizzle-orm";
import type { ServerContext } from "../context.ts";
import { ApiError } from "../http/errors.ts";
import { failureText, toGitApiError } from "../http/git-errors.ts";
import { toProject } from "../api/projects.ts";
import { canonicalProjectDir, normalizeRelativePath } from "./files.ts";
import { newId } from "./ids.ts";
import { readNodeSettings } from "./settings.ts";

type ProjectRow = typeof projects.$inferSelect;

const WATCH_DEBOUNCE_MS = 300;
const PROGRESS_PUBLISH_MS = 100;
const MAX_FINISHED_OPERATIONS = 200;
const OVERVIEW_CONCURRENCY = 4;
const GITHUB_HTTPS = /^https:\/\/github\.com\//i;
const NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
const IDENTITY_KEY = (projectId: string) => `git.identity.${projectId}`;

export interface OverviewEntry {
	project: Project;
	status: GitStatus | null;
	error: string | null;
}

/** Project-relative paths from a request body: POSIX-normalized, never absolute/`..`/NUL, never inside `.git`. */
export function safeGitPaths(paths: readonly string[]): string[] {
	return paths.map((input) => {
		const rel = normalizeRelativePath(input);
		if (rel === "" ) throw ApiError.badRequest("A path must name a file or directory inside the project, not the project root.");
		if (rel === ".git" || rel.startsWith(".git/")) throw ApiError.badRequest("Paths inside .git cannot be addressed.");
		return rel;
	});
}

/** A ref/branch name from a request: no option injection (`-x`), whitespace or control characters. */
export function safeRef(ref: string, what = "ref"): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
	if (ref.startsWith("-") || /[\s\u0000-\u001f\u007f]/.test(ref)) throw ApiError.badRequest(`Invalid ${what}: ${JSON.stringify(ref.slice(0, 80))}`);
	return ref;
}

/** Events under `.git/` that never change anything a user sees, plus dependency trees. */
export function isIgnoredWatchPath(relative: string): boolean {
	const segments = relative.split(/[\\/]/).filter(Boolean);
	if (segments.includes("node_modules")) return true;
	if (segments[0] === ".git") {
		const second = segments[1];
		if (second === undefined) return false;
		return second === "objects" || second === "logs" || second === "lfs" || second.endsWith(".lock");
	}
	return false;
}

/**
 * Everything the Git routes do on top of `@clam/git-engine`: per-project serialized mutations, authentication from
 * the project's linked GitHub account (token handed only to the engine's askpass broker), commit identity,
 * `git:<projectId>` status events (after every mutation, on debounced working-tree changes and agent `tool_end`),
 * `git_sync_states` upkeep, clone operations and pull requests.
 */
export class GitService {
	private readonly queues = new Map<string, Promise<unknown>>();
	private readonly operations = new Map<string, GitOperation>();
	private readonly aborters = new Map<string, AbortController>();
	private readonly cloneDests = new Set<string>();
	private readonly lastPublished = new Map<string, string>();
	private readonly watchers = new Map<string, FSWatcher>();
	private readonly refreshTimers = new Map<string, NodeJS.Timeout>();
	private readonly stops: Array<() => void> = [];
	private disposed = false;

	constructor(private readonly ctx: ServerContext) {
		this.stops.push(ctx.bus.watchDemand("git:", (topic, active) => this.onDemand(topic.slice("git:".length), active)));
		this.stops.push(
			ctx.runtime.onEvent((sessionId, event) => {
				if (event.type !== "tool_end") return;
				const row = ctx.db.select({ projectId: agentSessions.projectId }).from(agentSessions).where(eq(agentSessions.id, sessionId)).get();
				if (row && ctx.bus.hasSubscribers(`git:${row.projectId}`)) this.scheduleRefresh(row.projectId);
			}),
		);
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		for (const stop of this.stops.splice(0)) stop();
		for (const timer of this.refreshTimers.values()) clearTimeout(timer);
		this.refreshTimers.clear();
		for (const watcher of this.watchers.values()) watcher.close();
		this.watchers.clear();
		for (const aborter of this.aborters.values()) aborter.abort();
		await Promise.allSettled([...this.queues.values()]);
	}

	// ---------------------------------------------------------------- project lookup

	/** The project row and its working directory. Only the stored (canonical) directory is ever used; client paths are never accepted. */
	async resolve(projectId: string): Promise<{ row: ProjectRow; dir: string }> {
		const row = this.ctx.db.select().from(projects).where(eq(projects.id, projectId)).get();
		if (!row) throw ApiError.notFound("Project");
		let real: string;
		try {
			real = await realpath(row.path);
			if (!(await stat(real)).isDirectory()) throw new Error("not a directory");
		} catch {
			throw new ApiError(409, "project_dir_missing", `The project directory no longer exists: ${row.path}`);
		}
		if (real !== row.path) {
			throw new ApiError(409, "project_dir_moved", `The project directory resolves elsewhere now (${real}); re-add the project at its new location.`);
		}
		return { row, dir: row.path };
	}

	/** Runs a mutation after every earlier mutation of the same project has settled (their failures do not block it). */
	private serialize<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(projectId) ?? Promise.resolve();
		const run = previous.then(fn);
		const tail = run.catch(() => undefined);
		this.queues.set(projectId, tail);
		void tail.then(() => {
			if (this.queues.get(projectId) === tail) this.queues.delete(projectId);
		});
		return run;
	}

	private async guarded<T>(fn: () => Promise<T>): Promise<T> {
		try {
			return await fn();
		} catch (err) {
			throw toGitApiError(err);
		}
	}

	/** Resolve + serialize + error mapping in one: the shape of every mutating route. */
	private mutate<T>(projectId: string, fn: (p: { row: ProjectRow; dir: string }) => Promise<T>): Promise<T> {
		return this.guarded(async () => {
			await this.resolve(projectId); // 404/409 before queueing
			return this.serialize(projectId, async () => fn(await this.resolve(projectId)));
		});
	}

	private read<T>(projectId: string, fn: (p: { row: ProjectRow; dir: string }) => Promise<T>): Promise<T> {
		return this.guarded(async () => fn(await this.resolve(projectId)));
	}

	// ---------------------------------------------------------------- accounts, auth, identity

	private defaultAccountId(): string | null {
		return this.ctx.github.listAccounts().find((a) => a.isDefault)?.id ?? null;
	}

	/** The linked account if it still exists, else the node's default account, else null. */
	accountIdFor(row: ProjectRow): string | null {
		const linked = row.repository?.accountId ?? null;
		if (linked && this.ctx.github.listAccounts().some((a) => a.id === linked)) return linked;
		return this.defaultAccountId();
	}

	/**
	 * Credentials for network operations, only for github.com https remotes. The token is read here (so a missing or
	 * revoked credential fails before git starts) and reaches git solely through the engine's askpass broker.
	 */
	private async authFor(row: ProjectRow, dir: string): Promise<GitAuth | undefined> {
		const remotes = (await this.ctx.git.status(dir)).remotes;
		const origin = remotes.find((r) => r.name === "origin") ?? remotes[0];
		if (!origin || !GITHUB_HTTPS.test(origin.url)) return undefined;
		const accountId = this.accountIdFor(row);
		if (!accountId) return undefined;
		const token = await this.ctx.github.tokenFor(accountId);
		return { token: async () => token };
	}

	private readIdentityOverride(projectId: string): { name: string; email: string } | null {
		const stored = this.ctx.db.select().from(settings).where(eq(settings.key, IDENTITY_KEY(projectId))).get();
		if (!stored) return null;
		try {
			const value: unknown = JSON.parse(stored.value);
			if (typeof value === "object" && value !== null && "name" in value && "email" in value && typeof value.name === "string" && typeof value.email === "string") {
				return { name: value.name, email: value.email };
			}
		} catch {
			// Unreadable override: fall through to the other sources.
		}
		return null;
	}

	/** Per-project override → the repo's own git config → derived from the linked/default GitHub account. */
	private async identityOf(row: ProjectRow, dir: string): Promise<GitIdentity> {
		const override = this.readIdentityOverride(row.id);
		if (override) return { ...override, source: "project" };
		const configured = await this.ctx.git.configIdentity(dir);
		if (configured) return { ...configured, source: "git-config" };
		const accountId = this.accountIdFor(row);
		if (accountId) return { ...(await this.ctx.github.commitIdentity(accountId)), source: "account" };
		throw new ApiError(409, "no_git_identity", "No commit identity is available: connect a GitHub account, set user.name/user.email in the repository, or set an identity for this project.");
	}

	identity(projectId: string): Promise<GitIdentity> {
		return this.read(projectId, ({ row, dir }) => this.identityOf(row, dir));
	}

	setIdentity(projectId: string, body: { name: string; email: string } | null): Promise<GitIdentity> {
		return this.guarded(async () => {
			const { row, dir } = await this.resolve(projectId);
			if (body === null) {
				this.ctx.db.delete(settings).where(eq(settings.key, IDENTITY_KEY(projectId))).run();
			} else {
				const value = JSON.stringify({ name: body.name, email: body.email });
				const updatedAt = new Date().toISOString();
				this.ctx.db.insert(settings).values({ key: IDENTITY_KEY(projectId), value, updatedAt }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt } }).run();
			}
			return this.identityOf(row, dir);
		});
	}

	// ---------------------------------------------------------------- status, events, sync state

	private statusSignature(status: GitStatus): string {
		const { updatedAt: _ignored, ...rest } = status;
		return JSON.stringify(rest);
	}

	/** Persist the observed state of the current branch; never fails the caller (it is a cache). */
	private async recordSync(projectId: string, dir: string, status: GitStatus, event?: "pushed" | "pulled"): Promise<void> {
		if (!status.isRepo || !status.branch || !status.headSha) return;
		try {
			let remoteSha: string | null = null;
			if (status.upstream) {
				const branches = await this.ctx.git.branches(dir);
				remoteSha = branches.find((b) => b.remote && (b.name === status.upstream || b.name === `refs/remotes/${status.upstream}`))?.headSha ?? null;
			}
			const now = new Date().toISOString();
			const values = {
				commitSha: status.headSha,
				remoteSha,
				ahead: status.upstream ? status.ahead : null,
				behind: status.upstream ? status.behind : null,
				dirty: !status.clean,
				lastFetchedAt: status.lastFetchedAt,
				updatedAt: now,
				...(event === "pushed" && { lastPushedAt: now }),
				...(event === "pulled" && { lastPulledAt: now }),
			};
			this.ctx.db
				.insert(gitSyncStates)
				.values({ projectId, branch: status.branch, ...values })
				.onConflictDoUpdate({ target: [gitSyncStates.projectId, gitSyncStates.branch], set: values })
				.run();
		} catch (err) {
			this.ctx.log.debug({ err, projectId }, "could not record git sync state");
		}
	}

	/**
	 * Read status, refresh the sync cache, and publish `git:<id>`. Mutations always publish; watcher/tool_end refreshes
	 * publish only when something visible changed (so Git's own index refreshes cannot start an event loop).
	 */
	private async observe(projectId: string, dir: string, opts: { publish: "always" | "on-change" | "never"; event?: "pushed" | "pulled" }): Promise<GitStatus> {
		const status = await this.ctx.git.status(dir);
		await this.recordSync(projectId, dir, status, opts.event);
		const signature = this.statusSignature(status);
		const changed = this.lastPublished.get(projectId) !== signature;
		if (opts.publish === "always" || (opts.publish === "on-change" && changed)) {
			this.lastPublished.set(projectId, signature);
			this.ctx.bus.publish(`git:${projectId}`, { type: "status", status });
		}
		return status;
	}

	status(projectId: string): Promise<GitStatus> {
		// A read the UI polls: refreshes the cache; publishes only a real change to other subscribers.
		return this.read(projectId, ({ dir }) => this.observe(projectId, dir, { publish: "on-change" }));
	}

	async overview(): Promise<OverviewEntry[]> {
		const rows = this.ctx.db.select().from(projects).all();
		const results: OverviewEntry[] = [];
		let next = 0;
		const worker = async (): Promise<void> => {
			for (;;) {
				const row = rows[next++];
				if (!row) return;
				const project = toProject(row, { sessionCount: 0, lastActivityAt: null });
				try {
					const { dir } = await this.resolve(row.id);
					results.push({ project, status: await this.observe(row.id, dir, { publish: "never" }), error: null });
				} catch (err) {
					const mapped = toGitApiError(err);
					results.push({ project, status: null, error: mapped instanceof Error ? mapped.message : String(mapped) });
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(OVERVIEW_CONCURRENCY, rows.length) }, worker));
		const order = new Map(rows.map((r, i) => [r.id, i]));
		return results.sort((a, b) => (order.get(a.project.id) ?? 0) - (order.get(b.project.id) ?? 0));
	}

	// ---------------------------------------------------------------- watching

	private onDemand(projectId: string, active: boolean): void {
		if (!active) {
			this.watchers.get(projectId)?.close();
			this.watchers.delete(projectId);
			clearTimeout(this.refreshTimers.get(projectId));
			this.refreshTimers.delete(projectId);
			return;
		}
		if (this.disposed || this.watchers.has(projectId)) return;
		const row = this.ctx.db.select().from(projects).where(eq(projects.id, projectId)).get();
		if (!row) return;
		try {
			const watcher = watch(row.path, { recursive: true, persistent: false }, (_event, filename) => {
				if (filename && isIgnoredWatchPath(filename.toString())) return;
				this.scheduleRefresh(projectId);
			});
			watcher.on("error", (err) => {
				this.ctx.log.debug({ err, projectId }, "git working-tree watcher stopped");
				watcher.close();
				if (this.watchers.get(projectId) === watcher) this.watchers.delete(projectId);
			});
			this.watchers.set(projectId, watcher);
		} catch (err) {
			this.ctx.log.warn({ err, projectId }, "cannot watch the project directory; git status updates only after actions");
		}
	}

	private scheduleRefresh(projectId: string): void {
		if (this.disposed || this.refreshTimers.has(projectId)) return;
		const timer = setTimeout(() => {
			this.refreshTimers.delete(projectId);
			if (!this.ctx.bus.hasSubscribers(`git:${projectId}`)) return;
			void this.resolve(projectId)
				.then(({ dir }) => this.observe(projectId, dir, { publish: "on-change" }))
				.catch((err: unknown) => this.ctx.log.debug({ err, projectId }, "git status refresh failed"));
		}, WATCH_DEBOUNCE_MS);
		timer.unref();
		this.refreshTimers.set(projectId, timer);
	}

	// ---------------------------------------------------------------- operations registry

	private publishOperation(op: GitOperation, projectId: string | null, project?: Project): void {
		this.ctx.bus.publish(`git-op:${op.id}`, { type: "operation", operation: op, ...(project && { project }) });
		if (projectId) this.ctx.bus.publish(`git:${projectId}`, { type: "operation", operation: op });
	}

	private beginOperation(kind: GitOperation["kind"], projectId: string | null): GitOperation {
		const op: GitOperation = { id: newId("gop"), kind, state: "running", phase: null, percent: null, error: null, projectId: kind === "clone" ? null : projectId, startedAt: new Date().toISOString(), finishedAt: null };
		this.operations.set(op.id, op);
		this.pruneOperations();
		this.publishOperation({ ...op }, projectId);
		return op;
	}

	private progressReporter(op: GitOperation, projectId: string | null): (p: { phase: string; percent: number | null }) => void {
		let lastAt = 0;
		let lastPercent: number | null = null;
		let lastPhase: string | null = null;
		return ({ phase, percent }) => {
			const t = Date.now();
			const meaningful = phase !== lastPhase || (percent !== null && lastPercent !== null && Math.floor(percent) !== Math.floor(lastPercent));
			if (t - lastAt < PROGRESS_PUBLISH_MS && !(meaningful && percent === 100)) return;
			if (!meaningful && percent === lastPercent) return;
			lastAt = t;
			lastPercent = percent;
			lastPhase = phase;
			this.setOperation(op, { phase, percent }, projectId);
		};
	}

	/** Updates the registry's operation in place and publishes an immutable snapshot of it. */
	private setOperation(op: GitOperation, patch: Partial<GitOperation>, projectId: string | null, project?: Project): void {
		Object.assign(op, patch);
		this.publishOperation({ ...op }, projectId, project);
	}

	private finishOperation(op: GitOperation, outcome: { error: string | null; projectId?: string | null }, projectId: string | null, project?: Project): void {
		this.setOperation(
			op,
			{ state: outcome.error === null ? "succeeded" : "failed", error: outcome.error, percent: outcome.error === null ? 100 : op.percent, finishedAt: new Date().toISOString(), ...(outcome.projectId !== undefined && { projectId: outcome.projectId }) },
			projectId,
			project,
		);
	}

	private pruneOperations(): void {
		const finished = [...this.operations.values()].filter((o) => o.state !== "running");
		for (const old of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_OPERATIONS))) this.operations.delete(old.id);
	}

	operation(id: string): GitOperation {
		const op = this.operations.get(id);
		if (!op) throw ApiError.notFound("Git operation");
		return { ...op };
	}

	/** Runs a network/long mutation as a tracked operation (events on `git:<projectId>`); the operation's result is the caller's. */
	private async tracked<T>(kind: "fetch" | "pull" | "push", projectId: string, run: (report: (p: { phase: string; percent: number | null }) => void) => Promise<T>, failed: (value: T) => string | null = () => null): Promise<T> {
		const op = this.beginOperation(kind, projectId);
		try {
			const value = await run(this.progressReporter(op, projectId));
			this.finishOperation(op, { error: failed(value) }, projectId);
			return value;
		} catch (err) {
			this.finishOperation(op, { error: failureText(err) }, projectId);
			throw err;
		}
	}

	// ---------------------------------------------------------------- reads

	diff(projectId: string, query: GitDiffQuery): Promise<GitDiff> {
		return this.read(projectId, ({ dir }) => {
			const q: GitDiffQuery = { ...query };
			if (q.path !== undefined) q.path = safeGitPaths([q.path])[0] as string;
			for (const key of ["commit", "base", "head"] as const) if (q[key] !== undefined) q[key] = safeRef(q[key] as string, key);
			if (q.scope === "commit" && !q.commit) throw ApiError.badRequest("scope=commit needs a commit.");
			if (q.scope === "range" && (!q.base || !q.head)) throw ApiError.badRequest("scope=range needs base and head.");
			return this.ctx.git.diff(dir, q);
		});
	}

	branches(projectId: string): Promise<GitBranch[]> {
		return this.read(projectId, ({ dir }) => this.ctx.git.branches(dir));
	}

	log(projectId: string, o: { ref?: string; limit: number; cursor?: string }): Promise<GitLogPage> {
		return this.read(projectId, ({ dir }) => this.ctx.git.log(dir, { ...o, ...(o.ref !== undefined && { ref: safeRef(o.ref) }) }));
	}

	conflicts(projectId: string, against?: string): Promise<GitConflictReport> {
		return this.read(projectId, ({ dir }) => this.ctx.git.conflicts(dir, { ...(against !== undefined && { against: safeRef(against, "against") }) }));
	}

	// ---------------------------------------------------------------- local mutations

	private async after(projectId: string, dir: string): Promise<GitStatus> {
		return this.observe(projectId, dir, { publish: "always" });
	}

	createBranch(projectId: string, o: { name: string; from?: string; checkout: boolean }): Promise<GitStatus> {
		return this.mutate(projectId, async ({ dir }) => {
			await this.ctx.git.createBranch(dir, { name: safeRef(o.name, "branch name"), checkout: o.checkout, ...(o.from !== undefined && { from: safeRef(o.from, "start point") }) });
			return this.after(projectId, dir);
		});
	}

	checkout(projectId: string, branch: string): Promise<GitStatus> {
		return this.mutate(projectId, async ({ dir }) => {
			await this.ctx.git.checkout(dir, safeRef(branch, "branch"));
			return this.after(projectId, dir);
		});
	}

	stage(projectId: string, paths: string[]): Promise<GitStatus> {
		const safe = safeGitPaths(paths);
		return this.mutate(projectId, async ({ dir }) => {
			await this.ctx.git.stage(dir, safe);
			return this.after(projectId, dir);
		});
	}

	unstage(projectId: string, paths: string[]): Promise<GitStatus> {
		const safe = safeGitPaths(paths);
		return this.mutate(projectId, async ({ dir }) => {
			await this.ctx.git.unstage(dir, safe);
			return this.after(projectId, dir);
		});
	}

	/** Destructive; the route has already required `confirm: true`. Only the given paths are touched. */
	discard(projectId: string, paths: string[]): Promise<GitStatus> {
		const safe = safeGitPaths(paths);
		return this.mutate(projectId, async ({ dir }) => {
			await this.ctx.git.discard(dir, safe);
			return this.after(projectId, dir);
		});
	}

	/** `extraTrailers` is for server-internal callers (the task engine adds `Task: <id>`); it is not part of the route body. */
	commit(projectId: string, body: { message: string; paths?: string[]; sessionId?: string }, extraTrailers?: Record<string, string>): Promise<{ commit: GitCommit; status: GitStatus }> {
		const paths = body.paths ? safeGitPaths(body.paths) : undefined;
		return this.mutate(projectId, async ({ row, dir }) => {
			const author = await this.identityOf(row, dir);
			const agentTrailer = body.sessionId ? { Agent: this.agentTrailer(projectId, body.sessionId) } : undefined;
			const trailers = agentTrailer || extraTrailers ? { ...agentTrailer, ...extraTrailers } : undefined;
			const commit = await this.ctx.git.commit(dir, {
				message: body.message,
				author: { name: author.name, email: author.email },
				...(paths && { paths }),
				...(trailers && { trailers }),
			});
			return { commit, status: await this.after(projectId, dir) };
		});
	}

	/** `<agentName>@<nodeName>` for the agent that owns the session. */
	private agentTrailer(projectId: string, sessionId: string): string {
		const session = this.ctx.db
			.select({ projectId: agentSessions.projectId, agentName: agents.name })
			.from(agentSessions)
			.innerJoin(agents, eq(agents.id, agentSessions.agentId))
			.where(eq(agentSessions.id, sessionId))
			.get();
		if (!session) throw ApiError.notFound("Session");
		if (session.projectId !== projectId) throw ApiError.badRequest("That session belongs to a different project.");
		return `${session.agentName}@${readNodeSettings(this.ctx.db).nodeName}`;
	}

	// ---------------------------------------------------------------- network mutations

	fetch(projectId: string): Promise<GitStatus> {
		return this.mutate(projectId, async ({ row, dir }) => {
			const auth = await this.authFor(row, dir);
			await this.tracked("fetch", projectId, (onProgress) => this.ctx.git.fetch(dir, { ...(auth && { auth }), onProgress }));
			return this.observe(projectId, dir, { publish: "always" });
		});
	}

	/** Fast-forward only. A refusal (dirty overlap, diverged, ...) is a 409 whose `details` is the full `GitPullResult`; nothing in the tree changed. */
	pull(projectId: string): Promise<GitPullResult> {
		return this.mutate(projectId, async ({ row, dir }) => {
			const auth = await this.authFor(row, dir);
			const result = await this.tracked(
				"pull",
				projectId,
				() => this.ctx.git.pull(dir, { ...(auth && { auth }) }),
				(r) => (r.result === "refused" ? r.message : null),
			);
			const status = await this.observe(projectId, dir, { publish: "always", ...(result.result === "fast-forward" && { event: "pulled" as const }) });
			const full: GitPullResult = { ...result, status };
			if (result.result === "refused") throw new ApiError(409, "git_pull_refused", result.message, full);
			return full;
		});
	}

	/** Never forced. A rejection is a 409 (403/401 for permission/SSO/auth) whose `details` is the full `GitPushResult` with the remote's verbatim message. */
	push(projectId: string, body: { setUpstream: boolean }): Promise<GitPushResult> {
		return this.mutate(projectId, async ({ row, dir }) => {
			const auth = await this.authFor(row, dir);
			const result = await this.tracked(
				"push",
				projectId,
				() => this.ctx.git.push(dir, { ...(auth && { auth }), setUpstream: body.setUpstream }),
				(r) => (r.result === "rejected" ? r.message : null),
			);
			const status = await this.observe(projectId, dir, { publish: "always", ...(result.result === "pushed" && { event: "pushed" as const }) });
			const full: GitPushResult = { ...result, status };
			if (result.result === "rejected") {
				const http = result.reason === "permission" || result.reason === "sso" ? 403 : result.reason === "auth" ? 401 : 409;
				throw new ApiError(http, "git_push_rejected", result.message, full);
			}
			return full;
		});
	}

	// ---------------------------------------------------------------- .clmesh

	clmeshInit(projectId: string): Promise<ClmeshInitResult> {
		return this.mutate(projectId, async ({ row, dir }) => {
			const workspaceId = row.workspaceId;
			const written = await initClmesh(this.ctx.git, dir, { workspaceId, projectId, projectName: row.name });
			return { ...written, status: await this.after(projectId, dir) };
		});
	}

	// ---------------------------------------------------------------- pull requests

	private repoFor(row: ProjectRow): { owner: string; repo: string; accountId: string } {
		const repository = row.repository;
		if (!repository) throw new ApiError(409, "no_repository", "This project is not linked to a GitHub repository.");
		const accountId = this.accountIdFor(row);
		if (!accountId) throw new ApiError(409, "no_github_account", "Connect a GitHub account (Settings → GitHub) to use pull requests.");
		return { owner: repository.owner, repo: repository.name, accountId };
	}

	createPullRequest(projectId: string, body: CreatePullRequestInput): Promise<PullRequest> {
		return this.mutate(projectId, async ({ row, dir }) => {
			const { owner, repo, accountId } = this.repoFor(row);
			const status = await this.ctx.git.status(dir);
			const head = safeRef(body.head ?? status.branch ?? "", "head branch");
			if (head === "") throw ApiError.badRequest("No head branch: check out a branch or pass `head`.");
			const base = safeRef(body.base, "base branch");
			const remoteBranches = await this.ctx.git.branches(dir);
			if (!remoteBranches.some((b) => b.remote && (b.name === `origin/${head}` || b.name === `refs/remotes/origin/${head}`))) {
				throw new ApiError(409, "branch_not_pushed", `Branch ${head} is not on the remote yet; push it before opening a pull request.`);
			}
			return this.ctx.github.createPullRequest(accountId, owner, repo, { title: body.title, body: body.body, head, base, draft: body.draft });
		});
	}

	listPullRequests(projectId: string, state: "open" | "closed" | "all"): Promise<PullRequest[]> {
		return this.read(projectId, async ({ row }) => {
			const { owner, repo, accountId } = this.repoFor(row);
			return this.ctx.github.listPullRequests(accountId, owner, repo, state);
		});
	}

	getPullRequest(projectId: string, number: number): Promise<PullRequest> {
		return this.read(projectId, async ({ row }) => {
			const { owner, repo, accountId } = this.repoFor(row);
			return this.ctx.github.getPullRequest(accountId, owner, repo, number);
		});
	}

	// ---------------------------------------------------------------- clone

	/**
	 * Validates everything that can be checked up front (so mistakes are plain 4xx answers), then clones in the
	 * background as a tracked operation (`git-op:<id>`). On success the project is created and linked to the repository.
	 */
	async startClone(body: CloneProjectInput): Promise<GitOperation> {
		return this.guarded(async () => {
			if (!NAME.test(body.owner) || !NAME.test(body.repo)) throw ApiError.badRequest("Invalid repository owner or name.");
			if (body.branch !== undefined) safeRef(body.branch, "branch");
			if (body.path.includes("\0") || !path.isAbsolute(body.path)) throw ApiError.badRequest("The target path must be absolute.");
			const dest = path.resolve(body.path);
			if (!this.ctx.db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, body.workspaceId)).get()) throw ApiError.notFound("Workspace");
			if (!this.ctx.github.listAccounts().some((a) => a.id === body.accountId)) throw ApiError.notFound("GitHub account");

			let existed = false;
			try {
				const info = await stat(dest);
				existed = true;
				if (!info.isDirectory()) throw new ApiError(409, "git_dest_not_empty", `${dest} exists and is not a directory.`);
				if ((await readdir(dest)).length > 0) throw new ApiError(409, "git_dest_not_empty", `${dest} is not empty; clone into a new or empty directory.`);
			} catch (err) {
				if (err instanceof ApiError) throw err;
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw ApiError.badRequest(`Cannot use ${dest}: ${(err as Error).message}`);
			}
			if (this.cloneDests.has(dest)) throw new ApiError(409, "git_dest_not_empty", `A clone into ${dest} is already running.`);
			const canonicalDest = existed ? await realpath(dest) : path.join(await realpath(path.dirname(dest)).catch(() => path.dirname(dest)), path.basename(dest));
			if (this.ctx.db.select({ id: projects.id }).from(projects).where(and(eq(projects.workspaceId, body.workspaceId), eq(projects.path, canonicalDest))).get()) {
				throw ApiError.conflict(`This workspace already has a project at ${canonicalDest}`);
			}

			// Access and metadata first: a 404/403/SSO answer arrives as the response, not as a failed background job.
			const meta = await this.ctx.github.getRepository(body.accountId, body.owner, body.repo);
			const token = await this.ctx.github.tokenFor(body.accountId);

			const op = this.beginOperation("clone", null);
			const aborter = new AbortController();
			this.aborters.set(op.id, aborter);
			this.cloneDests.add(dest);
			void this.runClone(op, { body, dest, existed, meta, token, signal: aborter.signal }).finally(() => {
				this.cloneDests.delete(dest);
				this.aborters.delete(op.id);
			});
			return { ...op };
		});
	}

	private async runClone(
		op: GitOperation,
		o: { body: CloneProjectInput; dest: string; existed: boolean; meta: { id: string; owner: string; name: string; htmlUrl: string; defaultBranch: string }; token: string; signal: AbortSignal },
	): Promise<void> {
		const { body, dest, meta } = o;
		try {
			await this.ctx.git.clone(`https://github.com/${meta.owner}/${meta.name}.git`, dest, {
				auth: { token: async () => o.token },
				onProgress: this.progressReporter(op, null),
				signal: o.signal,
				...(body.branch !== undefined && { branch: body.branch }),
			});
			const canonical = await canonicalProjectDir(dest);
			const repository: RepositoryRef = { owner: meta.owner, name: meta.name, externalId: meta.id, htmlUrl: meta.htmlUrl, defaultBranch: meta.defaultBranch, accountId: body.accountId };
			const id = newId("prj");
			this.ctx.db.insert(projects).values({ id, workspaceId: body.workspaceId, name: body.name ?? meta.name, path: canonical, repositoryId: meta.id, repository }).run();
			const row = this.ctx.db.select().from(projects).where(eq(projects.id, id)).get() as ProjectRow;
			const project = toProject(row, { sessionCount: 0, lastActivityAt: null });
			await this.observe(id, canonical, { publish: "never" }).catch((err: unknown) => this.ctx.log.debug({ err }, "initial git status after clone failed"));
			this.finishOperation(op, { error: null, projectId: id }, null, project);
		} catch (err) {
			await this.discardPartialClone(dest, o.existed);
			this.ctx.log.warn({ owner: body.owner, repo: body.repo, error: failureText(err) }, "clone failed");
			this.finishOperation(op, { error: failureText(err) }, null);
		}
	}

	/** Removes what a failed clone left behind: the directory if this clone created it, otherwise only its contents (it was empty before). */
	private async discardPartialClone(dest: string, existedBefore: boolean): Promise<void> {
		try {
			if (!existedBefore) {
				await rm(dest, { recursive: true, force: true });
				return;
			}
			for (const entry of await readdir(dest)) await rm(path.join(dest, entry), { recursive: true, force: true });
		} catch (err) {
			this.ctx.log.warn({ err, dest }, "could not clean up a failed clone");
		}
	}
}

export type CloneProjectInput = z.infer<typeof CloneProjectBody>;
export type CreatePullRequestInput = z.infer<typeof CreatePullRequestBody>;
