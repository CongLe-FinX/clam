import type { wire } from "@clam/agent-network";
import { NetworkError, wire as wireSchemas } from "@clam/agent-network";
import { i18nMsg, type SharedSession } from "@clam/contracts";
import { agentSessions, agents, projects } from "@clam/database";
import { buildContinuationNote, buildMeshMessage, slugify } from "@clam/task-engine";
import type { SetupReport } from "@clam/handoff-engine";
import { eq } from "drizzle-orm";
import { AgentRuntimeError } from "@clam/agent-runtime";
import { ApiError } from "../http/errors.ts";
import { KeyedLock, errorText } from "../network/util.ts";
import { injectIntoSession } from "../tasks/session-injection.ts";
import type { EpochApi, SharedHub } from "./hub.ts";
import type { CheckpointRow, SharedRow } from "./store.ts";
import { postCheckpointTail } from "./tail.ts";
import { FaultInjected } from "../handoff/fault.ts";
import { withSetupSection } from "../handoff/session-kind.ts";

interface DriverChange {
	epoch: number;
	driverNodeId: string;
	driverNodeName: string;
	reason: "takeover" | "transfer";
	sessionId: string | null;
	uiUrl: string | null;
	agentId: string | null;
	agentName: string | null;
}

export function sessionUrl(uiUrl: string | null, sessionId: string | null): string | null {
	if (!uiUrl) return null;
	const base = uiUrl.replace(/\/+$/, "");
	return sessionId ? `${base}/sessions/${sessionId}` : base;
}

/**
 * Who drives a shared session, and what happens when that changes. The driver role moves with an EPOCH (fencing
 * token): a takeover or transfer makes the new driver announce `epoch + 1` to everyone, and every driver-only call
 * (mirror, checkpoint, driver notice, membership removal) with an older epoch is refused (`409 stale_epoch`).
 *
 * TAKEOVER (participant, manual): align the clone with the shared branch (fetch, check out, fast-forward: refused when
 * local changes overlap, nothing is ever discarded), `omp session unpack` the last snapshot into the local project, bind a NEW
 * local session to it, become driver, retire the mirror and participant sessions, announce, brief the agent with a
 * continuation note. TRANSFER (driver, online): fresh checkpoint, wait until the target holds it, the target takes over.
 *
 * FORMER DRIVER (it learns the higher epoch when the new driver's announcement arrives or a reconcile finds it): its
 * driving session becomes a read-only moved copy with a frozen transcript, work in its clone that is not on the shared
 * branch is committed to `clam/rescue/<sharedId>-<node>` (pushed when possible, never discarded) and it carries on as a
 * participant with a mirror of the new driver. The half-done part is journaled in `meta.pendingFormerDriver` and
 * finished at boot.
 */
export class EpochService implements EpochApi {
	private readonly lock = new KeyedLock();
	private readonly work = new Set<Promise<void>>();
	private readonly reconciling = new Map<string, Promise<void>>();
	private disposers: Array<() => void> = [];
	private timer: NodeJS.Timeout | null = null;
	private stopped = true;

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

	private track(job: Promise<void>): void {
		const tracked = job.catch((error: unknown) => this.hub.log.error({ err: errorText(error) }, "shared session epoch work failed")).finally(() => this.work.delete(tracked));
		this.work.add(tracked);
	}

	// ------------------------------------------------------------------ lifecycle

	start(): void {
		this.stopped = false;
		this.disposers.push(
			this.ctx.network.peers.onChange((change) => {
				if (change.type === "online" || change.type === "url_changed") void this.reconcilePeer(change.peerId);
			}),
		);
		this.timer = setInterval(() => {
			for (const peer of this.ctx.network.peers.activeRows()) if (peer.status === "online" || peer.status === "degraded") void this.reconcilePeer(peer.id);
		}, this.hub.options.reconcileMs);
		this.timer.unref();
		this.track(this.recover());
	}

	async stop(): Promise<void> {
		this.stopped = true;
		for (const dispose of this.disposers.splice(0)) dispose();
		clearInterval(this.timer ?? undefined);
		this.timer = null;
		await Promise.allSettled([...this.work, ...this.reconciling.values()]);
	}

	async recover(): Promise<void> {
		try {
			for (const shared of this.store.active()) {
				if (shared.meta.pendingFormerDriver) this.track(this.completeFormerDriver(shared.id));
			}
			// The cached peer status may still say "online" from before a crash, so ask everybody instead of waiting for a transition.
			for (const peer of this.ctx.network.peers.activeRows()) void this.reconcilePeer(peer.id);
		} catch (error) {
			this.hub.log.warn({ err: errorText(error) }, "shared session recovery failed");
		}
	}

	// ------------------------------------------------------------------ takeover

	takeover(sharedId: string, options: { force: boolean }): Promise<SharedSession> {
		return this.lock.run(sharedId, async () => {
			await this.performTakeover(sharedId, { reason: "takeover", force: options.force });
			return this.hub.views.shared(this.store.get(sharedId));
		});
	}

	private async performTakeover(sharedId: string, options: { reason: "takeover" | "transfer"; force: boolean; checkpointSeq?: number; interrupted?: boolean }): Promise<void> {
		const shared = this.store.get(sharedId);
		if (shared.state !== "active") throw new ApiError(409, "not_a_participant", i18nMsg("This node left the shared session"));
		if (shared.localRole === "driver") throw new ApiError(409, "already_driver", i18nMsg("This node already drives the shared session"));
		if (!shared.localProjectId) throw new ApiError(409, "no_local_clone", i18nMsg("No local clone of the repository is linked to this shared session"));
		const project = this.ctx.db.select().from(projects).where(eq(projects.id, shared.localProjectId)).get();
		if (!project) throw new ApiError(409, "no_local_clone", i18nMsg("The local clone of this shared session no longer exists"));
		const driver = this.ctx.network.peers.row(shared.driverNodeId);
		const driverOnline = driver !== undefined && (driver.status === "online" || driver.status === "degraded");
		if (options.reason === "takeover" && driverOnline && !options.force) {
			throw new ApiError(409, "driver_online", i18nMsg("{name} is the driver and is online. Ask it to transfer the work, or confirm continuing here anyway (it will then become a participant).", { name: driver.name }), { driverNodeId: driver.id });
		}
		const held = options.checkpointSeq !== undefined ? this.store.checkpoint(sharedId, options.checkpointSeq) : this.store.latestHeldCheckpoint(sharedId);
		if (!held || !held.snapshotPath || !held.snapshotSha256) throw new ApiError(409, "no_snapshot", i18nMsg("No session snapshot has been received yet; a takeover needs one. Wait for the driver's next checkpoint."));

		const filesMode = shared.vcs === "files";
		if (filesMode && !held.filesPath) throw new ApiError(409, "no_files", i18nMsg("No folder bundle has been received for that checkpoint yet; wait for the driver's next checkpoint."));
		// Git mode: align the clone with the shared branch. Files mode: restore the folder from the checkpoint's bundle (refuses on local edits unless forced; nothing is deleted).
		const aligned = filesMode ? { headCommit: null, treeNote: null } : await this.alignWorkingTree(shared, held);
		const restored = filesMode ? await this.hub.files.restore(shared, held, { force: options.force, reason: options.reason }) : null;
		let sessionFile: string;
		try {
			sessionFile = (await this.ctx.ompCli.sessionUnpack(this.hub.checkpoints.snapshotFile(sharedId, held.seq).path, project.path)).sessionFile;
		} catch (error) {
			if (error instanceof AgentRuntimeError && error.code === "invalid_archive") throw new ApiError(409, "snapshot_invalid", i18nMsg("The session snapshot is not usable: {error}", { error: error.message }));
			throw error;
		}
		const selfRow = this.store.participant(sharedId, this.self);
		const session = await this.ctx.sessions.adopt({ projectId: project.id, agentId: selfRow?.agentId ?? null, title: shared.title, sharedSessionId: sharedId, sessionFile });
		const agent = this.ctx.db.select({ name: agents.name, id: agents.id }).from(agents).where(eq(agents.id, session.agentId)).get();
		const epoch = shared.epoch + 1;
		const nodeName = this.hub.nodeName();
		const oldDriverName = shared.driverNodeName;
		const oldDriverAgent = this.store.participant(sharedId, shared.driverNodeId)?.agentName ?? null;
		const retire = [shared.mirrorSessionId, selfRow?.agentSessionId].filter((id): id is string => id != null && id !== session.id);
		const announce = this.store.transaction(() => {
			this.store.update(sharedId, { driverNodeId: this.self, driverNodeName: nodeName, localRole: "driver", localSessionId: session.id, mirrorSessionId: null, epoch });
			this.store.upsertParticipant({
				sharedSessionId: sharedId,
				nodeId: this.self,
				nodeName,
				agentId: session.agentId,
				agentName: agent?.name ?? selfRow?.agentName ?? null,
				role: "driver",
				state: "active",
				agentSessionId: session.id,
				uiUrl: null,
				snapshotSeq: selfRow?.snapshotSeq ?? 0,
				briefed: true,
				joinedAt: selfRow?.joinedAt ?? new Date().toISOString(),
				createdAt: selfRow?.createdAt,
			});
			this.store.updateParticipant(sharedId, shared.driverNodeId, { role: "participant" });
			return this.store.participants(sharedId).filter((p) => p.nodeId !== this.self && p.state === "active");
		});
		const notice: wire.SharedDriverNotice = {
			epoch,
			reason: options.reason,
			checkpointSeq: held.seq,
			commit: held.commit,
			sessionId: session.id,
			uiUrl: this.hub.uiUrl(),
			agentId: session.agentId,
			agentName: agent?.name ?? null,
			at: new Date().toISOString(),
		};
		for (const target of announce) this.hub.enqueue({ peerId: target.nodeId, sharedSessionId: sharedId, kind: "shared.driver", refId: `${sharedId}:${epoch}`, path: `/shared/${sharedId}/driver`, body: notice });
		// The old driver's questions belonged to its runtime: nobody can answer them now.
		if (shared.mirrorSessionId) this.hub.mirror.withdrawRequests(shared.mirrorSessionId);
		for (const id of retire) {
			try {
				this.ctx.sessions.update(id, { archived: true });
			} catch (error) {
				this.hub.log.warn({ err: errorText(error), sessionId: id }, "could not retire a session after a takeover");
			}
		}
		this.hub.mirror.publish(sharedId);
		this.hub.discussion.note(sharedId, options.reason === "transfer" ? i18nMsg("{name} took over as driver (epoch {epoch}) from {old}.", { name: nodeName, epoch, old: oldDriverName }) : i18nMsg("{name} continues as driver (epoch {epoch}) from checkpoint {seq}; {old} did not hand over.", { name: nodeName, epoch, seq: held.seq, old: oldDriverName }));
		this.hub.changed(sharedId);
		const text = buildContinuationNote({
			sharedSessionId: sharedId,
			title: shared.title,
			from: { nodeName: oldDriverName, agentName: oldDriverAgent },
			to: { nodeName, agentName: agent?.name ?? null },
			epoch,
			reason: options.reason,
			interrupted: options.interrupted === true,
			checkpoint: { seq: held.seq, at: held.createdAt, commit: held.commit, pushed: held.pushed },
			branch: shared.branch,
			...(restored && { files: restored }),
			headCommit: aligned.headCommit,
			treeNote: aligned.treeNote,
			afterCheckpoint: postCheckpointTail(this.store, this.hub.log, shared.mirrorSessionId, held),
		});
		// The continuation note opens the continued conversation. This node's dependency setup runs first (it may wait for the user's approval), so
		// the note goes out in the background: the takeover itself does not wait, and failing to send it must not undo it.
		this.continueSession({ shared, sessionId: session.id, projectId: project.id, dir: project.path, agentName: agent?.name ?? null, fromAgentName: oldDriverAgent, epoch, reason: options.reason, headCommit: aligned.headCommit, text });
	}

	/**
	 * Record the takeover as a `kind: session` handoff, run dependency setup + validation on this node (`beforeContinuation`), then send the
	 * continuation note with the setup report appended. A failing record or setup never blocks the note; the send is idempotent by `clientId`.
	 */
	private continueSession(c: { shared: SharedRow; sessionId: string; projectId: string; dir: string; agentName: string | null; fromAgentName: string | null; epoch: number; reason: "takeover" | "transfer"; headCommit: string | null; text: string }): void {
		const sharedId = c.shared.id;
		const clientId = `shared_continue_${sharedId}_${c.epoch}`;
		const { sessionKind } = this.ctx.handoffs;
		void (async () => {
			let report: SetupReport = { ran: [], skipped: [] };
			try {
				report = await sessionKind.beforeContinuation({
					sharedSessionId: sharedId,
					title: c.shared.title,
					workspaceId: c.shared.workspaceId,
					fromNodeId: c.shared.driverNodeId,
					fromNodeName: c.shared.driverNodeName,
					fromAgentName: c.fromAgentName,
					toEpoch: c.epoch,
					dir: c.dir,
					projectId: c.projectId,
					sessionId: c.sessionId,
					agentName: c.agentName,
					reason: c.reason,
					vcs: c.shared.vcs === "files" ? "files" : "git",
					headCommit: c.headCommit,
					continuation: { text: c.text, clientId },
				});
			} catch (error) {
				if (error instanceof FaultInjected) throw error;
				this.hub.log.warn({ err: errorText(error), sharedId }, "dependency setup before the continuation note failed; sending the note without it");
			}
			try {
				await this.ctx.sessions.prompt(c.sessionId, { message: withSetupSection(c.text, report), clientId });
				sessionKind.continued({ sharedSessionId: sharedId, toEpoch: c.epoch });
			} catch (error) {
				if (error instanceof FaultInjected) throw error;
				this.hub.log.warn({ err: errorText(error), sharedId }, "could not send the continuation note");
				sessionKind.continued({ sharedSessionId: sharedId, toEpoch: c.epoch, error: errorText(error, 200) });
			}
		})().catch((error: unknown) => this.hub.log.warn({ err: errorText(error), sharedId }, "the continuation of the shared session stopped"));
	}

	/** This node lost the driver role: record it as the source side of a `kind: session` handoff. Bookkeeping only, never breaks the shared flow. */
	private recordFormerDriver(shared: SharedRow, change: DriverChange): void {
		try {
			const transfer = shared.meta.transfer;
			const handedOver = transfer?.toNodeId === change.driverNodeId && (transfer.phase === "handing_over" || (transfer.phase === "failed" && transfer.error?.code === "interrupted"));
			this.ctx.handoffs.sessionKind.recordSource({
				sharedSessionId: shared.id,
				title: shared.title,
				workspaceId: shared.workspaceId,
				toNodeId: change.driverNodeId,
				toNodeName: change.driverNodeName,
				toAgentName: change.agentName,
				fromEpoch: shared.epoch,
				toEpoch: change.epoch,
				sessionId: shared.localSessionId,
				agentName: this.store.participant(shared.id, this.self)?.agentName ?? null,
				reason: handedOver ? "transfer" : change.reason,
				vcs: shared.vcs === "files" ? "files" : "git",
			});
		} catch (error) {
			if (error instanceof FaultInjected) throw error;
			this.hub.log.warn({ err: errorText(error), sharedId: shared.id }, "could not record the lost driver role as a handoff");
		}
	}

	/** Fetch, check out the shared branch and fast-forward it. Refuses (409) when local changes overlap; never discards anything. */
	private async alignWorkingTree(shared: SharedRow, held: CheckpointRow): Promise<{ headCommit: string | null; treeNote: string | null }> {
		const projectId = shared.localProjectId as string;
		const { gitService } = this.ctx;
		if (!held.commit) return { headCommit: null, treeNote: "The checkpoint recorded no commit, so the working tree was left as it is." };
		let status = await gitService.status(projectId);
		if (!status.isRepo) throw new ApiError(409, "not_a_git_repo", i18nMsg("The local clone is not a git repository"));
		if (status.operation) throw new ApiError(409, "git_operation_in_progress", i18nMsg("A {operation} is in progress in the local clone; finish or abort it, then continue.", { operation: status.operation }));
		try {
			await gitService.fetch(projectId);
		} catch (error) {
			throw new ApiError(409, "git_fetch_failed", i18nMsg("Could not fetch the repository (is origin reachable?): {error}", { error: errorText(error, 200) }));
		}
		if (status.branch !== shared.branch) {
			try {
				status = await gitService.checkout(projectId, shared.branch as string);
			} catch (error) {
				throw new ApiError(409, "git_checkout_failed", i18nMsg("Could not check out {branch}: {error} Local changes were left untouched.", { branch: String(shared.branch), error: errorText(error, 300) }));
			}
		}
		try {
			status = (await gitService.pull(projectId)).status;
		} catch (error) {
			const details = error instanceof ApiError ? error.details : undefined;
			const noUpstream = typeof details === "object" && details !== null && "reason" in details && details.reason === "no-upstream";
			if (!noUpstream) throw error;
		}
		const head = status.headSha;
		if (head === held.commit) return { headCommit: head, treeNote: null };
		return {
			headCommit: head,
			treeNote: held.pushed
				? `The branch ${shared.branch} is at ${head?.slice(0, 12) ?? "?"}, not exactly at the checkpoint commit ${held.commit.slice(0, 12)} (it moved on after the snapshot).`
				: `The checkpoint commit ${held.commit.slice(0, 12)} was never pushed, so it is not in this clone; the branch is at ${head?.slice(0, 12) ?? "?"}. Files changed after the previous push may be missing.`,
		};
	}

	// ------------------------------------------------------------------ transfer (target side; the driver side is `transfers.ts`)

	async receiveTransfer(peerId: string, sharedId: string, request: wire.SharedTransferRequest): Promise<wire.SharedTransferAccepted> {
		const shared = this.store.find(sharedId);
		if (!shared || shared.state !== "active") throw ApiError.notFound("Shared session");
		if (peerId !== shared.driverNodeId || shared.localRole === "driver") throw new ApiError(403, "forbidden", i18nMsg("Only the driver of the shared session may hand it over"));
		if (request.epoch !== shared.epoch) throw new ApiError(409, "stale_epoch", i18nMsg("The transfer carries epoch {epoch}; the shared session is at epoch {current}", { epoch: request.epoch, current: shared.epoch }), { currentEpoch: shared.epoch });
		const held = this.store.checkpoint(sharedId, request.checkpointSeq);
		if (!held?.snapshotPath || held.snapshotSha256 !== request.sha256 || (held.files !== null && !held.filesPath)) throw new ApiError(409, "no_snapshot", i18nMsg("This node does not hold the snapshot (and folder bundle) of that checkpoint"));
		this.track(
			this.lock
				.run(sharedId, () => this.performTakeover(sharedId, { reason: "transfer", force: true, checkpointSeq: request.checkpointSeq, interrupted: request.interrupted === true }))
				.catch((error: unknown) => {
					this.hub.discussion.note(sharedId, i18nMsg("Taking over from {name} failed: {error}", { name: shared.driverNodeName, error: errorText(error, 300) }));
					this.hub.log.warn({ err: errorText(error), sharedId }, "transfer takeover failed");
				}),
		);
		return { accepted: true, epoch: shared.epoch };
	}

	// ------------------------------------------------------------------ learning about a driver change

	async receiveDriver(peerId: string, sharedId: string, notice: wire.SharedDriverNotice): Promise<void> {
		await this.lock.run(sharedId, async () => {
			const shared = this.store.find(sharedId);
			if (!shared) throw ApiError.notFound("Shared session");
			const sender = this.store.participant(sharedId, peerId);
			if (!sender || sender.state !== "active") throw new ApiError(403, "forbidden", i18nMsg("Only participants of the shared session may announce a new driver"));
			if (notice.epoch < shared.epoch) throw new ApiError(409, "stale_epoch", i18nMsg("The notice carries epoch {epoch}; the shared session is at epoch {current}", { epoch: notice.epoch, current: shared.epoch }), { currentEpoch: shared.epoch, driverNodeId: shared.driverNodeId });
			if (notice.epoch === shared.epoch) {
				if (shared.driverNodeId === peerId) return; // a duplicate delivery
				throw new ApiError(409, "split_brain", i18nMsg("Two nodes claim to drive at epoch {epoch}", { epoch: notice.epoch }), { driverNodeId: shared.driverNodeId });
			}
			const peer = this.ctx.network.peers.row(peerId);
			await this.apply(shared, {
				epoch: notice.epoch,
				driverNodeId: peerId,
				driverNodeName: peer?.name ?? sender.nodeName,
				reason: notice.reason,
				sessionId: notice.sessionId ?? null,
				uiUrl: notice.uiUrl ?? null,
				agentId: notice.agentId ?? null,
				agentName: notice.agentName ?? null,
			});
		});
	}

	/** Apply a driver change learned from an announcement or a reconcile (caller holds the lock of the session). */
	private async apply(shared: SharedRow, change: DriverChange): Promise<void> {
		if (shared.state !== "active") {
			this.store.update(shared.id, { driverNodeId: change.driverNodeId, driverNodeName: change.driverNodeName, epoch: change.epoch });
			return;
		}
		const wasDriver = shared.localRole === "driver";
		const previousMirror = shared.mirrorSessionId;
		this.store.transaction(() => {
			const oldDriver = this.store.participant(shared.id, shared.driverNodeId);
			if (oldDriver) this.store.updateParticipant(shared.id, shared.driverNodeId, { role: "participant" });
			const known = this.store.participant(shared.id, change.driverNodeId);
			this.store.upsertParticipant({
				sharedSessionId: shared.id,
				nodeId: change.driverNodeId,
				nodeName: change.driverNodeName,
				agentId: change.agentId ?? known?.agentId ?? null,
				agentName: change.agentName ?? known?.agentName ?? null,
				role: "driver",
				state: "active",
				agentSessionId: change.sessionId ?? known?.agentSessionId ?? null,
				uiUrl: change.uiUrl ?? known?.uiUrl ?? null,
				snapshotSeq: known?.snapshotSeq ?? 0,
				joinedAt: known?.joinedAt ?? new Date().toISOString(),
				createdAt: known?.createdAt,
			});
			this.store.update(shared.id, {
				driverNodeId: change.driverNodeId,
				driverNodeName: change.driverNodeName,
				epoch: change.epoch,
				localRole: wasDriver ? "former_driver" : shared.localRole,
				mirrorSessionId: null,
			});
			if (wasDriver) {
				const pending = { epoch: change.epoch, driverNodeId: change.driverNodeId, driverNodeName: change.driverNodeName, reason: change.reason, sessionId: change.sessionId, uiUrl: change.uiUrl };
				this.store.patchMeta(shared.id, { pendingFormerDriver: pending });
			}
			if (!wasDriver && shared.localRole === "participant") this.store.update(shared.id, { localSessionId: null });
		});
		if (wasDriver) this.hub.mirror.unpublish(shared.id);
		if (wasDriver) this.recordFormerDriver(shared, change);
		if (previousMirror) this.hub.mirror.withdrawRequests(previousMirror);
		if (previousMirror && previousMirror !== shared.localSessionId) {
			try {
				this.ctx.sessions.update(previousMirror, { archived: true });
			} catch (error) {
				this.hub.log.warn({ err: errorText(error), sessionId: previousMirror }, "could not archive the previous mirror");
			}
		}
		this.hub.transfers.driverChanged(shared.id, { driverNodeId: change.driverNodeId, sessionId: change.sessionId, uiUrl: change.uiUrl });
		this.hub.changed(shared.id);
		if (wasDriver) {
			this.track(this.completeFormerDriver(shared.id));
			return;
		}
		this.afterParticipantChange(shared.id, change);
	}

	/** A participant (or former driver with nothing left to finish) follows the new driver: new mirror, a note for its agent. */
	private afterParticipantChange(sharedId: string, change: DriverChange): void {
		const shared = this.store.get(sharedId);
		if (shared.state !== "active") return;
		this.hub.sharing.ensureMirror(shared);
		const agentSessionId = this.hub.sharing.ensureParticipantAgent(sharedId);
		void this.hub.sharing.briefPending();
		if (agentSessionId) {
			const text = buildMeshMessage({
				ref: `shared session ${sharedId}`,
				title: shared.title,
				author: { kind: "system", agentName: null, nodeName: change.driverNodeName },
				kind: "note",
				text: `The driver changed: ${change.driverNodeName} drives from now on (epoch ${change.epoch}). Their agent continues the work; you keep helping as a participant.`,
				reminder: "Use mesh_team to see the team.",
			});
			injectIntoSession(this.ctx, { sessionId: agentSessionId, clientId: `shared_driver_${sharedId}_${change.epoch}`, text, kind: "note" }).catch((error: unknown) => this.hub.log.warn({ err: errorText(error), sharedId }, "could not tell the participant agent about the driver change"));
		}
		this.hub.changed(sharedId);
	}

	/**
	 * The second half of losing the driver role: freeze the transcript, make the driving session a read-only moved copy,
	 * rescue unpushed work, mark the OMP copy moved, become a participant (mirror + participant agent session). Idempotent;
	 * `meta.pendingFormerDriver` stays set until it is done, so a crash in the middle is finished at the next boot.
	 */
	private async completeFormerDriver(sharedId: string): Promise<void> {
		await this.lock.run(`former:${sharedId}`, async () => {
			const shared = this.store.find(sharedId);
			const pending = shared?.meta.pendingFormerDriver;
			if (!shared || !pending) return;
			const sessionId = shared.localSessionId;
			if (sessionId) {
				const session = this.ctx.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).get();
				if (session && !session.movedTo) {
					await this.hub.mirror.freeze(sessionId).catch((error: unknown) => this.hub.log.warn({ err: errorText(error), sharedId }, "could not freeze the transcript of the moved session"));
					await this.ctx.sessions.markMoved(sessionId, {
						nodeId: pending.driverNodeId,
						nodeName: pending.driverNodeName,
						url: sessionUrl(pending.uiUrl, pending.sessionId),
						sessionId: pending.sessionId,
						at: new Date().toISOString(),
					});
					const file = this.ctx.sessions.get(sessionId).runtimeSessionFile;
					if (file) {
						// Best effort: omp refuses while another omp process on this machine holds the same session id (only possible when both nodes share a machine).
						await this.ctx.ompCli.sessionMoved(file, pending.driverNodeName).catch((error: unknown) => this.hub.log.warn({ err: errorText(error), sharedId }, "omp session moved failed"));
					}
				}
			}
			// Git mode: unpushed work goes to a rescue branch. Files mode: what is new or changed since the last synced checkpoint is bundled (noted by the files unit itself).
			const rescue = shared.vcs === "files" ? (await this.hub.files.rescueSinceSync(shared), null) : await this.rescue(shared, pending.driverNodeName);
			this.hub.sharing.ensureMirror(this.store.get(sharedId));
			this.hub.sharing.ensureParticipantAgent(sharedId);
			void this.hub.sharing.briefPending();
			this.store.patchMeta(sharedId, { pendingFormerDriver: null });
			if (rescue) this.hub.discussion.note(sharedId, i18nMsg("{node} had work that is not on the shared branch; it was saved on {branch}.", { node: this.hub.nodeName(), branch: rescue }));
			this.hub.changed(sharedId);
		});
	}

	/** Commit uncommitted changes and push unpushed commits to `clam/rescue/<sharedId>-<node>`; null when there was nothing to save. */
	private async rescue(shared: SharedRow, newDriverName: string): Promise<string | null> {
		const projectId = shared.localProjectId;
		if (!projectId) return null;
		const { gitService } = this.ctx;
		try {
			let status = await gitService.status(projectId);
			if (!status.isRepo) return null;
			const dirty = status.files.length > 0;
			const unpushed = status.upstream !== null && status.ahead > 0;
			if (!dirty && !unpushed) return null;
			if (status.operation) {
				this.hub.discussion.note(shared.id, i18nMsg("A {operation} is in progress in the clone, so its work could not be moved to a rescue branch; nothing was discarded.", { operation: status.operation }));
				return null;
			}
			const name = `clam/rescue/${shared.id}-${slugify(this.hub.nodeName(), 30)}`;
			if (status.branch !== name) {
				const local = (await gitService.branches(projectId)).some((b) => !b.remote && (b.name === name || b.name === `refs/heads/${name}`));
				status = local ? await gitService.checkout(projectId, name) : await gitService.createBranch(projectId, { name, checkout: true });
			}
			this.store.update(shared.id, { rescueBranch: name });
			if (dirty) {
				const renamed = status.files.flatMap((f) => (f.origPath ? [f.path, f.origPath] : []));
				if (renamed.length > 0) status = await gitService.unstage(projectId, renamed);
				await gitService.commit(
					projectId,
					{ message: `Rescue: ${shared.title} — work of ${this.hub.nodeName()} that is not on ${shared.branch} (${newDriverName} drives now)`, paths: status.files.map((f) => f.path), ...(shared.localSessionId && { sessionId: shared.localSessionId }) },
					{ Session: shared.id, Epoch: String(shared.epoch) },
				);
			}
			try {
				await gitService.push(projectId, { setUpstream: true });
			} catch (error) {
				this.hub.discussion.note(shared.id, i18nMsg("The rescue branch {name} could not be pushed ({error}); it is committed locally.", { name, error: errorText(error, 160) }));
			}
			return name;
		} catch (error) {
			this.hub.log.warn({ err: errorText(error), sharedId: shared.id }, "rescuing the work of the former driver failed; nothing was discarded");
			this.hub.discussion.note(shared.id, i18nMsg("Saving the former driver's work on a rescue branch failed: {error}. The clone was not touched further.", { error: errorText(error, 200) }));
			return null;
		}
	}

	// ------------------------------------------------------------------ reconcile

	stateFor(peerId: string, sharedId: string): wire.SharedStateResponse {
		const shared = this.store.find(sharedId);
		const member = shared ? this.store.participant(sharedId, peerId) : undefined;
		if (!shared || !member) throw ApiError.notFound("Shared session");
		const last = this.store.latestCheckpoint(sharedId);
		const driver = this.store.participant(sharedId, shared.driverNodeId);
		return {
			sharedSessionId: shared.id,
			title: shared.title,
			workspaceId: shared.workspaceId,
			epoch: shared.epoch,
			driverNodeId: shared.driverNodeId,
			branch: shared.branch,
			vcs: shared.vcs === "files" ? "files" : "git",
			driverSessionId: shared.localRole === "driver" ? shared.localSessionId : (driver?.agentSessionId ?? null),
			driverUiUrl: shared.localRole === "driver" ? this.hub.uiUrl() : (driver?.uiUrl ?? null),
			participants: this.store.participants(sharedId).map((p) => ({
				nodeId: p.nodeId,
				nodeName: p.nodeName,
				role: p.role as "driver" | "participant",
				state: p.state as "invited" | "active" | "declined" | "left" | "removed",
				agentId: p.agentId,
				agentName: p.agentName,
				uiUrl: p.nodeId === this.self ? this.hub.uiUrl() : p.uiUrl,
			})),
			lastCheckpoint: last ? { seq: last.seq, epoch: last.epoch, commit: last.commit, pushed: last.pushed, snapshotSha256: last.snapshotSha256, filesSha256: last.files?.sha256 ?? null } : null,
		};
	}

	reconcilePeer(peerId: string): Promise<void> {
		const running = this.reconciling.get(peerId);
		if (running) return running;
		const job = this.runReconcile(peerId).finally(() => this.reconciling.delete(peerId));
		this.reconciling.set(peerId, job);
		return job;
	}

	/** Ask `peerId` about every shared session we have in common and apply a higher epoch it reports. Never throws. */
	private async runReconcile(peerId: string): Promise<void> {
		if (this.stopped) return;
		try {
			for (const shared of this.store.sessionsWithPeer(peerId)) {
				const peer = this.ctx.network.peers.row(peerId);
				if (!peer || peer.status === "revoked") return;
				let state: wire.SharedStateResponse;
				try {
					const response = await this.ctx.network.client.request<unknown>(peer.url, { method: "GET", path: `/shared/${shared.id}`, retry: false, signal: AbortSignal.timeout(10_000) });
					const parsed = wireSchemas.SharedStateResponse.safeParse(response.body);
					if (!parsed.success) continue;
					state = parsed.data;
				} catch (error) {
					if (!(error instanceof NetworkError) || (error.status ?? 0) >= 500 || error.status === null) return; // unreachable: the next online event or tick retries
					continue; // 403/404: the peer does not (or no longer) share it with us
				}
				await this.lock.run(shared.id, async () => {
					const current = this.store.find(shared.id);
					if (!current || current.state !== "active") return;
					if (state.epoch > current.epoch) {
						const driver = state.participants.find((p) => p.nodeId === state.driverNodeId);
						await this.apply(current, {
							epoch: state.epoch,
							driverNodeId: state.driverNodeId,
							driverNodeName: driver?.nodeName ?? (state.driverNodeId === peerId ? peer.name : state.driverNodeId),
							reason: "takeover",
							sessionId: state.driverSessionId ?? null,
							uiUrl: state.driverUiUrl ?? null,
							agentId: driver?.agentId ?? null,
							agentName: driver?.agentName ?? null,
						});
					} else if (state.epoch === current.epoch && state.driverNodeId !== current.driverNodeId) {
						this.hub.log.error({ sharedId: current.id, mine: current.driverNodeId, theirs: state.driverNodeId, epoch: state.epoch }, "split brain: two nodes claim to drive the same epoch");
					}
				});
			}
		} catch (error) {
			this.hub.log.warn({ err: errorText(error), peerId }, "reconciling shared sessions with a peer failed");
		}
	}
}
