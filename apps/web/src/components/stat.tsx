import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/ui/skeleton";

export function Stat({ label, value, sub, loading, className, mono = true }: { label: string; value: ReactNode; sub?: ReactNode; loading?: boolean; className?: string; mono?: boolean }) {
	return (
		<div className={cn("flex min-w-0 flex-col gap-1", className)}>
			<span className="text-2xs font-medium uppercase tracking-wider text-subtle">{label}</span>
			{loading ? <Skeleton className="h-6 w-20" /> : <span className={cn("truncate text-lg font-semibold leading-tight tracking-tight tabular", mono && "font-mono text-base")}>{value}</span>}
			{sub ? <span className="truncate text-xs text-muted-foreground">{sub}</span> : null}
		</div>
	);
}
