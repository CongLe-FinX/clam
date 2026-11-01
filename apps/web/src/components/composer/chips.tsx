import { AlertCircle, EyeOff, RotateCw, X } from "lucide-react";
import { memo } from "react";
import { fileCategory } from "@/lib/file-kind";
import { t } from "@/i18n";
import { cn, formatBytes } from "@/lib/utils";
import { FileIcon } from "../rich/file-icon.tsx";

/** One thing waiting to go with the next message: a picture (thumbnail chip) or any other file (file chip). */
export interface ChipModel {
	id: string | number;
	name: string;
	size: number;
	kind: "image" | "file";
	/** Image URL (object URL, data URL or file URL). */
	preview?: string;
	mimeType?: string;
	status: "uploading" | "ready" | "error";
	/** 0..1 while uploading. */
	progress: number;
	error?: string;
	/** Picture that the model will not see (it only gets the file path); shown as a small badge with this explanation. */
	unseen?: string;
}

const remove = "grid size-5 place-items-center rounded-full bg-black/65 text-white outline-none backdrop-blur-sm transition-colors hover:bg-black/80 focus-visible:ring-2 focus-visible:ring-ring before:absolute before:-inset-2 before:content-[''] coarse:size-6 coarse:before:-inset-3";

function Bar({ progress }: { progress: number }) {
	return (
		<span aria-hidden className="absolute inset-x-0 bottom-0 h-1 overflow-hidden bg-black/25">
			<span className="block h-full origin-left bg-accent transition-transform duration-150 ease-out" style={{ transform: `scaleX(${Math.min(1, Math.max(0.04, progress))})` }} />
		</span>
	);
}

const Chip = memo(function Chip({ chip, onRemove, onRetry }: { chip: ChipModel; onRemove: (id: ChipModel["id"]) => void; onRetry?: (id: ChipModel["id"]) => void }) {
	const failed = chip.status === "error";
	const busy = chip.status === "uploading";
	const label = busy ? t("Cancel upload of {name}", { name: chip.name }) : t("Remove {name}", { name: chip.name });
	const retry =
		failed && onRetry ? (
			<button type="button" aria-label={t("Retry upload of {name}", { name: chip.name })} onClick={() => onRetry(chip.id)} className="absolute left-1/2 top-1/2 grid size-8 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white/95 text-danger outline-none shadow-sm focus-visible:ring-2 focus-visible:ring-ring coarse:size-10">
				<RotateCw className="size-4" />
			</button>
		) : null;
	if (chip.kind === "image") {
		return (
			<li title={failed ? `${chip.name} — ${chip.error ?? t("Upload failed")}` : chip.name} className="animate-fade-in relative size-16 shrink-0 overflow-hidden rounded-xl bg-surface-2 shadow-[inset_0_0_0_1px_var(--border)] coarse:size-[4.5rem]">
				{chip.preview ? <img src={chip.preview} alt={chip.name} draggable={false} className={cn("size-full object-cover transition-opacity duration-200", busy && "opacity-70", failed && "opacity-60")} /> : <FileIcon category="image" className="m-auto size-full rounded-none" />}
				{failed ? <span aria-hidden className="absolute inset-0 bg-danger/25" /> : null}
				{chip.unseen ? (
					<span title={chip.unseen} className="absolute bottom-1 left-1 grid size-5 place-items-center rounded-full bg-black/65 text-white backdrop-blur-sm">
						<EyeOff aria-hidden className="size-3" />
						<span className="sr-only">{chip.unseen}</span>
					</span>
				) : null}
				<span className="absolute right-1 top-1">
					<button type="button" aria-label={label} onClick={() => onRemove(chip.id)} className={cn(remove, "relative")}>
						<X className="size-3" />
					</button>
				</span>
				{retry}
				{busy ? <Bar progress={chip.progress} /> : null}
			</li>
		);
	}
	return (
		<li title={failed ? `${chip.name} — ${chip.error ?? t("Upload failed")}` : chip.name} className={cn("animate-fade-in relative flex h-16 w-52 shrink-0 items-center gap-2.5 overflow-hidden rounded-xl bg-surface-2 px-2.5 shadow-[inset_0_0_0_1px_var(--border)] coarse:h-[4.5rem] coarse:w-56", failed && "shadow-[inset_0_0_0_1px_var(--danger)]")}>
			{failed ? <AlertCircle aria-hidden className="size-9 shrink-0 rounded-lg bg-danger/12 p-2 text-danger" /> : <FileIcon category={fileCategory(chip.name, chip.mimeType)} className="size-9 shrink-0 rounded-lg" />}
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="truncate text-[13px] font-medium">{chip.name}</span>
				<span className={cn("tabular truncate text-2xs", failed ? "text-danger" : "text-subtle")}>{failed ? (chip.error ?? t("Upload failed")) : busy ? t("{percent} uploaded", { percent: `${Math.round(chip.progress * 100)}%` }) : formatBytes(chip.size)}</span>
			</span>
			{failed && onRetry ? (
				<button type="button" aria-label={t("Retry upload of {name}", { name: chip.name })} onClick={() => onRetry(chip.id)} className="grid size-7 shrink-0 place-items-center rounded-md text-danger outline-none hover:bg-danger/12 focus-visible:ring-2 focus-visible:ring-ring coarse:size-11">
					<RotateCw className="size-4" />
				</button>
			) : null}
			<button type="button" aria-label={label} onClick={() => onRemove(chip.id)} className="grid size-7 shrink-0 place-items-center rounded-md text-subtle outline-none hover:bg-surface-3 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring coarse:size-11">
				<X className="size-3.5" />
			</button>
			{busy ? <Bar progress={chip.progress} /> : null}
		</li>
	);
});

/** The chips of everything attached to the message being written: thumbnails for pictures, cards for other files, each with progress, an error + retry, and a remove button. */
export function ComposerChips({ chips, onRemove, onRetry, className }: { chips: readonly ChipModel[]; onRemove: (id: ChipModel["id"]) => void; onRetry?: (id: ChipModel["id"]) => void; className?: string }) {
	if (chips.length === 0) return null;
	return (
		<ul aria-label={t("Attachments")} className={cn("scrollbar-none flex gap-2 overflow-x-auto px-2.5 pb-1 pt-2.5", className)}>
			{chips.map((chip) => (
				<Chip key={chip.id} chip={chip} onRemove={onRemove} onRetry={onRetry} />
			))}
		</ul>
	);
}
