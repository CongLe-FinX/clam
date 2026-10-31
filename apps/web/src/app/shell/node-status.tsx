import { SignOutItem } from "@/features/auth/sign-out-item";
import { useHealth, useNode, useOmpProviders } from "@/lib/queries";
import { shortFingerprint, cn } from "@/lib/utils";
import { useWsStatus } from "@/lib/ws";
import { Skeleton } from "@/ui/skeleton";
import { StatusDot, type DotStatus } from "@/ui/status-dot";
import { Tip } from "@/ui/tooltip";

export function useNodeStatus() {
	const node = useNode();
	const health = useHealth();
	const omp = useOmpProviders();
	const wsStatus = useWsStatus();
	const dot: DotStatus = node.isError || wsStatus === "closed" ? "down" : health.data ? health.data.status : "starting";
	const ompInstalled = omp.data?.install.installed;
	return { node, health, omp, wsStatus, dot, ompInstalled };
}

/** Node identity card at the top of the sidebar (full mode). */
export function NodeStatusCard({ className }: { className?: string }) {
	const { node, omp, wsStatus, dot, ompInstalled } = useNodeStatus();
	return (
		<div className={cn("flex flex-col gap-1.5 rounded-lg bg-surface-2 px-2.5 py-2 shadow-[inset_0_0_0_1px_var(--border)]", className)}>
			<div className="flex items-center gap-2">
				<StatusDot status={dot} label={`Node ${dot}`} />
				{node.data ? <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{node.data.name}</span> : <Skeleton className="h-4 w-24" />}
				<span className="font-mono text-2xs text-subtle">{wsStatus === "open" ? "live" : wsStatus === "connecting" ? "…" : "offline"}</span>
			</div>
			<div className="flex items-center justify-between gap-2 text-2xs text-subtle">
				<span className="font-mono">{node.data ? shortFingerprint(node.data.fingerprint) : "—"}</span>
				<span className={cn("flex items-center gap-1", ompInstalled === false && "text-warning")}>
					OMP {omp.isLoading ? "…" : ompInstalled ? (omp.data?.install.version?.replace(/^omp\//, "") ?? "ok") : ompInstalled === false ? "missing" : "?"}
				</span>
			</div>
			<SignOutItem />
		</div>
	);
}

/** Rail-mode compact indicator. */
export function NodeStatusDot() {
	const { node, dot } = useNodeStatus();
	return (
		<Tip label={node.data ? `${node.data.name} · ${dot}` : "Node"} side="right">
			<span className="grid size-8 place-items-center">
				<StatusDot status={dot} />
			</span>
		</Tip>
	);
}
