import type { AskAnswer, CancelSubagentResult, PendingUiRequest, SessionEvent, Subagent, SubagentsPage, UiRequestAnswerer, UiRequestOutcome } from "@clam/contracts";
import { routes } from "@clam/contracts";
import { createContext, useContext, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { t } from "@/i18n";
import { api, ApiError } from "@/lib/api";
import { ws } from "@/lib/ws";
import { preloadMarkdown } from "@/components/lazy-markdown";

/** Who answered, as a phrase: "by you" on the machine that is looking, otherwise "from <machine>". */
export const answererLabel = (by: UiRequestAnswerer, selfNodeId: string | undefined): string => (by.nodeId === selfNodeId ? t("by you") : t("from {machine}", { machine: by.machine }));

/** Option previews are markdown/code: fetch its renderer as the question arrives, so the card never shows them unformatted. */
function warmPreviews(requests: readonly PendingUiRequest[]): void {
	if (requests.some((r) => r.questions?.some((q) => q.options.some((o) => o.preview)))) preloadMarkdown();
}

/** A subagent as last reported, plus the local time it was received (elapsed timers run from there, immune to clock skew). */
export interface SubagentRec extends Subagent {
	recvAt: number;
}

/** An unanswered question/approval and when this browser first saw it (a countdown never starts before that). */
export interface PendingRequest extends PendingUiRequest {
	receivedAt: number;
}

/** How a request ended, kept for a while so its cards can say what happened (answered, defaults used on timeout, cancelled). */
export interface ResolvedRequest {
	request: PendingRequest;
	outcome: UiRequestOutcome;
	answers?: AskAnswer[];
	/** Shared sessions: the person (and machine) whose answer the agent got. */
	answeredBy?: UiRequestAnswerer | undefined;
	at: number;
}

export interface OmpState {
	/** Spawn order. */
	subagents: readonly SubagentRec[];
	/** The subagent list is from a running process (false: the last saved snapshot). */
	live: boolean;
	/** The first subagent fetch finished. */
	loaded: boolean;
	requests: readonly PendingRequest[];
	resolved: ReadonlyMap<string, ResolvedRequest>;
	/** Subagent whose transcript is open. */
	viewing: string | null;
	/** Bumps when the user asks to answer a pending question (the dock expands and scrolls into view). */
	focusTick: number;
}

const INITIAL: OmpState = { subagents: [], live: false, loaded: false, requests: [], resolved: new Map(), viewing: null, focusTick: 0 };
const MAX_RESOLVED = 24;

type Listener = () => void;

/** Subagent order is stable: spawn time, then index, then id. */
function sortSubagents(list: SubagentRec[]): SubagentRec[] {
	return list.sort((a, b) => a.startedAt - b.startedAt || a.index - b.index || a.id.localeCompare(b.id));
}

/**
 * Everything OMP-specific about one session that is not a message: subagents, the questions/approvals the agent is waiting
 * on (and how earlier ones ended). It listens on the session topic by itself, next to `SessionStream`, and re-fetches after a
 * reconnect, so neither depends on the other. Subagent progress is applied once per animation frame.
 */
export class OmpStore {
	private state: OmpState = INITIAL;
	private listeners = new Set<Listener>();
	private pendingUpserts = new Map<string, Subagent>();
	private removed = new Set<string>();
	private raf = 0;
	private ac: AbortController | null = null;
	private off: (() => void) | null = null;
	/** Subscribers of one subagent's updates (transcript views refetch on them). */
	private subL = new Map<string, Set<Listener>>();
	private subVersion = new Map<string, number>();

	constructor(readonly sessionId: string) {}

	// ── subscription

	getState = (): OmpState => this.state;
	subscribe = (cb: Listener): (() => void) => {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	};

	private set(patch: Partial<OmpState>): void {
		this.state = { ...this.state, ...patch };
		for (const l of [...this.listeners]) l();
	}

	/** A counter that changes whenever the subagent changes; for `useSyncExternalStore` in transcript views. */
	subagentVersion = (id: string): number => this.subVersion.get(id) ?? 0;
	subscribeSubagent = (id: string, cb: Listener): (() => void) => {
		let set = this.subL.get(id);
		if (!set) {
			set = new Set();
			this.subL.set(id, set);
		}
		set.add(cb);
		return () => {
			set.delete(cb);
			if (set.size === 0 && this.subL.get(id) === set) this.subL.delete(id);
		};
	};

	// ── lifecycle

	attach = (): (() => void) => {
		this.ac = new AbortController();
		const offSession = ws.subscribe(
			`session:${this.sessionId}`,
			(e) => this.onEvent(e as SessionEvent),
			() => void this.refetch(true),
		);
		// Whether the roster comes from a running process follows the runtime's own status.
		const offRuntime = ws.subscribe("runtime", (e) => {
			if (e.type !== "status" || e.status.sessionId !== this.sessionId) return;
			const live = e.status.state === "ready" || e.status.state === "busy";
			if (live !== this.state.live) this.set({ live });
		});
		this.off = () => {
			offSession();
			offRuntime();
		};
		void this.refetch(false);
		return () => this.detach();
	};

	private detach(): void {
		this.off?.();
		this.off = null;
		this.ac?.abort();
		this.ac = null;
		if (this.raf) cancelAnimationFrame(this.raf);
		this.raf = 0;
	}

	/** Initial load, and after a reconnect: the server's lists are authoritative (events missed meanwhile are in them). */
	private async refetch(replace: boolean): Promise<void> {
		const signal = this.ac?.signal;
		const [subs, reqs] = await Promise.allSettled([
			api.get<SubagentsPage>(routes.sessionSubagents(this.sessionId), undefined, { signal }),
			api.get<PendingUiRequest[]>(routes.sessionUiRequests(this.sessionId), undefined, { signal }),
		]);
		if (signal?.aborted) return;
		if (subs.status === "fulfilled") this.applySubagentPage(subs.value, replace);
		else this.set({ loaded: true });
		if (reqs.status === "fulfilled" && Array.isArray(reqs.value)) {
			const known = new Map(this.state.requests.map((r) => [r.requestId, r]));
			const fetched = reqs.value.map((r) => known.get(r.requestId) ?? { ...r, receivedAt: Date.now() });
			// Initial load: keep what live events already delivered. Resync: only what the server still has pending.
			const extra = replace ? [] : this.state.requests.filter((r) => !reqs.value.some((x) => x.requestId === r.requestId));
			this.set({ requests: [...fetched, ...extra] });
			warmPreviews(fetched);
		}
	}

	private applySubagentPage(page: SubagentsPage, replace: boolean): void {
		const now = Date.now();
		const byId = new Map(replace ? [] : this.state.subagents.map((s) => [s.id, s]));
		for (const s of page.subagents) {
			const prev = byId.get(s.id);
			// An event that arrived while the fetch was in flight can be newer than the page.
			if (prev && prev.updatedAt > s.updatedAt) continue;
			byId.set(s.id, { ...s, recvAt: now });
			this.bump(s.id);
		}
		if (replace) for (const id of this.state.subagents.map((s) => s.id)) if (!byId.has(id)) this.bump(id);
		this.set({ subagents: sortSubagents([...byId.values()]), live: page.live, loaded: true });
	}

	// ── events

	private onEvent(e: SessionEvent): void {
		switch (e.type) {
			case "subagent_upsert":
				this.pendingUpserts.set(e.subagent.id, e.subagent);
				this.removed.delete(e.subagent.id);
				this.schedule();
				break;
			case "subagent_remove":
				this.pendingUpserts.delete(e.subagentId);
				this.removed.add(e.subagentId);
				this.schedule();
				break;
			case "ui_request":
				if (!this.state.requests.some((r) => r.requestId === e.requestId)) {
					const { type: _type, ...request } = e;
					this.set({ requests: [...this.state.requests, { ...request, receivedAt: Date.now() }] });
					warmPreviews([request]);
				}
				break;
			case "ui_request_resolved": {
				const request = this.state.requests.find((r) => r.requestId === e.requestId);
				if (!request) {
					// The driver's machine announces who answered right after the runtime's own event: complete the record.
					const known = this.state.resolved.get(e.requestId);
					if (known && e.answeredBy && !known.answeredBy) this.set({ resolved: new Map(this.state.resolved).set(e.requestId, { ...known, answeredBy: e.answeredBy }) });
					break;
				}
				const resolved = new Map(this.state.resolved);
				resolved.set(e.requestId, { request, outcome: e.outcome ?? "answered", answers: e.answers, answeredBy: e.answeredBy, at: Date.now() });
				while (resolved.size > MAX_RESOLVED) resolved.delete(resolved.keys().next().value as string);
				this.set({ requests: this.state.requests.filter((r) => r.requestId !== e.requestId), resolved });
				break;
			}
			case "agent_end":
				// A turn that ended cannot be waiting for anything.
				break;
			default:
				break;
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
		if (this.pendingUpserts.size === 0 && this.removed.size === 0) return;
		const now = Date.now();
		const byId = new Map(this.state.subagents.map((s) => [s.id, s]));
		for (const [id, s] of this.pendingUpserts) {
			byId.set(id, { ...s, recvAt: now });
			this.bump(id);
		}
		for (const id of this.removed) {
			byId.delete(id);
			this.bump(id);
		}
		this.pendingUpserts.clear();
		this.removed.clear();
		this.set({ subagents: sortSubagents([...byId.values()]) });
	}

	private bump(id: string): void {
		this.subVersion.set(id, (this.subVersion.get(id) ?? 0) + 1);
		const set = this.subL.get(id);
		if (set) for (const l of [...set]) l();
	}

	// ── actions

	/** Answer an `ask`. The server validates the shape; a rejection is thrown for the card to show. Somebody being first is not an error: the card closes as answered by them. */
	answerAsk = async (requestId: string, answers: AskAnswer[]): Promise<void> => {
		try {
			await api.post(routes.sessionUiResponse(this.sessionId), { requestId, answers });
		} catch (e) {
			if (this.settledElsewhere(requestId, e)) return;
			throw e;
		}
		this.dropLocally(requestId, "answered", answers);
	};

	/** Answer a select/confirm/input/editor request; `null` cancels it. */
	respond = async (requestId: string, value: boolean | string | null): Promise<void> => {
		try {
			await api.post(routes.sessionUiResponse(this.sessionId), { requestId, value });
		} catch (e) {
			if (this.settledElsewhere(requestId, e)) return;
			throw e;
		}
		this.dropLocally(requestId, value === null ? "cancelled" : "answered");
	};

	/**
	 * A member machine of a shared session (or another browser) got there first, or the agent stopped waiting (its driver
	 * changed, it moved on): the request is closed with what happened. `already_answered` names who answered.
	 */
	private settledElsewhere(requestId: string, e: unknown): boolean {
		if (!(e instanceof ApiError)) return false;
		if (e.code === "already_answered") {
			const details = (e.details ?? {}) as { outcome?: UiRequestOutcome; answeredBy?: UiRequestAnswerer | null };
			this.dropLocally(requestId, details.outcome ?? "answered", undefined, details.answeredBy ?? undefined);
			toast.info(details.answeredBy ? t("{machine} answered first — your answer was not sent.", { machine: details.answeredBy.machine }) : t("This was already answered — your answer was not sent."));
			return true;
		}
		if (e.code === "request_closed" || e.code === "stale_epoch" || e.code === "runtime_invalid_state") {
			this.dropLocally(requestId, "abandoned");
			toast.info(t("The agent is not waiting for this answer any more."));
			return true;
		}
		return false;
	}

	/** The server's `ui_request_resolved` follows; closing at once keeps the card from flashing back to its buttons. */
	private dropLocally(requestId: string, outcome: UiRequestOutcome, answers?: AskAnswer[], answeredBy?: UiRequestAnswerer): void {
		const request = this.state.requests.find((r) => r.requestId === requestId);
		if (!request) return;
		const resolved = new Map(this.state.resolved);
		resolved.set(requestId, { request, outcome, answers, answeredBy, at: Date.now() });
		this.set({ requests: this.state.requests.filter((r) => r.requestId !== requestId), resolved });
	}

	focusQuestion = (): void => this.set({ focusTick: this.state.focusTick + 1 });

	private panelOpener: (() => void) | null = null;
	/** The session page registers how to reveal the Subagents tab of its side panel. */
	setPanelOpener = (open: (() => void) | null): void => {
		this.panelOpener = open;
	};
	openPanel = (): void => this.panelOpener?.();

	openSubagent = (id: string | null): void => this.set({ viewing: id });

	cancelSubagent = (id: string): Promise<CancelSubagentResult> => api.post<CancelSubagentResult>(routes.sessionSubagentCancel(this.sessionId, id), {});

	steerSubagent = (id: string, message: string): Promise<void> => api.post(routes.sessionSubagentSteer(this.sessionId, id), { message });
}

// ───────────────────────────── React bindings ─────────────────────────────

export const OmpContext = createContext<OmpStore | null>(null);

export function useOmpStore(): OmpStore {
	const store = useContext(OmpContext);
	if (!store) throw new Error("OmpContext is missing");
	return store;
}

/** Optional variant for components that also render outside a session (they simply show nothing OMP-specific). */
export function useOptionalOmpStore(): OmpStore | null {
	return useContext(OmpContext);
}

export function useOmpState(store: OmpStore): OmpState {
	return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

const EMPTY_STATE_STORE = { subscribe: () => () => {}, getState: () => INITIAL };

/** Same as `useOmpState` but safe without a store (returns the empty state). */
export function useOmpStateOptional(store: OmpStore | null): OmpState {
	const source = store ?? EMPTY_STATE_STORE;
	return useSyncExternalStore(source.subscribe, source.getState, source.getState);
}

/** Re-renders when one subagent changes; the returned number is only a change marker. */
export function useSubagentVersion(store: OmpStore, id: string): number {
	return useSyncExternalStore(
		(cb) => store.subscribeSubagent(id, cb),
		() => store.subagentVersion(id),
		() => 0,
	);
}
