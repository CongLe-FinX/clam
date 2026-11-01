import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";
import { t, tr } from "@/i18n";
import { Badge } from "@/ui/badge";
import { KIND_META } from "./format.ts";

/** The host tools CL Agent Mesh registers in every OMP runtime (`MESH_HOST_TOOLS` in @clam/contracts; kept local so the session chunk does not bundle the Zod schemas). */
const MESH_TOOLS: Record<string, true> = { mesh_agents: true, mesh_delegate: true, mesh_message: true, mesh_task: true, mesh_complete: true };
export const isMeshTool = (name: string): boolean => MESH_TOOLS[name] === true;

interface Rec {
	status: "running" | "ok" | "error" | "interrupted";
	result?: string;
}

function arg(args: unknown, ...keys: string[]): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	for (const k of keys) {
		const v = (args as Record<string, unknown>)[k];
		if (typeof v === "string" && v.trim()) return v.trim();
	}
	return undefined;
}

function clip(s: string, n: number): string {
	const one = s.replace(/\s+/g, " ").trim();
	return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

const firstLine = (s: string | undefined): string => clip((s ?? "").split("\n").find((l) => l.trim()) ?? "", 160);

function TaskLink({ taskId }: { taskId: string }) {
	return (
		<Link to="/tasks/$taskId" params={{ taskId }} className="inline-flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-0.5 text-2xs font-medium text-accent outline-none hover:bg-accent-soft focus-visible:bg-accent-soft coarse:py-2">
			{t("Open task")} <ArrowUpRight className="size-3" aria-hidden />
		</Link>
	);
}

/**
 * Compact rendering of the CL Agent Mesh host tools inside a tool card: a one-line headline for the card header and an
 * optional body line (message preview, outcome, task link). The raw arguments/result stay available when the card is expanded.
 */
export function meshSummary(name: string, args: unknown, rec: Rec | undefined): { headline: string; extra: ReactNode } | null {
	const running = !rec || rec.status === "running";
	const failed = rec?.status === "error" || rec?.status === "interrupted";
	const result = rec?.result;
	switch (name) {
		case "mesh_delegate": {
			const title = arg(args, "title") ?? t("a task");
			const m = result ? /task (\S+)(?: to ([^\s,.]+@?[^\s,]*))?/.exec(result) : null;
			const taskId = !failed && result?.startsWith("Delegated") ? m?.[1] : undefined;
			const target = m?.[2] ?? [arg(args, "agent", "agentName", "agentId"), arg(args, "node", "nodeName", "nodeId", "target")].filter(Boolean).join("@");
			const shortTitle = clip(title, 60);
			const headline = running
				? target
					? t("Delegating ‘{title}’ to {target}…", { title: shortTitle, target })
					: t("Delegating ‘{title}’…", { title: shortTitle })
				: failed || !taskId
					? t("Could not delegate ‘{title}’", { title: shortTitle })
					: t("Delegated ‘{title}’ to {target}", { title: shortTitle, target: target || t("another machine") });
			return {
				headline,
				extra: taskId ? (
					<div className="flex items-center justify-between gap-2 border-t px-3 py-1">
						<span className="min-w-0 truncate text-2xs text-subtle">{t("The task is tracked on the Tasks board; the executor's messages arrive in this session.")}</span>
						<TaskLink taskId={taskId} />
					</div>
				) : failed || (rec && !taskId) ? (
					<p className="border-t px-3 py-1.5 text-2xs text-danger">{firstLine(result)}</p>
				) : null,
			};
		}
		case "mesh_message": {
			const text = arg(args, "text", "message") ?? "";
			const kind = arg(args, "kind") as keyof typeof KIND_META | undefined;
			const taskId = arg(args, "taskId", "task_id", "task");
			const meta = kind ? KIND_META[kind] : undefined;
			return {
				headline: running ? t("Sending a message…") : failed ? t("Message not sent") : meta ? t("Sent {kind}: {text}", { kind: tr(meta.label).toLowerCase(), text: clip(text, 80) }) : t("Sent message: {text}", { text: clip(text, 80) }),
				extra: (
					<div className="flex items-start gap-2 border-t px-3 py-1.5">
						{meta ? <Badge variant={meta.variant}>{tr(meta.label)}</Badge> : null}
						<p className="line-clamp-2 min-w-0 flex-1 text-xs text-muted-foreground">{failed ? firstLine(result) : clip(text, 240)}</p>
						{taskId ? <TaskLink taskId={taskId} /> : null}
					</div>
				),
			};
		}
		case "mesh_complete": {
			const outcome = arg(args, "outcome") ?? "succeeded";
			const taskId = arg(args, "taskId", "task_id", "task");
			const variant = outcome === "succeeded" ? "success" : outcome === "blocked" ? "warning" : "danger";
			return {
				headline: running ? t("Reporting the result…") : failed ? t("Could not report the result") : t("Finished the task — {outcome}", { outcome }),
				extra: (
					<div className="flex items-start gap-2 border-t px-3 py-1.5">
						<Badge variant={failed ? "danger" : variant}>{failed ? t("error") : outcome}</Badge>
						<p className="line-clamp-2 min-w-0 flex-1 text-xs text-muted-foreground">{failed ? firstLine(result) : clip(arg(args, "summary") ?? "", 240)}</p>
						{taskId ? <TaskLink taskId={taskId} /> : null}
					</div>
				),
			};
		}
		case "mesh_agents":
			return {
				headline: running ? t("Looking up the agent directory…") : failed ? t("Could not read the agent directory") : t("Looked up the agent directory"),
				extra: result && !running ? <p className="line-clamp-2 border-t px-3 py-1.5 text-xs text-muted-foreground">{firstLine(result)}</p> : null,
			};
		case "mesh_task": {
			const taskId = arg(args, "taskId", "task_id", "task");
			return {
				headline: running ? t("Checking a task…") : failed ? t("Could not read the task") : taskId ? t("Checked task {id}", { id: taskId.slice(0, 12) }) : t("Checked task"),
				extra:
					!running && (taskId || result) ? (
						<div className="flex items-start gap-2 border-t px-3 py-1.5">
							<p className="line-clamp-2 min-w-0 flex-1 text-xs text-muted-foreground">{firstLine(result)}</p>
							{taskId ? <TaskLink taskId={taskId} /> : null}
						</div>
					) : null,
			};
		}
		default:
			return null;
	}
}
