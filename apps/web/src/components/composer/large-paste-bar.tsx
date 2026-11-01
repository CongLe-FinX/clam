import { FileText, X } from "lucide-react";
import { t } from "@/i18n";
import { formatNumber } from "@/lib/utils";
import type { LargePaste } from "@/lib/large-paste";
import { Button } from "@/ui/button";

/** Shown after a very long paste: keep it in the message, or move it out into a text file that is attached instead. */
export function LargePasteBar({ paste, onAttach, onKeep, note }: { paste: LargePaste; onAttach: () => void; onKeep: () => void; note?: string }) {
	return (
		<div role="status" className="animate-fade-in mx-2 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl bg-accent-soft px-3 py-2 text-xs text-foreground">
			<FileText aria-hidden className="size-4 shrink-0 text-accent" />
			<span className="min-w-0 flex-1 basis-40">
				{note ?? t("Long paste: {chars} characters, {lines} lines. Attach it as a file to keep the message short?", { chars: formatNumber(paste.chars), lines: formatNumber(paste.lines) })}
			</span>
			<span className="flex shrink-0 items-center gap-1">
				<Button size="sm" variant="primary" onClick={onAttach}>
					{t("Attach as file")}
				</Button>
				<Button size="sm" variant="ghost" onClick={onKeep}>
					{t("Keep inline")}
				</Button>
				<button type="button" aria-label={t("Dismiss")} onClick={onKeep} className="grid size-7 place-items-center rounded-md text-muted-foreground outline-none hover:bg-surface-3 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring coarse:size-11">
					<X className="size-3.5" />
				</button>
			</span>
		</div>
	);
}
