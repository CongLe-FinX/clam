import * as S from "@radix-ui/react-scroll-area";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function ScrollArea({ className, children, viewportClassName, ...props }: ComponentProps<typeof S.Root> & { viewportClassName?: string }) {
	return (
		<S.Root className={cn("relative overflow-hidden", className)} {...props}>
			<S.Viewport className={cn("size-full rounded-[inherit] [&>div]:!block", viewportClassName)}>{children}</S.Viewport>
			<S.Scrollbar orientation="vertical" className="flex w-2 touch-none select-none p-px transition-opacity data-[state=hidden]:opacity-0">
				<S.Thumb className="relative flex-1 rounded-full bg-border-strong" />
			</S.Scrollbar>
			<S.Scrollbar orientation="horizontal" className="flex h-2 touch-none select-none flex-col p-px">
				<S.Thumb className="relative flex-1 rounded-full bg-border-strong" />
			</S.Scrollbar>
		</S.Root>
	);
}
