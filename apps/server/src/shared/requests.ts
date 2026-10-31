import { NetworkError, type wire } from "@clam/agent-network";
import { AgentRuntimeError } from "@clam/agent-runtime";
import type { PendingUiRequest, SessionEvent, SessionLiveState, UiRequestAnswerer, UiRequestResolution } from "@clam/contracts";
import { ApiError } from "../http/errors.ts";
import { errorText } from "../network/util.ts";
import type { UiResponseInput } from "../services/session-service.ts";
import type { RequestApi, SharedHub } from "./hub.ts";

/** How many finished requests per driving session the driver keeps (and replicates): enough for a late reader to learn who answered. */
const RESOLVED_KEPT = 12;
const ANSWER_TIMEOUT_MS = 20_000;

type Requests = NonNullable<SessionLiveState["requests"]>;

const claimKey = (sessionId: string, requestId: string): string => `${sessionId}\n${requestId}`;

/** What a request is called in the group chat line. */
function kindOf(method: string | undefined): string {
	if (method === "ask") return "question";
	if (method === undefined) return "request";
	return "approval request";
}

/** The refusal for a request that is not pending: somebody answered first (say who), or it is long gone. */
function closedError(requestId: string, done: UiRequestResolution | undefined): ApiError {
	if (!done) return new ApiError(409, "request_closed", "The agent is no longer waiting for this answer", { requestId });
	const by = done.answeredBy ? ` by someone on ${done.answeredBy.machine}` : "";
	const message = done.outcome === "answered" ? `This was already answered${by}` : `This request is closed (${done.outcome.replace("_", " ")})`;
	return new ApiError(409, "already_answered", message, { requestId, outcome: done.outcome, answeredBy: done.answeredBy ?? null });
}

/**
 * Questions and approvals of a shared session, answered from any member machine (docs/shared-sessions.md "Answering from
 * another machine").
 *
 * DRIVER: the agent's runtime is the one that is waiting, so it stays the only judge. The pending requests and how the latest
 * ones ended are published to every participant inside the mirrored state (`MirrorService`); a participant's answer arrives as
 * `POST /shared/:id/answer` (`receiveAnswer`) and is handed to the very same `SessionService.respondToUi` a local answer takes,
 * so the validation is identical. The runtime applies the first answer synchronously, hence "first answer wins" needs no lock:
 * a second one finds the request resolved and is refused `409 already_answered` with who answered. Who answered is remembered
 * from the claim made just before the runtime is asked (a local answer has no claim: it is this machine's own person).
 *
 * PARTICIPANT: `answer` forwards a person's answer of a mirror session to the driver and surfaces its refusals unchanged.
 */
export class RequestService implements RequestApi {
	/** Driver: the person behind an answer that is being applied right now. */
	private readonly claims = new Map<string, UiRequestAnswerer>();
	/** Driver: finished requests by driving session id, newest last. */
	private readonly resolved = new Map<string, UiRequestResolution[]>();
	/** Driver: what the pending requests are (their `method`), to name them once they are gone. */
	private readonly methods = new Map<string, string>();
	private unsubscribe: (() => void) | null = null;

	constructor(private readonly hub: SharedHub) {}

	private get ctx() {
		return this.hub.ctx;
	}

	start(): void {
		this.unsubscribe ??= this.ctx.runtime.onEvent((sessionId, event) => this.onRuntimeEvent(sessionId, event));
	}

	stop(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	// ------------------------------------------------------------------ driver

	private drivingSession(sessionId: string) {
		const shared = this.hub.store.bySession(sessionId);
		return shared && shared.state === "active" && shared.localRole === "driver" && shared.localSessionId === sessionId ? shared : undefined;
	}

	private onRuntimeEvent(sessionId: string, event: SessionEvent): void {
		if (event.type !== "ui_request" && event.type !== "ui_request_resolved") return;
		const shared = this.drivingSession(sessionId);
		if (!shared) return;
		if (event.type === "ui_request") {
			this.methods.set(claimKey(sessionId, event.requestId), event.method);
			this.hub.mirror.requestsChanged(sessionId);
			return;
		}
		const key = claimKey(sessionId, event.requestId);
		const method = this.methods.get(key);
		this.methods.delete(key);
		const claim = this.claims.get(key);
		this.claims.delete(key);
		const outcome = event.outcome ?? "answered";
		// Only a person's answer has an author. A cancel may be the agent's own (nobody to name) unless a participant claimed it.
		const answeredBy: UiRequestAnswerer | undefined = claim ?? (outcome === "answered" ? { nodeId: this.ctx.identity.nodeId, machine: this.hub.nodeName() } : undefined);
		const entry: UiRequestResolution = { requestId: event.requestId, outcome, ...(event.answers ? { answers: event.answers } : {}), ...(answeredBy ? { answeredBy } : {}), at: Date.now() };
		const list = this.resolved.get(sessionId) ?? [];
		list.push(entry);
		if (list.length > RESOLVED_KEPT) list.splice(0, list.length - RESOLVED_KEPT);
		this.resolved.set(sessionId, list);
		this.hub.mirror.requestsChanged(sessionId);
		// The runtime's own event (already published) does not say who answered; the viewers of this machine learn it from a second one.
		if (answeredBy) this.ctx.bus.publish(`session:${sessionId}`, { type: "ui_request_resolved", requestId: event.requestId, outcome, ...(event.answers ? { answers: event.answers } : {}), answeredBy } satisfies SessionEvent);
		if (answeredBy && (outcome === "answered" || claim)) {
			const agent = this.hub.store.participant(shared.id, this.ctx.identity.nodeId)?.agentName ?? "The agent";
			this.hub.discussion.note(shared.id, `${answeredBy.machine} answered ${agent}'s ${kindOf(method)}`);
		}
	}

	snapshot(sessionId: string): Requests {
		const pending = (this.ctx.runtime.get(sessionId)?.pendingUiRequests() ?? []).map(({ type: _type, ...request }): PendingUiRequest => request);
		for (const request of pending) this.methods.set(claimKey(sessionId, request.requestId), request.method);
		return { pending, resolved: [...(this.resolved.get(sessionId) ?? [])], at: Date.now() };
	}

	async receiveAnswer(peerId: string, sharedId: string, request: wire.SharedAnswerRequest): Promise<wire.SharedAnswerAccepted> {
		const shared = this.hub.store.find(sharedId);
		const participant = shared ? this.hub.store.participant(sharedId, peerId) : undefined;
		if (!shared || shared.state !== "active" || !participant || participant.state !== "active") throw ApiError.notFound("Shared session");
		if (request.epoch < shared.epoch) throw new ApiError(409, "stale_epoch", `The answer carries epoch ${request.epoch}; the shared session is at epoch ${shared.epoch}: the question belongs to an agent session that no longer drives`, { currentEpoch: shared.epoch, driverNodeId: shared.driverNodeId });
		if (request.epoch > shared.epoch) {
			void this.hub.epochs.reconcilePeer(peerId);
			throw new ApiError(409, "epoch_unknown", `The answer carries epoch ${request.epoch}; this node is still at epoch ${shared.epoch} and is asking who drives now`, { currentEpoch: shared.epoch });
		}
		const sessionId = shared.localSessionId;
		if (shared.localRole !== "driver" || !sessionId) throw ApiError.conflict("This node does not drive the shared session; it cannot take answers for its agent");
		const pending = this.ctx.runtime.get(sessionId)?.pendingUiRequests().some((r) => r.requestId === request.requestId);
		if (!pending) throw closedError(request.requestId, this.resolved.get(sessionId)?.find((r) => r.requestId === request.requestId));

		const key = claimKey(sessionId, request.requestId);
		this.claims.set(key, { nodeId: peerId, machine: participant.nodeName });
		const input: UiResponseInput = request.answers !== undefined ? { requestId: request.requestId, answers: request.answers } : { requestId: request.requestId, value: request.value ?? null };
		try {
			await this.ctx.sessions.respondToUi(sessionId, input);
		} catch (error) {
			if (this.claims.get(key)?.nodeId === peerId) this.claims.delete(key);
			if (error instanceof AgentRuntimeError && error.code === "invalid_state") throw closedError(request.requestId, this.resolved.get(sessionId)?.find((r) => r.requestId === request.requestId));
			if (error instanceof AgentRuntimeError && error.code === "invalid_argument") throw ApiError.badRequest(error.message, error.details);
			throw error;
		}
		return { ok: true, outcome: request.value === null ? "cancelled" : "answered" };
	}

	// ------------------------------------------------------------------ participant

	async answer(mirrorSessionId: string, input: UiResponseInput): Promise<void> {
		const shared = this.hub.store.bySession(mirrorSessionId);
		if (!shared || shared.state !== "active" || shared.mirrorSessionId !== mirrorSessionId || shared.localRole === "driver") throw ApiError.notFound("Shared session");
		const stored = this.hub.store.mirrorState(mirrorSessionId)?.state?.requests;
		const known = stored?.resolved.find((r) => r.requestId === input.requestId);
		if (known && !stored?.pending.some((r) => r.requestId === input.requestId)) {
			throw closedError(input.requestId, known);
		}
		const driver = this.ctx.network.peers.row(shared.driverNodeId);
		if (!driver || (driver.status !== "online" && driver.status !== "degraded")) throw new ApiError(503, "driver_unreachable", `${shared.driverNodeName} (the driver) is offline: the answer cannot reach the agent. Try again when it is back.`);
		const body: wire.SharedAnswerRequest = input.answers !== undefined ? { epoch: shared.epoch, requestId: input.requestId, answers: input.answers } : { epoch: shared.epoch, requestId: input.requestId, value: input.value ?? null };
		try {
			await this.ctx.network.client.request(driver.url, { method: "POST", path: `/shared/${shared.id}/answer`, body, signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS) });
		} catch (error) {
			if (!(error instanceof NetworkError)) throw error;
			if (error.code === "stale_epoch" || error.code === "epoch_unknown") {
				void this.hub.epochs.reconcilePeer(driver.id);
				throw new ApiError(409, "stale_epoch", "The driver of this shared session changed: this question is not waiting for an answer any more.", error.details);
			}
			if (error.status !== null && error.status >= 400 && error.status < 500) {
				// An old node does not know the route (the router's own 404 names it); a 404 from a node that does is "you are not a participant".
				if (error.status === 404 && error.message.startsWith("Route ")) throw new ApiError(409, "unsupported_driver", `${shared.driverNodeName} cannot take answers from other machines (it runs an older version). Answer on that machine.`);
				throw new ApiError(error.status, error.code, error.message, error.details);
			}
			this.hub.log.warn({ err: errorText(error), sharedId: shared.id }, "an answer could not be delivered to the driver");
			throw new ApiError(503, "driver_unreachable", `${shared.driverNodeName} (the driver) could not be reached: ${error.message}`);
		}
	}
}
