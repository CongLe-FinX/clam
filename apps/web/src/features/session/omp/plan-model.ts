import type { TodoPhase } from "@clam/contracts";

export const isDone = (status: string): boolean => status === "completed" || status === "done";
export const isDropped = (status: string): boolean => status === "abandoned" || status === "cancelled" || status === "dropped";
export const isActive = (status: string): boolean => status === "in_progress" || status === "active";

export interface PlanStats {
	total: number;
	done: number;
	/** Dropped tasks do not count towards the total. */
	percent: number;
	/** The task being worked on: the first in progress, else the first still pending. */
	current: { phase: string; content: string } | null;
	complete: boolean;
}

export function planStats(phases: readonly TodoPhase[] | undefined): PlanStats {
	let total = 0;
	let done = 0;
	let active: PlanStats["current"] = null;
	let pending: PlanStats["current"] = null;
	for (const phase of phases ?? []) {
		for (const task of phase.tasks) {
			if (isDropped(task.status)) continue;
			total++;
			if (isDone(task.status)) done++;
			else if (isActive(task.status)) active ??= { phase: phase.name, content: task.content };
			else pending ??= { phase: phase.name, content: task.content };
		}
	}
	return { total, done, percent: total === 0 ? 0 : Math.round((done / total) * 100), current: active ?? pending, complete: total > 0 && done === total };
}

/** Changes to the plan are small, stable strings: used to tell when a dismissed chip should come back. */
export function planSignature(phases: readonly TodoPhase[] | undefined): string {
	return (phases ?? []).map((p) => `${p.name}:${p.tasks.map((t) => t.content).join("|")}`).join("/");
}

export type ChangeKind = "added" | "started" | "completed" | "dropped" | "blocked" | "unblocked";

export interface TodoChange {
	/** One line: what the agent did to the plan. */
	title: string;
	items: Array<{ kind: ChangeKind; content: string }>;
}

function strings(value: unknown): string[] {
	if (typeof value === "string") return value.trim() ? [value.trim()] : [];
	if (!Array.isArray(value)) return [];
	return value.flatMap((v) => {
		if (typeof v === "string") return strings(v);
		if (v && typeof v === "object" && "content" in v && typeof v.content === "string") return strings(v.content);
		return [];
	});
}

interface TodoDetails {
	op?: string | null;
	phases?: TodoPhase[];
	completedTasks?: Array<{ phase: string; content: string }>;
}

/** What one `todo` tool call changed, from its arguments and the structured result. */
export function todoChange(args: unknown, details: unknown): TodoChange {
	const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	const d = (details && typeof details === "object" ? details : {}) as TodoDetails;
	const op = (typeof a.op === "string" ? a.op : d.op) ?? "";
	const targets = [...strings(a.task), ...strings(a.tasks)];
	const named = (kind: ChangeKind): TodoChange["items"] => targets.map((content) => ({ kind, content }));
	switch (op) {
		case "init": {
			const all = (d.phases ?? []).flatMap((p) => p.tasks.map((t) => t.content));
			const items = (all.length > 0 ? all : [...strings(a.items), ...strings(a.list)]).map((content) => ({ kind: "added" as const, content }));
			return { title: items.length > 0 ? `Planned ${items.length} ${items.length === 1 ? "task" : "tasks"}` : "Planned the work", items };
		}
		case "append": {
			const items = strings(a.items).map((content) => ({ kind: "added" as const, content }));
			return { title: items.length > 0 ? `Added ${items.length} ${items.length === 1 ? "task" : "tasks"}` : "Extended the plan", items };
		}
		case "start":
			return { title: "Started", items: named("started") };
		case "done": {
			const finished = (d.completedTasks ?? []).map((t) => ({ kind: "completed" as const, content: t.content }));
			const items = finished.length > 0 ? finished : named("completed");
			return { title: items.length === 1 ? "Completed" : `Completed ${items.length} tasks`, items };
		}
		case "drop":
		case "rm":
			return { title: op === "rm" ? "Removed" : "Dropped", items: named("dropped") };
		case "block":
			return { title: "Blocked", items: named("blocked") };
		case "unblock":
			return { title: "Unblocked", items: named("unblocked") };
		default:
			return { title: "Looked at the plan", items: [] };
	}
}
