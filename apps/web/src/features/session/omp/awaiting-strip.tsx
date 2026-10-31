import type { SessionLiveState } from "@clam/contracts";
import { routes } from "@clam/contracts";
import { ExternalLink, MessageCircleQuestion } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ws } from "@/lib/ws";

/** What the driver's agent is waiting for when its machine does not replicate the request itself (`state.requests` absent: an old node), read from the mirrored live state. */
export function useAwaiting(mirrorSessionId: string | null | undefined): NonNullable<SessionLiveState["awaiting"]> | null {
	const [awaiting, setAwaiting] = useState<SessionLiveState["awaiting"]>(null);
	useEffect(() => {
		setAwaiting(null);
		if (!mirrorSessionId) return;
		let alive = true;
		const off = ws.subscribe(`session:${mirrorSessionId}`, (e) => {
			if (e.type === "state") setAwaiting(e.state.requests ? null : (e.state.awaiting ?? null));
		});
		api.get<SessionLiveState>(routes.sessionState(mirrorSessionId)).then(
			(state) => alive && setAwaiting((prev) => prev ?? (state.requests ? null : (state.awaiting ?? null))),
			() => undefined,
		);
		return () => {
			alive = false;
			off();
		};
	}, [mirrorSessionId]);
	return awaiting ?? null;
}

/**
 * Members of a shared session answer the driver's questions and approvals themselves: the driver replicates the request and the
 * card shows up on every machine (`AskDock`). This strip is only the fallback for a driver that is too old to replicate it:
 * the agent is waiting, and the answer has to be given on its machine.
 */
export function AwaitingStrip({ mirrorSessionId, driverName, driverUrl, className }: { mirrorSessionId: string | null | undefined; driverName: string; driverUrl: string | null; className?: string }) {
	const awaiting = useAwaiting(mirrorSessionId);
	if (!awaiting) return null;
	const approval = awaiting.method !== "ask";
	return (
		<div role="status" className={cn("animate-slide-up mx-auto flex w-full max-w-[60rem] shrink-0 items-center gap-3 px-3 pt-2 pb-1.5 sm:px-4", className)}>
			<div className="flex min-h-12 w-full items-center gap-3 rounded-2xl bg-overlay px-3.5 py-2 shadow-pop">
				<span aria-hidden className={cn("grid size-7 shrink-0 place-items-center rounded-lg", approval ? "bg-warning/14 text-warning" : "bg-accent-soft text-accent")}>
					<MessageCircleQuestion className="size-4" />
				</span>
				<div className="flex min-w-0 flex-1 flex-col">
					<span className="truncate text-[13px] font-medium">{approval ? "The agent needs an approval" : "The agent asked a question"}</span>
					<span className="truncate text-xs text-muted-foreground">{awaiting.title || "Waiting for an answer"}</span>
				</div>
				{driverUrl ? (
					<a
						href={driverUrl}
						target="_blank"
						rel="noreferrer"
						className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-medium text-accent-foreground outline-none transition-colors hover:bg-accent-hover focus-visible:shadow-[0_0_0_2px_var(--ring)] coarse:h-11"
					>
						Answer on {driverName} <ExternalLink className="size-3.5" aria-hidden />
					</a>
				) : (
					<span className="shrink-0 rounded-md bg-surface-3 px-2 py-1 text-2xs text-muted-foreground">Answer on {driverName}</span>
				)}
			</div>
		</div>
	);
}
