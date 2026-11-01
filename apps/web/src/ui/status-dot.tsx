import { msg, tr, type Msg } from "@/i18n";
import { cn } from "@/lib/utils";

export type DotStatus = "online" | "busy" | "offline" | "crashed" | "ok" | "degraded" | "down" | "idle" | "starting";

const color: Record<DotStatus, string> = {
	online: "bg-success",
	ok: "bg-success",
	idle: "bg-success",
	busy: "bg-accent",
	starting: "bg-warning",
	degraded: "bg-warning",
	offline: "bg-subtle",
	crashed: "bg-danger",
	down: "bg-danger",
};
/** Display label of each dot status; also the one label map for node health (`ok`/`degraded`/`down`). Render with `tr()`. */
export const DOT_STATUS_LABEL: Record<DotStatus, Msg> = {
	online: msg("Online"),
	busy: msg("Busy"),
	offline: msg("Offline"),
	crashed: msg("Crashed"),
	ok: msg("OK"),
	degraded: msg("Degraded"),
	down: msg("Down"),
	idle: msg("Idle"),
	starting: msg("Starting"),
};
const pulsing = new Set<DotStatus>(["busy", "starting"]);

export function StatusDot({ status, className, label }: { status: DotStatus; className?: string; label?: string }) {
	return (
		<span role="img" aria-label={label ?? tr(DOT_STATUS_LABEL[status])} className={cn("relative inline-flex size-2 shrink-0", className)}>
			{pulsing.has(status) ? <span className={cn("absolute inset-0 rounded-full opacity-60 [animation:clam-pulse-ring_1.6s_ease-out_infinite]", color[status])} /> : null}
			<span className={cn("relative size-2 rounded-full", color[status])} />
		</span>
	);
}
