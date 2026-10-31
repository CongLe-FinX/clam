import * as P from "@radix-ui/react-popover";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverAnchor = P.Anchor;
export const PopoverClose = P.Close;

export function PopoverContent({ className, align = "center", sideOffset = 8, ...props }: ComponentProps<typeof P.Content>) {
	return (
		<P.Portal>
			<P.Content
				align={align}
				sideOffset={sideOffset}
				collisionPadding={8}
				className={cn("clam-pop z-[70] w-72 max-w-[calc(100vw-1rem)] rounded-xl bg-overlay p-3 text-[13px] shadow-pop shadow-[inset_0_0_0_1px_var(--border-strong)] outline-none", className)}
				{...props}
			/>
		</P.Portal>
	);
}
