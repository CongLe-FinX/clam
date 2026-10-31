import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-2xs font-medium leading-none [&_svg]:size-3", {
	variants: {
		variant: {
			neutral: "bg-surface-3 text-muted-foreground",
			accent: "bg-accent-soft text-accent",
			success: "bg-success/12 text-success",
			warning: "bg-warning/14 text-warning",
			danger: "bg-danger/13 text-danger",
			outline: "text-muted-foreground shadow-[inset_0_0_0_1px_var(--border-strong)]",
		},
	},
	defaultVariants: { variant: "neutral" },
});

export function Badge({ className, variant, ...props }: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
	return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
