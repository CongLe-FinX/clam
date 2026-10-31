import { File, FileArchive, FileAudio, FileCode, FileJson, FileSpreadsheet, FileText, FileVideo, Image, Presentation, type LucideIcon } from "lucide-react";
import { type FileCategory } from "@/lib/file-kind";
import { cn } from "@/lib/utils";

const ICONS: Record<FileCategory, LucideIcon> = {
	image: Image,
	video: FileVideo,
	audio: FileAudio,
	pdf: FileText,
	spreadsheet: FileSpreadsheet,
	document: FileText,
	presentation: Presentation,
	archive: FileArchive,
	code: FileCode,
	data: FileJson,
	text: FileText,
	other: File,
};

const TONES: Record<FileCategory, string> = {
	image: "text-info bg-info/12",
	video: "text-accent bg-accent-soft",
	audio: "text-accent bg-accent-soft",
	pdf: "text-danger bg-danger/12",
	spreadsheet: "text-success bg-success/12",
	document: "text-info bg-info/12",
	presentation: "text-warning bg-warning/12",
	archive: "text-warning bg-warning/12",
	code: "text-muted-foreground bg-surface-3",
	data: "text-muted-foreground bg-surface-3",
	text: "text-muted-foreground bg-surface-3",
	other: "text-muted-foreground bg-surface-3",
};

export const CATEGORY_LABEL: Record<FileCategory, string> = {
	image: "Image",
	video: "Video",
	audio: "Audio",
	pdf: "PDF document",
	spreadsheet: "Spreadsheet",
	document: "Document",
	presentation: "Presentation",
	archive: "Archive",
	code: "Source file",
	data: "Data file",
	text: "Text file",
	other: "File",
};

/** Rounded square badge with the icon for a file family. */
export function FileIcon({ category, className }: { category: FileCategory; className?: string }) {
	const Icon = ICONS[category];
	return (
		<span aria-hidden className={cn("grid size-10 shrink-0 place-items-center rounded-lg", TONES[category], className)}>
			<Icon className="size-5" />
		</span>
	);
}
