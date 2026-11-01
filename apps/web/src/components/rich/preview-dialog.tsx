import { Download } from "lucide-react";
import { lazy, Suspense } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/ui/dialog";
import { Skeleton } from "@/ui/skeleton";
import type { RichFile } from "./assets.ts";
import { t } from "@/i18n";

const FilePreview = lazy(() => import("../file-preview.tsx"));

/** Modal preview for video/audio/PDF files (images use the lightbox). Loaded lazily by FileTile / FileChip. */
export default function PreviewDialog({ file, onClose }: { file: RichFile; onClose: () => void }) {
	return (
		<Dialog open onOpenChange={(o) => !o && onClose()}>
			<DialogContent aria-describedby={undefined} className="h-[min(88dvh,56rem)] max-w-5xl gap-2 p-3 sm:p-4">
				<div className="flex items-center gap-2 pr-10">
					<DialogTitle className="min-w-0 flex-1 truncate">{file.name}</DialogTitle>
					<a
						href={file.downloadUrl}
						download={file.name}
						className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-surface-3 px-3 text-[13px] font-medium outline-none hover:bg-border-strong focus-visible:ring-2 focus-visible:ring-ring coarse:h-11"
					>
						<Download className="size-4" /> {t("Download")}
					</a>
				</div>
				<div className="min-h-0 flex-1 overflow-hidden rounded-lg">
					<Suspense fallback={<Skeleton className="size-full" />}>
						<FilePreview kind={file.kind} src={file.url} name={file.name} />
					</Suspense>
				</div>
			</DialogContent>
		</Dialog>
	);
}
