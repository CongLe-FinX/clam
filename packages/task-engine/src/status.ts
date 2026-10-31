import { TERMINAL_TASK_STATUSES, type TaskStatus } from "@clam/contracts";

export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = ["offered", "accepted", "running", "blocked"];

export function isTerminalStatus(s: TaskStatus): boolean {
	return TERMINAL_TASK_STATUSES.includes(s);
}

export const ALLOWED_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
	offered: ["accepted", "rejected", "cancelled", "failed"],
	accepted: ["running", "blocked", "cancelled", "failed"],
	running: ["blocked", "succeeded", "failed", "cancelled", "handed_off"],
	blocked: ["running", "accepted", "succeeded", "failed", "cancelled", "handed_off"],
	rejected: [],
	succeeded: [],
	failed: [],
	cancelled: [],
	handed_off: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
	if (from === to) return false;
	return ALLOWED_TRANSITIONS[from].includes(to);
}

export class TaskTransitionError extends Error {
	readonly code = "illegal_transition" as const;
	constructor(
		readonly from: TaskStatus,
		readonly to: TaskStatus,
	) {
		super(`illegal task transition ${from} → ${to}`);
		this.name = "TaskTransitionError";
	}
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
	if (!canTransition(from, to)) throw new TaskTransitionError(from, to);
}

export function statusAfterCompletion(outcome: "succeeded" | "failed" | "blocked"): TaskStatus {
	return outcome;
}
