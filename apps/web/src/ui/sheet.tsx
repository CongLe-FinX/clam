import * as D from "@radix-ui/react-dialog";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps, HTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import { DialogOverlay } from "./dialog.tsx";

export const Sheet = D.Root;
export const SheetTrigger = D.Trigger;
export const SheetClose = D.Close;

const sheetVariants = cva("fixed z-[61] flex flex-col bg-overlay shadow-pop outline-none will-change-transform", {
	variants: {
		side: {
			left: "clam-sheet-left inset-y-0 left-0 w-[min(86vw,320px)] border-r pt-safe pb-safe",
			right: "clam-sheet-right inset-y-0 right-0 w-[min(92vw,420px)] border-l pt-safe pb-safe",
			bottom: "clam-sheet-bottom inset-x-0 bottom-0 max-h-[88dvh] rounded-t-2xl border-t pb-safe",
		},
	},
	defaultVariants: { side: "right" },
});

export function SheetContent({
	side,
	className,
	children,
	...props
}: ComponentProps<typeof D.Content> & VariantProps<typeof sheetVariants>) {
	return (
		<D.Portal>
			<DialogOverlay />
			<D.Content
				className={cn(sheetVariants({ side }), className)}
				// Focus the sheet itself, not its first control (which would pop a tooltip open).
				onOpenAutoFocus={(e) => {
					e.preventDefault();
					(e.currentTarget as HTMLElement).focus({ preventScroll: true });
				}}
				{...props}
			>
				{side === "bottom" ? <div aria-hidden className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-border-strong" /> : null}
				{children}
			</D.Content>
		</D.Portal>
	);
}
export function SheetHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
	return <div className={cn("flex flex-col gap-1 px-4 py-3", className)} {...props} />;
}
export function SheetTitle({ className, ...props }: ComponentProps<typeof D.Title>) {
	return <D.Title className={cn("text-sm font-semibold", className)} {...props} />;
}
export function SheetDescription({ className, ...props }: ComponentProps<typeof D.Description>) {
	return <D.Description className={cn("text-xs text-muted-foreground", className)} {...props} />;
}
