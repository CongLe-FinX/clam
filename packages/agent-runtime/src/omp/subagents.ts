import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SessionEvent, Subagent, SubagentMessagesPage, SubagentStatus, SubagentToolRun, UiMessage } from "@clam/contracts";
import { isRecord } from "./frames.ts";
import { toUiMessage } from "./messages.ts";

/**
 * Subagents the agent spawned with the `task` tool, tracked from OMP's `subagent_lifecycle` / `subagent_progress` frames
 * (enabled with `set_subagent_subscription`). OMP's own registry (`get_subagents`) forgets a subagent the moment it ends;
 * this tracker keeps finished ones so the UI can show the whole team, and remembers each transcript file so a transcript
 * can be read even after the process is gone (see `readSubagentTranscript`).
 */

const MAX_RECENT_TOOLS = 6;
const MAX_RECENT_LINES = 6;
const MAX_LINE = 400;
const MAX_TRACKED = 256;
const DEFAULT_THROTTLE_MS = 250;
/** Transcripts are read in bounded slices so one huge file cannot stall the server. */
const MAX_TRANSCRIPT_SLICE = 4 * 1024 * 1024;

function str(value: unknown): string | null {
	return typeof value === "string" && value !== "" ? value : null;
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optNum(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function cut(text: string): string {
	return text.length > MAX_LINE ? `${text.slice(0, MAX_LINE - 1)}…` : text;
}

const STATUSES: ReadonlySet<string> = new Set<SubagentStatus>(["pending", "running", "completed", "failed", "aborted"]);

function isTerminal(status: SubagentStatus): boolean {
	return status === "completed" || status === "failed" || status === "aborted";
}

function statusOfLifecycle(status: unknown): SubagentStatus | null {
	if (status === "started") return "running";
	return typeof status === "string" && STATUSES.has(status) ? (status as SubagentStatus) : null;
}

function recentTools(value: unknown): SubagentToolRun[] {
	if (!Array.isArray(value)) return [];
	const runs: SubagentToolRun[] = [];
	for (const raw of value.slice(-MAX_RECENT_TOOLS)) {
		if (!isRecord(raw) || typeof raw.tool !== "string") continue;
		const run: SubagentToolRun = { tool: raw.tool, args: cut(typeof raw.args === "string" ? raw.args : ""), endedAt: num(raw.endMs) };
		if (typeof raw.intent === "string" && raw.intent) run.intent = cut(raw.intent);
		if (typeof raw.isError === "boolean") run.isError = raw.isError;
		runs.push(run);
	}
	return runs;
}

function recentOutput(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((l): l is string => typeof l === "string" && l.trim() !== "")
		.slice(-MAX_RECENT_LINES)
		.map(cut);
}

function modelOf(progress: Record<string, unknown>): string | null {
	const resolved = str(progress.resolvedModel);
	if (resolved) return resolved;
	const override = progress.modelOverride;
	if (typeof override === "string" && override) return override;
	if (Array.isArray(override) && typeof override[0] === "string") return override[0];
	return null;
}

export interface PersistedSubagents {
	version: 1;
	subagents: Array<{ subagent: Subagent; sessionFile: string | null }>;
}

export interface SubagentTrackerOptions {
	emit(event: SessionEvent): void;
	/** Called after every change (events may still be throttled); used to persist the roster. */
	onChange?(): void;
	now?: () => number;
	/** At most one progress event per subagent in this window (a trailing one always follows). Default 250 ms. */
	throttleMs?: number;
}

interface Entry {
	subagent: Subagent;
	sessionFile: string | null;
	lastEmit: number;
	timer: NodeJS.Timeout | null;
}

export class SubagentTracker {
	private readonly entries = new Map<string, Entry>();
	private readonly opts: SubagentTrackerOptions;
	private readonly now: () => number;
	private readonly throttleMs: number;

	constructor(options: SubagentTrackerOptions) {
		this.opts = options;
		this.now = options.now ?? Date.now;
		this.throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
	}

	list(): Subagent[] {
		return [...this.entries.values()].map((e) => e.subagent).sort((a, b) => a.startedAt - b.startedAt || a.index - b.index || a.id.localeCompare(b.id));
	}

	get(id: string): Subagent | undefined {
		return this.entries.get(id)?.subagent;
	}

	/** The transcript file of a subagent this tracker has seen (never a caller-supplied path). */
	sessionFileOf(id: string): string | null {
		return this.entries.get(id)?.sessionFile ?? null;
	}

	/** Frames of types `subagent_lifecycle` and `subagent_progress`; everything else is ignored. Returns true when handled. */
	handle(frame: { type: string } & Record<string, unknown>): boolean {
		if (frame.type !== "subagent_lifecycle" && frame.type !== "subagent_progress") return false;
		const payload = frame.payload;
		if (!isRecord(payload)) return true;
		if (frame.type === "subagent_lifecycle") this.lifecycle(payload);
		else this.progress(payload);
		return true;
	}

	private blank(id: string, payload: Record<string, unknown>): Subagent {
		const at = this.now();
		return {
			id,
			index: num(payload.index),
			agent: str(payload.agent) ?? "task",
			parentToolCallId: str(payload.parentToolCallId),
			status: "pending",
			description: null,
			assignment: null,
			model: null,
			stage: null,
			currentTool: null,
			currentToolArgs: null,
			recentTools: [],
			recentOutput: [],
			toolCount: 0,
			requests: 0,
			tokens: 0,
			cost: 0,
			contextTokens: null,
			contextWindow: null,
			completionPercent: null,
			detached: payload.detached === true,
			durationMs: 0,
			startedAt: at,
			updatedAt: at,
			hasTranscript: false,
			error: null,
		};
	}

	private lifecycle(payload: Record<string, unknown>): void {
		const id = str(payload.id);
		const status = statusOfLifecycle(payload.status);
		if (!id || !status) return;
		let entry = this.entries.get(id);
		// A new spawn under a finished id (same name reused by a later `task` call) starts a fresh entry.
		if (!entry || (status === "running" && isTerminal(entry.subagent.status))) {
			entry = this.insert(id, payload);
		}
		const next = { ...entry.subagent };
		// A terminal state is final; a late `started` must not revive it.
		if (!isTerminal(next.status) || isTerminal(status)) next.status = status;
		const description = str(payload.description);
		if (description) next.description = description;
		const parent = str(payload.parentToolCallId);
		if (parent) next.parentToolCallId = parent;
		if (payload.detached === true) next.detached = true;
		const sessionFile = str(payload.sessionFile);
		if (sessionFile) {
			entry.sessionFile = sessionFile;
			next.hasTranscript = true;
		}
		if (status === "failed" && next.error === null) next.error = "The subagent failed";
		this.commit(entry, next, true);
	}

	private progress(payload: Record<string, unknown>): void {
		const progress = payload.progress;
		if (!isRecord(progress)) return;
		const id = str(progress.id);
		if (!id) return;
		let entry = this.entries.get(id);
		if (!entry) entry = this.insert(id, payload);
		const status = statusOfLifecycle(progress.status);
		const prev = entry.subagent;
		const next: Subagent = { ...prev };
		// Progress never revives a finished subagent.
		const settled = isTerminal(prev.status);
		if (status && !settled) next.status = status;
		next.index = num(payload.index) || prev.index;
		next.description = str(progress.description) ?? prev.description;
		next.assignment = str(payload.assignment) ?? str(progress.assignment) ?? prev.assignment;
		next.model = modelOf(progress) ?? prev.model;
		next.stage = str(progress.stage) ?? str(progress.lastIntent) ?? prev.stage;
		next.currentTool = str(progress.currentTool);
		next.currentToolArgs = str(progress.currentToolArgs) ? cut(String(progress.currentToolArgs)) : null;
		next.recentTools = recentTools(progress.recentTools);
		next.recentOutput = recentOutput(progress.recentOutput);
		next.toolCount = num(progress.toolCount);
		next.requests = num(progress.requests);
		next.tokens = num(progress.tokens);
		next.cost = num(progress.cost);
		next.contextTokens = optNum(progress.contextTokens);
		next.contextWindow = optNum(progress.contextWindow);
		next.completionPercent = optNum(progress.completionPercent);
		next.durationMs = num(progress.durationMs);
		if (payload.detached === true) next.detached = true;
		const parent = str(payload.parentToolCallId);
		if (parent) next.parentToolCallId = parent;
		const sessionFile = str(payload.sessionFile);
		if (sessionFile) {
			entry.sessionFile = sessionFile;
			next.hasTranscript = true;
		}
		const failure = isRecord(progress.retryFailure) ? str(progress.retryFailure.errorMessage) : null;
		if (failure) next.error = cut(failure);
		this.commit(entry, next, next.status !== prev.status);
	}

	private insert(id: string, payload: Record<string, unknown>): Entry {
		const old = this.entries.get(id);
		clearTimeout(old?.timer ?? undefined);
		const entry: Entry = { subagent: this.blank(id, payload), sessionFile: null, lastEmit: 0, timer: null };
		this.entries.delete(id);
		this.entries.set(id, entry);
		while (this.entries.size > MAX_TRACKED) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			const gone = this.entries.get(oldest);
			clearTimeout(gone?.timer ?? undefined);
			this.entries.delete(oldest);
			this.opts.emit({ type: "subagent_remove", subagentId: oldest });
		}
		return entry;
	}

	/** Store a new snapshot and publish it: at once when `immediate`, else at most once per throttle window (trailing edge kept). */
	private commit(entry: Entry, next: Subagent, immediate: boolean): void {
		next.updatedAt = this.now();
		entry.subagent = next;
		this.opts.onChange?.();
		if (immediate) {
			this.flush(entry);
			return;
		}
		if (entry.timer) return;
		const wait = entry.lastEmit + this.throttleMs - this.now();
		if (wait <= 0) {
			this.flush(entry);
			return;
		}
		entry.timer = setTimeout(() => {
			entry.timer = null;
			this.flush(entry);
		}, Math.max(0, wait));
		entry.timer.unref?.();
	}

	private flush(entry: Entry): void {
		if (entry.timer) {
			clearTimeout(entry.timer);
			entry.timer = null;
		}
		entry.lastEmit = this.now();
		this.opts.emit({ type: "subagent_upsert", subagent: entry.subagent });
	}

	/** The process is gone: whatever was still running was killed with it. Publishes the changes. */
	interruptRunning(): void {
		for (const entry of this.entries.values()) {
			if (isTerminal(entry.subagent.status)) continue;
			this.commit(entry, { ...entry.subagent, status: "aborted", currentTool: null, currentToolArgs: null, stage: null }, true);
		}
	}

	/** Stop pending timers (shutdown). Pending trailing events are dropped. */
	dispose(): void {
		for (const entry of this.entries.values()) {
			clearTimeout(entry.timer ?? undefined);
			entry.timer = null;
		}
	}

	persisted(): PersistedSubagents {
		return { version: 1, subagents: this.list().map((subagent) => ({ subagent, sessionFile: this.entries.get(subagent.id)?.sessionFile ?? null })) };
	}

	/** Load a previous run's roster. Anything that was still running belongs to a process that no longer exists. */
	restore(data: PersistedSubagents): void {
		for (const item of data.subagents) {
			const subagent = settledSubagent(item.subagent);
			this.entries.set(subagent.id, { subagent, sessionFile: item.sessionFile, lastEmit: 0, timer: null });
		}
	}
}

/** A subagent as it must be shown once its process is gone: still-running ones were killed with it. */
function settledSubagent(subagent: Subagent): Subagent {
	return isTerminal(subagent.status) ? subagent : { ...subagent, status: "aborted", currentTool: null, currentToolArgs: null, stage: null };
}

/** Parse a persisted roster; anything malformed yields null (the roster is only a cache of what was seen). */
export function parsePersistedSubagents(text: string): PersistedSubagents | null {
	try {
		const data: unknown = JSON.parse(text);
		if (!isRecord(data) || data.version !== 1 || !Array.isArray(data.subagents)) return null;
		const subagents: PersistedSubagents["subagents"] = [];
		for (const item of data.subagents) {
			if (!isRecord(item) || !isRecord(item.subagent) || typeof item.subagent.id !== "string") continue;
			subagents.push({ subagent: item.subagent as unknown as Subagent, sessionFile: typeof item.sessionFile === "string" ? item.sessionFile : null });
		}
		return { version: 1, subagents };
	} catch {
		return null;
	}
}

export const SUBAGENT_ROSTER_FILE = "clam-subagents.json";

/** `message` entries of an OMP session file as UI messages; the entry id keeps message ids stable across incremental reads. */
export function transcriptMessages(entries: unknown[]): UiMessage[] {
	const out: UiMessage[] = [];
	for (const entry of entries) {
		if (!isRecord(entry) || entry.type !== "message" || typeof entry.id !== "string") continue;
		const message = toUiMessage(entry.message, entry.id);
		if (message) out.push(message);
	}
	return out;
}

/**
 * Read a subagent transcript straight from its file, the way OMP's `get_subagent_messages` does: only complete,
 * newline-terminated records are consumed, `nextByte` is where to continue, and `reset` says the file is shorter than
 * `fromByte` (read again from the start). Used when no process is running; the path always comes from the tracker.
 */
export async function readSubagentTranscript(sessionFile: string, fromByte = 0): Promise<SubagentMessagesPage> {
	let start = Number.isFinite(fromByte) ? Math.max(0, Math.trunc(fromByte)) : 0;
	let size: number;
	try {
		size = (await stat(sessionFile)).size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { fromByte: start, nextByte: start, reset: false, messages: [] };
		throw error;
	}
	let reset = false;
	if (start > size) {
		start = 0;
		reset = true;
	}
	if (start >= size) return { fromByte: start, nextByte: start, reset, messages: [] };
	const buffer = await readFile(sessionFile);
	const slice = buffer.subarray(start, Math.min(size, start + MAX_TRANSCRIPT_SLICE));
	const lastNewline = slice.lastIndexOf(0x0a);
	if (lastNewline < 0) return { fromByte: start, nextByte: start, reset, messages: [] };
	const complete = slice.subarray(0, lastNewline + 1);
	const entries: unknown[] = [];
	for (const line of complete.toString("utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			/* a damaged record is skipped, like OMP's own loader does */
		}
	}
	return { fromByte: start, nextByte: start + complete.length, reset, messages: transcriptMessages(entries) };
}

/**
 * The roster `OmpSessionRuntime` last saved for a session directory, for sessions whose process is not running. Anything the
 * file records as still running belonged to a process that no longer exists and is reported as aborted. Null = no roster.
 */
export async function readSubagentRoster(sessionDir: string): Promise<PersistedSubagents | null> {
	let text: string;
	try {
		text = await readFile(join(sessionDir, SUBAGENT_ROSTER_FILE), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	const roster = parsePersistedSubagents(text);
	if (!roster) return null;
	return { version: 1, subagents: roster.subagents.map(({ subagent, sessionFile }) => ({ subagent: settledSubagent(subagent), sessionFile })) };
}
