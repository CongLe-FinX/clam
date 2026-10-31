import type { HandoffRole, HandoffState } from "@clam/contracts";

/**
 * State machines of docs/handoff-protocol.md §3, as data. Differences from the doc, all deliberate:
 * - target `git_restored` is `files_restored` (work may have no git repo: files travel as a bundle);
 * - source `accepted → failed` / `awaiting_ack → failed`: the target reported `failed` (§6.1: "mark failed, stay owner");
 * - target `acked → failed` exists for the superseded path (§6.2: the source reclaimed, `stale_epoch`);
 * - target `received → failed` / `accepted → failed` carry `failed(timeout)` after the restore deadline (§6.2, §7);
 * - a cancel that arrives after `persisted` ends as `failed` with `failure_code = cancelled` (the doc's diagram
 *   only has direct `cancelled` edges from `accepted`/`persisted`).
 */

export type SourceState =
	| "draft"
	| "preparing"
	| "prepare_failed"
	| "offered"
	| "accepted"
	| "awaiting_ack"
	| "ack_timeout"
	| "acked"
	| "released"
	| "completed"
	| "rejected"
	| "expired"
	| "cancelled"
	| "reclaimed"
	| "failed";

export type TargetState =
	| "received"
	| "accepted"
	| "persisted"
	| "files_restored"
	| "context_restored"
	| "deps_ready"
	| "validated"
	| "session_created"
	| "acked"
	| "owner"
	| "resumed"
	| "completed"
	| "rejected"
	| "failed"
	| "cancelled";

type Table<S extends string> = Readonly<Record<S, readonly S[]>>;

export const SOURCE_TRANSITIONS: Table<SourceState> = {
	draft: ["preparing"],
	preparing: ["prepare_failed", "offered"],
	prepare_failed: ["draft"],
	offered: ["accepted", "rejected", "expired", "cancelled"],
	accepted: ["awaiting_ack", "failed"],
	awaiting_ack: ["acked", "ack_timeout", "cancelled", "failed"],
	ack_timeout: ["awaiting_ack", "reclaimed"],
	acked: ["released"],
	released: ["completed"],
	completed: [],
	rejected: [],
	expired: [],
	cancelled: [],
	reclaimed: [],
	failed: [],
};

export const TARGET_TRANSITIONS: Table<TargetState> = {
	received: ["rejected", "accepted", "failed"],
	accepted: ["persisted", "cancelled", "failed"],
	persisted: ["files_restored", "failed", "cancelled"],
	files_restored: ["context_restored", "failed"],
	context_restored: ["deps_ready", "failed"],
	deps_ready: ["validated", "failed"],
	validated: ["session_created", "failed"],
	session_created: ["acked", "failed"],
	acked: ["owner", "failed"],
	owner: ["resumed"],
	resumed: ["completed"],
	completed: [],
	rejected: [],
	failed: [],
	cancelled: [],
};

export const SOURCE_TERMINAL: ReadonlySet<SourceState> = new Set(["completed", "rejected", "expired", "cancelled", "reclaimed", "failed"]);
export const TARGET_TERMINAL: ReadonlySet<TargetState> = new Set(["completed", "rejected", "failed", "cancelled"]);

/** States in which the source is still the executing owner of epoch n (it must not release without a valid ack). */
export const SOURCE_OWNS_EPOCH: ReadonlySet<SourceState> = new Set([
	"draft",
	"preparing",
	"prepare_failed",
	"offered",
	"accepted",
	"awaiting_ack",
	"ack_timeout",
]);

const SOURCE_STATES = Object.keys(SOURCE_TRANSITIONS) as SourceState[];
const TARGET_STATES = Object.keys(TARGET_TRANSITIONS) as TargetState[];

export function isSourceState(state: string): state is SourceState {
	return (SOURCE_STATES as string[]).includes(state);
}
export function isTargetState(state: string): state is TargetState {
	return (TARGET_STATES as string[]).includes(state);
}

function tableFor(role: HandoffRole): Table<string> {
	return role === "source" ? SOURCE_TRANSITIONS : TARGET_TRANSITIONS;
}

export function isTerminal(role: HandoffRole, state: HandoffState): boolean {
	return role === "source" ? SOURCE_TERMINAL.has(state as SourceState) : TARGET_TERMINAL.has(state as TargetState);
}

/** Allowed edge? Unknown states for the role are never allowed. */
export function canTransition(role: HandoffRole, from: HandoffState, to: HandoffState): boolean {
	return tableFor(role)[from]?.includes(to) ?? false;
}

/**
 * Shortest chain of allowed edges `from → … → to` (excluding `from`, including `to`); `[]` when equal, null when
 * unreachable. Recovery may need an intermediate hop (e.g. source `ack_timeout → awaiting_ack → acked`); persist each hop.
 */
export function transitionPath(role: HandoffRole, from: HandoffState, to: HandoffState): HandoffState[] | null {
	if (from === to) return [];
	const table = tableFor(role);
	const previous = new Map<string, string>();
	const queue: string[] = [from];
	while (queue.length > 0) {
		const current = queue.shift() as string;
		for (const next of table[current] ?? []) {
			if (previous.has(next) || next === from) continue;
			previous.set(next, current);
			if (next === to) {
				const path: string[] = [];
				for (let at: string | undefined = to; at !== undefined && at !== from; at = previous.get(at)) path.unshift(at);
				return path as HandoffState[];
			}
			queue.push(next);
		}
	}
	return null;
}

export class InvalidTransitionError extends Error {
	readonly code = "invalid_transition" as const;
	constructor(
		readonly role: HandoffRole,
		readonly from: string,
		readonly to: string,
	) {
		super(`Invalid ${role} handoff transition ${from} → ${to}`);
		this.name = "InvalidTransitionError";
	}
}

export function assertTransition(role: HandoffRole, from: HandoffState, to: HandoffState): void {
	if (!canTransition(role, from, to)) throw new InvalidTransitionError(role, from, to);
}

// ------------------------------------------------------------------ the ten target steps (§4)

export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface TargetStepDef {
	n: number;
	name: string;
	/** Target state reached once this step completed. */
	doneState: TargetState;
}

export const TARGET_STEPS: readonly TargetStepDef[] = [
	{ n: 1, name: "receive", doneState: "received" },
	{ n: 2, name: "persist", doneState: "persisted" },
	{ n: 3, name: "restore_files", doneState: "files_restored" },
	{ n: 4, name: "restore_context", doneState: "context_restored" },
	{ n: 5, name: "setup_dependencies", doneState: "deps_ready" },
	{ n: 6, name: "validate_workspace", doneState: "validated" },
	{ n: 7, name: "create_session", doneState: "session_created" },
	{ n: 8, name: "durable_ack", doneState: "acked" },
	{ n: 9, name: "acquire_ownership", doneState: "owner" },
	{ n: 10, name: "resume", doneState: "resumed" },
];

/** Steps 3–6 are idempotent and resumable (§4); 2, 7 and 8 are re-entrant by their own rules (§6.2). */
export const IDEMPOTENT_STEPS: ReadonlySet<number> = new Set([3, 4, 5, 6]);

/**
 * First step of 1..10 that is not `done`/`skipped` (a `failed`/`running` one counts: that is where a restart
 * resumes). Steps missing from `steps` are pending. Null when all ten are finished.
 */
export function nextTargetStep(steps: ReadonlyArray<{ n: number; state: StepStatus }>): TargetStepDef | null {
	for (const def of TARGET_STEPS) {
		const state = steps.find((s) => s.n === def.n)?.state ?? "pending";
		if (state !== "done" && state !== "skipped") return def;
	}
	return null;
}

/** The step that follows the one that produced `state` (e.g. `session_created` → step 8); null if none. */
export function stepAfterState(state: TargetState): TargetStepDef | null {
	const index = TARGET_STEPS.findIndex((s) => s.doneState === state);
	return index < 0 ? null : (TARGET_STEPS[index + 1] ?? null);
}
