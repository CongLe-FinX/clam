import type { wire } from "@clam/agent-network";
import { NetworkError } from "@clam/agent-network";
import { i18nMsg, type I18nMessage, type SharedSession, type TransferBody } from "@clam/contracts";
import type { SharedTransferMeta } from "@clam/database";
import { ApiError } from "../http/errors.ts";
import { KeyedLock, errorText } from "../network/util.ts";
import { sessionUrl } from "./epochs.ts";
import type { SharedHub, TransferApi } from "./hub.ts";
import { newTransferId } from "./store.ts";

type Phase = SharedTransferMeta["phase"];

/** The `message` + `i18n` pair of a transfer record. */
const spread = (m: I18nMessage): { message: string; i18n: SharedTransferMeta["i18n"] } => ({ message: m.text, i18n: m.i18n });

/** Phases in which the hand-over is running. */
const RUNNING: ReadonlySet<Phase> = new Set(["inviting", "waiting_accept", "stopping", "checkpointing", "delivering", "handing_over"]);
/** From here on the driving session must not change any more (the final checkpoint is about to be, or was, taken). */
const FROZEN: ReadonlySet<Phase> = new Set(["stopping", "checkpointing", "delivering", "handing_over"]);

class TransferCancelled extends Error {
	constructor() {
		super("The hand-over was cancelled");
		this.name = "TransferCancelled";
	}
}

interface Job {
	id: string;
	controller: AbortController;
	done: Promise<void>;
}

/**
 * Handing the driver role to another node as ONE action (docs/shared-sessions.md, "Hand-over"):
 * invite the node when it is not a participant yet, wait until it accepted (auto-accept policy or a human, possibly on
 * its own domain), stop or wait for the running turn, take a final checkpoint of EVERYTHING (commit all + push + session
 * snapshot), wait until the target holds the snapshot, ask it to take over (`EpochService.receiveTransfer`) and wait for its
 * announcement. The request returns as soon as the hand-over started; its progress is `meta.transfer` (the `transfer` field
 * of `SharedSession`, pushed on every phase change). A restart marks a running hand-over failed (`interrupted`).
 */
export class TransferService implements TransferApi {
	private readonly lock = new KeyedLock();
	private readonly jobs = new Map<string, Job>();
	private stopped = false;

	constructor(private readonly hub: SharedHub) {}

	private get ctx() {
		return this.hub.ctx;
	}

	private get store() {
		return this.hub.store;
	}

	private get self(): string {
		return this.ctx.identity.nodeId;
	}

	// ------------------------------------------------------------------ starting

	handover(sessionId: string, body: TransferBody): Promise<SharedSession> {
		return this.lock.run(`session:${sessionId}`, async () => {
			const session = this.ctx.sessions.get(sessionId);
			if (session.kind === "mirror" || session.movedTo) throw new ApiError(409, "session_read_only", i18nMsg("Only a session that runs on this node can be handed over"));
			if (!session.sharedSessionId) {
				// Nothing is created before the request is known to be valid.
				this.preflight(sessionId, body);
				await this.hub.sharing.addParticipant(sessionId, { nodeId: body.toNodeId, ...(body.agentId && { agentId: body.agentId }) });
			}
			const sharedId = this.ctx.sessions.get(sessionId).sharedSessionId;
			if (!sharedId) throw ApiError.conflict(i18nMsg("The session could not be shared"));
			return this.begin(sharedId, body);
		});
	}

	begin(sharedId: string, body: TransferBody): Promise<SharedSession> {
		return this.lock.run(`begin:${sharedId}`, async () => {
			const shared = this.store.find(sharedId);
			if (!shared) throw ApiError.notFound("Shared session");
			if (shared.state !== "active" || shared.localRole !== "driver" || !shared.localSessionId) throw new ApiError(409, "not_driver", i18nMsg("Only the driver can hand the driver role over"));
			const running = shared.meta.transfer;
			if (running && RUNNING.has(running.phase)) throw new ApiError(409, "transfer_in_progress", i18nMsg("A hand-over to {name} is already in progress; cancel it first.", { name: running.toNodeName }));
			const peer = this.preflight(shared.localSessionId, body);
			const participant = this.store.participant(sharedId, peer.id);
			const state = participant?.state;
			const needsInvite = state !== "active" && state !== "invited";
			const busy = this.ctx.sessions.isTurnRunning(shared.localSessionId);
			const record = this.open(sharedId, peer, body.stopRunning === true, needsInvite ? "inviting" : state === "invited" ? "waiting_accept" : busy ? "stopping" : "checkpointing");
			if (needsInvite) {
				try {
					await this.hub.sharing.addParticipant(shared.localSessionId, { nodeId: peer.id, ...(body.agentId && { agentId: body.agentId }) });
				} catch (error) {
					this.store.patchMeta(sharedId, { transfer: running ?? null });
					this.hub.changed(sharedId);
					throw error;
				}
			}
			this.hub.discussion.note(sharedId, body.stopRunning ? i18nMsg("Handing the work over to {name} (stopping the running turn first).", { name: peer.name }) : i18nMsg("Handing the work over to {name}.", { name: peer.name }));
			const controller = new AbortController();
			const job: Job = {
				id: record.id,
				controller,
				done: this.run(sharedId, record.id, body, peer.name, controller.signal)
					.catch((error: unknown) => this.hub.log.error({ err: errorText(error), sharedId }, "hand-over failed unexpectedly"))
					.finally(() => {
						if (this.jobs.get(sharedId)?.id === record.id) this.jobs.delete(sharedId);
					}),
			};
			this.jobs.set(sharedId, job);
			return this.hub.views.shared(this.store.get(sharedId));
		});
	}

	/** Everything that can be refused synchronously, before anything is created. Returns the target's peer row. */
	private preflight(sessionId: string, body: TransferBody) {
		if (body.toNodeId === this.self) throw new ApiError(409, "invalid_target", i18nMsg("Choose another node: this node already drives the session"));
		const peer = this.ctx.network.peers.row(body.toNodeId);
		if (!peer || peer.status === "revoked") throw ApiError.notFound("Peer");
		if (peer.status !== "online" && peer.status !== "degraded") throw new ApiError(409, "target_offline", i18nMsg("{name} is not reachable right now; a hand-over needs it online", { name: peer.name }));
		this.hub.assertShareable(peer.id);
		if (!body.stopRunning && this.ctx.sessions.isTurnRunning(sessionId)) {
			throw new ApiError(409, "session_busy", i18nMsg("The agent is working on a turn right now. Stop the running turn and hand over (stopRunning), or wait until it has finished."));
		}
		return peer;
	}

	// ------------------------------------------------------------------ the hand-over

	private async run(sharedId: string, id: string, body: TransferBody, name: string, signal: AbortSignal): Promise<void> {
		try {
			await this.waitAccepted(sharedId, id, body.toNodeId, name, signal);
			const interrupted = await this.quiesce(sharedId, id, body.stopRunning === true, signal);
			const epoch = this.store.get(sharedId).epoch;
			const checkpoint = await this.finalCheckpoint(sharedId, id, name, signal);
			this.advance(sharedId, id, "delivering", i18nMsg("Sending the session snapshot to {name}…", { name }));
			await this.hub.checkpoints.waitDelivered(sharedId, checkpoint.seq, body.toNodeId, this.hub.options.transferTimeoutMs);
			this.ensureLive(signal);
			this.advance(sharedId, id, "handing_over", i18nMsg("Asking {name} to take over…", { name }));
			const peer = this.ctx.network.peers.row(body.toNodeId);
			if (!peer) throw ApiError.notFound("Peer");
			const request: wire.SharedTransferRequest = { epoch, checkpointSeq: checkpoint.seq, sha256: checkpoint.sha256, interrupted };
			try {
				await this.ctx.network.client.request(peer.url, { method: "POST", path: `/shared/${sharedId}/transfer`, body: request, retry: false });
			} catch (error) {
				if (error instanceof NetworkError) throw new ApiError(409, "transfer_refused", i18nMsg("{name} did not accept the hand-over: {error}", { name, error: error.message }), { code: error.code });
				throw error;
			}
			// The target takes over and announces it; `driverChanged` completes the record when that arrives.
			const deadline = Date.now() + this.hub.options.transferTimeoutMs;
			while (Date.now() < deadline) {
				if (this.store.get(sharedId).driverNodeId === body.toNodeId) return;
				await this.pause(this.hub.options.transferPollMs, signal);
			}
			throw new ApiError(409, "transfer_pending", i18nMsg("{name} accepted the hand-over but has not announced taking over yet. Check on {name}; this node follows as soon as it does.", { name }));
		} catch (error) {
			if (error instanceof TransferCancelled) return;
			if (this.stopped) return; // the record stays running; the next boot marks it interrupted
			this.fail(sharedId, id, error);
		}
	}

	/** Phase `waiting_accept`: the target must be an active participant. */
	private async waitAccepted(sharedId: string, id: string, nodeId: string, name: string, signal: AbortSignal): Promise<void> {
		const deadline = Date.now() + this.hub.options.transferAcceptTimeoutMs;
		let announced = false;
		for (;;) {
			this.ensureLive(signal);
			const participant = this.store.participant(sharedId, nodeId);
			if (participant?.state === "active") return;
			if (!participant || participant.state === "declined" || participant.state === "removed" || participant.state === "left") {
				throw new ApiError(409, "invite_declined", participant?.state === "left" ? i18nMsg("{name} left, so the work cannot be handed over to it.", { name }) : i18nMsg("{name} declined the invitation, so the work cannot be handed over to it.", { name }));
			}
			if (!announced) {
				this.advance(sharedId, id, "waiting_accept", i18nMsg("Waiting for {name} to accept the invitation…", { name }));
				announced = true;
			}
			if (Date.now() > deadline) {
				throw new ApiError(409, "accept_timeout", i18nMsg("{name} has not accepted the invitation yet. It stays open: once {name} accepted, hand the work over again.", { name }));
			}
			await this.pause(this.hub.options.transferPollMs, signal);
		}
	}

	/**
	 * Phases `stopping` / `checkpointing`: from here on the driving session takes no new prompt (`guardPrompt`); a running turn
	 * is aborted (`stopRunning`) or waited for. Returns whether a turn was aborted.
	 */
	private async quiesce(sharedId: string, id: string, stopRunning: boolean, signal: AbortSignal): Promise<boolean> {
		const sessionId = this.store.get(sharedId).localSessionId;
		const running = sessionId !== null && this.ctx.sessions.isTurnRunning(sessionId);
		this.advance(sharedId, id, running ? "stopping" : "checkpointing", running ? (stopRunning ? i18nMsg("Stopping the running turn…") : i18nMsg("Waiting for the running turn to finish…")) : i18nMsg("Saving everything…"));
		if (sessionId === null) return false;
		const abort = stopRunning && running;
		if (abort) await this.ctx.sessions.abort(sessionId).catch((error: unknown) => this.hub.log.warn({ err: errorText(error), sharedId }, "could not abort the running turn"));
		await this.waitIdle(sessionId, abort, signal);
		return abort;
	}

	private async waitIdle(sessionId: string, stopRunning: boolean, signal: AbortSignal): Promise<void> {
		const limit = stopRunning ? this.hub.options.transferStopTimeoutMs : this.hub.options.idleTimeoutMs;
		const deadline = Date.now() + limit;
		while (this.ctx.sessions.isBusy(sessionId)) {
			this.ensureLive(signal);
			if (Date.now() > deadline) {
				throw new ApiError(409, "stop_timeout", stopRunning ? i18nMsg("The running turn did not stop within {seconds} s.", { seconds: Math.round(limit / 1000) }) : i18nMsg("The running turn did not finish within {seconds} s; stop it to hand over.", { seconds: Math.round(limit / 1000) }));
			}
			await this.pause(Math.min(100, this.hub.options.transferPollMs), signal);
		}
	}

	/** Phase `checkpointing`: commit ALL working-tree changes, push, snapshot. Nothing may be left behind, so a push or snapshot problem fails the hand-over. */
	private async finalCheckpoint(sharedId: string, id: string, name: string, signal: AbortSignal): Promise<{ seq: number; sha256: string }> {
		for (let attempt = 0; ; attempt += 1) {
			const shared = this.store.get(sharedId);
			this.advance(sharedId, id, "checkpointing", shared.vcs === "files" ? i18nMsg("Saving everything: bundling the working folder and snapshotting the session…") : i18nMsg("Saving everything: committing the working tree, pushing {branch} and snapshotting the session…", { branch: shared.branch ?? "" }));
			const checkpoint = await this.hub.checkpoints.checkpoint(sharedId, { manual: true, note: `Hand-over to ${name}` });
			this.ensureLive(signal);
			// A turn that was already on its way when the session was frozen settled while the checkpoint ran and changed the tree after the commit.
			const sessionId = this.store.get(sharedId).localSessionId;
			if ((this.store.get(sharedId).meta.turnsSinceCheckpoint ?? 0) > 0 && attempt < 2 && sessionId !== null) {
				await this.waitIdle(sessionId, true, signal);
				continue;
			}
			if (!checkpoint.snapshot) throw new ApiError(409, "snapshot_failed", checkpoint.note ? i18nMsg("The session could not be snapshotted ({detail}), so nothing was handed over.", { detail: checkpoint.note }) : i18nMsg("The session could not be snapshotted (no details), so nothing was handed over."));
			if (shared.vcs === "files") {
				if (!checkpoint.files) throw new ApiError(409, "files_failed", checkpoint.note ? i18nMsg("The working folder could not be bundled ({detail}), so {name} would not get the latest files. Nothing was handed over.", { detail: checkpoint.note, name }) : i18nMsg("The working folder could not be bundled (no details), so {name} would not get the latest files. Nothing was handed over.", { name }));
				return { seq: checkpoint.seq, sha256: checkpoint.snapshot.sha256 };
			}
			if (!checkpoint.pushed) throw new ApiError(409, "push_failed", checkpoint.note ? i18nMsg("The shared branch could not be pushed ({detail}), so {name} would not get the latest changes. Nothing was handed over.", { detail: checkpoint.note, name }) : i18nMsg("The shared branch could not be pushed (no details), so {name} would not get the latest changes. Nothing was handed over.", { name }));
			return { seq: checkpoint.seq, sha256: checkpoint.snapshot.sha256 };
		}
	}

	// ------------------------------------------------------------------ completion

	driverChanged(sharedId: string, change: { driverNodeId: string; sessionId: string | null; uiUrl: string | null }): void {
		const current = this.store.find(sharedId)?.meta.transfer;
		if (!current) return;
		const lateSuccess = current.phase === "failed" && current.error?.code === "interrupted";
		if (!RUNNING.has(current.phase) && !lateSuccess) return;
		if (change.driverNodeId === current.toNodeId) {
			this.write(sharedId, current.id, {
				phase: "continuing",
				...spread(i18nMsg("{name} is continuing the work.", { name: current.toNodeName })),
				error: null,
				newSessionId: change.sessionId,
				newSessionUrl: sessionUrl(change.uiUrl, change.sessionId),
			}, false);
			return;
		}
		const driverChanged = i18nMsg("Another node took over as driver in the meantime.");
		this.write(sharedId, current.id, { phase: "failed", ...spread(driverChanged), error: { code: "driver_changed", message: driverChanged.text, i18n: driverChanged.i18n } }, false);
		this.jobs.get(sharedId)?.controller.abort();
	}

	cancel(sharedId: string): Promise<SharedSession> {
		return this.lock.run(`begin:${sharedId}`, async () => {
			const shared = this.store.find(sharedId);
			if (!shared) throw ApiError.notFound("Shared session");
			const current = shared.meta.transfer;
			if (!current) return this.hub.views.shared(shared);
			if (!RUNNING.has(current.phase)) {
				this.store.patchMeta(sharedId, { transfer: null });
				this.hub.changed(sharedId);
				return this.hub.views.shared(this.store.get(sharedId));
			}
			if (current.phase === "handing_over") throw new ApiError(409, "not_cancellable", i18nMsg("{name} was already asked to take over; the hand-over cannot be cancelled any more.", { name: current.toNodeName }));
			this.write(sharedId, current.id, { phase: "cancelled", ...spread(i18nMsg("The hand-over to {name} was cancelled.", { name: current.toNodeName })), error: null });
			this.jobs.get(sharedId)?.controller.abort();
			this.hub.discussion.note(sharedId, i18nMsg("The hand-over to {name} was cancelled.", { name: current.toNodeName }));
			return this.hub.views.shared(this.store.get(sharedId));
		});
	}

	guardPrompt(row: { id: string; kind: string; sharedSessionId: string | null }): void {
		if (!row.sharedSessionId) return;
		const shared = this.store.find(row.sharedSessionId);
		const transfer = shared?.meta.transfer;
		if (!shared || !transfer || shared.localRole !== "driver" || shared.localSessionId !== row.id || !FROZEN.has(transfer.phase)) return;
		throw new ApiError(409, "transfer_in_progress", i18nMsg("The work is being handed over to {name}; this session takes no prompts until that finished or was cancelled.", { name: transfer.toNodeName }));
	}

	recover(): void {
		for (const shared of this.store.active()) {
			const transfer = shared.meta.transfer;
			if (!transfer || !RUNNING.has(transfer.phase)) continue;
			const text = i18nMsg("The hand-over to {name} was interrupted when this node restarted. Start it again.", { name: transfer.toNodeName });
			this.write(shared.id, transfer.id, { phase: "failed", ...spread(text), error: { code: "interrupted", message: text.text, i18n: text.i18n } });
		}
	}

	async stop(): Promise<void> {
		this.stopped = true;
		for (const job of this.jobs.values()) job.controller.abort();
		await Promise.allSettled([...this.jobs.values()].map((job) => job.done));
	}

	// ------------------------------------------------------------------ record

	private open(sharedId: string, peer: { id: string; name: string }, stopRunning: boolean, phase: Phase): SharedTransferMeta {
		const now = new Date().toISOString();
		const toNodeName = peer.name;
		const record: SharedTransferMeta = {
			id: newTransferId(),
			toNodeId: peer.id,
			toNodeName,
			phase,
			...spread(phase === "inviting" ? i18nMsg("Inviting {name}…", { name: toNodeName }) : phase === "waiting_accept" ? i18nMsg("Waiting for {name} to accept the invitation…", { name: toNodeName }) : i18nMsg("Saving everything…")),
			stopRunning,
			error: null,
			newSessionId: null,
			newSessionUrl: null,
			startedAt: now,
			updatedAt: now,
		};
		this.store.patchMeta(sharedId, { transfer: record });
		this.hub.changed(sharedId);
		return record;
	}

	private advance(sharedId: string, id: string, phase: Phase, message: I18nMessage): void {
		this.write(sharedId, id, { phase, ...spread(message) });
	}

	private fail(sharedId: string, id: string, error: unknown): void {
		const code = error instanceof ApiError ? error.code : error instanceof NetworkError ? "transfer_refused" : "transfer_failed";
		const message = error instanceof ApiError ? error.message : errorText(error, 300);
		const twin = error instanceof ApiError ? error.i18n : undefined;
		if (this.write(sharedId, id, { phase: "failed", message, i18n: twin, error: { code, message, i18n: twin } })) {
			const name = this.store.find(sharedId)?.meta.transfer?.toNodeName;
			this.hub.discussion.note(sharedId, name === undefined ? i18nMsg("The hand-over to the other node failed: {error}", { error: message }) : i18nMsg("The hand-over to {name} failed: {error}", { name, error: message }));
		}
	}

	/** Update the record `id` while it is running (a finished record is final, except an `interrupted` one that turns out to have succeeded). */
	private write(sharedId: string, id: string, patch: Partial<SharedTransferMeta>, emit = true): boolean {
		const current = this.store.find(sharedId)?.meta.transfer;
		if (!current || current.id !== id) return false;
		const lateSuccess = current.phase === "failed" && current.error?.code === "interrupted" && patch.phase === "continuing";
		if (!RUNNING.has(current.phase) && !lateSuccess) return false;
		this.store.patchMeta(sharedId, { transfer: { ...current, ...patch, updatedAt: new Date().toISOString() } });
		if (emit) this.hub.changed(sharedId);
		return true;
	}

	private ensureLive(signal: AbortSignal): void {
		if (signal.aborted) throw new TransferCancelled();
	}

	private async pause(ms: number, signal: AbortSignal): Promise<void> {
		this.ensureLive(signal);
		const { promise, resolve } = Promise.withResolvers<void>();
		const wake = (): void => resolve();
		const timer = setTimeout(wake, ms);
		signal.addEventListener("abort", wake, { once: true });
		await promise;
		clearTimeout(timer);
		signal.removeEventListener("abort", wake);
		this.ensureLive(signal);
	}
}
