import * as S from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const Select = S.Root;
export const SelectGroup = S.Group;
export const SelectValue = S.Value;

export function SelectTrigger({ className, children, ...props }: ComponentProps<typeof S.Trigger>) {
	return (
		<S.Trigger
			className={cn(
				"flex h-8 w-full items-center justify-between gap-2 rounded-lg bg-surface-1 px-3 text-[13px] shadow-[inset_0_0_0_1px_var(--border-strong)] outline-none transition-[box-shadow,background-color] hover:bg-surface-2 focus-visible:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_3px_var(--accent-soft)] disabled:opacity-50 coarse:h-11 data-[placeholder]:text-subtle [&>span]:truncate",
				className,
			)}
			{...props}
		>
			{children}
			<S.Icon asChild>
				<ChevronDown className="size-3.5 shrink-0 text-subtle" />
			</S.Icon>
		</S.Trigger>
	);
}

export function SelectContent({ className, children, position = "popper", ...props }: ComponentProps<typeof S.Content>) {
	return (
		<S.Portal>
			<S.Content
				position={position}
				sideOffset={6}
				className={cn(
					"clam-pop z-[70] max-h-[min(320px,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl bg-overlay p-1 text-[13px] shadow-pop shadow-[inset_0_0_0_1px_var(--border-strong)]",
					className,
				)}
				{...props}
			>
				<S.Viewport className="scrollbar-thin max-h-[inherit]">{children}</S.Viewport>
			</S.Content>
		</S.Portal>
	);
}

export function SelectItem({ className, children, ...props }: ComponentProps<typeof S.Item>) {
	return (
		<S.Item
			className={cn(
				"relative flex cursor-default select-none items-center gap-2 rounded-md py-1.5 pl-2 pr-7 outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-surface-3 coarse:py-2.5",
				className,
			)}
			{...props}
		>
			<S.ItemText>{children}</S.ItemText>
			<S.ItemIndicator className="absolute right-2">
				<Check className="size-3.5 text-accent" />
			</S.ItemIndicator>
		</S.Item>
	);
}
