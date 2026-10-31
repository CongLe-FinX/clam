import { ChevronDown } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { type RichFile } from "./assets.ts";
import { FileTile, ImageGroupContext } from "./file-tile.tsx";

const LIMIT = 12;

export interface FileStripProps {
	files: RichFile[];
	onOpen?: (file: RichFile) => void;
	title?: string;
	className?: string;
}

/** A labelled group of files (turn outputs, message attachments): image thumbnails in a grid, other kinds as cards; long lists collapse. */
export const FileStrip = memo(function FileStrip({ files, onOpen, title = "Files from this turn", className }: FileStripProps) {
	const [all, setAll] = useState(false);
	const shown = all ? files : files.slice(0, LIMIT);
	const hidden = files.length - shown.length;
	const { images, others } = useMemo(
		() => ({ images: shown.filter((f) => f.kind === "image"), others: shown.filter((f) => f.kind !== "image") }),
		[shown],
	);
	if (files.length === 0) return null;
	return (
		<section aria-label={title} className={cn("flex flex-col gap-2", className)}>
			<h4 className="text-2xs font-medium uppercase tracking-wide text-subtle">
				{title} <span className="tabular normal-case tracking-normal">· {files.length}</span>
			</h4>
			{images.length > 0 ? (
				<ImageGroupContext.Provider value={images}>
					<div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
						{images.map((f) => (
							<FileTile key={f.key} file={f} onOpen={onOpen} className="max-w-none" />
						))}
					</div>
				</ImageGroupContext.Provider>
			) : null}
			{others.length > 0 ? (
				<div className="grid gap-2 sm:grid-cols-2">
					{others.map((f) => (
						<FileTile key={f.key} file={f} onOpen={onOpen} className="max-w-none" />
					))}
				</div>
			) : null}
			{hidden > 0 ? (
				<button
					type="button"
					onClick={() => setAll(true)}
					className="inline-flex h-8 w-fit items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-muted-foreground outline-none hover:bg-surface-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring coarse:h-11"
				>
					<ChevronDown aria-hidden className="size-3.5" /> +{hidden} more
				</button>
			) : null}
		</section>
	);
});
