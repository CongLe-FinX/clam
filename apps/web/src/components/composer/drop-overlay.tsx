import { ImagePlus } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Covers a drop target while files are dragged over it. Never takes pointer events, so the drop reaches the target underneath. */
export function DropOverlay({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<div aria-hidden className={cn("animate-fade-in pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-1.5 rounded-[inherit] bg-accent-soft/90 text-sm font-medium text-accent shadow-[inset_0_0_0_2px_var(--accent)] backdrop-blur-[2px]", className)}>
			<ImagePlus className="size-6" />
			<span>{children}</span>
		</div>
	);
}
