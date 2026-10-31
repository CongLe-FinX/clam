import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Standard scrollable page body with consistent padding + max width. */
export function PageContainer({ children, className, wide }: { children: ReactNode; className?: string; wide?: boolean }) {
	return (
		<div className="scrollbar-thin h-full overflow-y-auto overscroll-contain">
			<div className={cn("mx-auto flex w-full flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8 lg:py-7", wide ? "max-w-[1400px]" : "max-w-5xl", className)}>{children}</div>
		</div>
	);
}

export function PageHeader({ title, description, actions, eyebrow }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
	return (
		<header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
			<div className="flex min-w-0 flex-col gap-1">
				{eyebrow ? <div className="text-2xs font-medium uppercase tracking-wider text-subtle">{eyebrow}</div> : null}
				<h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
				{description ? <p className="max-w-2xl text-[13px] text-muted-foreground">{description}</p> : null}
			</div>
			{actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
		</header>
	);
}

export function SectionTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
	return (
		<div className="flex items-center justify-between gap-3">
			<h2 className="text-2xs font-semibold uppercase tracking-wider text-subtle">{children}</h2>
			{actions}
		</div>
	);
}
