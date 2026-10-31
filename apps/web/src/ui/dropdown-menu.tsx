import * as M from "@radix-ui/react-dropdown-menu";
import { Check } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const DropdownMenu = M.Root;
export const DropdownMenuTrigger = M.Trigger;
export const DropdownMenuGroup = M.Group;
export const DropdownMenuRadioGroup = M.RadioGroup;

export function DropdownMenuContent({ className, sideOffset = 6, align = "end", ...props }: ComponentProps<typeof M.Content>) {
	return (
		<M.Portal>
			<M.Content
				sideOffset={sideOffset}
				align={align}
				collisionPadding={8}
				className={cn("clam-pop z-[70] min-w-44 max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl bg-overlay p-1 text-[13px] shadow-pop shadow-[inset_0_0_0_1px_var(--border-strong)]", className)}
				{...props}
			/>
		</M.Portal>
	);
}

const itemClass =
	"relative flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-surface-3 coarse:py-2.5 [&_svg]:size-4 [&_svg]:text-muted-foreground";

export function DropdownMenuItem({ className, danger, ...props }: ComponentProps<typeof M.Item> & { danger?: boolean }) {
	return <M.Item className={cn(itemClass, danger && "text-danger [&_svg]:text-danger", className)} {...props} />;
}
export function DropdownMenuRadioItem({ className, children, ...props }: ComponentProps<typeof M.RadioItem>) {
	return (
		<M.RadioItem className={cn(itemClass, "pr-7", className)} {...props}>
			{children}
			<M.ItemIndicator className="absolute right-2">
				<Check className="!size-3.5 !text-accent" />
			</M.ItemIndicator>
		</M.RadioItem>
	);
}
export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof M.Label>) {
	return <M.Label className={cn("px-2 py-1 text-2xs font-medium uppercase tracking-wider text-subtle", className)} {...props} />;
}
export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof M.Separator>) {
	return <M.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
}
