import type { wire } from "@clam/agent-network";
import { NetworkError } from "@clam/agent-network";
import { i18nMsg, SessionLiveState as SessionLiveStateSchema, UiMessage as UiMessageSchema, type AgentSession, type MessagesPage, type PendingUiRequest, type SessionEvent, type SessionLiveState, type UiMessage } from "@clam/contracts";
import { agentSessions } from "@clam/database";
import { eq } from "drizzle-orm";
import { ApiError } from "../http/errors.ts";
import { KeyedLock, errorText } from "../network/util.ts";
import type { SessionViews, UiResponseInput } from "../services/session-service.ts";
import type { MirrorApi, SharedHub } from "./hub.ts";
import { newStreamId, pageOf, type SharedRow } from "./store.ts";
import { TranscriptReducer } from "./transcript.ts";

/** Events the mirror forwards: the live view of a conversation. A question or approval travels inside the forwarded `state` (`requests`, see `RequestService`), which is how an old node that does not know it still accepts every batch. */
const FORWARDED: ReadonlySet<string> = new Set(["state", "agent_start", "agent_end", "message_start", "message_delta", "message_end", "message_removed", "tool_start", "tool_update", "tool_end", "prompt_result", "settled", "notice"]);
/** A sync chunk stays well under the listener's 1 MiB body limit. */
const CHUNK_BYTES = 512 * 1024;
const TRANSCRIPT_PAGE = 256;

type Event = { type: string } & Record<string, unknown>;

interface PeerLink {
	peerId: string;
	/** The peer must be (re)synchronised with the whole transcript before it can follow batches again. */
	needsSync: boolean;
	/** Its snapshot is on its way: batches numbered after that snapshot are kept for it (see `flush`). */
	syncing: boolean;
	pending: wire.SharedMirrorRequest[];
	pumping: boolean;
	retry: NodeJS.Timeout | null;
}

/** Driver side of one shared session: the driving session's events, its transcript and one link per participant. */
class Publisher {
	readonly streamId = newStreamId();
	seq = 0;
	loaded = false;
	loading: Promise<void> | null = null;
	/** While the transcript is being read: every event the runtime emits meanwhile, to be laid over the read (`ensureLoaded`). Null when no read is running. */
	loadEvents: Event[] | null = null;
	readonly reducer = new TranscriptReducer();
	state: SessionLiveState | null = null;
	buffer: Event[] = [];
	timer: NodeJS.Timeout | null = null;
	readonly links = new Map<string, PeerLink>();

	constructor(
		readonly sharedId: string,
		readonly sessionId: string,
		readonly epoch: number,
	) {}
}

function emptyState(sessionId: string): SessionLiveState {
	return {
		sessionId,
		runtime: { sessionId, state: "stopped", pid: null, startedAt: null, restarts: 0, lastError: null, lastActivityAt: null },
		model: null,
		thinkingLevel: null,
		availableThinkingLevels: [],
		isStreaming: false,
		isSettled: true,
		contextUsage: null,
		queued: { steering: [], followUp: [] },
		todoPhases: [],
		tokensPerSecond: null,
	};
}

/** Merge what a batch does not need to say twice: consecutive deltas of one block, and every `state` but the last. */
function coalesce(events: readonly Event[]): Event[] {
	const out: Event[] = [];
	let lastState = -1;
	for (const event of events) {
		const previous = out.at(-1);
		if (event.type === "message_delta" && previous?.type === "message_delta" && previous.messageId === event.messageId && previous.contentIndex === event.contentIndex && previous.kind === event.kind) {
			out[out.length - 1] = { ...previous, delta: `${String(previous.delta)}${String(event.delta)}` };
			continue;
		}
		if (event.type === "state") {
			if (lastState >= 0) out[lastState] = event;
			else {
				lastState = out.length;
				out.push(event);
			}
			continue;
		}
		out.push(event);
	}
	return out;
}

/**
 * The live copy of the driving session on participant nodes.
 *
 * DRIVER: `Publisher` rebuilds the transcript from the driving session's runtime events (`TranscriptReducer`), batches
 * events at most every `mirrorFlushMs` and posts them in order to every reachable participant (`POST /shared/:id/mirror`,
 * numbered by `seq` within one publisher run `streamId`). A participant that is behind (new, offline, a batch failed or was
 * refused) is brought up to date by replaying the whole transcript in size-bounded `sync` chunks, then follows batches again.
 *
 * PARTICIPANT: `receive` applies batches once and in order (a duplicate is acknowledged, a gap answers `409 mirror_resync`),
 * persists the transcript per mirror session (it survives the driver going offline) and republishes the events on the
 * mirror's `session:<id>` topic so every viewer sees the conversation live.
 *
 * Also the `SessionViews` of the session service: mirrors and moved copies are read from the stored transcripts.
 */
export class MirrorService implements MirrorApi, SessionViews {
	private readonly publishers = new Map<string, Publisher>();
	private readonly bySession = new Map<string, Publisher>();
	private readonly receiveLock = new KeyedLock();
	/** Participant side: transcripts and sync progress by mirror session. */
	private readonly reducers = new Map<string, TranscriptReducer>();
	private readonly syncing = new Map<string, { streamId: string; nextIndex: number }>();
	private unsubscribe: Array<() => void> = [];
	private stopped = true;

	constructor(private readonly hub: SharedHub) {}

	private get ctx() {
		return this.hub.ctx;
	}

	private get store() {
		return this.hub.store;
	}

	// ------------------------------------------------------------------ lifecycle

	start(): void {
		this.stopped = false;
		this.unsubscribe.push(
			this.ctx.runtime.onEvent((sessionId, event) => this.onRuntimeEvent(sessionId, event)),
			this.ctx.network.peers.onChange((change) => {
				if (change.type === "online" || change.type === "url_changed") for (const publisher of this.publishers.values()) this.syncLink(publisher, change.peerId);
			}),
		);
		for (const row of this.store.active()) if (row.localRole === "driver") this.publish(row.id);
	}

	async stop(): Promise<void> {
		this.stopped = true;
		for (const stop of this.unsubscribe.splice(0)) stop();
		for (const sharedId of [...this.publishers.keys()]) this.unpublish(sharedId);
		await this.receiveLock.run("stop", async () => undefined);
	}

	// ------------------------------------------------------------------ driver: publishing

	publish(sharedId: string): void {
		if (this.stopped) return;
		const row = this.store.find(sharedId);
		const sessionId = row?.localSessionId;
		if (!row || row.state !== "active" || row.localRole !== "driver" || !sessionId) return;
		let publisher = this.publishers.get(sharedId);
		if (publisher && (publisher.sessionId !== sessionId || publisher.epoch !== row.epoch)) {
			this.unpublish(sharedId);
			publisher = undefined;
		}
		if (!publisher) {
			publisher = new Publisher(sharedId, sessionId, row.epoch);
			this.publishers.set(sharedId, publisher);
			this.bySession.set(sessionId, publisher);
		}
		for (const participant of this.store.activePeers(sharedId)) this.syncLink(publisher, participant.nodeId);
	}

	unpublish(sharedId: string): void {
		const publisher = this.publishers.get(sharedId);
		if (!publisher) return;
		clearTimeout(publisher.timer ?? undefined);
		for (const link of publisher.links.values()) clearTimeout(link.retry ?? undefined);
		this.publishers.delete(sharedId);
		if (this.bySession.get(publisher.sessionId) === publisher) this.bySession.delete(publisher.sessionId);
	}

	syncPeer(sharedId: string, peerId: string): void {
		const publisher = this.publishers.get(sharedId);
		if (publisher) this.syncLink(publisher, peerId);
	}

	/** Mark the link as needing the whole transcript and start pumping. */
	private syncLink(publisher: Publisher, peerId: string): void {
		const participant = this.store.participant(publisher.sharedId, peerId);
		if (!participant || participant.state !== "active" || peerId === this.ctx.identity.nodeId) return;
		let link = publisher.links.get(peerId);
		if (!link) {
			link = { peerId, needsSync: true, syncing: false, pending: [], pumping: false, retry: null };
			publisher.links.set(peerId, link);
		}
		link.needsSync = true;
		clearTimeout(link.retry ?? undefined);
		link.retry = null;
		void this.pump(publisher, link);
	}

	private onRuntimeEvent(sessionId: string, event: SessionEvent): void {
		const publisher = this.bySession.get(sessionId);
		if (!publisher || !FORWARDED.has(event.type)) return;
		if (!publisher.loaded) {
			// What happened before the read began is part of the read; what happens while it runs is kept and laid over it.
			publisher.loadEvents?.push(event as Event);
			if (this.store.activePeers(publisher.sharedId).length > 0) void this.ensureLoaded(publisher);
			return;
		}
		const forwarded = (event.type === "state" ? { ...event, state: this.withRequests(publisher, event.state) } : event) as Event;
		publisher.reducer.apply(forwarded);
		if (event.type === "state") publisher.state = forwarded.state as SessionLiveState;
		this.buffer(publisher, forwarded);
		// The last state the runtime published may still say "streaming" (it is refreshed on a timer, not on the settle): ask again, so participants never keep seeing a busy driver.
		if (event.type === "settled") void this.ctx.runtime.get(sessionId)?.getState().catch(() => undefined);
	}

	private buffer(publisher: Publisher, event: Event): void {
		publisher.buffer.push(event);
		if (!publisher.timer) {
			publisher.timer = setTimeout(() => this.flush(publisher), this.hub.options.mirrorFlushMs);
			publisher.timer.unref();
		}
	}

	/** The driver's state as participants get it: with the questions/approvals its agent waits for and how the latest ones ended. */
	private withRequests(publisher: Publisher, state: SessionLiveState): SessionLiveState {
		return { ...state, requests: this.hub.requests.snapshot(publisher.sessionId) };
	}

	requestsChanged(sessionId: string): void {
		const publisher = this.bySession.get(sessionId);
		// Before the first participant needs it nothing is buffered: the snapshot taken when a link syncs has the current requests.
		if (!publisher?.loaded) return;
		const state = this.withRequests(publisher, publisher.state ?? emptyState(sessionId));
		publisher.state = state;
		this.buffer(publisher, { type: "state", state });
	}

	/**
	 * Read the driving session's transcript (and state) once. The runtime keeps working while that is read, so the events that
	 * arrive meanwhile are laid over the read (`TranscriptReducer.overlay`): a message the read did not see appears from its own
	 * events, one it saw half-written is completed by them. Nothing awaits between that and `loaded`, so no event falls in a gap.
	 */
	private ensureLoaded(publisher: Publisher): Promise<void> {
		if (publisher.loaded) return Promise.resolve();
		publisher.loading ??= (async () => {
			const during: Event[] = [];
			publisher.loadEvents = during;
			try {
				const transcript = await this.readTranscript(publisher.sessionId);
				const read = await this.ctx.sessions.state(publisher.sessionId).catch(() => null);
				publisher.reducer.replace(transcript);
				publisher.reducer.overlay(during);
				const state = read ?? (during.findLast((event) => event.type === "state")?.state as SessionLiveState | undefined) ?? null;
				publisher.state = state ? this.withRequests(publisher, state) : null;
				publisher.loaded = true;
			} catch (error) {
				this.hub.log.warn({ err: errorText(error), sharedId: publisher.sharedId }, "could not read the driving session's transcript for the mirror");
			} finally {
				publisher.loadEvents = null;
				publisher.loading = null;
			}
		})();
		return publisher.loading;
	}

	private async readTranscript(sessionId: string): Promise<UiMessage[]> {
		const pages: UiMessage[][] = [];
		let cursor: string | undefined;
		do {
			const page: MessagesPage = await this.ctx.sessions.messages(sessionId, { limit: TRANSCRIPT_PAGE, ...(cursor ? { cursor } : {}) });
			pages.unshift(page.messages);
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		return pages.flat();
	}

	/** Send what accumulated as one numbered batch to every link that follows the stream. */
	private flush(publisher: Publisher): void {
		clearTimeout(publisher.timer ?? undefined);
		publisher.timer = null;
		if (publisher.buffer.length === 0) return;
		const events = coalesce(publisher.buffer);
		publisher.buffer = [];
		publisher.seq++;
		const batch: wire.SharedMirrorRequest = { type: "events", epoch: publisher.epoch, streamId: publisher.streamId, seq: publisher.seq, events: events as wire.SharedMirrorEvent[] };
		for (const link of publisher.links.values()) {
			// A link that still waits for its snapshot gets everything from that snapshot on (the snapshot includes these events); one whose snapshot is on its way gets the batches numbered after it as soon as the snapshot has arrived.
			if (link.needsSync && !link.syncing) continue;
			link.pending.push(batch);
			void this.pump(publisher, link);
		}
	}

	private scheduleRetry(publisher: Publisher, link: PeerLink): void {
		if (this.stopped || link.retry) return;
		link.retry = setTimeout(() => {
			link.retry = null;
			void this.pump(publisher, link);
		}, this.hub.options.retryMs);
		link.retry.unref();
	}

	private async pump(publisher: Publisher, link: PeerLink): Promise<void> {
		if (link.pumping || this.stopped || this.publishers.get(publisher.sharedId) !== publisher) return;
		link.pumping = true;
		try {
			while (!this.stopped && this.publishers.get(publisher.sharedId) === publisher) {
				const participant = this.store.participant(publisher.sharedId, link.peerId);
				if (!participant || participant.state !== "active") return;
				const peer = this.ctx.network.peers.row(link.peerId);
				if (!peer || (peer.status !== "online" && peer.status !== "degraded")) {
					// `peers.onChange(online)` starts the sync as soon as it is back.
					link.needsSync = true;
					link.pending = [];
					return;
				}
				if (link.needsSync) {
					await this.ensureLoaded(publisher);
					if (!publisher.loaded) return void this.scheduleRetry(publisher, link);
					// Everything buffered so far is in the snapshot: number it first, then forget what this link had queued.
					this.flush(publisher);
					link.pending = [];
					const snapshot = { seq: publisher.seq, messages: publisher.reducer.messages(), state: publisher.state ? this.withRequests(publisher, publisher.state) : null };
					link.syncing = true;
					const outcome = await this.sendSync(publisher, peer.url, snapshot).finally(() => {
						link.syncing = false;
					});
					if (outcome !== "ok") {
						if (outcome === "failed") this.scheduleRetry(publisher, link);
						return;
					}
					link.needsSync = false;
					continue;
				}
				const batch = link.pending[0];
				if (!batch) return;
				const outcome = await this.post(peer.url, publisher.sharedId, batch);
				if (outcome === "ok") {
					link.pending.shift();
					continue;
				}
				link.needsSync = true;
				link.pending = [];
				if (outcome === "stale") return;
				if (outcome === "failed") return void this.scheduleRetry(publisher, link);
			}
		} finally {
			link.pumping = false;
		}
	}

	private async sendSync(publisher: Publisher, url: string, snapshot: { seq: number; messages: UiMessage[]; state: SessionLiveState | null }): Promise<"ok" | "stale" | "failed"> {
		const chunks: UiMessage[][] = [[]];
		let size = 0;
		for (const message of snapshot.messages) {
			const bytes = JSON.stringify(message).length;
			if (size > 0 && size + bytes > CHUNK_BYTES) {
				chunks.push([]);
				size = 0;
			}
			(chunks.at(-1) as UiMessage[]).push(message);
			size += bytes;
		}
		for (const [index, messages] of chunks.entries()) {
			const final = index === chunks.length - 1;
			const body: wire.SharedMirrorRequest = { type: "sync", epoch: publisher.epoch, streamId: publisher.streamId, seq: snapshot.seq, index, final, messages, ...(final && snapshot.state ? { state: snapshot.state } : {}) };
			const outcome = await this.post(url, publisher.sharedId, body);
			if (outcome === "ok") continue;
			return outcome === "stale" ? "stale" : "failed";
		}
		return "ok";
	}

	/** One request; `resync` = the participant wants the whole transcript, `stale` = a newer driver exists. */
	private async post(url: string, sharedId: string, body: wire.SharedMirrorRequest): Promise<"ok" | "resync" | "stale" | "failed"> {
		try {
			await this.ctx.network.client.request(url, { method: "POST", path: `/shared/${sharedId}/mirror`, body, retry: false });
			return "ok";
		} catch (error) {
			if (error instanceof NetworkError) {
				if (error.code === "mirror_resync") return "resync";
				if (error.code === "stale_epoch") {
					const peerId = [...this.publishers.get(sharedId)?.links.keys() ?? []].find((id) => this.ctx.network.peers.row(id)?.url === url);
					if (peerId) void this.hub.epochs.reconcilePeer(peerId);
					return "stale";
				}
				if (error.code === "epoch_unknown") return "failed";
			}
			this.hub.log.debug({ err: errorText(error), sharedId }, "mirror delivery failed");
			return "failed";
		}
	}

	// ------------------------------------------------------------------ participant: receiving

	receive(peerId: string, sharedId: string, request: wire.SharedMirrorRequest): wire.SharedMirrorAccepted {
		const shared = this.store.find(sharedId);
		if (!shared || shared.state !== "active") throw ApiError.notFound("Shared session");
		if (request.epoch < shared.epoch) throw new ApiError(409, "stale_epoch", i18nMsg("The mirror carries epoch {epoch}; the shared session is at epoch {current}", { epoch: request.epoch, current: shared.epoch }), { currentEpoch: shared.epoch, driverNodeId: shared.driverNodeId });
		if (request.epoch > shared.epoch) {
			void this.hub.epochs.reconcilePeer(peerId);
			throw new ApiError(409, "epoch_unknown", i18nMsg("The mirror carries epoch {epoch}; this node is still at epoch {current} and is asking who drives now", { epoch: request.epoch, current: shared.epoch }), { currentEpoch: shared.epoch });
		}
		if (shared.localRole === "driver") throw ApiError.conflict(i18nMsg("This node drives the shared session; it does not take a mirror from another driver"));
		if (peerId !== shared.driverNodeId) throw new ApiError(403, "forbidden", i18nMsg("Only the driver of the shared session may send its mirror"));
		const mirrorId = shared.mirrorSessionId ?? this.hub.sharing.ensureMirror(shared);
		return this.applyReceived(shared, mirrorId, request);
	}

	private reducerOf(mirrorId: string): TranscriptReducer {
		let reducer = this.reducers.get(mirrorId);
		if (!reducer) {
			reducer = new TranscriptReducer(this.store.mirrorMessages(mirrorId));
			this.reducers.set(mirrorId, reducer);
		}
		return reducer;
	}

	private applyReceived(shared: SharedRow, mirrorId: string, request: wire.SharedMirrorRequest): wire.SharedMirrorAccepted {
		const stored = this.store.mirrorState(mirrorId);
		const resync = (lastSeq: number): ApiError => new ApiError(409, "mirror_resync", i18nMsg("The mirror is not at the position of this batch; replay the whole conversation"), { lastSeq });
		const reducer = this.reducerOf(mirrorId);

		if (request.type === "sync") {
			const progress = this.syncing.get(mirrorId);
			if (request.index === 0) {
				reducer.replace([]);
				this.store.clearMirrorMessages(mirrorId);
				this.syncing.set(mirrorId, { streamId: request.streamId, nextIndex: 0 });
				this.store.upsertMirrorState({ mirrorSessionId: mirrorId, sharedSessionId: shared.id, epoch: request.epoch, streamId: request.streamId, lastSeq: 0, syncing: true, state: stored?.state ?? null });
			} else if (!progress || progress.streamId !== request.streamId || progress.nextIndex !== request.index) {
				throw resync(stored?.lastSeq ?? 0);
			}
			const current = this.syncing.get(mirrorId) as { streamId: string; nextIndex: number };
			current.nextIndex = request.index + 1;
			const applied: UiMessage[] = [];
			for (const raw of request.messages) {
				const parsed = UiMessageSchema.safeParse(raw);
				if (!parsed.success) continue;
				reducer.apply({ type: "message_end", message: parsed.data });
				this.store.putMirrorMessage(mirrorId, parsed.data);
				applied.push(parsed.data);
			}
			for (const message of applied) this.ctx.bus.publish(`session:${mirrorId}`, { type: "message_end", message } satisfies SessionEvent);
			if (!request.final) return { applied: true, lastSeq: 0 };
			this.syncing.delete(mirrorId);
			const parsedState = request.state === undefined ? null : SessionLiveStateSchema.safeParse(request.state);
			const state = parsedState?.success ? this.rewriteState(parsedState.data, mirrorId) : (stored?.state ?? null);
			this.store.upsertMirrorState({ mirrorSessionId: mirrorId, sharedSessionId: shared.id, epoch: request.epoch, streamId: request.streamId, lastSeq: request.seq, syncing: false, state });
			for (const event of this.requestEvents(stored?.state ?? null, state)) this.ctx.bus.publish(`session:${mirrorId}`, event);
			if (state) this.ctx.bus.publish(`session:${mirrorId}`, { type: "state", state } satisfies SessionEvent);
			this.touch(mirrorId);
			return { applied: true, lastSeq: request.seq };
		}

		// events
		if (!stored || stored.syncing || stored.streamId !== request.streamId || stored.epoch !== request.epoch) throw resync(stored?.lastSeq ?? 0);
		if (request.seq <= stored.lastSeq) return { applied: false, lastSeq: stored.lastSeq };
		if (request.seq !== stored.lastSeq + 1) throw resync(stored.lastSeq);
		let state = stored.state;
		let settled = false;
		const toPublish: SessionEvent[] = [];
		for (const raw of request.events) {
			const event = raw as Event;
			if (event.type === "message_start" || event.type === "message_end") {
				const parsed = UiMessageSchema.safeParse(event.message);
				if (!parsed.success) continue;
				event.message = parsed.data;
			}
			if (event.type === "state") {
				const parsedState = SessionLiveStateSchema.safeParse(event.state);
				if (!parsedState.success) continue;
				state = this.rewriteState(parsedState.data, mirrorId);
				toPublish.push({ type: "state", state });
				continue;
			}
			const change = reducer.apply(event);
			for (const id of change.changed) {
				const message = reducer.get(id);
				if (message) this.store.putMirrorMessage(mirrorId, message);
			}
			for (const id of change.removed) this.store.removeMirrorMessage(mirrorId, id);
			if (event.type === "settled" || event.type === "message_end") settled = true;
			toPublish.push(event as unknown as SessionEvent);
		}
		this.store.upsertMirrorState({ mirrorSessionId: mirrorId, sharedSessionId: shared.id, epoch: request.epoch, streamId: request.streamId, lastSeq: request.seq, syncing: false, state });
		for (const event of this.requestEvents(stored.state, state)) this.ctx.bus.publish(`session:${mirrorId}`, event);
		for (const event of toPublish) this.ctx.bus.publish(`session:${mirrorId}`, event);
		if (settled || toPublish.some((e) => e.type === "state")) this.touch(mirrorId);
		return { applied: true, lastSeq: request.seq };
	}

	/** The driver's state as seen through the mirror: this node's session id, never `crashed`, busy as the driver is. */
	private rewriteState(state: SessionLiveState, mirrorId: string): SessionLiveState {
		const busy = state.isStreaming || !state.isSettled;
		return { ...state, sessionId: mirrorId, runtime: { sessionId: mirrorId, state: busy ? "busy" : "ready", pid: null, startedAt: null, restarts: 0, lastError: null, lastActivityAt: new Date().toISOString() } };
	}

	/** A request of the driver as the viewers of this mirror see it: `raisedAt` rebased from the driver's clock onto this node's (the countdown must not inherit the skew between the machines). */
	private rebase(request: PendingUiRequest, publishedAt: number): PendingUiRequest {
		return request.raisedAt === undefined ? request : { ...request, raisedAt: Date.now() - Math.max(0, publishedAt - request.raisedAt) };
	}

	/** `ui_request` / `ui_request_resolved` events of the viewers of a mirror: what its stored pending requests gained and lost between two states. */
	private requestEvents(before: SessionLiveState | null, after: SessionLiveState | null): SessionEvent[] {
		const was = before?.requests?.pending ?? [];
		const pending = after?.requests?.pending ?? [];
		const events: SessionEvent[] = [];
		for (const request of pending) {
			if (!was.some((r) => r.requestId === request.requestId)) events.push({ type: "ui_request", ...this.rebase(request, after?.requests?.at ?? Date.now()) });
		}
		for (const request of was) {
			if (pending.some((r) => r.requestId === request.requestId)) continue;
			const done = after?.requests?.resolved.find((r) => r.requestId === request.requestId);
			events.push({ type: "ui_request_resolved", requestId: request.requestId, outcome: done?.outcome ?? "abandoned", ...(done?.answers ? { answers: done.answers } : {}), ...(done?.answeredBy ? { answeredBy: done.answeredBy } : {}) });
		}
		return events;
	}

	withdrawRequests(mirrorSessionId: string): void {
		const stored = this.store.mirrorState(mirrorSessionId);
		const before = stored?.state;
		if (!stored || !before?.requests?.pending.length) return;
		const after: SessionLiveState = { ...before, awaiting: null, requests: { pending: [], resolved: before.requests.resolved, at: Date.now() } };
		this.store.upsertMirrorState({ mirrorSessionId, sharedSessionId: stored.sharedSessionId, epoch: stored.epoch, state: after });
		for (const event of this.requestEvents(before, after)) this.ctx.bus.publish(`session:${mirrorSessionId}`, event);
		this.ctx.bus.publish(`session:${mirrorSessionId}`, { type: "state", state: after } satisfies SessionEvent);
		this.touch(mirrorSessionId);
	}

	private touch(sessionId: string): void {
		this.ctx.db.update(agentSessions).set({ updatedAt: new Date().toISOString() }).where(eq(agentSessions.id, sessionId)).run();
		const row = this.ctx.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).get();
		if (row) this.ctx.bus.publish("sessions", { type: "upsert", session: this.ctx.sessions.toSession(row) });
	}

	// ------------------------------------------------------------------ moved copies

	async freeze(sessionId: string): Promise<void> {
		const row = this.ctx.sessions.get(sessionId);
		const shared = row.sharedSessionId ? this.store.find(row.sharedSessionId) : undefined;
		if (!shared) return;
		const runtime = await this.ctx.sessions.runtime(sessionId);
		const pages: UiMessage[][] = [];
		let cursor: string | undefined;
		do {
			const page = await runtime.messages({ limit: TRANSCRIPT_PAGE, ...(cursor ? { cursor } : {}) });
			pages.unshift(page.messages);
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		const state = await runtime.getState().catch(() => null);
		this.store.transaction(() => {
			this.store.clearMirrorMessages(sessionId);
			for (const message of pages.flat()) this.store.putMirrorMessage(sessionId, message);
			this.store.upsertMirrorState({ mirrorSessionId: sessionId, sharedSessionId: shared.id, epoch: shared.epoch, state });
		});
		this.reducers.delete(sessionId);
	}

	// ------------------------------------------------------------------ SessionViews

	private isMoved(sessionId: string): boolean {
		return this.ctx.db.select({ movedTo: agentSessions.movedTo }).from(agentSessions).where(eq(agentSessions.id, sessionId)).get()?.movedTo != null;
	}

	status(sessionId: string): AgentSession["status"] {
		if (this.isMoved(sessionId)) return "stopped";
		const state = this.store.mirrorState(sessionId)?.state;
		return state && (state.isStreaming || !state.isSettled) ? "running" : "idle";
	}

	messages(sessionId: string, query: { cursor?: string; limit?: number }): MessagesPage {
		return pageOf(this.store.mirrorMessages(sessionId), query);
	}

	state(sessionId: string): SessionLiveState {
		const moved = this.isMoved(sessionId);
		const stored = this.store.mirrorState(sessionId)?.state ?? emptyState(sessionId);
		if (moved) return { ...stored, sessionId, isStreaming: false, isSettled: true, queued: { steering: [], followUp: [] }, awaiting: null, runtime: { ...emptyState(sessionId).runtime } };
		return this.rewriteState(stored, sessionId);
	}

	pendingRequests(sessionId: string): PendingUiRequest[] {
		if (this.isMoved(sessionId)) return [];
		const requests = this.store.mirrorState(sessionId)?.state?.requests;
		return requests ? requests.pending.map((r) => this.rebase(r, requests.at)) : [];
	}

	respond(sessionId: string, input: UiResponseInput): Promise<void> {
		return this.hub.requests.answer(sessionId, input);
	}
}

export { newStreamId };
