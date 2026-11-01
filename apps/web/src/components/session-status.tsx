import type { AgentSession, RuntimeState } from "@clam/contracts";
import { Badge } from "@/ui/badge";
import { StatusDot, type DotStatus } from "@/ui/status-dot";
import { MessageCircleQuestion } from "lucide-react";
import { cn } from "@/lib/utils";
import { msg, t, tr, type Msg } from "@/i18n";

export function sessionDot(status: AgentSession["status"]): DotStatus {
	return status === "running" ? "busy" : status === "error" ? "crashed" : status === "stopped" ? "offline" : "online";
}

export function runtimeDot(state: RuntimeState): DotStatus {
	switch (state) {
		case "ready":
			return "online";
		case "busy":
			return "busy";
		case "starting":
		case "restarting":
			return "starting";
		case "crashed":
			return "crashed";
		default:
			return "offline";
	}
}

/** Display labels of a session runtime's state (the one map for every screen; render with `tr()`). */
export const RUNTIME_STATE_LABEL: Record<RuntimeState, Msg> = {
	stopped: msg("Stopped"),
	starting: msg("Starting"),
	ready: msg("Ready"),
	busy: msg("Busy"),
	crashed: msg("Crashed"),
	restarting: msg("Restarting"),
};

/** Display labels of a session's status (render with `tr()`). */
export const SESSION_STATUS_LABEL: Record<AgentSession["status"], Msg> = { idle: msg("Idle"), running: msg("Running"), error: msg("Error"), stopped: msg("Stopped") };

export function SessionStatusBadge({ status }: { status: AgentSession["status"] }) {
	const variant = status === "running" ? "accent" : status === "error" ? "danger" : "neutral";
	return (
		<Badge variant={variant} className="gap-1.5">
			<StatusDot status={sessionDot(status)} className="size-1.5 [&>span]:size-1.5" />
			{tr(SESSION_STATUS_LABEL[status])}
		</Badge>
	);
}

/** Marks sessions that belong to a shared session: a live mirror of another machine's work, a moved copy, or a session shared with other machines. */
export function SessionKindBadge({ session, className }: { session: Pick<AgentSession, "kind" | "movedTo" | "sharedSessionId">; className?: string }) {
	if (session.movedTo) return <Badge variant="warning" className={className}>{t("Moved to {name}", { name: session.movedTo.nodeName })}</Badge>;
	if (session.kind === "mirror") return <Badge variant="accent" className={className}>{t("Live view")}</Badge>;
	if (session.sharedSessionId) return <Badge variant="outline" className={className}>{t("Shared")}</Badge>;
	return null;
}

/** The agent is waiting for an answer or an approval in this session. */
export function PendingBadge({ session, className }: { session: Pick<AgentSession, "pendingRequests">; className?: string }) {
	const n = session.pendingRequests;
	if (!n) return null;
	return (
		<Badge variant="warning" className={cn("gap-1", className)} title={t("{count, plural, one {The agent is waiting for your answer} other {The agent is waiting for # answers}}", { count: n })}>
			<MessageCircleQuestion aria-hidden /> {t("Needs you")}
		</Badge>
	);
}
