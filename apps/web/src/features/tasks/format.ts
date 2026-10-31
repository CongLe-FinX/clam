import type { Project, Task, TaskMessage, TaskParty, TaskStatus } from "@clam/contracts";
import type { LucideIcon } from "lucide-react";
import { CheckCircle2, CircleDashed, CircleSlash, Clock, Hand, Loader2, OctagonAlert, Send, XCircle } from "lucide-react";

export type BadgeVariant = "neutral" | "accent" | "success" | "warning" | "danger" | "outline";

export const STATUS_META: Record<TaskStatus, { label: string; variant: BadgeVariant; icon: LucideIcon; spin?: boolean }> = {
	offered: { label: "Offered", variant: "warning", icon: Send },
	accepted: { label: "Queued", variant: "neutral", icon: Clock },
	running: { label: "Running", variant: "accent", icon: Loader2, spin: true },
	blocked: { label: "Blocked", variant: "warning", icon: Hand },
	succeeded: { label: "Succeeded", variant: "success", icon: CheckCircle2 },
	failed: { label: "Failed", variant: "danger", icon: XCircle },
	rejected: { label: "Rejected", variant: "danger", icon: CircleSlash },
	cancelled: { label: "Cancelled", variant: "neutral", icon: OctagonAlert },
	handed_off: { label: "Handed off", variant: "neutral", icon: CircleDashed },
};

export type BoardColumn = "offered" | "active" | "done" | "closed";

export const COLUMNS: Array<{ id: BoardColumn; label: string; hint: string }> = [
	{ id: "offered", label: "Offered", hint: "Waiting for a decision" },
	{ id: "active", label: "In progress", hint: "Queued · running · blocked" },
	{ id: "done", label: "Done", hint: "Succeeded" },
	{ id: "closed", label: "Failed & closed", hint: "Failed · rejected · cancelled" },
];

export function columnOf(status: TaskStatus): BoardColumn {
	switch (status) {
		case "offered":
			return "offered";
		case "accepted":
		case "running":
		case "blocked":
			return "active";
		case "succeeded":
			return "done";
		default:
			return "closed";
	}
}

const TERMINAL: Record<string, true> = { rejected: true, succeeded: true, failed: true, cancelled: true, handed_off: true };
export const isTerminal = (status: TaskStatus): boolean => TERMINAL[status] === true;

/** The node on the other end of the task, from this node's point of view. */
export const otherParty = (t: Task): TaskParty => (t.direction === "incoming" ? t.sender : t.executor);
/** The party that lives on THIS node (session links are only meaningful for it). */
export const ownParty = (t: Task): TaskParty => (t.direction === "incoming" ? t.executor : t.sender);

export const partyLabel = (p: TaskParty): string => (p.agentName ? `${p.agentName}@${p.nodeName}` : p.nodeName);

/** Loop guard: agent-authored messages each node allows per task (docs/architecture.md, M4). */
export const AGENT_MESSAGE_LIMIT = 12;

/** `https://github.com/Owner/Repo(.git)` · `git@github.com:Owner/Repo.git` → `owner/repo` (lower-case), else null. */
export function repoSlug(url: string): string | null {
	const m = /github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?(?:[#?].*)?$/i.exec(url.trim());
	return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/** Local projects whose linked GitHub repository is the task's repository. */
export function projectsForRepo(url: string, projects: Project[]): Project[] {
	const slug = repoSlug(url);
	if (!slug) return [];
	return projects.filter((p) => p.repository && `${p.repository.owner}/${p.repository.name}`.toLowerCase() === slug);
}

export function formatAge(iso: string, now = Date.now()): string {
	const s = Math.max(0, (now - Date.parse(iso)) / 1000);
	if (s < 45) return "now";
	if (s < 3600) return `${Math.round(s / 60)}m`;
	if (s < 86_400) return `${Math.round(s / 3600)}h`;
	return `${Math.round(s / 86_400)}d`;
}

/** Author line of a discussion message: `agent@node`, `human@node` or `system`. */
export function authorLabel(m: { author: TaskMessage["author"] }): string {
	if (m.author.kind === "system") return "System";
	const who = m.author.kind === "agent" ? (m.author.agentName ?? "agent") : "human";
	return `${who}@${m.author.nodeName}`;
}

export const KIND_META: Record<TaskMessage["kind"], { label: string; variant: BadgeVariant }> = {
	question: { label: "Question", variant: "warning" },
	answer: { label: "Answer", variant: "success" },
	instruction: { label: "Instruction", variant: "accent" },
	note: { label: "Note", variant: "neutral" },
};

export const APPROVAL_MODES = [
	{ value: "always-ask", label: "Always ask" },
	{ value: "always-ask-cached", label: "Always ask (remember)" },
	{ value: "write", label: "Ask for writes" },
	{ value: "yolo", label: "Auto-approve everything" },
] as const;
