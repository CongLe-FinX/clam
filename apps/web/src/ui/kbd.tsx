import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
	return (
		<kbd
			className={cn("inline-flex h-[18px] min-w-[18px] items-center justify-center rounded bg-surface-3 px-1 font-mono text-2xs font-medium text-muted-foreground shadow-[inset_0_-1px_0_var(--border-strong)]", className)}
			{...props}
		/>
	);
}
