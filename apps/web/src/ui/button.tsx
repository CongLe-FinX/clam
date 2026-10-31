import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes, Ref } from "react";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
	"relative inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium outline-none transition-[background-color,color,box-shadow,transform,opacity] duration-150 ease-out active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
	{
		variants: {
			variant: {
				primary: "bg-accent text-accent-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.18)] hover:bg-accent-hover",
				secondary: "bg-surface-3 text-foreground hover:bg-border-strong",
				outline: "bg-transparent text-foreground shadow-[inset_0_0_0_1px_var(--border-strong)] hover:bg-surface-2",
				ghost: "bg-transparent text-muted-foreground hover:bg-surface-2 hover:text-foreground",
				danger: "bg-danger/90 text-white hover:bg-danger",
				link: "h-auto rounded-sm p-0 text-accent underline-offset-4 hover:underline active:scale-100",
			},
			size: {
				sm: "h-7 px-2.5 text-xs coarse:h-11 [&_svg]:size-3.5",
				md: "h-8 px-3 text-[13px] coarse:h-11 [&_svg]:size-4",
				lg: "h-10 px-4 text-sm coarse:h-12 [&_svg]:size-4",
				icon: "size-8 coarse:size-11 [&_svg]:size-4",
				"icon-sm": "size-7 coarse:size-11 [&_svg]:size-3.5",
			},
		},
		defaultVariants: { variant: "secondary", size: "md" },
	},
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
	asChild?: boolean;
	loading?: boolean;
	ref?: Ref<HTMLButtonElement>;
}

export function Button({ className, variant, size, asChild, loading, disabled, children, type, ref, ...props }: ButtonProps) {
	const Comp = asChild ? Slot : "button";
	return (
		<Comp
			ref={ref}
			type={asChild ? undefined : (type ?? "button")}
			disabled={disabled || loading}
			aria-busy={loading || undefined}
			className={cn(buttonVariants({ variant, size }), className)}
			{...props}
		>
			{asChild ? (
				children
			) : (
				<>
					{loading ? <Loader2 className="animate-spin" aria-hidden /> : null}
					{children}
				</>
			)}
		</Comp>
	);
}
