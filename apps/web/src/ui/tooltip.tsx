import * as T from "@radix-ui/react-tooltip";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

export const TooltipProvider = ({ children }: { children: ReactNode }) => (
	<T.Provider delayDuration={350} skipDelayDuration={200}>
		{children}
	</T.Provider>
);
export const Tooltip = T.Root;
export const TooltipTrigger = T.Trigger;

export function TooltipContent({ className, sideOffset = 6, ...props }: ComponentProps<typeof T.Content>) {
	return (
		<T.Portal>
			<T.Content
				sideOffset={sideOffset}
				className={cn("clam-pop z-[80] max-w-xs rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background", className)}
				{...props}
			/>
		</T.Portal>
	);
}

const coarse = typeof matchMedia === "function" ? matchMedia("(pointer: coarse)") : null;

/** Convenience: `<Tip label="Copy"><Button/></Tip>`. Tooltips are skipped on touch devices (they would stick after focus). */
export function Tip({ label, children, side, shortcut }: { label: ReactNode; children: ReactNode; side?: "top" | "right" | "bottom" | "left"; shortcut?: string }) {
	if (coarse?.matches) return <>{children}</>;
	return (
		<T.Root>
			<T.Trigger asChild>{children}</T.Trigger>
			<TooltipContent side={side}>
				{label}
				{shortcut ? <span className="ml-1.5 font-mono opacity-60">{shortcut}</span> : null}
			</TooltipContent>
		</T.Root>
	);
}
