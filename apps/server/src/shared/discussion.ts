import { NetworkError, wire as wireSchemas } from "@clam/agent-network";
import type { wire } from "@clam/agent-network";
import type { SessionEvent, SharedMessage } from "@clam/contracts";
import { agents, agentSessions } from "@clam/database";
import {
	buildSharedMessageInjection,
	formatParticipant,
	buildSinceLastTurnBlock,
	formatHlc,
	isAddressed,
	mergeHlc,
	parseHlc,
	pickFallbackAgent,
	resolveRecipients,
	tickHlc,
	wakesAgents,
	type GroupMessageKind,
	type Hlc,
	type MentionCandidate,
	type MessageKind,
	type MessageTo,
} from "@clam/task-engine";
import { eq } from "drizzle-orm";
import { ApiError } from "../http/errors.ts";
import { KeyedLock, errorText } from "../network/util.ts";
import { injectIntoSession } from "../tasks/session-injection.ts";
import type { DiscussionApi, PostInput, SharedHub } from "./hub.ts";
import { newSharedMessageId, type SharedMessageRow, type SharedRow } from "./store.ts";

/** Prompts of the machinery itself (briefing, continuation, driver-change note): the turn that answers them is not something the group should read. */
const SILENT_PROMPTS = ["shared_brief_", "shared_continue_", "shared_driver_"] as const;
/** The wire's body limit. A longer final text is cut and says so. */
const REPLY_MAX_CHARS = 20_000;
const SYNC_PAGE = 100;
/** A pull never loops more than this many pages (a runaway peer cannot keep the node busy). */
const SYNC_MAX_PAGES = 50;

/** How an injected message is delivered while the agent is busy: only an instruction interrupts (steer), everything else queues. */
const DELIVERY_KIND: Record<GroupMessageKind, MessageKind> = { chat: "note", reply: "note", system: "note", instruction: "instruction", question: "question", answer: "answer", note: "note" };

/** The local agent session of a shared session on this node, and when it was created (older messages are not its business). */
interface Target {
	sessionId: string;
	role: "driver" | "participant";
	createdAt: string;
}

/** What one turn of a member session produced, collected from its runtime events until `settled`. */
interface Run {
	completedPrompts: string[];
	finalText: string | null;
}

/** What a stored message means for the local agent: `wake` = addressed to it, `buffer` = for the group (shown on its next addressed turn), the rest is not its business. */
type Disposition = "skip" | "own" | "history" | "wake" | "buffer";

/**
 * The group chat of a shared session (docs/shared-sessions.md §4.3): a LEADERLESS log, the same on every member node.
 *
 * Any member node that is online accepts a message (a human at its UI, its agent through `mesh_say`, the auto-posted reply
 * of its agent, a system note), stamps it (hybrid logical clock, per-origin sequence number), stores it and queues it through
 * the outbox for every other active member; receivers store it idempotently by message id. A member that was away pulls
 * what it lacks from any reachable peer by a per-origin cursor (`POST /shared/:id/messages/sync`). Order everywhere:
 * `(hlc, origin node, id)`. Epoch fencing never applies here.
 *
 * Each node then decides for ITS agent (the driving session on the lead node, the participant agent session elsewhere):
 * a message addressed to it is injected as a prompt together with everything the group said that was not for it since its
 * last addressed turn ("Since your last turn in the group"); the rest waits in that buffer. The final text of each turn of
 * such an agent is posted to the group automatically (`reply`); only an @mention in it wakes another agent, and those wakes
 * count against the loop budget (`SharedRow.agentMessageLimit`) until a human writes.
 */
export class DiscussionService implements DiscussionApi {
	private readonly chains = new KeyedLock();
	private readonly retries = new Map<string, NodeJS.Timeout>();
	private readonly failures = new Map<string, number>();
	private readonly runs = new Map<string, Run>();
	private readonly syncing = new Map<string, Promise<void>>();
	private readonly disposers: Array<() => void> = [];
	private timer: NodeJS.Timeout | undefined;
	/** The newest clock stamp this node issued or saw: loaded from the log on first use, so a restart (or a wall clock that went back) never stamps below it. */
	private hlcLast: Hlc | null | undefined;
	private stopped = true;

	constructor(private readonly hub: SharedHub) {}

	private get store() {
		return this.hub.store;
	}

	private get ctx() {
		return this.hub.ctx;
	}

	private get self(): string {
		return this.ctx.identity.nodeId;
	}

	start(): void {
		this.stopped = false;
		this.disposers.push(
			this.ctx.runtime.onEvent((sessionId, event) => this.onRuntimeEvent(sessionId, event)),
			this.ctx.network.peers.onChange((change) => {
				if (change.type === "online" || change.type === "url_changed") void this.syncPeer(change.peerId);
			}),
		);
		this.timer = setInterval(() => {
			for (const peer of this.ctx.network.peers.activeRows()) if (peer.status === "online" || peer.status === "degraded") void this.syncPeer(peer.id);
		}, this.hub.options.reconcileMs);
		this.timer.unref();
		void this.retryPending();
		// The cached peer status may be stale after a restart: ask everybody instead of waiting for a transition.
		for (const peer of this.ctx.network.peers.activeRows()) void this.syncPeer(peer.id);
	}

	stop(): void {
		this.stopped = true;
		for (const dispose of this.disposers.splice(0)) dispose();
		clearInterval(this.timer);
		this.timer = undefined;
		for (const timer of this.retries.values()) clearTimeout(timer);
		this.retries.clear();
	}

	markRead(sharedId: string): void {
		this.store.get(sharedId);
		if (this.store.markRead(sharedId) > 0) this.hub.changed(sharedId);
	}

	// ------------------------------------------------------------------ the clock

	private lastHlc(): Hlc | null {
		if (this.hlcLast === undefined) {
			const stored = this.store.maxHlc();
			this.hlcLast = stored ? parseHlc(stored) : null;
		}
		return this.hlcLast;
	}

	/** The stamp of a message this node accepts now. Stamp and insert happen without an await in between, so stamps are inserted in the order they are issued. */
	private stamp(): string {
		this.hlcLast = tickHlc(this.lastHlc(), Date.now());
		return formatHlc(this.hlcLast);
	}

	private observe(stamp: string): void {
		const remote = parseHlc(stamp);
		if (remote) this.hlcLast = mergeHlc(this.lastHlc(), remote, Date.now());
	}

	// ------------------------------------------------------------------ authoring

	/** The members that can be addressed: active nodes that have an agent. */
	private candidates(sharedId: string): MentionCandidate[] {
		return this.store
			.participants(sharedId)
			.filter((p) => p.state === "active")
			.map((p) => this.hub.views.participant(p))
			.map((p) => ({ nodeId: p.nodeId, nodeName: p.nodeName, agentId: p.agentId, agentName: p.agentName }));
	}

	async post(sharedId: string, input: PostInput): Promise<SharedMessage> {
		const shared = this.store.get(sharedId);
		if (shared.state !== "active") throw new ApiError(409, "not_a_participant", "This node left the shared session");
		if (input.kind === "system" || (input.author.kind === "human" && input.kind === "reply")) throw ApiError.badRequest(`a ${input.author.kind} cannot post a message of kind ${input.kind}`);
		if (input.kind === "instruction" && input.author.kind === "agent" && shared.localRole !== "driver") {
			throw ApiError.badRequest("only the lead's agent may send an instruction; use question, answer or note");
		}
		const candidates = this.candidates(sharedId);
		if (input.to) {
			const unknown = input.to.agents.find((a) => !candidates.some((c) => c.nodeId === a.nodeId && c.agentId === a.agentId));
			if (unknown) throw ApiError.badRequest(`${unknown.agentId}@${unknown.nodeId} is not an active agent of this shared session`);
		}
		let to = resolveRecipients({ author: input.author.kind, authorNodeId: this.self, text: input.text, candidates, explicit: input.to });
		// A human's message without a mention (and without an explicit `to`) goes to the lead; while the lead cannot take it, it goes to an agent that can (never made lead). An explicit choice is kept.
		const lost = input.author.kind === "human" && !input.to && to.mode === "lead" ? this.leadLost(shared) : null;
		const fallback = lost
			? pickFallbackAgent(candidates, { postedOnNodeId: this.self, leadNodeId: shared.driverNodeId, hasLocalAgent: shared.localRole !== "driver" && this.targetOf(shared) !== null, isReachable: (nodeId) => this.isReachable(nodeId) })
			: null;
		if (fallback) to = { mode: "agents", agents: [{ nodeId: fallback.nodeId, agentId: fallback.agentId }] };
		if (input.author.kind === "agent" && wakesAgents(to)) {
			const budget = this.store.budget(sharedId, shared.agentMessageLimit);
			if (budget.remaining <= 0) {
				throw new ApiError(
					429,
					"agent_message_limit",
					`Agent message limit reached for this shared session (${budget.limit} messages from this node's agents that wake another agent, without a human message in between). A human must continue in the group chat.`,
					budget,
				);
			}
		}
		const row = this.append(shared, { authorKind: input.author.kind, agent: input.author.kind === "agent" ? { id: input.author.agentId, name: input.author.agentName } : undefined, kind: input.kind, text: input.text, to });
		if (lost) {
			const reason = lost.offline ? "is offline" : "cannot run its agent right now";
			this.note(sharedId, fallback ? `${lost.nodeName} (lead) ${reason} — sent to ${formatParticipant(fallback)}` : `${lost.nodeName} (lead) ${reason} and no other agent is reachable — the message waits in the group`);
		}
		void this.route(sharedId);
		return this.hub.views.message(row);
	}

	/** Whether the lead cannot take a message now: its node is offline (as seen from here), or it is this node and its agent session is gone or crashed. Null while it can. */
	private leadLost(shared: SharedRow): { nodeName: string; offline: boolean } | null {
		if (shared.localRole === "driver") {
			const target = this.targetOf(shared);
			const state = target ? this.ctx.runtime.get(target.sessionId)?.status().state : undefined;
			return !target || state === "crashed" ? { nodeName: this.hub.nodeName(), offline: false } : null;
		}
		return this.isReachable(shared.driverNodeId) ? null : { nodeName: shared.driverNodeName, offline: true };
	}

	/** The cached peer status: `degraded` is still a node that answers some of the time (it turns `offline` after the monitor's grace). */
	private isReachable(nodeId: string): boolean {
		const status = this.ctx.network.peers.row(nodeId)?.status;
		return status === "online" || status === "degraded";
	}

	/** The lead's node when it is offline (a woken participant agent is told it must not edit the shared branch then). */
	private offlineLead(shared: SharedRow): { nodeName: string } | null {
		const lost = this.leadLost(shared);
		return lost?.offline ? { nodeName: lost.nodeName } : null;
	}

	/**
	 * A `system` message: member joined/left, hand-over progress, takeover, checkpoint. Replicated to every member node unless
	 * `local`: use that for something EVERY node observes on its own (a leave notice, a driver change it learns of), where
	 * each node posting a replicated line would only multiply it. Nothing is injected into an agent session for it.
	 */
	note(sharedId: string, text: string, options: { local?: boolean } = {}): void {
		const shared = this.store.find(sharedId);
		if (!shared) return;
		this.append(shared, { authorKind: "system", kind: "system", text: text.slice(0, 2000), to: { mode: "agents", agents: [] }, replicate: options.local !== true && shared.state === "active" });
	}

	/** Accept a message on this node: stamp, store, fan out to every other active member, publish. */
	private append(shared: SharedRow, input: { authorKind: "human" | "agent" | "system"; agent?: { id: string | null; name: string | null } | undefined; kind: GroupMessageKind; text: string; to: MessageTo; replicate?: boolean }): SharedMessageRow {
		const replicate = input.replicate ?? true;
		const recipients = replicate ? this.store.activePeers(shared.id) : [];
		const system = input.authorKind === "system";
		const now = new Date().toISOString();
		const row = this.store.appendMessage(
			{
				id: newSharedMessageId(),
				sharedSessionId: shared.id,
				authorKind: input.authorKind,
				authorNodeName: this.hub.nodeName(),
				authorAgentId: input.agent?.id ?? null,
				authorAgentName: input.agent?.name ?? null,
				kind: input.kind,
				to: input.to,
				text: input.text,
				epoch: shared.epoch,
				createdAt: now,
				hlc: this.stamp(),
				delivery: !replicate ? "local" : recipients.length > 0 ? "pending" : "delivered",
				injectedSessionId: system ? "system" : null,
				readAt: system ? now : null,
			},
			{ replicate },
		);
		for (const recipient of recipients) this.enqueue(row, recipient.nodeId);
		this.hub.changed(shared.id, { messages: [row] });
		return row;
	}

	private toWire(message: SharedMessageRow & { originSeq: number }): wire.SharedMessageRequest {
		return {
			messageId: message.id,
			epoch: message.epoch,
			kind: message.kind as wire.SharedMessageKind,
			body: message.text,
			author: { kind: message.authorKind as "human" | "agent" | "system", agentId: message.authorAgentId, agentName: message.authorAgentName },
			to: message.to,
			origin: { nodeId: message.authorNodeId, nodeName: message.authorNodeName, seq: message.originSeq },
			hlc: message.hlc,
			createdAt: message.createdAt,
		};
	}

	/** Send an existing message to one node (also used to hand the history to a participant that just joined). Local-only notes are not sent. */
	enqueue(message: SharedMessageRow, peerId: string): void {
		if (message.originSeq === null) return;
		const body = this.toWire({ ...message, originSeq: message.originSeq });
		this.hub.enqueue({ peerId, sharedSessionId: message.sharedSessionId, kind: "shared.message", refId: message.id, path: `/shared/${message.sharedSessionId}/messages`, body });
	}

	// ------------------------------------------------------------------ receiving

	async receive(peerId: string, sharedId: string, request: wire.SharedMessageRequest): Promise<{ messageId: string; accepted: true }> {
		const shared = this.store.find(sharedId);
		if (!shared || shared.state !== "active") throw ApiError.notFound("Shared session");
		const sender = this.store.participant(sharedId, peerId);
		if (!sender || sender.state !== "active") throw new ApiError(403, "forbidden", "Only participants of the shared session may post to its group chat");
		if (request.origin.nodeId !== peerId) throw new ApiError(403, "forbidden", "A node pushes its own messages only; messages of other nodes are fetched with messages/sync");
		this.ingest(shared, request);
		return { messageId: request.messageId, accepted: true };
	}

	/**
	 * Store a message another node accepted (pushed by its origin or relayed by a pull); idempotent by id. A same-id message
	 * with a different origin or sequence is a protocol violation (`409 idempotency_conflict`). Returns whether it was new.
	 */
	private ingest(shared: SharedRow, request: wire.SharedMessageRequest): boolean {
		if ((request.kind === "system") !== (request.author.kind === "system")) throw ApiError.badRequest("a system message is authored by the system, and nothing else is");
		if (request.origin.nodeId === this.self) {
			if (this.store.message(request.messageId)) return false;
			throw new ApiError(403, "forbidden", "A message that claims this node as its origin and that this node never accepted");
		}
		const existing = this.store.message(request.messageId);
		if (existing) {
			if (existing.sharedSessionId !== shared.id || existing.authorNodeId !== request.origin.nodeId || existing.originSeq !== request.origin.seq) {
				throw new ApiError(409, "idempotency_conflict", "That message id is already used by another message");
			}
			return false;
		}
		const { row, inserted } = this.store.insertReceived({
			id: request.messageId,
			sharedSessionId: shared.id,
			authorKind: request.author.kind,
			authorNodeId: request.origin.nodeId,
			authorNodeName: request.origin.nodeName,
			authorAgentId: request.author.agentId ?? null,
			authorAgentName: request.author.agentName ?? null,
			kind: request.kind,
			to: request.to,
			text: request.body,
			epoch: request.epoch,
			createdAt: request.createdAt,
			hlc: request.hlc,
			originSeq: request.origin.seq,
			delivery: "local",
			injectedSessionId: request.kind === "system" ? "system" : null,
		});
		if (!inserted) return false;
		this.observe(request.hlc);
		this.hub.changed(shared.id, { messages: [row] });
		void this.route(shared.id);
		return true;
	}

	// ------------------------------------------------------------------ catch-up

	serveSync(peerId: string, sharedId: string, request: wire.SharedMessagesSyncRequest): wire.SharedMessagesSyncResponse {
		const shared = this.store.find(sharedId);
		if (!shared || shared.state !== "active") throw ApiError.notFound("Shared session");
		const sender = this.store.participant(sharedId, peerId);
		if (!sender || sender.state !== "active") throw new ApiError(403, "forbidden", "Only participants of the shared session may read its group chat");
		const rows = this.store.messagesAfter(sharedId, request.cursor, request.limit);
		const page = rows.slice(0, request.limit);
		const cursor: Record<string, number> = { ...request.cursor };
		const messages = page.flatMap((row) => {
			if (row.originSeq === null) return [];
			cursor[row.authorNodeId] = Math.max(cursor[row.authorNodeId] ?? 0, row.originSeq);
			return [this.toWire({ ...row, originSeq: row.originSeq })];
		});
		return { messages, cursor, hasMore: rows.length > request.limit };
	}

	syncPeer(peerId: string): Promise<void> {
		const running = this.syncing.get(peerId);
		if (running) return running;
		const job = this.runSync(peerId).finally(() => this.syncing.delete(peerId));
		this.syncing.set(peerId, job);
		return job;
	}

	/** Pull from `peerId`, for each shared session we have in common, everything after what this node holds. Never throws. */
	private async runSync(peerId: string): Promise<void> {
		if (this.stopped) return;
		try {
			for (const shared of this.store.sessionsWithPeer(peerId)) {
				const peer = this.ctx.network.peers.row(peerId);
				if (!peer || peer.status === "revoked") return;
				let cursor = this.store.cursor(shared.id);
				for (let page = 0; page < SYNC_MAX_PAGES && !this.stopped; page++) {
					let response: wire.SharedMessagesSyncResponse;
					try {
						const body: wire.SharedMessagesSyncRequest = { cursor, limit: SYNC_PAGE };
						const reply = await this.ctx.network.client.request<unknown>(peer.url, { method: "POST", path: `/shared/${shared.id}/messages/sync`, body, retry: false, signal: AbortSignal.timeout(15_000) });
						const parsed = wireSchemas.SharedMessagesSyncResponse.safeParse(reply.body);
						if (!parsed.success) {
							this.hub.log.warn({ sharedId: shared.id, peerId }, "a peer answered the group chat catch-up with something that is not a page of messages");
							break;
						}
						response = parsed.data;
					} catch (error) {
						if (!(error instanceof NetworkError) || (error.status ?? 0) >= 500 || error.status === null) return; // unreachable: the next online event or tick retries
						break; // 403/404: the peer does not (or no longer) share it with us
					}
					const current = this.store.find(shared.id);
					if (!current || current.state !== "active") break;
					for (const message of response.messages) this.ingestRelayed(current, message);
					if (!response.hasMore) break;
					cursor = response.cursor;
				}
			}
		} catch (error) {
			this.hub.log.warn({ err: errorText(error), peerId }, "catching up the group chat with a peer failed");
		}
	}

	/** A message of a pull: its origin must be a member of the shared session (any state: a node that left keeps its history). */
	private ingestRelayed(shared: SharedRow, message: wire.SharedMessageRequest): void {
		if (!this.store.participant(shared.id, message.origin.nodeId)) {
			this.hub.log.warn({ sharedId: shared.id, origin: message.origin.nodeId, messageId: message.messageId }, "ignored a relayed group message from an origin that is not a member");
			return;
		}
		try {
			this.ingest(shared, message);
		} catch (error) {
			this.hub.log.warn({ err: errorText(error), sharedId: shared.id, messageId: message.messageId }, "ignored an invalid relayed group message");
		}
	}

	// ------------------------------------------------------------------ waking the local agent

	/** The local agent session of a shared session on this node, if any: the driving session on the lead node, the participant agent session elsewhere (never a mirror). */
	private targetOf(shared: SharedRow): Target | null {
		if (shared.state !== "active") return null;
		const role = shared.localRole === "driver" ? "driver" : "participant";
		const sessionId = role === "driver" ? shared.localSessionId : (this.store.participant(shared.id, this.self)?.agentSessionId ?? null);
		if (!sessionId) return null;
		const row = this.ctx.db.select({ archived: agentSessions.archived, kind: agentSessions.kind, movedTo: agentSessions.movedTo, createdAt: agentSessions.createdAt }).from(agentSessions).where(eq(agentSessions.id, sessionId)).get();
		return row && !row.archived && row.kind === "local" && !row.movedTo ? { sessionId, role, createdAt: row.createdAt } : null;
	}

	private classify(shared: SharedRow, target: Target, message: SharedMessageRow): Disposition {
		if (message.authorKind === "system") return "skip";
		if (message.authorKind === "agent" && message.authorNodeId === this.self) return "own";
		// What was said before this node joined, and what reached this node before the session existed (a new lead session after a takeover), is history, not news.
		const joined = this.store.participant(shared.id, this.self)?.joinedAt;
		if ((joined && message.createdAt < joined) || message.receivedAt < target.createdAt) return "history";
		return isAddressed(message.to, { nodeId: this.self, isLead: shared.localRole === "driver" }) ? "wake" : "buffer";
	}

	/** Look at what the local agent has not been handed yet and wake it if something is addressed to it. Never throws. */
	private async route(sharedId: string): Promise<void> {
		try {
			const shared = this.store.find(sharedId);
			const target = shared ? this.targetOf(shared) : null;
			if (target) await this.chains.run(target.sessionId, () => this.flush(sharedId, target.sessionId));
		} catch (error) {
			this.hub.log.warn({ err: errorText(error), sharedId }, "routing group messages to the local agent failed");
		}
	}

	/**
	 * One prompt: the newest message addressed to the agent, preceded by everything older that it has not seen (the buffer:
	 * what the group said that was not for it). Messages newer than that stay buffered for the next addressed turn.
	 * Everything handed over is marked in the log, so a restart neither loses nor repeats a message.
	 */
	private async flush(sharedId: string, sessionId: string): Promise<void> {
		const shared = this.store.find(sharedId);
		const target = shared ? this.targetOf(shared) : null;
		if (!shared || !target || target.sessionId !== sessionId) return;
		const history: string[] = [];
		const own: string[] = [];
		const pending: Array<{ row: SharedMessageRow; wake: boolean }> = [];
		for (const row of this.store.uninjectedMessages(sharedId)) {
			const disposition = this.classify(shared, target, row);
			if (disposition === "history") history.push(row.id);
			else if (disposition === "own") own.push(row.id);
			else if (disposition === "wake" || disposition === "buffer") pending.push({ row, wake: disposition === "wake" });
		}
		this.store.markInjected(history, "history");
		this.store.markInjected(own, "self");
		const last = pending.findLastIndex((p) => p.wake);
		if (last < 0) return;
		const trigger = (pending[last] as (typeof pending)[number]).row;
		const buffered = pending.slice(0, last).map((p) => p.row);
		try {
			this.ctx.sessions.get(sessionId);
			const text = buildSharedMessageInjection({
				sharedSessionId: sharedId,
				title: shared.title,
				author: { kind: trigger.authorKind as "human" | "agent" | "system", agentName: trigger.authorAgentName, nodeName: trigger.authorNodeName },
				kind: trigger.kind as GroupMessageKind,
				text: trigger.text,
				role: target.role,
				leadOffline: target.role === "participant" ? this.offlineLead(shared) : null,
				sinceLastTurn: buildSinceLastTurnBlock(
					buffered.map((row) => ({ author: { kind: row.authorKind as "human" | "agent" | "system", agentName: row.authorAgentName, nodeName: row.authorNodeName }, kind: row.kind as GroupMessageKind, text: row.text })),
				),
			});
			await injectIntoSession(this.ctx, { sessionId, clientId: `shared_msg_${trigger.id}`, text, kind: DELIVERY_KIND[trigger.kind as GroupMessageKind] });
		} catch (error) {
			this.hub.log.warn({ err: errorText(error), sharedId, messageId: trigger.id, sessionId }, "could not inject a group message into the session");
			this.scheduleRetry(sharedId);
			return;
		}
		this.failures.delete(sharedId);
		const handed = [...buffered.map((row) => row.id), trigger.id];
		this.store.markInjected(handed, sessionId);
		this.hub.changed(sharedId, { messages: handed.flatMap((id) => this.store.message(id) ?? []) });
	}

	private scheduleRetry(sharedId: string): void {
		const failed = (this.failures.get(sharedId) ?? 0) + 1;
		this.failures.set(sharedId, failed);
		const { injectRetries, injectRetryMs } = this.ctx.tasks.timings;
		if (this.stopped || failed > injectRetries || this.retries.has(sharedId)) return;
		const timer = setTimeout(() => {
			this.retries.delete(sharedId);
			void this.route(sharedId);
		}, injectRetryMs);
		timer.unref();
		this.retries.set(sharedId, timer);
	}

	async retryPending(): Promise<void> {
		this.failures.clear();
		for (const shared of this.store.active()) await this.route(shared.id);
	}

	// ------------------------------------------------------------------ replies: the final text of every turn

	private onRuntimeEvent(sessionId: string, event: SessionEvent): void {
		if (event.type === "prompt_result") {
			if (event.status === "completed") this.run(sessionId).completedPrompts.push(event.clientId);
		} else if (event.type === "message_end") {
			if (event.message.role !== "assistant") return;
			const aborted = event.message.stopReason === "aborted" || event.message.stopReason === "error";
			const text = event.message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n").trim();
			this.run(sessionId).finalText = aborted || text === "" ? null : text;
		} else if (event.type === "settled") {
			const run = this.runs.get(sessionId);
			this.runs.delete(sessionId);
			const finalText = run?.finalText;
			if (!finalText || !run.completedPrompts.some((clientId) => !SILENT_PROMPTS.some((prefix) => clientId.startsWith(prefix)))) return;
			// Not inside the runtime's own event dispatch: posting does database work and publishes, and must not delay the runtime's settle handling.
			setImmediate(() => void this.postReply(sessionId, finalText));
		}
	}

	private run(sessionId: string): Run {
		let run = this.runs.get(sessionId);
		if (!run) this.runs.set(sessionId, (run = { completedPrompts: [], finalText: null }));
		return run;
	}

	/** The shared session this session is the local agent session of (its driving session on the lead node, the participant agent session elsewhere). */
	private memberOf(sessionId: string): SharedRow | undefined {
		for (const shared of [this.store.bySession(sessionId), this.store.byAgentSession(sessionId)]) {
			if (shared && this.targetOf(shared)?.sessionId === sessionId) return shared;
		}
		return undefined;
	}

	/** Post the final text of a turn to the group as this agent's reply. Never throws. */
	private async postReply(sessionId: string, text: string): Promise<void> {
		try {
			const shared = this.memberOf(sessionId);
			if (!shared) return;
			const agent = this.ctx.db
				.select({ id: agents.id, name: agents.name })
				.from(agentSessions)
				.innerJoin(agents, eq(agents.id, agentSessions.agentId))
				.where(eq(agentSessions.id, sessionId))
				.get();
			let to = resolveRecipients({ author: "agent", authorNodeId: this.self, text, candidates: this.candidates(shared.id) });
			const budget = this.store.budget(shared.id, shared.agentMessageLimit);
			const limited = wakesAgents(to) && budget.remaining <= 0;
			// A reply cannot be refused (it is the turn's answer): over the loop budget it is posted, but wakes nobody.
			if (limited) to = { mode: "agents", agents: [] };
			const body = text.length > REPLY_MAX_CHARS ? `${text.slice(0, REPLY_MAX_CHARS - 80)}\n\n… (reply cut at ${REPLY_MAX_CHARS - 80} characters; the rest is in ${this.hub.nodeName()}'s session)` : text;
			this.append(shared, { authorKind: "agent", agent: agent ?? { id: null, name: null }, kind: "reply", text: body, to });
			if (limited) {
				this.note(shared.id, `${agent?.name ?? "An agent"}@${this.hub.nodeName()} mentioned another agent, but this node's agents already posted ${budget.limit} messages that wake an agent without a human message in between: nobody was woken. A human must continue in the group chat.`);
			}
		} catch (error) {
			this.hub.log.warn({ err: errorText(error), sessionId }, "could not post the reply of a turn to the group chat");
		}
	}
}
