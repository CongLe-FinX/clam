import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function EmptyState({ icon: Icon, title, description, action, className }: { icon?: LucideIcon; title: string; description?: ReactNode; action?: ReactNode; className?: string }) {
	return (
		<div className={cn("flex flex-col items-center justify-center gap-3 px-6 py-14 text-center", className)}>
			{Icon ? (
				<div className="grid size-11 place-items-center rounded-xl bg-surface-2 text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]">
					<Icon className="size-5" />
				</div>
			) : null}
			<div className="flex max-w-sm flex-col gap-1">
				<h3 className="text-sm font-medium">{title}</h3>
				{description ? <p className="text-[13px] text-muted-foreground">{description}</p> : null}
			</div>
			{action}
		</div>
	);
}
