import { type ReactNode, useId } from "react";
import { cn } from "@/lib/utils";
import { Label } from "./label.tsx";

export function Field({
	label,
	hint,
	error,
	className,
	children,
}: {
	label: string;
	hint?: ReactNode;
	error?: string | null;
	className?: string;
	/** Render-prop receives the id to wire label → control. */
	children: (id: string) => ReactNode;
}) {
	const id = useId();
	return (
		<div className={cn("flex flex-col gap-1.5", className)}>
			<Label htmlFor={id}>{label}</Label>
			{children(id)}
			{error ? (
				<p role="alert" className="text-xs text-danger">
					{error}
				</p>
			) : hint ? (
				<p className="text-xs text-subtle">{hint}</p>
			) : null}
		</div>
	);
}
