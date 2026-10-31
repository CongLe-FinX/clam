import * as S from "@radix-ui/react-switch";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Switch({ className, ...props }: ComponentProps<typeof S.Root>) {
	return (
		<S.Root
			className={cn(
				"relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full bg-surface-3 shadow-[inset_0_0_0_1px_var(--border-strong)] outline-none transition-colors duration-150 disabled:opacity-50 data-[state=checked]:bg-accent data-[state=checked]:shadow-none coarse:h-7 coarse:w-12",
				className,
			)}
			{...props}
		>
			<S.Thumb className="pointer-events-none block size-4 translate-x-0.5 rounded-full bg-white shadow transition-transform duration-200 ease-[var(--ease-spring)] data-[state=checked]:translate-x-[18px] coarse:size-6 coarse:data-[state=checked]:translate-x-[22px]" />
		</S.Root>
	);
}
