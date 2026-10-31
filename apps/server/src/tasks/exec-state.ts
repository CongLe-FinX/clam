import type { PreparedBranch } from "./task-git.ts";
import type { TaskRow } from "./store.ts";

/** Why a `blocked` executor task waits; decides what unblocks it (`TaskExecutor.messageInjected`, `decide`, `ui_request_resolved`). */
export type BlockedFor = "question" | "agent" | "approval" | "aborted" | "tree";

/** Executor-private run state, stored in `tasks.exec_state`; never leaves the node. */
export interface ExecState {
	/** The task occupies its project's working tree (branch prepared / session started) until it ends. */
	holdsTree?: boolean;
	prepared?: PreparedBranch;
	/** `mesh_complete` of the executing agent; finalised when the session next settles. */
	completion?: { outcome: "succeeded" | "failed" | "blocked"; summary: string; at: string };
	reminderSent?: boolean;
	blockedFor?: BlockedFor;
	cancelling?: boolean;
	/** The last prompt ended with an error (e.g. `--max-cost` reached). */
	promptError?: string;
	/** The last prompt was aborted by someone on this node. */
	aborted?: boolean;
	sessionStarted?: boolean;
}

export const execState = (task: Pick<TaskRow, "execState">): ExecState => task.execState as ExecState;
