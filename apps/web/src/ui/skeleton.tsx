import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/** Shimmer animates a transform on a pseudo layer (compositor-only). */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
	return (
		<div
			aria-hidden
			className={cn(
				"relative overflow-hidden rounded-md bg-surface-2 before:absolute before:inset-0 before:-translate-x-full before:animate-[clam-shimmer_1.4s_ease-in-out_infinite] before:bg-gradient-to-r before:from-transparent before:via-foreground/[0.06] before:to-transparent",
				className,
			)}
			{...props}
		/>
	);
}
