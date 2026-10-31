import * as T from "@radix-ui/react-tabs";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const Tabs = T.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof T.List>) {
	return <T.List className={cn("scrollbar-none inline-flex items-center gap-1 overflow-x-auto rounded-lg bg-surface-2 p-0.5", className)} {...props} />;
}
export function TabsTrigger({ className, ...props }: ComponentProps<typeof T.Trigger>) {
	return (
		<T.Trigger
			className={cn(
				"inline-flex h-7 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 text-xs font-medium text-muted-foreground outline-none transition-[background-color,color] duration-150 hover:text-foreground data-[state=active]:bg-surface-3 data-[state=active]:text-foreground coarse:h-10 [&_svg]:size-3.5",
				className,
			)}
			{...props}
		/>
	);
}
export function TabsContent({ className, ...props }: ComponentProps<typeof T.Content>) {
	return <T.Content className={cn("outline-none data-[state=active]:animate-fade-in", className)} {...props} />;
}
