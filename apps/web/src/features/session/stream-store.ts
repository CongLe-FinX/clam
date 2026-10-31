import type { AgentSession, MessagesPage, PendingUiRequest, RuntimeStatus, SessionEvent, SessionLiveState, SessionOutputsPage, TurnOutputs, UiMessage } from "@clam/contracts";
import { routes } from "@clam/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { clearInitialPrompt, initialPromptClientId, peekInitialPrompt } from "@/lib/initial-prompt";
import { qk } from "@/lib/queries";
import { newClientId } from "@/lib/utils";
import { ws } from "@/lib/ws";
import { PAGE_SIZE, takePreloaded } from "./preload.ts";

// ───────────────────────────── public types ─────────────────────────────

export type ToolStatus = "running" | "ok" | "error" | "interrupted";

export interface ToolRec {
	id: string;
	name: string;
	args: unknown;
	intent?: string;
	status: ToolStatus;
	/** Latest partial output while running. */
	preview?: string;
	result?: string;
	/** Structured result of the `todo` and `ask` tools (`UiMessage.toolDetails`). */
	details?: unknown;
	/** Local receipt times (ms). Undefined for tools only known from history. */
	startedAt?: number;
	endedAt?: number;
}

export interface MsgRec {
	/** Stable list key: `u:<clientId>` for user messages with a clientId, else the server message id. */
	key: string;
	msg: UiMessage;
	streaming: boolean;
	/** Locally created, not yet confirmed by the server echo / history. */
	optimistic: boolean;
	/** Optimistic message whose POST has resolved. */
	sent: boolean;
	/** Plain text for the copy button, computed once when the message is final. */
	copyText: string;
}

export interface UiRequestRec {
	requestId: string;
	method: string;
	title: string;
	message?: string;
	options?: string[];
	receivedAt: number;
}

export type LogKind = "tool" | "runtime" | "notice" | "prompt" | "agent" | "approval";
export interface LogEntry {
	id: number;
	at: number;
	kind: LogKind;
	level: "info" | "success" | "warning" | "error";
	text: string;
	detail?: string;
	/** Tool entries read live status/duration from the ToolRec. */
	toolCallId?: string;
}

export interface StreamMeta {
	live: SessionLiveState | null;
	liveStatus: "loading" | "ready" | "error";
	liveError: unknown;
	historyStatus: "loading" | "ready" | "error";
	historyError: unknown;
	total: number | null;
	hasOlder: boolean;
	loadingOlder: boolean;
	agentRunning: boolean;
	aborting: boolean;
	uiRequests: readonly UiRequestRec[];
	selectedToolId: string | null;
	/** Bumps whenever the local user sends a prompt (forces scroll-to-latest). */
	sendTick: number;
	resyncing: boolean;
}

const initialMeta: StreamMeta = {
	live: null,
	liveStatus: "loading",
	liveError: null,
	historyStatus: "loading",
	historyError: null,
	total: null,
	hasOlder: false,
	loadingOlder: false,
	agentRunning: false,
	aborting: false,
	uiRequests: [],
	selectedToolId: null,
	sendTick: 0,
	resyncing: false,
};

export const isBusy = (m: StreamMeta): boolean => m.agentRunning || m.live?.runtime.state === "busy";

// ───────────────────────────── helpers ─────────────────────────────

const MAX_LOG = 1500;
const MAX_BUFFER = 5000;

/** Concatenated text blocks of a message. */
export function textOf(msg: UiMessage): string {
	let out = "";
	for (const b of msg.content) if (b.type === "text") out += (out ? "\n\n" : "") + b.text;
	return out;
}

const listable = (m: UiMessage): boolean => m.role === "user" || m.role === "assistant" || m.role === "custom";

type Listener = () => void;
function addKeyed(map: Map<string, Set<Listener>>, key: string, cb: Listener): () => void {
	let set = map.get(key);
	if (!set) {
		set = new Set();
		map.set(key, set);
	}
	set.add(cb);
	return () => {
		set.delete(cb);
		if (set.size === 0 && map.get(key) === set) map.delete(key);
	};
}
function fire(set: Set<Listener> | undefined): void {
	if (set) for (const l of [...set]) l();
}

interface DeltaItem {
	contentIndex: number;
	kind: "text" | "thinking" | "toolCall";
	delta: string;
}

// ───────────────────────────── the store ─────────────────────────────

/**
 * Event-sourced view of one session. Components subscribe to exactly the slice they render
 * (a message, a tool, the key order, a meta field), so a streaming delta re-renders one row.
 * Deltas are buffered and flushed once per animation frame.
 */
export class SessionStream {
	private recs = new Map<string, MsgRec>();
	private idIndex = new Map<string, string>();
	private tools = new Map<string, ToolRec>();
	/** Tool call name/args from final assistant messages (history has no tool_start events). */
	private calls = new Map<string, { name: string; args: unknown; intent?: string }>();
	getCall = (id: string): { name: string; args: unknown; intent?: string } | undefined => this.calls.get(id);
	private order: readonly string[] = [];
	private log: readonly LogEntry[] = [];
	private logSeq = 0;
	private meta: StreamMeta = initialMeta;

	private metaL = new Set<Listener>();
	private orderL = new Set<Listener>();
	private logL = new Set<Listener>();
	private msgL = new Map<string, Set<Listener>>();
	private toolL = new Map<string, Set<Listener>>();

	private cursor: string | null = null;
	/** Events received before the first history page; null once history has settled. */
	private buffer: Array<{ e: SessionEvent; at: number }> | null = [];
	/** While replaying buffered events: their original receipt time (tool timers must not collapse to ~0 ms). */
	private replayAt: number | null = null;
	private now = (): number => this.replayAt ?? Date.now();
	private deltas = new Map<string, DeltaItem[]>();
	private toolPreviews = new Map<string, string>();
	private raf = 0;
	private liveFromEvent = false;
	private unsub: (() => void) | null = null;
	private ac: AbortController | null = null;
	private invalidateTimer: ReturnType<typeof setTimeout> | null = null;
	private abortTimer: ReturnType<typeof setTimeout> | null = null;
	/** Files each agent turn produced (by output id) and the assistant row each strip is shown under. */
	private outputs = new Map<string, TurnOutputs>();
	private rowOutputs = new Map<string, readonly TurnOutputs[]>();
	private outL = new Map<string, Set<Listener>>();
	/** Rows that arrived live. The enter animation plays once for them; virtualizer remounts must never replay it. */
	private liveRows = new Set<string>();

	constructor(
		readonly sessionId: string,
		private readonly qc: QueryClient,
	) {
		// The server sends the dialog's "First prompt" itself, before this page existed: show it right away.
		const first = peekInitialPrompt(sessionId);
		if (first) {
			const clientId = initialPromptClientId(sessionId);
			const key = `u:${clientId}`;
			this.put(key, { id: `optimistic:${clientId}`, role: "user", timestamp: Date.now(), content: [{ type: "text", text: first }], clientId }, { optimistic: true, sent: true });
			this.order = [key];
		}
	}

	// ── subscriptions (stable arrow props for useSyncExternalStore)

	getMeta = (): StreamMeta => this.meta;
	subscribeMeta = (cb: Listener): (() => void) => {
		this.metaL.add(cb);
		return () => this.metaL.delete(cb);
	};
	getOrder = (): readonly string[] => this.order;
	subscribeOrder = (cb: Listener): (() => void) => {
		this.orderL.add(cb);
		return () => this.orderL.delete(cb);
	};
	getLog = (): readonly LogEntry[] => this.log;
	subscribeLog = (cb: Listener): (() => void) => {
		this.logL.add(cb);
		return () => this.logL.delete(cb);
	};
	getRec = (key: string): MsgRec | undefined => this.recs.get(key);
	subscribeRec = (key: string, cb: Listener): (() => void) => addKeyed(this.msgL, key, cb);
	getTool = (id: string): ToolRec | undefined => this.tools.get(id);
	subscribeTool = (id: string, cb: Listener): (() => void) => addKeyed(this.toolL, id, cb);
	getRowOutputs = (key: string): readonly TurnOutputs[] | undefined => this.rowOutputs.get(key);
	subscribeRowOutputs = (key: string, cb: Listener): (() => void) => addKeyed(this.outL, key, cb);
	isLiveRow = (key: string): boolean => this.liveRows.has(key);
	/** The row has been shown: it must not animate again when it remounts. */
	seenRow = (key: string): void => {
		this.liveRows.delete(key);
	};

	private setMeta(patch: Partial<StreamMeta>): void {
		this.meta = { ...this.meta, ...patch };
		fire(this.metaL);
	}
	private emitOrder(): void {
		this.reindexOutputs();
		fire(this.orderL);
	}

	// ── lifecycle

	/** Subscribes to the topic BEFORE fetching history (race rule), returns a detach function. */
	attach = (): (() => void) => {
		clearInitialPrompt(this.sessionId);
		this.buffer = [];
		this.liveFromEvent = false;
		this.ac = new AbortController();
		const offSession = ws.subscribe(
			`session:${this.sessionId}`,
			(e) => this.onEvent(e as SessionEvent),
			() => void this.resync(),
		);
		let rt: string | null = this.meta.live?.runtime.state ?? null;
		const offRuntime = ws.subscribe("runtime", (e) => {
			if (e.type !== "status" || e.status.sessionId !== this.sessionId) return;
			const next = e.status.state;
			if (next === "ready" && (rt === "restarting" || rt === "crashed")) this.scheduleReload(true);
			rt = next;
		});
		this.unsub = () => {
			offSession();
			offRuntime();
		};
		void this.loadInitial(this.ac.signal);
		return () => this.detach();
	};

	private detach(): void {
		this.unsub?.();
		this.unsub = null;
		this.ac?.abort();
		this.ac = null;
		if (this.raf) cancelAnimationFrame(this.raf);
		this.raf = 0;
		clearTimeout(this.invalidateTimer ?? undefined);
		clearTimeout(this.abortTimer ?? undefined);
		this.invalidateTimer = this.abortTimer = null;
		this.flush();
	}

	private async loadInitial(signal: AbortSignal): Promise<void> {
		this.setMeta({ historyStatus: this.meta.historyStatus === "ready" ? "ready" : "loading" });
		const applyPage = (page: MessagesPage): void => {
			this.mergeHistory(page.messages);
			if (!this.hasLoadedOlder) this.cursor = page.nextCursor;
			this.setMeta({ historyStatus: "ready", historyError: null, total: page.total, hasOlder: this.cursor !== null });
		};
		let settled = false;
		// A hover/focus preload paints the conversation immediately; the fresh fetch below then closes any gap before attach.
		const pre = takePreloaded(this.sessionId);
		if (pre) {
			void pre.page.then((page) => {
				if (!settled && !signal.aborted) applyPage(page);
			}, () => undefined);
			void pre.outputs.then((page) => {
				if (!settled && !signal.aborted) this.mergeOutputs(page.outputs);
			}, () => undefined);
		}
		const history = api
			.get<MessagesPage>(routes.sessionMessages(this.sessionId), { limit: PAGE_SIZE }, { signal })
			.then((page) => {
				settled = true;
				applyPage(page);
			})
			.catch((e) => {
				if (signal.aborted || this.meta.historyStatus === "ready") return;
				settled = true;
				this.setMeta({ historyStatus: "error", historyError: e });
			})
			.finally(() => {
				if (signal.aborted) return;
				this.drainBuffer();
			});
		const state = this.fetchState(signal);
		void this.fetchUiRequests(signal);
		await Promise.allSettled([history, state, this.loadOutputs(signal)]);
	}
	private hasLoadedOlder = false;

	private drainBuffer(): void {
		const buf = this.buffer;
		this.buffer = null;
		if (!buf) return;
		try {
			for (const { e, at } of buf) {
				this.replayAt = at;
				this.apply(e);
			}
		} finally {
			this.replayAt = null;
		}
	}

	/** (Re)fetch live state. Starts the runtime on the server if needed, so it can take seconds. */
	fetchState = async (signal?: AbortSignal): Promise<void> => {
		if (!this.liveFromEvent || this.meta.liveStatus === "error") this.setMeta({ liveStatus: this.meta.live ? this.meta.liveStatus : "loading", liveError: null });
		try {
			const state = await api.get<SessionLiveState>(routes.sessionState(this.sessionId), undefined, { signal });
			if (signal?.aborted) return;
			if (!this.liveFromEvent) this.applyState(state);
			else this.setMeta({ liveStatus: "ready", liveError: null });
		} catch (e) {
			if (signal?.aborted) return;
			this.setMeta({ liveStatus: "error", liveError: e });
		}
	};

	/** Manual retry for the error banner: reload state and the latest page. */
	retry = async (): Promise<void> => {
		this.liveFromEvent = false;
		this.setMeta({ liveStatus: "loading", liveError: null });
		await Promise.allSettled([this.fetchState(), this.resync()]);
	};

	/** After reconnect / seq gap: refetch state + latest page and merge idempotently. `reconcile` also drops messages the server no longer has (transcript reloaded after a runtime restart). */
	private async resync(reconcile = false): Promise<void> {
		if (this.buffer) return; // initial load still covers it
		this.setMeta({ resyncing: true });
		try {
			let streaming = this.meta.agentRunning;
			try {
				const state = await api.get<SessionLiveState>(routes.sessionState(this.sessionId));
				this.liveFromEvent = false;
				this.applyState(state);
				streaming = state.isStreaming;
			} catch (e) {
				this.setMeta({ liveStatus: this.meta.live ? "ready" : "error", liveError: e });
			}
			void this.fetchUiRequests(undefined, true);
			try {
				void this.loadOutputs();
				const page = await api.get<MessagesPage>(routes.sessionMessages(this.sessionId), { limit: PAGE_SIZE });
				if (!streaming) this.finalizeStreaming();
				this.mergeHistory(page.messages);
				if (reconcile) this.reconcile(page.messages, page.nextCursor === null);
				if (!this.hasLoadedOlder) this.cursor = page.nextCursor;
				this.setMeta({ historyStatus: "ready", historyError: null, total: page.total, hasOlder: this.cursor !== null });
			} catch (e) {
				this.setMeta({ historyError: e });
			}
		} finally {
			this.setMeta({ resyncing: false });
		}
	}

	private reloadQueued = false;
	/** Runtime came back (restart/crash recovery): the transcript is reloaded from disk server-side. */
	private scheduleReload(reconcile: boolean): void {
		if (this.reloadQueued) return;
		this.reloadQueued = true;
		setTimeout(() => {
			this.reloadQueued = false;
			void this.resync(reconcile);
		}, 0);
	}

	/** Drop loaded messages that the server's latest page no longer contains (e.g. an interrupted streaming message). */
	private reconcile(messages: UiMessage[], complete: boolean): void {
		const keep = new Set<string>();
		let oldest = Number.POSITIVE_INFINITY;
		for (const m of messages) {
			if (!listable(m)) continue;
			keep.add(this.resolveKey(m));
			oldest = Math.min(oldest, m.timestamp);
		}
		const drop = this.order.filter((k) => {
			const r = this.recs.get(k);
			return r !== undefined && !r.optimistic && !keep.has(k) && (complete || r.msg.timestamp >= oldest);
		});
		if (drop.length === 0) return;
		const gone = new Set(drop);
		for (const k of drop) {
			const r = this.recs.get(k);
			this.recs.delete(k);
			if (r && this.idIndex.get(r.msg.id) === k) this.idIndex.delete(r.msg.id);
			fire(this.msgL.get(k));
		}
		this.order = this.order.filter((k) => !gone.has(k));
		this.emitOrder();
	}

	/** Pending approvals are re-fetchable so one is never lost across reloads/reconnects. */
	private async fetchUiRequests(signal?: AbortSignal, replace = false): Promise<void> {
		try {
			const list = await api.get<PendingUiRequest[]>(routes.sessionUiRequests(this.sessionId), undefined, { signal });
			if (signal?.aborted || !Array.isArray(list)) return;
			const known = new Map(this.meta.uiRequests.map((r) => [r.requestId, r]));
			const fetched = list.map((r) => known.get(r.requestId) ?? { requestId: r.requestId, method: r.method, title: r.title, message: r.message, options: r.options, receivedAt: Date.now() });
			// Initial load: union with live events already received. Resync: the server list is authoritative.
			const extra = replace ? [] : this.meta.uiRequests.filter((r) => !list.some((x) => x.requestId === r.requestId));
			this.setMeta({ uiRequests: [...fetched, ...extra] });
		} catch {
			/* optional route: approvals still arrive live over the socket */
		}
	}

	// ── message bookkeeping

	private resolveKey(msg: UiMessage): string {
		const byId = this.idIndex.get(msg.id);
		if (byId) return byId;
		if (msg.clientId) return `u:${msg.clientId}`;
		if (msg.role === "user") {
			const text = textOf(msg);
			for (let i = this.order.length - 1, n = 0; i >= 0 && n < 30; i--, n++) {
				const rec = this.recs.get(this.order[i] as string);
				if (rec?.optimistic && rec.msg.role === "user" && textOf(rec.msg) === text) return rec.key;
			}
		}
		return msg.id;
	}

	private put(key: string, msg: UiMessage, o: { streaming?: boolean; optimistic?: boolean; sent?: boolean } = {}): boolean {
		const prev = this.recs.get(key);
		const streaming = o.streaming ?? false;
		const rec: MsgRec = { key, msg, streaming, optimistic: o.optimistic ?? false, sent: o.sent ?? true, copyText: streaming ? "" : textOf(msg) };
		this.recs.set(key, rec);
		this.idIndex.set(msg.id, key);
		if (!streaming && msg.role === "assistant") {
			for (const b of msg.content) if (b.type === "toolCall" && !b.id.startsWith("pending:")) this.calls.set(b.id, { name: b.name, args: b.arguments, intent: b.intent });
		}
		if (prev && prev.msg.id !== msg.id && this.idIndex.get(prev.msg.id) === key) this.idIndex.delete(prev.msg.id);
		fire(this.msgL.get(key));
		return !prev;
	}

	private append(key: string): void {
		if (this.buffer === null && this.replayAt === null) {
			this.liveRows.add(key);
			if (this.liveRows.size > 64) this.liveRows.delete(this.liveRows.values().next().value as string);
		}
		this.order = [...this.order, key];
		this.emitOrder();
	}

	// ── turn outputs

	private async loadOutputs(signal?: AbortSignal): Promise<void> {
		try {
			const page = await api.get<SessionOutputsPage>(routes.sessionOutputs(this.sessionId), undefined, { signal });
			if (!signal?.aborted) this.mergeOutputs(page.outputs);
		} catch {
			/* The strip is an enhancement of the transcript: it appears when the next turn ends or after the next reload. */
		}
	}

	private mergeOutputs(list: readonly TurnOutputs[]): void {
		let changed = false;
		for (const o of list) {
			const prev = this.outputs.get(o.id);
			if (prev && prev.endedAt === o.endedAt && prev.truncated === o.truncated && prev.files.length === o.files.length) continue;
			this.outputs.set(o.id, o);
			changed = true;
		}
		while (this.outputs.size > 1000) this.outputs.delete(this.outputs.keys().next().value as string);
		if (changed) this.reindexOutputs();
	}

	/**
	 * Decide which assistant row shows each turn's file strip: the row whose id is the anchor message, else the assistant row
	 * with the anchor's timestamp (ids change after a runtime restart), else the last assistant row at or before the turn's end.
	 * Only rows whose listener set actually changed are notified, so a strip update re-renders one row.
	 */
	private reindexOutputs(): void {
		if (this.outputs.size === 0 && this.rowOutputs.size === 0) return;
		let assistants: Array<{ key: string; ts: number }> | null = null;
		const rows = (): Array<{ key: string; ts: number }> => {
			if (!assistants) {
				assistants = [];
				for (const k of this.order) {
					const r = this.recs.get(k);
					if (r?.msg.role === "assistant") assistants.push({ key: k, ts: r.msg.timestamp });
				}
			}
			return assistants;
		};
		let byTs: Map<number, string> | null = null;
		const next = new Map<string, TurnOutputs[]>();
		for (const o of this.outputs.values()) {
			let key = o.anchorMessageId ? this.idIndex.get(o.anchorMessageId) : undefined;
			if (key !== undefined && this.recs.get(key)?.msg.role !== "assistant") key = undefined;
			if (key === undefined && o.anchorTimestamp !== null) {
				byTs ??= new Map(rows().map((r) => [r.ts, r.key] as const));
				key = byTs.get(o.anchorTimestamp);
			}
			if (key === undefined) {
				// Last assistant row whose timestamp is not after the turn's end (rows are in chronological order).
				const list = rows();
				let lo = 0;
				let hi = list.length - 1;
				while (lo <= hi) {
					const mid = (lo + hi) >> 1;
					const row = list[mid];
					if (row && row.ts <= o.endedAt) {
						key = row.key;
						lo = mid + 1;
					} else hi = mid - 1;
				}
			}
			if (key === undefined) continue;
			const bucket = next.get(key);
			if (bucket) bucket.push(o);
			else next.set(key, [o]);
		}
		const merged = new Map<string, readonly TurnOutputs[]>();
		for (const [key, list] of next) {
			list.sort((a, b) => a.startedAt - b.startedAt);
			const prev = this.rowOutputs.get(key);
			if (prev && prev.length === list.length && prev.every((p, i) => p === list[i])) {
				merged.set(key, prev);
				continue;
			}
			merged.set(key, list);
			fire(this.outL.get(key));
		}
		for (const key of this.rowOutputs.keys()) if (!merged.has(key)) fire(this.outL.get(key));
		this.rowOutputs = merged;
	}

	private ingestToolResult(m: UiMessage): void {
		if (!m.toolCallId) return;
		const result = textOf(m);
		const prev = this.tools.get(m.toolCallId);
		if (prev && prev.status !== "running" && prev.status !== "interrupted") {
			if (prev.result === undefined) this.setTool({ ...prev, result, details: prev.details ?? m.toolDetails });
			return;
		}
		this.setTool({
			id: m.toolCallId,
			name: prev?.name || m.toolName || "",
			args: prev?.args,
			intent: prev?.intent,
			status: m.isError ? "error" : "ok",
			result,
			details: m.toolDetails,
			startedAt: prev?.startedAt,
			endedAt: prev?.endedAt ?? (prev?.startedAt !== undefined ? Date.now() : undefined),
		});
	}

	private setTool(rec: ToolRec): void {
		this.tools.set(rec.id, rec);
		fire(this.toolL.get(rec.id));
	}

	/** Fold a chronological history page (latest page) into the store. */
	private mergeHistory(messages: UiMessage[]): void {
		const fresh: string[] = [];
		for (const m of messages) {
			if (m.role === "toolResult") {
				this.ingestToolResult(m);
				continue;
			}
			if (!listable(m)) continue;
			const key = this.resolveKey(m);
			const prev = this.recs.get(key);
			if (prev?.streaming) continue; // live stream is the authority
			if (this.put(key, m)) fresh.push(key);
		}
		if (fresh.length === 0) return;
		const merged = [...this.order, ...fresh];
		const ts = (k: string): number => this.recs.get(k)?.msg.timestamp ?? 0;
		const confirmed = merged.filter((k) => !this.recs.get(k)?.optimistic).sort((a, b) => ts(a) - ts(b));
		const optimistic = merged.filter((k) => this.recs.get(k)?.optimistic);
		this.order = [...confirmed, ...optimistic];
		this.emitOrder();
	}

	/** Prepend an older page (chronological) in front of the loaded window. */
	loadOlder = async (): Promise<void> => {
		const cursor = this.cursor;
		if (!cursor || this.meta.loadingOlder) return;
		this.setMeta({ loadingOlder: true });
		try {
			const page = await api.get<MessagesPage>(routes.sessionMessages(this.sessionId), { cursor, limit: PAGE_SIZE });
			const keys: string[] = [];
			for (const m of page.messages) {
				if (m.role === "toolResult") {
					this.ingestToolResult(m);
					continue;
				}
				if (!listable(m)) continue;
				const key = this.resolveKey(m);
				if (this.recs.has(key)) continue;
				this.put(key, m);
				keys.push(key);
			}
			this.hasLoadedOlder = true;
			this.cursor = page.nextCursor;
			if (keys.length) {
				this.order = [...keys, ...this.order];
				this.emitOrder();
			}
			this.setMeta({ loadingOlder: false, hasOlder: this.cursor !== null, total: page.total });
		} catch (e) {
			this.setMeta({ loadingOlder: false });
			toast.error(`Could not load earlier messages: ${e instanceof Error ? e.message : "request failed"}`);
		}
	};

	private finalizeStreaming(): void {
		for (const rec of [...this.recs.values()]) if (rec.streaming) this.put(rec.key, rec.msg, { optimistic: rec.optimistic, sent: rec.sent });
		for (const t of [...this.tools.values()]) if (t.status === "running") this.setTool({ ...t, status: "interrupted", endedAt: Date.now() });
	}

	// ── live events

	private onEvent(e: SessionEvent): void {
		if (e.type === "state") {
			this.liveFromEvent = true;
			this.applyState(e.state);
			return;
		}
		if (this.buffer) {
			if (this.buffer.length < MAX_BUFFER) this.buffer.push({ e, at: Date.now() });
			return;
		}
		this.apply(e);
	}

	private applyState(state: SessionLiveState): void {
		const prev = this.meta.live;
		if (prev && prev.runtime.state !== state.runtime.state) {
			const s = state.runtime.state;
			this.pushLog({
				kind: "runtime",
				level: s === "crashed" ? "error" : s === "ready" ? "success" : "info",
				text: `Runtime ${prev.runtime.state} → ${s}`,
				detail: s === "crashed" ? (state.runtime.lastError ?? undefined) : undefined,
			});
		}
		this.setMeta({ live: state, liveStatus: "ready", liveError: null, agentRunning: state.isStreaming });
		if (!this.meta.resyncing && prev && state.runtime.state === "ready" && prev.runtime.state !== "ready" && prev.runtime.state !== "busy") {
			this.scheduleReload(prev.runtime.state === "restarting" || prev.runtime.state === "crashed");
		}
	}

	private apply(e: SessionEvent): void {
		if (e.type === "message_delta") {
			const list = this.deltas.get(e.messageId);
			const item: DeltaItem = { contentIndex: e.contentIndex, kind: e.kind, delta: e.delta };
			if (list) list.push(item);
			else this.deltas.set(e.messageId, [item]);
			this.schedule();
			return;
		}
		if (e.type === "tool_update") {
			this.toolPreviews.set(e.toolCallId, e.preview);
			this.schedule();
			return;
		}
		this.flush();
		switch (e.type) {
			case "message_removed": {
				// The server withdrew a user message it showed ahead of OMP's echo (prompt failed/aborted before dispatch).
				const key = this.idIndex.get(e.messageId);
				const rec = key ? this.recs.get(key) : undefined;
				if (key && rec) {
					this.recs.delete(key);
					this.idIndex.delete(e.messageId);
					this.idIndex.delete(rec.msg.id);
					this.order = this.order.filter((k) => k !== key);
					this.emitOrder();
					fire(this.msgL.get(key));
				}
				break;
			}
			case "agent_start":
				this.setMeta({ agentRunning: true });
				this.pushLog({ kind: "agent", level: "info", text: "Agent started" });
				break;
			case "agent_end":
				this.setMeta({ agentRunning: false, aborting: false });
				for (const t of [...this.tools.values()]) if (t.status === "running") this.setTool({ ...t, status: "interrupted", endedAt: Date.now() });
				this.pushLog({ kind: "agent", level: "info", text: "Agent finished" });
				this.refreshProjectFiles();
				this.invalidateSoon();
				break;
			case "message_start":
				this.onMessage(e.message, true);
				break;
			case "message_end":
				this.onMessage(e.message, false);
				break;
			case "tool_start": {
				const prev = this.tools.get(e.toolCallId);
				this.setTool({ id: e.toolCallId, name: e.toolName, args: e.args, intent: e.intent ?? prev?.intent, status: "running", startedAt: this.now() });
				this.pushLog({ kind: "tool", level: "info", text: e.toolName, detail: e.intent, toolCallId: e.toolCallId });
				break;
			}
			case "tool_end": {
				const prev = this.tools.get(e.toolCallId);
				this.toolPreviews.delete(e.toolCallId);
				this.setTool({
					id: e.toolCallId,
					name: prev?.name ?? "",
					args: prev?.args,
					intent: prev?.intent,
					status: e.isError ? "error" : "ok",
					result: e.result,
					details: e.toolDetails,
					startedAt: prev?.startedAt,
					endedAt: this.now(),
				});
				break;
			}
			case "turn_outputs":
				this.mergeOutputs([e.outputs]);
				break;
			case "prompt_result":
				this.setMeta({ aborting: false });
				this.pushLog({
					kind: "prompt",
					level: e.status === "error" ? "error" : e.status === "aborted" ? "warning" : "success",
					text: `Prompt ${e.status}`,
					detail: e.error,
				});
				if (e.status === "error" && e.error) toast.error(e.error);
				break;
			case "settled":
				this.pushLog({ kind: "agent", level: "info", text: "Session settled" });
				this.invalidateSoon();
				break;
			case "notice":
				this.pushLog({ kind: "notice", level: e.level === "error" ? "error" : e.level === "warning" ? "warning" : "info", text: e.message });
				if (e.level === "error") toast.error(e.message);
				else if (e.level === "warning") toast.warning(e.message);
				break;
			case "ui_request":
				if (!this.meta.uiRequests.some((r) => r.requestId === e.requestId)) {
					const rec: UiRequestRec = { requestId: e.requestId, method: e.method, title: e.title, message: e.message, options: e.options, receivedAt: this.now() };
					this.setMeta({ uiRequests: [...this.meta.uiRequests, rec] });
					this.pushLog({ kind: "approval", level: "warning", text: `Approval requested: ${e.title}`, detail: e.message });
				}
				break;
			case "ui_request_resolved":
				if (this.meta.uiRequests.some((r) => r.requestId === e.requestId)) {
					this.setMeta({ uiRequests: this.meta.uiRequests.filter((r) => r.requestId !== e.requestId) });
					this.pushLog({ kind: "approval", level: "info", text: "Approval resolved" });
				}
				break;
			default:
				break;
		}
	}

	private onMessage(msg: UiMessage, start: boolean): void {
		if (msg.role === "toolResult") {
			if (!start) this.ingestToolResult(msg);
			return;
		}
		if (!listable(msg)) return;
		const key = this.resolveKey(msg);
		const isNew = !this.recs.has(key);
		const streaming = start && msg.role === "assistant";
		// A late duplicate start must not downgrade an already-finished message.
		const prev = this.recs.get(key);
		if (start && prev && !prev.streaming && msg.role === "assistant") return;
		this.put(key, msg, { streaming });
		if (isNew) this.append(key);
		if (!start && msg.role === "assistant" && (msg.errorMessage || msg.stopReason === "error")) {
			this.pushLog({ kind: "notice", level: "error", text: "Assistant error", detail: msg.errorMessage ?? msg.stopReason });
		}
	}

	private schedule(): void {
		if (this.raf) return;
		this.raf = requestAnimationFrame(() => {
			this.raf = 0;
			this.flush();
		});
	}

	private flush(): void {
		if (this.raf) {
			cancelAnimationFrame(this.raf);
			this.raf = 0;
		}
		if (this.deltas.size) {
			const batch = this.deltas;
			this.deltas = new Map();
			for (const [id, items] of batch) this.applyDeltas(id, items);
		}
		if (this.toolPreviews.size) {
			const batch = this.toolPreviews;
			this.toolPreviews = new Map();
			for (const [id, preview] of batch) {
				const t = this.tools.get(id);
				if (t && t.status === "running") this.setTool({ ...t, preview });
			}
		}
	}

	private applyDeltas(messageId: string, items: DeltaItem[]): void {
		const key = this.idIndex.get(messageId) ?? messageId;
		const prev = this.recs.get(key);
		const base: UiMessage = prev?.msg ?? { id: messageId, role: "assistant", timestamp: Date.now(), content: [] };
		const content = base.content.slice();
		for (const d of items) {
			const idx = Math.max(0, d.contentIndex);
			const want = d.kind === "toolCall" ? "toolCall" : d.kind;
			while (content.length <= idx) {
				content.push(want === "toolCall" ? { type: "toolCall", id: `pending:${messageId}:${content.length}`, name: "", arguments: "" } : { type: want, text: "" });
			}
			const b = content[idx];
			if (!b) continue;
			if (b.type === "toolCall" && want === "toolCall") {
				// Raw partial-JSON args: never rendered. The card fills in from message_end / tool_start.
				continue;
			} else if ((b.type === "text" || b.type === "thinking") && b.type === want) {
				content[idx] = { ...b, text: b.text + d.delta };
			} else if (want !== "toolCall") {
				// Kind mismatch (e.g. text delta into a thinking slot): start a new block rather than corrupt the old one.
				content.push({ type: want, text: d.delta });
			}
		}
		const isNew = !prev;
		this.put(key, { ...base, content }, { streaming: true });
		if (isNew) this.append(key);
	}

	// ── log

	private pushLog(e: Omit<LogEntry, "id" | "at">): void {
		const entry: LogEntry = { ...e, id: ++this.logSeq, at: this.now() };
		const next = this.log.length >= MAX_LOG ? [...this.log.slice(this.log.length - MAX_LOG + 1), entry] : [...this.log, entry];
		this.log = next;
		fire(this.logL);
	}
	clearLog = (): void => {
		this.log = [];
		fire(this.logL);
	};

	/** The agent may have written files during the turn: refresh the file tree and any open previews of this session's project. */
	private refreshProjectFiles(): void {
		const projectId = this.qc.getQueryData<AgentSession>(qk.session(this.sessionId))?.projectId;
		if (!projectId) return;
		void this.qc.invalidateQueries({ queryKey: ["local", "project", projectId], predicate: (q) => q.queryKey[3] === "files" || q.queryKey[3] === "file" });
	}

	private invalidateSoon(): void {
		if (this.invalidateTimer) return;
		this.invalidateTimer = setTimeout(() => {
			this.invalidateTimer = null;
			void this.qc.invalidateQueries({ queryKey: qk.session(this.sessionId), exact: true });
		}, 350);
	}

	// ── UI state

	selectTool = (id: string | null): void => {
		if (this.meta.selectedToolId !== id) this.setMeta({ selectedToolId: id });
	};

	// ── actions

	/** Optimistically renders the prompt; on failure rolls back and rethrows so the composer can restore the text. */
	sendPrompt = async (text: string, behavior: "steer" | "followUp"): Promise<void> => {
		const clientId = newClientId();
		const key = `u:${clientId}`;
		const msg: UiMessage = { id: `optimistic:${clientId}`, role: "user", timestamp: Date.now(), content: [{ type: "text", text }], clientId };
		this.put(key, msg, { optimistic: true, sent: false });
		this.append(key);
		this.setMeta({ sendTick: this.meta.sendTick + 1 });
		try {
			await api.post(routes.sessionPrompt(this.sessionId), {
				message: text,
				streamingBehavior: isBusy(this.meta) ? behavior : undefined,
				clientId,
			});
		} catch (e) {
			const cur = this.recs.get(key);
			if (cur?.optimistic) {
				this.recs.delete(key);
				this.idIndex.delete(msg.id);
				this.order = this.order.filter((k) => k !== key);
				this.emitOrder();
				fire(this.msgL.get(key));
			}
			throw e;
		}
		const cur = this.recs.get(key);
		if (cur?.optimistic) this.put(key, cur.msg, { optimistic: true, sent: true });
	};

	abort = async (): Promise<void> => {
		this.setMeta({ aborting: true });
		clearTimeout(this.abortTimer ?? undefined);
		this.abortTimer = setTimeout(() => this.setMeta({ aborting: false }), 10_000);
		try {
			await api.post(routes.sessionAbort(this.sessionId));
		} catch (e) {
			this.setMeta({ aborting: false });
			throw e;
		}
	};

	setModel = async (selector: string, info?: { provider: string; id: string; name?: string }): Promise<void> => {
		const prev = this.meta.live;
		if (!prev) throw new Error("Runtime state is not available yet");
		const slash = selector.indexOf("/");
		const optimistic = info ?? { provider: slash > 0 ? selector.slice(0, slash) : "", id: slash > 0 ? selector.slice(slash + 1) : selector };
		this.setMeta({ live: { ...prev, model: optimistic } });
		try {
			const next = await api.post<SessionLiveState>(routes.sessionModel(this.sessionId), { selector });
			this.liveFromEvent = true;
			this.applyState(next);
			this.invalidateSoon();
		} catch (e) {
			const cur = this.meta.live;
			if (cur) this.setMeta({ live: { ...cur, model: prev.model } });
			throw e;
		}
	};

	setThinking = async (level: string): Promise<void> => {
		const prev = this.meta.live;
		if (!prev) throw new Error("Runtime state is not available yet");
		this.setMeta({ live: { ...prev, thinkingLevel: level, thinkingSelector: null } });
		try {
			const next = await api.post<SessionLiveState>(routes.sessionThinking(this.sessionId), { level });
			this.liveFromEvent = true;
			this.applyState(next);
			this.invalidateSoon();
		} catch (e) {
			const cur = this.meta.live;
			if (cur) this.setMeta({ live: { ...cur, thinkingLevel: prev.thinkingLevel, thinkingSelector: prev.thinkingSelector } });
			throw e;
		}
	};

	restartRuntime = async (): Promise<RuntimeStatus> => {
		const status = await api.post<RuntimeStatus>(routes.runtimeRestart(this.sessionId));
		this.liveFromEvent = false;
		void this.qc.invalidateQueries({ queryKey: qk.runtime });
		void this.fetchState();
		return status;
	};
}

// ───────────────────────────── React bindings ─────────────────────────────

export const StreamContext = createContext<SessionStream | null>(null);

export function useStream(): SessionStream {
	const s = useContext(StreamContext);
	if (!s) throw new Error("useStream must be used inside a session workspace");
	return s;
}

/** Subscribe to a derived slice of meta. The selector must return referentially stable values. */
export function useStreamMeta<T>(stream: SessionStream, selector: (m: StreamMeta) => T): T {
	return useSyncExternalStore(
		stream.subscribeMeta,
		() => selector(stream.getMeta()),
		() => selector(initialMeta),
	);
}

export function useMsgRec(stream: SessionStream, key: string): MsgRec | undefined {
	const sub = useCallback((cb: () => void) => stream.subscribeRec(key, cb), [stream, key]);
	return useSyncExternalStore(sub, () => stream.getRec(key));
}

/** Role only: lets a row shell pick its renderer without re-rendering on every delta. */
export function useMsgRole(stream: SessionStream, key: string): UiMessage["role"] | undefined {
	const sub = useCallback((cb: () => void) => stream.subscribeRec(key, cb), [stream, key]);
	return useSyncExternalStore(sub, () => stream.getRec(key)?.msg.role);
}

export function useToolRec(stream: SessionStream, id: string | null | undefined): ToolRec | undefined {
	const sub = useCallback((cb: () => void) => (id ? stream.subscribeTool(id, cb) : () => undefined), [stream, id]);
	return useSyncExternalStore(sub, () => (id ? stream.getTool(id) : undefined));
}

export function useOrder(stream: SessionStream): readonly string[] {
	return useSyncExternalStore(stream.subscribeOrder, stream.getOrder);
}

export function useRowOutputs(stream: SessionStream, key: string): readonly TurnOutputs[] | undefined {
	const sub = useCallback((cb: () => void) => stream.subscribeRowOutputs(key, cb), [stream, key]);
	return useSyncExternalStore(sub, () => stream.getRowOutputs(key));
}

/** Derived primitive of one message record (e.g. a divider label). The selector must return a stable value. */
export function useMsgSlice<T>(stream: SessionStream, key: string, select: (rec: MsgRec | undefined) => T): T {
	const sub = useCallback((cb: () => void) => stream.subscribeRec(key, cb), [stream, key]);
	return useSyncExternalStore(sub, () => select(stream.getRec(key)));
}

export function useLog(stream: SessionStream): readonly LogEntry[] {
	return useSyncExternalStore(stream.subscribeLog, stream.getLog);
}
