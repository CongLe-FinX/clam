import { Timer } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { PendingRequest } from "./omp-store.ts";

/**
 * Milliseconds until the agent stops waiting and uses its defaults, or null when the request has no timeout.
 * The clock starts when the agent raised the request; a browser that sees it later (reload, other device) only ever
 * counts down from what is left, never from the full timeout again.
 */
export function useRemaining(request: PendingRequest): number | null {
	const total = request.timeoutMs;
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (total === undefined) return;
		const id = setInterval(() => setNow(Date.now()), 250);
		return () => clearInterval(id);
	}, [total]);
	if (total === undefined) return null;
	const start = request.raisedAt === undefined ? request.receivedAt : Math.min(request.raisedAt, request.receivedAt);
	return Math.max(0, Math.min(total, start + total - now));
}

export function formatClock(ms: number): string {
	const s = Math.ceil(ms / 1000);
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** "0:42" pill that turns amber for the last 10 seconds. */
export function CountdownPill({ remaining, className }: { remaining: number; className?: string }) {
	const urgent = remaining <= 10_000;
	return (
		<span
			role="timer"
			aria-label={`Answers automatically in ${formatClock(remaining)}`}
			className={cn("tabular inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-2xs transition-colors", urgent ? "bg-warning/14 text-warning" : "bg-surface-3 text-muted-foreground", className)}
		>
			<Timer className="size-3" aria-hidden />
			{formatClock(remaining)}
		</span>
	);
}

/** Thin bar that drains as the timeout runs out (transform only). */
export function CountdownBar({ remaining, total }: { remaining: number; total: number }) {
	const urgent = remaining <= 10_000;
	return (
		<div aria-hidden className="h-0.5 w-full overflow-hidden bg-surface-3">
			<div className={cn("h-full origin-left transition-transform duration-300 ease-linear", urgent ? "bg-warning" : "bg-accent/70")} style={{ transform: `scaleX(${total > 0 ? remaining / total : 0})` }} />
		</div>
	);
}
