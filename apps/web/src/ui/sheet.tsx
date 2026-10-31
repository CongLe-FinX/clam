import * as D from "@radix-ui/react-dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { type ComponentProps, type HTMLAttributes, type TouchEvent, useRef } from "react";
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

/**
 * Drag a bottom sheet down from its top edge (grab handle and header) to dismiss it: it follows the finger and either flies
 * out (far enough or fast enough) or springs back. Uses the independent `translate` property so the open/close animation,
 * which owns `transform`, is untouched.
 */
function useSwipeToDismiss(close: () => void) {
	const drag = useRef<{ y: number; t: number; el: HTMLElement } | null>(null);
	return {
		onTouchStart(e: TouchEvent<HTMLElement>) {
			const touch = e.touches[0];
			if (!touch || touch.clientY - e.currentTarget.getBoundingClientRect().top > 72) return;
			drag.current = { y: touch.clientY, t: performance.now(), el: e.currentTarget };
			e.currentTarget.style.transition = "none";
		},
		onTouchMove(e: TouchEvent<HTMLElement>) {
			const d = drag.current;
			const touch = e.touches[0];
			if (d && touch) d.el.style.translate = `0 ${Math.max(0, touch.clientY - d.y)}px`;
		},
		onTouchEnd(e: TouchEvent<HTMLElement>) {
			const d = drag.current;
			drag.current = null;
			const touch = e.changedTouches[0];
			if (!d || !touch) return;
			const dy = Math.max(0, touch.clientY - d.y);
			const fast = dy > 40 && dy / Math.max(1, performance.now() - d.t) > 0.5;
			d.el.style.transition = "translate 180ms var(--ease-out-quint)";
			if (dy > 110 || fast) {
				d.el.style.translate = "0 100%";
				setTimeout(close, 140);
			} else d.el.style.translate = "0 0";
		},
	};
}

export function SheetContent({
	side,
	className,
	children,
	...props
}: ComponentProps<typeof D.Content> & VariantProps<typeof sheetVariants>) {
	const closeRef = useRef<HTMLButtonElement>(null);
	const swipe = useSwipeToDismiss(() => closeRef.current?.click());
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
				{...(side === "bottom" ? swipe : {})}
				{...props}
			>
				{side === "bottom" ? (
					<>
						<div aria-hidden className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-border-strong" />
						<D.Close ref={closeRef} hidden tabIndex={-1} aria-hidden />
					</>
				) : null}
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
