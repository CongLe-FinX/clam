import { rm } from "node:fs/promises";
import type { wire } from "@clam/agent-network";
import type { Checkpoint, SessionEvent } from "@clam/contracts";
import { agentSessions, projects } from "@clam/database";
import { eq } from "drizzle-orm";
import { ApiError } from "../http/errors.ts";
import { KeyedLock, errorText } from "../network/util.ts";
import type { CheckpointApi, SharedHub } from "./hub.ts";
import { downloadSnapshot, SnapshotFiles, SnapshotRejectedError } from "./snapshots.ts";
import type { CheckpointRow, SharedRow } from "./store.ts";

/** How many snapshots of one shared session a node keeps on disk (the newest); older files are deleted, their rows stay. */
const KEEP_SNAPSHOTS = 3;
/** A failing download is retried with a growing delay up to this multiple of `retryMs`. */
const MAX_RETRY_FACTOR = 12;

interface GitOutcome {
	commit: string | null;
	pushed: boolean;
	problems: string[];
}

interface SnapshotOutcome {
	relative: string | null;
	sha256: string | null;
	size: number | null;
	messageCount: number | null;
	problems: string[];
}

interface Waiter {
	key: string;
	resolve(): void;
}

/**
 * Checkpoints of a shared session. DRIVER: commit the working tree to the shared branch (trailers `Session`, `Agent`,
 * `Epoch`) and push it (never forced; a refused push keeps the commit and records `pushed: false`), snapshot the driving
 * session (`omp session pack` while its runtime is released, see `SessionService.withConversationFile`), record the
 * checkpoint and tell every participant through the outbox (`shared.checkpoint`). Automatic after settled turns, at most
 * one per `checkpointDebounceMs`; manual on request.
 *
 * PARTICIPANT: record the notice and DOWNLOAD the snapshot from the driver (`GET /shared/:id/snapshots/:seq`: streamed,
 * sha256 and size checked while writing, size capped), store it 0600 and acknowledge (`shared.snapshot_ack`) so the driver
 * knows who holds it. Pending downloads survive restarts (they are rows without a file) and are retried when the holder is
 * reachable. Snapshots never enter Git.
 */
export class CheckpointService implements CheckpointApi {
	readonly files: SnapshotFiles;
	private readonly lock = new KeyedLock();
	private readonly lastRun = new Map<string, number>();
	private readonly autoTimers = new Map<string, NodeJS.Timeout>();
	private readonly downloads = new Map<string, Promise<void>>();
	private readonly retryTimers = new Map<string, NodeJS.Timeout>();
	private readonly failures = new Map<string, number>();
	private readonly waiters = new Set<Waiter>();
	private readonly disposers: Array<() => void> = [];
	private stopped = true;

	constructor(private readonly hub: SharedHub) {
		this.files = new SnapshotFiles(hub.ctx.config.dataDir);
	}

	private get ctx() {
		return this.hub.ctx;
	}

	private get store() {
		return this.hub.store;
	}

	// ------------------------------------------------------------------ lifecycle

	start(): void {
		this.stopped = false;
		this.disposers.push(
			this.ctx.runtime.onEvent((sessionId, event) => this.onRuntimeEvent(sessionId, event)),
			this.ctx.network.peers.onChange((change) => {
				if (change.type === "online" || change.type === "url_changed") void this.downloadPending(change.peerId);
			}),
		);
		void this.downloadPending();
		// A crash between a settled turn and its checkpoint must not leave the turn without one.
		for (const shared of this.store.active()) if (shared.localRole === "driver" && (shared.meta.turnsSinceCheckpoint ?? 0) > 0) this.scheduleAutomatic(shared.id);
	}

	async stop(): Promise<void> {
		this.stopped = true;
		for (const dispose of this.disposers.splice(0)) dispose();
		for (const timer of [...this.autoTimers.values(), ...this.retryTimers.values()]) clearTimeout(timer);
		this.autoTimers.clear();
		this.retryTimers.clear();
		await Promise.allSettled([...this.downloads.values()]);
		await this.lock.run("stop", async () => undefined);
	}

	private onRuntimeEvent(sessionId: string, event: SessionEvent): void {
		if (event.type !== "settled") return;
		const shared = this.store.bySession(sessionId);
		if (shared && shared.state === "active" && shared.localRole === "driver" && shared.localSessionId === sessionId) this.turnSettled(shared.id);
	}

	// ------------------------------------------------------------------ driver: taking checkpoints

	turnSettled(sharedId: string): void {
		const shared = this.store.find(sharedId);
		if (!shared || shared.state !== "active" || shared.localRole !== "driver") return;
		if (this.store.activePeers(sharedId).length === 0) return; // nobody to hand a snapshot to
		this.store.patchMeta(sharedId, { turnsSinceCheckpoint: (shared.meta.turnsSinceCheckpoint ?? 0) + 1 });
		this.scheduleAutomatic(sharedId);
	}

	private scheduleAutomatic(sharedId: string): void {
		if (this.stopped || this.autoTimers.has(sharedId)) return;
		const last = this.lastRun.get(sharedId) ?? Date.parse(this.store.latestCheckpoint(sharedId)?.createdAt ?? "") ?? 0;
		const wait = Math.max(0, (Number.isNaN(last) ? 0 : last) + this.hub.options.checkpointDebounceMs - Date.now());
		const timer = setTimeout(() => {
			this.autoTimers.delete(sharedId);
			const shared = this.store.find(sharedId);
			if (!shared || shared.state !== "active" || shared.localRole !== "driver" || (shared.meta.turnsSinceCheckpoint ?? 0) === 0) return;
			if (this.store.activePeers(sharedId).length === 0) return;
			this.checkpoint(sharedId, { manual: false }).catch((error: unknown) => this.hub.log.warn({ err: errorText(error), sharedId }, "automatic checkpoint failed"));
		}, wait);
		timer.unref();
		this.autoTimers.set(sharedId, timer);
	}

	checkpoint(sharedId: string, options: { note?: string; manual: boolean }): Promise<Checkpoint> {
		return this.lock.run(sharedId, async () => {
			const shared = this.store.get(sharedId);
			if (shared.state !== "active" || shared.localRole !== "driver") throw new ApiError(409, "not_driver", "Only the driver of a shared session takes checkpoints");
			if (!shared.localSessionId || !shared.localProjectId) throw ApiError.conflict("The driving session or its project is missing on this node");
			const seq = shared.lastCheckpointSeq + 1;
			const turnsAtStart = shared.meta.turnsSinceCheckpoint ?? 0;
			const git = await this.commitAndPush(shared, seq, options.note);
			const snapshot = await this.takeSnapshot(shared, seq);
			const session = this.ctx.db.select({ model: agentSessions.model }).from(agentSessions).where(eq(agentSessions.id, shared.localSessionId)).get();
			const note = [options.note?.trim(), ...git.problems, ...snapshot.problems].filter(Boolean).join(" · ").slice(0, 500) || null;
			const { row } = this.store.insertCheckpoint({
				sharedSessionId: shared.id,
				seq,
				epoch: shared.epoch,
				nodeId: this.ctx.identity.nodeId,
				branch: shared.branch,
				commit: git.commit,
				pushed: git.pushed,
				snapshotSha256: snapshot.sha256,
				snapshotSize: snapshot.size,
				snapshotMessages: snapshot.messageCount,
				snapshotPath: snapshot.relative,
				model: session?.model ?? null,
				deliveredTo: [],
				note,
			});
			this.store.update(shared.id, { lastCheckpointSeq: seq });
			// A turn that settled while this checkpoint ran changed the tree after the commit: it stays counted for the next one.
			const unsettled = Math.max(0, (this.store.get(shared.id).meta.turnsSinceCheckpoint ?? 0) - turnsAtStart);
			this.store.patchMeta(shared.id, { lastCheckpointCommit: git.commit, turnsSinceCheckpoint: unsettled });
			this.lastRun.set(shared.id, Date.now());
			if (unsettled > 0) this.scheduleAutomatic(shared.id);
			await this.prune(shared.id);
			for (const participant of this.store.activePeers(shared.id)) this.enqueueNotice(row, participant.nodeId, participant.joinedAt ?? "");
			this.hub.changed(shared.id, { checkpoints: [row] });
			// Low noise: a line for a checkpoint someone asked for or that moved the shared branch, not for every automatic one that found nothing new.
			if (options.manual || (git.pushed && git.commit !== (shared.meta.lastCheckpointCommit ?? null))) {
				this.hub.discussion.note(shared.id, `Checkpoint ${seq} taken${git.commit ? `: commit ${git.commit.slice(0, 12)}${git.pushed ? " pushed" : " (not pushed)"}` : ": no new commit"}${snapshot.sha256 ? ", session snapshot saved" : ", no session snapshot"}.`);
			}
			return this.hub.views.checkpoint(row);
		});
	}

	/** Commit everything in the working tree to the shared branch and push it. Problems become part of the checkpoint note. */
	private async commitAndPush(shared: SharedRow, seq: number, note: string | undefined): Promise<GitOutcome> {
		const projectId = shared.localProjectId as string;
		const sessionId = shared.localSessionId as string;
		const { gitService } = this.ctx;
		const outcome: GitOutcome = { commit: null, pushed: false, problems: [] };
		let status;
		try {
			status = await gitService.status(projectId);
		} catch (error) {
			outcome.problems.push(`git: ${errorText(error, 160)}`);
			return outcome;
		}
		if (!status.isRepo) {
			outcome.problems.push("the project is not a git repository");
			return outcome;
		}
		outcome.commit = status.headSha;
		if (status.operation) {
			outcome.problems.push(`a ${status.operation} is in progress in the project, so nothing was committed`);
			return outcome;
		}
		try {
			if (status.branch !== shared.branch) status = await gitService.checkout(projectId, shared.branch);
		} catch (error) {
			outcome.problems.push(`could not switch to ${shared.branch}: ${errorText(error, 160)}`);
			return outcome;
		}
		try {
			// A staged rename carries its old path, which `git add` cannot address any more; as delete + add both paths can be committed.
			const renamed = status.files.flatMap((f) => (f.origPath ? [f.path, f.origPath] : []));
			if (renamed.length > 0) status = await gitService.unstage(projectId, renamed);
			if (status.files.length > 0) {
				const message = `${shared.title} — checkpoint ${seq}${note?.trim() ? `: ${note.trim()}` : ""}`;
				const committed = await gitService.commit(projectId, { message, paths: status.files.map((f) => f.path), sessionId }, { Session: shared.id, Epoch: String(shared.epoch) });
				status = committed.status;
			}
		} catch (error) {
			outcome.problems.push(`could not commit the working tree: ${errorText(error, 160)}`);
			outcome.commit = status.headSha;
			return outcome;
		}
		outcome.commit = status.headSha;
		try {
			const pushed = await gitService.push(projectId, { setUpstream: true });
			outcome.pushed = true;
			outcome.commit = pushed.status.headSha;
		} catch (error) {
			outcome.problems.push(`push refused or failed, the commit is kept locally: ${errorText(error, 160)}`);
		}
		return outcome;
	}

	/** Pack the driving session while its runtime is released; `snapshot` stays null with a note when that is not possible. */
	private async takeSnapshot(shared: SharedRow, seq: number): Promise<SnapshotOutcome> {
		const sessionId = shared.localSessionId as string;
		const none: SnapshotOutcome = { relative: null, sha256: null, size: null, messageCount: null, problems: [] };
		let tmp: string | null = null;
		try {
			const messageCount = await this.ctx.sessions
				.messages(sessionId, { limit: 1 })
				.then((page) => page.total)
				.catch(() => 0);
			const target = await this.files.temporary(shared.id, `pack-${seq}`);
			tmp = target;
			await this.ctx.sessions.withConversationFile(
				sessionId,
				async (file) => {
					await this.ctx.ompCli.sessionPack(file, target);
				},
				{ idleTimeoutMs: this.hub.options.idleTimeoutMs },
			);
			const { sha256, size } = await this.files.digest(target);
			if (size > this.hub.options.maxSnapshotBytes) throw new Error(`the snapshot is ${size} bytes, over the ${this.hub.options.maxSnapshotBytes} byte limit`);
			const relative = await this.files.place(target, shared.id, seq);
			tmp = null;
			return { relative, sha256, size, messageCount, problems: [] };
		} catch (error) {
			if (tmp) await rm(tmp, { force: true });
			this.hub.log.warn({ err: errorText(error), sharedId: shared.id, seq }, "could not snapshot the driving session");
			return { ...none, problems: [`no session snapshot: ${errorText(error, 160)}`] };
		}
	}

	private enqueueNotice(row: CheckpointRow, peerId: string, generation: string): void {
		const notice: wire.SharedCheckpointNotice = {
			seq: row.seq,
			epoch: row.epoch,
			branch: row.branch,
			commit: row.commit,
			pushed: row.pushed,
			snapshot: row.snapshotSha256 !== null && row.snapshotSize !== null ? { sha256: row.snapshotSha256, size: row.snapshotSize, messageCount: row.snapshotMessages ?? 0 } : null,
			model: row.model,
			note: row.note,
			at: row.createdAt,
		};
		this.hub.enqueue({
			peerId,
			sharedSessionId: row.sharedSessionId,
			kind: "shared.checkpoint",
			refId: `${row.sharedSessionId}:${row.seq}`,
			path: `/shared/${row.sharedSessionId}/checkpoints`,
			body: notice,
			// A participant that (re)joined is told again, so the key carries its join time.
			idempotencyKey: `shared.checkpoint:${row.sharedSessionId}:${row.seq}:${peerId}:${generation}`.slice(0, 128),
		});
	}

	shipLatest(sharedId: string, peerId: string): void {
		const shared = this.store.find(sharedId);
		if (!shared || shared.state !== "active" || shared.localRole !== "driver") return;
		const latest = this.store.latestCheckpoint(sharedId);
		const participant = this.store.participant(sharedId, peerId);
		if (!participant || participant.state !== "active") return;
		if (!latest) {
			this.checkpoint(sharedId, { manual: false, note: "initial checkpoint" }).catch((error: unknown) => this.hub.log.warn({ err: errorText(error), sharedId }, "initial checkpoint failed"));
			return;
		}
		this.enqueueNotice(latest, peerId, participant.joinedAt ?? "");
	}

	private async prune(sharedId: string): Promise<void> {
		const held = this.store.checkpoints(sharedId).filter((c) => c.snapshotPath !== null);
		for (const old of held.slice(0, Math.max(0, held.length - KEEP_SNAPSHOTS))) {
			await this.files.remove(old.snapshotPath as string).catch(() => {});
			this.store.updateCheckpoint(sharedId, old.seq, { snapshotPath: null });
		}
	}

	// ------------------------------------------------------------------ participant: receiving notices, downloading

	receiveNotice(peerId: string, sharedId: string, notice: wire.SharedCheckpointNotice): void {
		const shared = this.store.find(sharedId);
		if (!shared || shared.state !== "active") throw ApiError.notFound("Shared session");
		if (notice.epoch < shared.epoch) throw new ApiError(409, "stale_epoch", `The checkpoint carries epoch ${notice.epoch}; the shared session is at epoch ${shared.epoch}`, { currentEpoch: shared.epoch, driverNodeId: shared.driverNodeId });
		if (notice.epoch > shared.epoch) {
			void this.hub.epochs.reconcilePeer(peerId);
			throw new ApiError(409, "epoch_unknown", `The checkpoint carries epoch ${notice.epoch}; this node is still at epoch ${shared.epoch} and is asking who drives now`, { currentEpoch: shared.epoch });
		}
		if (shared.localRole === "driver") throw ApiError.conflict("This node drives the shared session; it does not take checkpoints from another driver");
		if (peerId !== shared.driverNodeId) throw new ApiError(403, "forbidden", "Only the driver of the shared session may announce checkpoints");
		const { row, inserted } = this.store.insertCheckpoint({
			sharedSessionId: sharedId,
			seq: notice.seq,
			epoch: notice.epoch,
			nodeId: peerId,
			branch: notice.branch,
			commit: notice.commit ?? null,
			pushed: notice.pushed,
			snapshotSha256: notice.snapshot?.sha256 ?? null,
			snapshotSize: notice.snapshot?.size ?? null,
			snapshotMessages: notice.snapshot?.messageCount ?? null,
			snapshotPath: null,
			model: notice.model ?? null,
			deliveredTo: [],
			note: notice.note ?? null,
			createdAt: notice.at,
		});
		if (inserted) {
			if (notice.seq > shared.lastCheckpointSeq) this.store.update(sharedId, { lastCheckpointSeq: notice.seq });
			this.hub.changed(sharedId, { checkpoints: [row] });
		}
		if (row.snapshotSha256 && !row.snapshotPath) void this.download(sharedId, notice.seq);
		else if (row.snapshotPath) this.enqueueAck(row);
	}

	async downloadPending(peerId?: string): Promise<void> {
		try {
			for (const row of this.store.pendingSnapshots()) {
				if (peerId !== undefined && row.nodeId !== peerId) continue;
				await this.download(row.sharedSessionId, row.seq);
			}
		} catch (error) {
			this.hub.log.warn({ err: errorText(error) }, "downloading pending snapshots failed");
		}
	}

	private download(sharedId: string, seq: number): Promise<void> {
		const key = `${sharedId}:${seq}`;
		const running = this.downloads.get(key);
		if (running) return running;
		const work = this.runDownload(sharedId, seq).finally(() => this.downloads.delete(key));
		this.downloads.set(key, work);
		return work;
	}

	private async runDownload(sharedId: string, seq: number): Promise<void> {
		if (this.stopped) return;
		const row = this.store.checkpoint(sharedId, seq);
		if (!row || row.snapshotPath || !row.snapshotSha256 || row.snapshotSize === null) return;
		const peer = this.ctx.network.peers.row(row.nodeId);
		if (!peer || (peer.status !== "online" && peer.status !== "degraded")) return; // `peers.onChange(online)` retries
		const tmp = await this.files.temporary(sharedId, `get-${seq}`);
		const key = `${sharedId}:${seq}`;
		try {
			await downloadSnapshot(this.ctx, peer, { sharedId, seq, expected: { sha256: row.snapshotSha256, size: row.snapshotSize } }, tmp, { maxBytes: this.hub.options.maxSnapshotBytes, idleMs: this.hub.options.downloadIdleMs });
			const current = this.store.checkpoint(sharedId, seq);
			if (!current || current.snapshotPath) {
				await rm(tmp, { force: true });
				return;
			}
			const relative = await this.files.place(tmp, sharedId, seq);
			const updated = this.store.updateCheckpoint(sharedId, seq, { snapshotPath: relative }) as CheckpointRow;
			this.failures.delete(key);
			await this.prune(sharedId);
			this.enqueueAck(updated);
			this.hub.changed(sharedId, { checkpoints: [updated] });
		} catch (error) {
			await rm(tmp, { force: true });
			if (error instanceof SnapshotRejectedError) {
				this.hub.log.warn({ err: error.message, sharedId, seq }, "a snapshot cannot be downloaded");
				this.store.updateCheckpoint(sharedId, seq, { note: `${row.note ? `${row.note} · ` : ""}snapshot unavailable: ${error.message}`.slice(0, 500), snapshotSha256: null, snapshotSize: null, snapshotMessages: null });
				const failed = this.store.checkpoint(sharedId, seq);
				if (failed) this.hub.changed(sharedId, { checkpoints: [failed] });
				return;
			}
			this.hub.log.debug({ err: errorText(error), sharedId, seq }, "snapshot download failed; retrying");
			this.scheduleRetry(sharedId, seq);
		}
	}

	private scheduleRetry(sharedId: string, seq: number): void {
		const key = `${sharedId}:${seq}`;
		if (this.stopped || this.retryTimers.has(key)) return;
		const failed = (this.failures.get(key) ?? 0) + 1;
		this.failures.set(key, failed);
		const delay = this.hub.options.retryMs * Math.min(MAX_RETRY_FACTOR, 2 ** (failed - 1));
		const timer = setTimeout(() => {
			this.retryTimers.delete(key);
			void this.download(sharedId, seq);
		}, delay);
		timer.unref();
		this.retryTimers.set(key, timer);
	}

	private enqueueAck(row: CheckpointRow): void {
		if (!row.snapshotSha256 || row.snapshotSize === null) return;
		const body: wire.SharedCheckpointAck = { sha256: row.snapshotSha256, size: row.snapshotSize };
		this.hub.enqueue({
			peerId: row.nodeId,
			sharedSessionId: row.sharedSessionId,
			kind: "shared.snapshot_ack",
			refId: `${row.sharedSessionId}:${row.seq}`,
			path: `/shared/${row.sharedSessionId}/checkpoints/${row.seq}/ack`,
			body,
			idempotencyKey: `shared.snapshot_ack:${row.sharedSessionId}:${row.seq}`,
		});
	}

	// ------------------------------------------------------------------ driver: acknowledgements, serving

	receiveAck(peerId: string, sharedId: string, seq: number, ack: wire.SharedCheckpointAck): void {
		const shared = this.store.find(sharedId);
		if (!shared || shared.localRole !== "driver") throw ApiError.notFound("Shared session");
		const participant = this.store.participant(sharedId, peerId);
		if (!participant || participant.state !== "active") throw new ApiError(403, "forbidden", "Only participants of the shared session may acknowledge snapshots");
		const row = this.store.checkpoint(sharedId, seq);
		if (!row || row.snapshotSha256 !== ack.sha256) throw ApiError.notFound("Checkpoint");
		if (!row.deliveredTo.includes(peerId)) {
			const updated = this.store.updateCheckpoint(sharedId, seq, { deliveredTo: [...row.deliveredTo, peerId] }) as CheckpointRow;
			this.hub.changed(sharedId, { checkpoints: [updated] });
		}
		if (participant.snapshotSeq < seq) this.store.updateParticipant(sharedId, peerId, { snapshotSeq: seq });
		for (const waiter of [...this.waiters]) if (waiter.key === `${sharedId}:${seq}:${peerId}`) waiter.resolve();
	}

	snapshotFile(sharedId: string, seq: number): { path: string; size: number; sha256: string } {
		const row = this.store.checkpoint(sharedId, seq);
		if (!row || !row.snapshotPath || !row.snapshotSha256 || row.snapshotSize === null) throw ApiError.notFound("Snapshot");
		return { path: this.files.absolute(row.snapshotPath), size: row.snapshotSize, sha256: row.snapshotSha256 };
	}

	waitDelivered(sharedId: string, seq: number, peerId: string, timeoutMs: number): Promise<void> {
		const delivered = (): boolean => this.store.checkpoint(sharedId, seq)?.deliveredTo.includes(peerId) === true;
		if (delivered()) return Promise.resolve();
		const key = `${sharedId}:${seq}:${peerId}`;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const waiter: Waiter = {
			key,
			resolve: () => {
				clearTimeout(timer);
				this.waiters.delete(waiter);
				resolve();
			},
		};
		const timer = setTimeout(() => {
			this.waiters.delete(waiter);
			reject(new ApiError(409, "snapshot_not_delivered", "The other node did not confirm holding the snapshot in time"));
		}, timeoutMs);
		this.waiters.add(waiter);
		return promise;
	}

	/** Local project path of a shared session (used by takeover for `omp session unpack --cwd`). */
	projectPath(shared: SharedRow): string | null {
		if (!shared.localProjectId) return null;
		return this.ctx.db.select({ path: projects.path }).from(projects).where(eq(projects.id, shared.localProjectId)).get()?.path ?? null;
	}
}
