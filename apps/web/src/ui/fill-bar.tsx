import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export type FillTone = "accent" | "warning" | "danger";

const BG: Record<FillTone, string> = { accent: "bg-accent", warning: "bg-warning", danger: "bg-danger" };

/** `value` after it has been painted at 0 first: drives a CSS transition from empty on mount, then between values. */
export function useFillValue(value: number): number {
	const [shown, setShown] = useState(0);
	useEffect(() => {
		// Two frames: the empty state must have been painted before the first value, or there is nothing to transition from.
		let second = 0;
		const first = requestAnimationFrame(() => {
			second = requestAnimationFrame(() => setShown(value));
		});
		return () => {
			cancelAnimationFrame(first);
			cancelAnimationFrame(second);
		};
	}, [value]);
	return Math.max(0, Math.min(100, shown));
}

/**
 * A thin meter that fills up from empty on mount, then glides between values. Transform-only (cheap in a sidebar that
 * is on every page); `prefers-reduced-motion` zeroes the transition globally (index.css).
 */
export function FillBar({ value, tone = "accent", className }: { value: number; tone?: FillTone; className?: string }) {
	const v = useFillValue(value);
	return (
		<div role="presentation" className={cn("h-1 w-full overflow-hidden rounded-full bg-surface-3", className)}>
			<div
				className={cn("size-full origin-left rounded-full transition-[transform,background-color] duration-700 ease-[var(--ease-out-quint)]", BG[tone])}
				style={{ transform: `scaleX(${v / 100})` }}
			/>
		</div>
	);
}

/** Alert level of a resource → bar/dot tone. */
export function toneOfLevel(level: "warning" | "critical" | undefined): FillTone {
	return level === "critical" ? "danger" : level === "warning" ? "warning" : "accent";
}
