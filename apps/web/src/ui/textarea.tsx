import type { Ref, TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import { fieldClass } from "./input.tsx";

export function Textarea({ className, ref, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
	return <textarea ref={ref} className={cn(fieldClass, "min-h-16 resize-y py-2 leading-relaxed", className)} {...props} />;
}
