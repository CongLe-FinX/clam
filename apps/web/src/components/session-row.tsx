import type { AgentSession } from "@clam/contracts";
import { Link } from "@tanstack/react-router";
import { memo } from "react";
import { cn, formatCompact, formatCost, relativeTime } from "@/lib/utils";
import { StatusDot } from "@/ui/status-dot";
import { SessionKindBadge, sessionDot } from "./session-status.tsx";

/** One session in any list: status dot, title, project, model, tokens, cost, recency. Whole row is a link. */
export const SessionRow = memo(function SessionRow({ session, projectName, className }: { session: AgentSession; projectName?: string; className?: string }) {
	const tokens = session.stats?.tokens.total;
	return (
		<Link
			to="/sessions/$sessionId"
			params={{ sessionId: session.id }}
			preload="intent"
			className={cn(
				"group flex min-h-14 items-center gap-3 border-b px-4 py-2.5 outline-none transition-colors last:border-b-0 hover:bg-surface-2 focus-visible:bg-surface-2 coarse:min-h-16",
				className,
			)}
		>
			<StatusDot status={sessionDot(session.status)} label={session.status} />
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="flex min-w-0 items-center gap-2">
					<span className="truncate text-[13px] font-medium">{session.title || "Untitled session"}</span>
					<SessionKindBadge session={session} className="shrink-0" />
				</span>
				<span className="flex min-w-0 items-center gap-1.5 truncate text-xs text-subtle">
					{projectName ? <span className="truncate">{projectName}</span> : null}
					{projectName && session.model ? <span aria-hidden>·</span> : null}
					{session.model ? <span className="truncate font-mono text-2xs">{session.model}</span> : null}
				</span>
			</div>
			<div className="hidden shrink-0 flex-col items-end gap-0.5 text-xs text-subtle sm:flex">
				<span className="tabular">{relativeTime(session.updatedAt)}</span>
				{tokens !== undefined ? (
					<span className="tabular font-mono text-2xs">
						{formatCompact(tokens)} tok · {formatCost(session.stats?.cost)}
					</span>
				) : null}
			</div>
			<span className="shrink-0 text-2xs text-subtle tabular sm:hidden">{relativeTime(session.updatedAt)}</span>
		</Link>
	);
});
