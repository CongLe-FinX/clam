import * as D from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ComponentProps, HTMLAttributes } from "react";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;
export const DialogPortal = D.Portal;

export function DialogOverlay({ className, ...props }: ComponentProps<typeof D.Overlay>) {
	return <D.Overlay className={cn("clam-overlay fixed inset-0 z-[60] bg-[var(--scrim)] backdrop-blur-[2px]", className)} {...props} />;
}

export function DialogContent({
	className,
	children,
	hideClose,
	sheetOnMobile,
	...props
}: ComponentProps<typeof D.Content> & { hideClose?: boolean; /** Below 640 px render as a bottom sheet instead of a centred dialog. */ sheetOnMobile?: boolean }) {
	return (
		<D.Portal>
			<DialogOverlay />
			<D.Content
				className={cn(
					"clam-dialog fixed left-1/2 top-1/2 z-[61] flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-1.5rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-hidden rounded-2xl bg-overlay p-5 shadow-pop shadow-[inset_0_0_0_1px_var(--border-strong)] outline-none",
					sheetOnMobile &&
						"clam-dialog-sheet max-sm:bottom-0 max-sm:left-0 max-sm:top-auto max-sm:max-h-[90dvh] max-sm:w-full max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-b-none max-sm:pb-[max(1.25rem,env(safe-area-inset-bottom))]",
					className,
				)}
				{...props}
			>
				{children}
				{hideClose ? null : (
					<D.Close className="absolute right-3 top-3 grid size-8 place-items-center rounded-lg text-subtle outline-none transition-colors hover:bg-surface-3 hover:text-foreground coarse:size-10" aria-label={t("Close")}>
						<X className="size-4" />
					</D.Close>
				)}
			</D.Content>
		</D.Portal>
	);
}

export function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
	return <div className={cn("flex flex-col gap-1 pr-8", className)} {...props} />;
}
export function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
	return <div className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />;
}
export function DialogTitle({ className, ...props }: ComponentProps<typeof D.Title>) {
	return <D.Title className={cn("text-[15px] font-semibold tracking-tight", className)} {...props} />;
}
export function DialogDescription({ className, ...props }: ComponentProps<typeof D.Description>) {
	return <D.Description className={cn("text-[13px] text-muted-foreground", className)} {...props} />;
}
