import * as P from "@radix-ui/react-progress";
import { cn } from "@/lib/utils";

export function Progress({ value, className, tone = "accent" }: { value: number; className?: string; tone?: "accent" | "success" | "warning" | "danger" }) {
	const v = Math.max(0, Math.min(100, value));
	const bg = { accent: "bg-accent", success: "bg-success", warning: "bg-warning", danger: "bg-danger" }[tone];
	return (
		<P.Root value={v} className={cn("relative h-1.5 w-full overflow-hidden rounded-full bg-surface-3", className)}>
			<P.Indicator className={cn("size-full origin-left rounded-full transition-transform duration-500 ease-out", bg)} style={{ transform: `scaleX(${v / 100})` }} />
		</P.Root>
	);
}
