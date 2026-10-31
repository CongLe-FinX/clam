import type { InputHTMLAttributes, Ref } from "react";
import { cn } from "@/lib/utils";

export const fieldClass =
	"w-full rounded-lg bg-surface-1 px-3 text-[13px] text-foreground shadow-[inset_0_0_0_1px_var(--border-strong)] outline-none transition-[box-shadow,background-color] duration-150 placeholder:text-subtle hover:bg-surface-2 focus:bg-surface-1 focus:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_3px_var(--accent-soft)] disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:shadow-[inset_0_0_0_1px_var(--danger)]";

export function Input({ className, ref, type = "text", ...props }: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
	return <input ref={ref} type={type} className={cn(fieldClass, "h-8 coarse:h-11", className)} {...props} />;
}
