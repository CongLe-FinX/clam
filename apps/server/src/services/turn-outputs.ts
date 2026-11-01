import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { RuntimeStatus, SessionEvent, TurnOutputFile, TurnOutputs } from "@clam/contracts";
import { agentSessions, projects, turnOutputs } from "@clam/database";
import { DEFAULT_EXCLUDES, IgnoreMatcher, parseIgnoreLines } from "@clam/workspace-files";
import { asc, desc, eq } from "drizzle-orm";
import type { ServerContext } from "../context.ts";
import { contentTypeFor } from "../http/file-response.ts";
import { errorText } from "../network/util.ts";
import { newId } from "./ids.ts";

/** Walk limits: a snapshot that exceeds one is incomplete and the turn falls back to the paths its tool calls named. */
export const SNAPSHOT_MAX_ENTRIES = 20_000;
export const SNAPSHOT_MAX_DEPTH = 8;
export const SNAPSHOT_BUDGET_MS = 2_000;
/** Files listed per turn; more are reported as `truncated`. */
export const MAX_OUTPUT_FILES = 50;
/** Files remembered between two `takeRunOutputs` calls (the group chat takes at most 10 of them). */
const MAX_RUN_FILES = 200;
/** `GET /sessions/:id/outputs` returns this many newest turns. */
export const OUTPUT_TURNS_PAGE = 500;
/** How many files a snapshot stats at once. */
const STAT_BATCH = 64;

/** Tools whose calls name a file they write (OMP's own `write`/`edit`/`notebook`/`ast_edit`, and the common aliases of other agents). */
const WRITE_TOOLS = /^(write|edit|multi_?edit|notebook(_?edit)?|ast_?edit|create(_file)?|apply_?patch|str_?replace.*|patch|insert)$/i;
const PATH_KEYS = ["path", "file_path", "filePath", "notebook_path", "file"] as const;

const IGNORED = new IgnoreMatcher();
IGNORED.add(parseIgnoreLines(DEFAULT_EXCLUDES));

interface FileStat {
	size: number;
	mtimeMs: number;
}

interface Snapshot {
	files: Map<string, FileStat>;
	/** False when a limit stopped the walk: a diff against this snapshot is not reliable. */
	complete: boolean;
}

/** Folders and files never reported: dot-entries (`.git`, `.omp`, `.clam-upload-*`, `.env`...), dependencies, build output and caches (`DEFAULT_EXCLUDES`). */
function skipped(rel: string, isDir: boolean): boolean {
	return path.posix.basename(rel).startsWith(".") || IGNORED.ignores(rel, isDir);
}

/** The paths of a turn's explicit writes are trusted more than the walk (the agent named them), so only VCS data, dependencies and dot-folders are refused. */
function refusedExplicit(rel: string): boolean {
	const segments = rel.split("/");
	return segments.slice(0, -1).some((s) => s.startsWith(".") || s === "node_modules") || segments.includes(".git") || path.posix.basename(rel).startsWith(".clam-upload-");
}

/** Bounded, non-following walk of a folder: (relative posix path, size, mtime) of every regular file. Never throws. */
export interface SnapshotLimits {
	maxEntries?: number;
	maxDepth?: number;
	budgetMs?: number;
}

export async function snapshotFolder(root: string, limits: SnapshotLimits = {}): Promise<Snapshot> {
	const maxEntries = limits.maxEntries ?? SNAPSHOT_MAX_ENTRIES;
	const maxDepth = limits.maxDepth ?? SNAPSHOT_MAX_DEPTH;
	const deadline = Date.now() + (limits.budgetMs ?? SNAPSHOT_BUDGET_MS);
	const files = new Map<string, FileStat>();
	let entries = 0;
	let complete = true;

	async function visit(relDir: string, depth: number): Promise<void> {
		if (!complete) return;
		if (depth > maxDepth) {
			complete = false;
			return;
		}
		let dirents;
		try {
			dirents = await readdir(path.join(root, relDir), { withFileTypes: true });
		} catch {
			return; // vanished or unreadable: nothing to record here
		}
		const subdirs: string[] = [];
		const regular: string[] = [];
		for (const dirent of dirents) {
			const rel = relDir === "" ? dirent.name : `${relDir}/${dirent.name}`;
			const isDir = dirent.isDirectory();
			if (!isDir && !dirent.isFile()) continue; // symlinks, sockets...: never followed
			if (skipped(rel, isDir)) continue;
			if (++entries > maxEntries) {
				complete = false;
				return;
			}
			(isDir ? subdirs : regular).push(rel);
		}
		for (let i = 0; i < regular.length; i += STAT_BATCH) {
			if (Date.now() > deadline) {
				complete = false;
				return;
			}
			await Promise.all(
				regular.slice(i, i + STAT_BATCH).map(async (rel) => {
					try {
						const info = await lstat(path.join(root, rel));
						if (info.isFile()) files.set(rel, { size: info.size, mtimeMs: info.mtimeMs });
					} catch {
						// deleted while walking
					}
				}),
			);
		}
		for (const sub of subdirs) {
			if (Date.now() > deadline) {
				complete = false;
				return;
			}
			await visit(sub, depth + 1);
			if (!complete) return;
		}
	}

	await visit("", 0);
	return { files, complete };
}

/** Ranking inside a turn's list: what a person wants to look at first. */
function rank(mimeType: string, name: string): number {
	if (mimeType.startsWith("image/") || mimeType.startsWith("video/") || mimeType.startsWith("audio/") || mimeType === "application/pdf") return 0;
	return /\.(docx?|xlsx?|pptx?|od[tsp]|rtf|pages|numbers|key)$/i.test(name) ? 0 : 1;
}

function compareFiles(a: TurnOutputFile, b: TurnOutputFile): number {
	return rank(a.mimeType, a.name) - rank(b.mimeType, b.name) || a.path.localeCompare(b.path);
}

/** Files named by a write-like tool call: absolute paths inside `root` or relative ones; anything else yields nothing. */
export function explicitPaths(toolName: string, args: unknown, root: string): string[] {
	if (!WRITE_TOOLS.test(toolName) || typeof args !== "object" || args === null) return [];
	const record = args as Record<string, unknown>;
	const out: string[] = [];
	for (const key of PATH_KEYS) {
		const value = record[key];
		if (typeof value === "string" && value.trim() !== "") out.push(value.trim());
	}
	return out.flatMap((raw) => {
		const rel = path.isAbsolute(raw) ? path.relative(root, raw) : path.normalize(raw);
		if (rel === "" || rel === "." || rel.startsWith("..") || path.isAbsolute(rel)) return [];
		const posix = rel.split(path.sep).join("/").replace(/^\.\//, "");
		return refusedExplicit(posix) ? [] : [posix];
	});
}

function toRow(row: typeof turnOutputs.$inferSelect): TurnOutputs {
	return {
		id: row.id,
		sessionId: row.sessionId,
		projectId: row.projectId,
		anchorMessageId: row.anchorMessageId,
		anchorTimestamp: row.anchorTimestamp,
		startedAt: row.startedAt,
		endedAt: row.endedAt,
		files: row.files,
		truncated: row.truncated,
	};
}

/** One agent turn in progress: from `agent_start` until `agent_end`. */
interface OpenTurn {
	startedAt: number;
	projectId: string;
	/** Project folder as configured (resolved to its real path once the turn starts). */
	projectPath: string;
	root: Promise<string | null>;
	before: Promise<Snapshot | null>;
	explicit: Set<string>;
	anchor: { id: string; timestamp: number } | null;
}

interface SessionState {
	open: OpenTurn | null;
	/** Serializes the diff + persist of the session's finished turns, so `takeRunOutputs` can wait for them. */
	chain: Promise<void>;
	/** Files of this run's turns not yet taken by the group chat (a later turn's entry replaces an earlier one of the same path). */
	run: Map<string, TurnOutputFile>;
}

/**
 * What each agent turn created or modified in the project folder of its session (docs: the chat shows these files under the
 * turn). On `agent_start` it snapshots the folder (bounded walk), on `agent_end` it snapshots again and diffs; the paths
 * named by write/edit tool calls are added (they are exact, and are all there is when a walk hit its limits). A turn with
 * files is stored (`turn_outputs`) and published as `turn_outputs` on `session:<id>`. Never blocks the runtime's event
 * dispatch: every walk and every write happens off the event handler, and failures are logged and swallowed.
 */
export class TurnOutputService {
	/** Walk limits of the snapshots; the defaults are the module constants (tests lower them). */
	snapshotLimits: SnapshotLimits = {};
	private readonly states = new Map<string, SessionState>();
	private readonly disposers: Array<() => void> = [];

	constructor(private readonly ctx: ServerContext) {}

	start(): void {
		if (this.disposers.length > 0) return;
		this.disposers.push(
			this.ctx.runtime.onEvent((sessionId, event) => this.onEvent(sessionId, event)),
			this.ctx.runtime.onStatus((status) => this.onStatus(status)),
		);
	}

	dispose(): void {
		for (const dispose of this.disposers.splice(0)) dispose();
		this.states.clear();
	}

	/** Resolves when the diffs of all finished turns are recorded (shutdown / tests). */
	async drain(): Promise<void> {
		await Promise.all([...this.states.values()].map((state) => state.chain));
	}

	/** Resolves once the open turn's start snapshot is taken (at once when no turn is open): the folder can then change without being mistaken for the starting state. */
	async startSnapshotTaken(sessionId: string): Promise<void> {
		await this.states.get(sessionId)?.open?.before.catch(() => undefined);
	}

	/** The turns of a session that produced files, oldest → newest (the newest 500). */
	list(sessionId: string): TurnOutputs[] {
		const rows = this.ctx.db.select().from(turnOutputs).where(eq(turnOutputs.sessionId, sessionId)).orderBy(desc(turnOutputs.endedAt), desc(turnOutputs.id)).limit(OUTPUT_TURNS_PAGE).all();
		return rows.reverse().map(toRow);
	}

	/**
	 * Waits for the diffs still in flight for the session, then returns (and forgets) the files its turns produced since the
	 * previous call: the later turn's entry winning for a repeated path.
	 */
	async takeRunOutputs(sessionId: string): Promise<TurnOutputFile[]> {
		const state = this.states.get(sessionId);
		if (!state) return [];
		await state.chain;
		const files = [...state.run.values()];
		state.run.clear();
		return files;
	}

	// ------------------------------------------------------------------ runtime events

	private state(sessionId: string): SessionState {
		let state = this.states.get(sessionId);
		if (!state) this.states.set(sessionId, (state = { open: null, chain: Promise.resolve(), run: new Map() }));
		return state;
	}

	private onEvent(sessionId: string, event: SessionEvent): void {
		try {
			switch (event.type) {
				case "agent_start":
					this.begin(sessionId);
					break;
				case "tool_start": {
					const open = this.states.get(sessionId)?.open;
					if (open) void this.noteTool(open, event.toolName, event.args);
					break;
				}
				case "message_end": {
					const open = this.states.get(sessionId)?.open;
					if (!open || event.message.role !== "assistant") break;
					const hasText = event.message.content.some((block) => block.type === "text" && block.text.trim() !== "");
					const failed = event.message.stopReason === "aborted" || event.message.stopReason === "error";
					if (!(failed && !hasText)) open.anchor = { id: event.message.id, timestamp: event.message.timestamp };
					break;
				}
				case "agent_end":
				case "settled": // an `agent_end` that never arrived must not leave the turn open for ever
					this.finish(sessionId);
					break;
				default:
					break;
			}
		} catch (error) {
			this.ctx.log.warn({ err: errorText(error), sessionId }, "turn outputs: could not handle a runtime event");
		}
	}

	/** A crashed or restarting process loses its turn: the snapshot of an unfinished turn is dropped, not diffed. */
	private onStatus(status: RuntimeStatus): void {
		if (status.state === "crashed" || status.state === "restarting" || status.state === "stopped") {
			const state = this.states.get(status.sessionId);
			if (state) state.open = null;
		}
	}

	private begin(sessionId: string): void {
		const state = this.state(sessionId);
		if (state.open) return; // a continuation of the turn that is open
		const row = this.ctx.db
			.select({ kind: agentSessions.kind, projectId: projects.id, projectPath: projects.path })
			.from(agentSessions)
			.innerJoin(projects, eq(projects.id, agentSessions.projectId))
			.where(eq(agentSessions.id, sessionId))
			.get();
		// A mirror shows another node's session: it has no folder of its own to watch.
		if (!row || row.kind === "mirror") return;
		const root = realpath(row.projectPath).catch(() => null);
		// Started now, not when somebody asks: the walk races the agent's first write, not the user's patience.
		const before = root.then((r) => (r === null ? null : snapshotFolder(r, this.snapshotLimits)));
		before.catch(() => undefined);
		state.open = { startedAt: Date.now(), projectId: row.projectId, projectPath: row.projectPath, root, before, explicit: new Set(), anchor: null };
	}

	private async noteTool(open: OpenTurn, toolName: string, args: unknown): Promise<void> {
		const root = await open.root;
		if (root === null) return;
		for (const rel of explicitPaths(toolName, args, root)) open.explicit.add(rel);
	}

	private finish(sessionId: string): void {
		const state = this.states.get(sessionId);
		const open = state?.open;
		if (!state || !open) return;
		state.open = null;
		const endedAt = Date.now();
		// The second walk starts at once for the same reason as the first; the diff itself waits its turn.
		const after = open.root.then((r) => (r === null ? null : snapshotFolder(r, this.snapshotLimits)));
		after.catch(() => undefined);
		state.chain = state.chain
			.then(() => this.record(sessionId, state, open, after, endedAt))
			.catch((error: unknown) => {
				this.ctx.log.warn({ err: errorText(error), sessionId }, "turn outputs: could not record the files of a turn");
			});
	}

	private async record(sessionId: string, state: SessionState, open: OpenTurn, afterPromise: Promise<Snapshot | null>, endedAt: number): Promise<void> {
		const [root, before, after] = await Promise.all([open.root, open.before, afterPromise]);
		if (root === null) return;
		// The session (and with it the folder) may be gone by now.
		if (!this.ctx.db.select({ id: agentSessions.id }).from(agentSessions).where(eq(agentSessions.id, sessionId)).get()) {
			this.states.delete(sessionId);
			return;
		}
		const changed = new Map<string, { info: FileStat; change: "created" | "modified" }>();
		if (before?.complete && after?.complete) {
			for (const [rel, info] of after.files) {
				const was = before.files.get(rel);
				if (!was) changed.set(rel, { info, change: "created" });
				else if (was.size !== info.size || was.mtimeMs !== info.mtimeMs) changed.set(rel, { info, change: "modified" });
			}
		}
		for (const rel of open.explicit) {
			if (changed.has(rel)) continue;
			const info = await stat(path.join(root, rel)).catch(() => null);
			if (!info?.isFile()) continue; // never created, or a directory
			const existed = before?.complete ? before.files.has(rel) : true;
			changed.set(rel, { info: { size: info.size, mtimeMs: info.mtimeMs }, change: existed ? "modified" : "created" });
		}
		if (changed.size === 0) return;
		const all: TurnOutputFile[] = [...changed].map(([rel, { info, change }]) => {
			const name = path.posix.basename(rel);
			return { path: rel, name, size: info.size, mimeType: contentTypeFor(name).split(";", 1)[0] as string, modifiedAt: Math.round(info.mtimeMs), change };
		});
		all.sort(compareFiles);
		const files = all.slice(0, MAX_OUTPUT_FILES);
		const outputs: TurnOutputs = {
			id: newId("tout"),
			sessionId,
			projectId: open.projectId,
			anchorMessageId: open.anchor?.id ?? null,
			anchorTimestamp: open.anchor?.timestamp ?? null,
			startedAt: open.startedAt,
			endedAt,
			files,
			truncated: all.length > files.length,
		};
		this.ctx.db.insert(turnOutputs).values(outputs).run();
		this.ctx.bus.publish(`session:${sessionId}`, { type: "turn_outputs", outputs } satisfies SessionEvent);
		for (const file of files) {
			const earlier = state.run.get(file.path);
			state.run.set(file.path, earlier?.change === "created" ? { ...file, change: "created" } : file);
		}
		while (state.run.size > MAX_RUN_FILES) state.run.delete(state.run.keys().next().value as string);
	}
}
