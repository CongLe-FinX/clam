import { ChevronDown } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { cn, formatNumber } from "@/lib/utils";
import { type RichFile } from "./assets.ts";
import { FileTile, ImageGroupContext } from "./file-tile.tsx";
import { t } from "@/i18n";

const LIMIT = 12;

export interface FileStripProps {
	files: RichFile[];
	onOpen?: (file: RichFile) => void;
	title?: string;
	className?: string;
}

/**
 * A labelled group of files (turn outputs, message attachments): image thumbnails in a grid, every other file as one dense row in a
 * single panel (two columns when there is room); long lists collapse and expand again.
 */
export const FileStrip = memo(function FileStrip({ files, onOpen, title, className }: FileStripProps) {
	const [all, setAll] = useState(false);
	const heading = title ?? t("Files from this turn");
	const shown = all ? files : files.slice(0, LIMIT);
	const hidden = files.length - shown.length;
	const { images, others } = useMemo(
		() => ({ images: shown.filter((f) => f.kind === "image"), others: shown.filter((f) => f.kind !== "image") }),
		[shown],
	);
	if (files.length === 0) return null;
	return (
		<section aria-label={heading} className={cn("@container flex flex-col gap-1.5", className)}>
			<h4 className="text-2xs font-medium uppercase tracking-wide text-subtle">
				{heading} <span className="tabular normal-case tracking-normal">· {files.length}</span>
			</h4>
			{images.length > 0 ? (
				<ImageGroupContext.Provider value={images}>
					<div className="grid grid-cols-2 gap-2 @md:grid-cols-3 @2xl:grid-cols-4">
						{images.map((f) => (
							<FileTile key={f.key} file={f} onOpen={onOpen} className="max-w-none" />
						))}
					</div>
				</ImageGroupContext.Provider>
			) : null}
			{others.length > 0 ? (
				<div className="grid gap-x-1 rounded-xl bg-surface-1 p-1 shadow-[inset_0_0_0_1px_var(--border)] @lg:grid-cols-2">
					{others.map((f) => (
						<FileTile key={f.key} file={f} onOpen={onOpen} row />
					))}
				</div>
			) : null}
			{files.length > LIMIT ? (
				<button
					type="button"
					aria-expanded={all}
					onClick={() => setAll((v) => !v)}
					className="inline-flex h-7 w-fit items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-muted-foreground outline-none hover:bg-surface-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring coarse:h-11"
				>
					<ChevronDown aria-hidden className={cn("size-3.5 transition-transform duration-200", all && "rotate-180")} />
					{all ? t("Show less") : t("+{count} more", { count: formatNumber(hidden) })}
				</button>
			) : null}
		</section>
	);
});
