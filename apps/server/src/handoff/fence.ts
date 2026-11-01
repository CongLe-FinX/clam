import { i18nMsg, type TaskStatus } from "@clam/contracts";
import type { SourceState } from "@clam/handoff-engine";
import { bootFenceDecision } from "@clam/handoff-engine";
import { isTerminalStatus } from "@clam/task-engine";
import { ApiError } from "../http/errors.ts";
import type { SessionPromptGuard } from "../services/session-service.ts";
import { execState } from "../tasks/exec-state.ts";
import type { TaskRow } from "../tasks/store.ts";
import type { FenceApi, HandoffHub } from "./hub.ts";
import { isTerminalState } from "./store.ts";

/** Prompts the handoff engine sends itself (the target's resume prompt of its new session) carry a client id with this prefix. */
export const HANDOFF_PROMPT_PREFIX = "handoff_";

/**
 * Local fencing of tasks (docs/handoff-protocol.md §5, §8). A task is FROZEN while a handoff holds it (`execState.handoffId`: the executor
 * ignores it) and FENCED once this node lost ownership (`tasks.fenced`: never started, resumed, prompted or retried again). Only the executing
 * rows (`direction = incoming`) are ever frozen or fenced; the sender's mirror rows follow the executor instead (`TaskSender.followExecutor`).
 */
export class FenceService implements FenceApi {
	/** In-doubt tasks of this boot (`bootFenceDecision(...).blockResume`): their session is not resumed automatically. */
	private readonly inDoubt = new Set<string>();

	constructor(private readonly hub: HandoffHub) {}

	private get tasks() {
		return this.hub.ctx.tasks.store;
	}

	isFenced(taskId: string): boolean {
		return this.tasks.find(taskId)?.fenced === true;
	}

	isFrozen(taskId: string): boolean {
		const row = this.tasks.find(taskId);
		return row !== undefined && execState(row).handoffId !== undefined;
	}

	freeze(taskId: string, handoffId: string): void {
		const row = this.tasks.get(taskId);
		if (row.fenced) throw new ApiError(409, "task_fenced", i18nMsg("This node no longer owns the task"), { epoch: row.highestSeenEpoch });
		const holder = execState(row).handoffId;
		if (holder !== undefined && holder !== handoffId) {
			throw new ApiError(409, "handoff_in_progress", i18nMsg("Task {taskId} is already held by handoff {handoffId}", { taskId, handoffId: holder }), { handoffId: holder });
		}
		if (holder === handoffId) return;
		this.tasks.patchExecState(taskId, { handoffId });
	}

	unfreeze(taskId: string, handoffId: string): void {
		const row = this.tasks.find(taskId);
		if (!row || execState(row).handoffId !== handoffId) return;
		this.tasks.patchExecState(taskId, { handoffId: undefined });
		// The agent's turn may have been aborted for the handoff: let the executor pick the task up again.
		void this.hub.ctx.tasks.executor.thaw(taskId, handoffId).catch((error: unknown) => this.hub.log.warn({ taskId, handoffId, err: error instanceof Error ? error.message : String(error) }, "resuming a task after its handoff ended failed"));
	}

	fence(taskId: string, epoch: number, reason: string): void {
		const row = this.tasks.get(taskId);
		const wasFenced = row.fenced;
		this.markFenced(row, epoch);
		this.inDoubt.delete(taskId);
		if (wasFenced) return;
		this.hub.log.info({ taskId, epoch, reason }, "task fenced");
		this.hub.ctx.tasks.changed(taskId, { notifyPeer: false });
	}

	assertOwner(taskId: string, expectedEpoch?: number): void {
		const row = this.tasks.get(taskId);
		if (row.fenced || row.highestSeenEpoch > row.epoch) {
			throw new ApiError(409, "task_fenced", i18nMsg("This node no longer owns task {taskId}: it continues at epoch {epoch}", { taskId, epoch: Math.max(row.highestSeenEpoch, row.epoch) }), { currentEpoch: Math.max(row.highestSeenEpoch, row.epoch) });
		}
		if (expectedEpoch !== undefined && row.epoch !== expectedEpoch) {
			throw new ApiError(409, "stale_epoch", i18nMsg("Task {taskId} is at epoch {epoch}, not {expected}", { taskId, epoch: row.epoch, expected: expectedEpoch }), { currentEpoch: row.epoch });
		}
	}

	blockedResume(taskId: string): boolean {
		return this.inDoubt.has(taskId);
	}

	unblockResume(taskId: string): boolean {
		return this.inDoubt.delete(taskId);
	}

	/**
	 * Boot, synchronously and before any runtime is spawned (§8.1/§8.3): fence what this node released or lost, remember what is in doubt, and
	 * settle the freeze markers (a marker of a live handoff stays, recovery decides; an orphan marker is lifted).
	 */
	bootScan(): void {
		this.inDoubt.clear();
		for (const row of this.tasks.list({ direction: "incoming" })) {
			if (row.status === "handed_off") {
				if (!row.fenced) this.markFenced(row, row.highestSeenEpoch);
				continue;
			}
			if (isTerminalStatus(row.status as TaskStatus)) {
				this.settleMarker(row);
				continue;
			}
			if (row.fenced) continue;
			// A target handoff that holds the task but never sent its resume prompt (crash at `acked` after the task row was already acquired, or
			// at `owner`, i.e. before step 10): the handoff itself sends the first prompt (`TargetFlow.resumeWork`, docs §6.2). A restart-recovery
			// prompt from the executor would take its place (or collide with the resume prompt: "already processing"), and the handed-over context
			// would never reach the agent, so the session is held back like an in-doubt one until the handoff resumed it.
			if (this.hub.store.bySubject(row.id, "target").some((h) => h.kind === "task" && (h.state === "acked" || h.state === "owner"))) this.inDoubt.add(row.id);
			const newest = this.hub.store.bySubject(row.id, "source").find((h) => h.kind === "task");
			const decision = bootFenceDecision({
				localEpoch: row.epoch,
				highestSeenEpoch: row.highestSeenEpoch,
				sourceState: (newest?.state as SourceState | undefined) ?? null,
			});
			if (decision.fence) {
				this.markFenced(row, Math.max(row.epoch, newest?.state === "acked" || newest?.state === "released" || newest?.state === "completed" ? newest.toEpoch : 0));
				this.hub.log.warn({ taskId: row.id, reason: decision.reason }, "boot fence scan: task fenced");
				continue;
			}
			if (decision.blockResume) {
				this.inDoubt.add(row.id);
				this.hub.log.warn({ taskId: row.id, reason: decision.reason }, "boot fence scan: in-doubt handoff, the task's session is not resumed automatically");
			}
			this.settleMarker(row);
		}
	}

	/** Session prompt guard: refuses prompts for the executing session of a fenced or frozen task. */
	guardPrompt: SessionPromptGuard = (row, input) => {
		const task = this.tasks.byExecutorSession(row.id);
		if (!task) return;
		if (task.fenced) throw new ApiError(409, "task_fenced", i18nMsg("Task {taskId} continues on another node; this session no longer owns it", { taskId: task.id }), { currentEpoch: Math.max(task.highestSeenEpoch, task.epoch) });
		const handoffId = execState(task).handoffId;
		if (handoffId === undefined) return;
		if (input?.clientId.startsWith(HANDOFF_PROMPT_PREFIX)) return;
		throw new ApiError(409, "handoff_in_progress", i18nMsg("Task {taskId} is being handed over (handoff {handoffId}); it cannot be prompted now", { taskId: task.id, handoffId }), { handoffId });
	};

	private markFenced(row: TaskRow, epoch: number): void {
		const highestSeenEpoch = Math.max(row.highestSeenEpoch, epoch);
		if (row.fenced && highestSeenEpoch === row.highestSeenEpoch) return;
		this.tasks.update(row.id, { fenced: true, highestSeenEpoch });
	}

	/** A freeze marker needs a live handoff: otherwise (crash after the handoff ended) the task is unfrozen. Never auto-runs a half-restored target row. */
	private settleMarker(row: TaskRow): void {
		const handoffId = execState(row).handoffId;
		if (handoffId === undefined) return;
		const handoff = this.hub.store.find(handoffId);
		if (handoff && !isTerminalState(handoff)) return;
		if (handoff?.role === "target" && !isTerminalStatus(row.status as TaskStatus) && row.status !== "running" && row.status !== "blocked") {
			// A target row that never became the running task: leave it frozen rather than starting a half-restored task.
			this.hub.log.warn({ taskId: row.id, handoffId }, "boot fence scan: task frozen by a finished target handoff stays frozen");
			return;
		}
		this.tasks.patchExecState(row.id, { handoffId: undefined });
		this.hub.log.info({ taskId: row.id, handoffId }, "boot fence scan: orphan freeze marker lifted");
	}
}
