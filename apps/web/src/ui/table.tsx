import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>) {
	return (
		<div className="scrollbar-thin w-full overflow-x-auto">
			<table className={cn("w-full border-collapse text-[13px]", className)} {...props} />
		</div>
	);
}
export const THead = ({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) => <thead className={cn("text-left", className)} {...props} />;
export const TBody = ({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) => <tbody className={cn("[&>tr:last-child]:border-0", className)} {...props} />;
export const Tr = ({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) => <tr className={cn("border-b transition-colors hover:bg-surface-2/60", className)} {...props} />;
export const Th = ({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) => (
	<th className={cn("whitespace-nowrap border-b px-3 py-2 text-2xs font-medium uppercase tracking-wider text-subtle", className)} {...props} />
);
export const Td = ({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) => <td className={cn("px-3 py-2.5 align-middle", className)} {...props} />;
