import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/** Horizontal progress through a wizard. `current === steps.length` means every step is done. Labels collapse to the current one on phones. */
export function Stepper({ steps, current, className }: { steps: readonly string[]; current: number; className?: string }) {
	return (
		<div className={cn("flex flex-col gap-1.5", className)}>
			<ol className="flex items-center" aria-label="Progress">
				{steps.map((label, i) => {
					const done = i < current;
					const now = i === current;
					return (
						<li key={label} aria-current={now ? "step" : undefined} className={cn("flex items-center", i < steps.length - 1 && "min-w-0 flex-1")}>
							<span className="flex items-center gap-2">
								<span
									className={cn(
										"grid size-6 shrink-0 place-items-center rounded-full text-2xs font-semibold tabular transition-[background-color,box-shadow,color,transform] duration-300",
										done && "bg-accent text-accent-foreground",
										now && "bg-accent-soft text-accent shadow-[inset_0_0_0_1.5px_var(--accent)]",
										!done && !now && "bg-surface-2 text-subtle shadow-[inset_0_0_0_1px_var(--border-strong)]",
									)}
								>
									{done ? <Check className="size-3.5 animate-pop-in" strokeWidth={3} /> : i + 1}
								</span>
								<span className={cn("hidden whitespace-nowrap text-xs font-medium md:inline", now ? "text-foreground" : "text-subtle")}>{label}</span>
							</span>
							{i < steps.length - 1 ? (
								<span aria-hidden className="relative mx-2 h-0.5 min-w-3 flex-1 overflow-hidden rounded-full bg-surface-3">
									<span className="absolute inset-0 origin-left bg-accent transition-transform duration-500 ease-out" style={{ transform: `scaleX(${done ? 1 : 0})` }} />
								</span>
							) : null}
						</li>
					);
				})}
			</ol>
			<span className="text-xs font-medium text-muted-foreground md:hidden" aria-hidden>
				{current >= steps.length ? "Done" : `Step ${current + 1} of ${steps.length} · ${steps[current]}`}
			</span>
		</div>
	);
}
