import { Download } from "lucide-react";
import { lazy, type ReactNode, Suspense, useCallback, useState } from "react";
import { fileCategory } from "@/lib/file-kind";
import { type RichFile } from "./assets.ts";
import { FileIcon } from "./file-icon.tsx";
import { LazyLightbox } from "./lazy-lightbox.tsx";
import { t } from "@/i18n";

const PreviewDialog = lazy(() => import("./preview-dialog.tsx"));

const chip =
	"mx-0.5 inline-flex max-w-full items-center gap-1.5 rounded-md bg-surface-3 py-0.5 pl-1 pr-2 align-middle text-[0.93em] font-medium text-foreground no-underline outline-none transition-colors hover:bg-border-strong focus-visible:ring-2 focus-visible:ring-ring coarse:min-h-11";

/** Inline reference to a file from markdown (`[report](out/report.xlsx)`): images open the lightbox, video/audio/PDF a preview, the rest download. */
export function FileChip({ file, children }: { file: RichFile; children: ReactNode }) {
	const [open, setOpen] = useState(false);
	const close = useCallback(() => setOpen(false), []);
	const cat = fileCategory(file.name, file.mimeType);
	const inner = (
		<>
			<FileIcon category={cat} className="size-5 rounded [&_svg]:size-3" />
			<span className="min-w-0 truncate">{children}</span>
		</>
	);
	if (file.kind === "other" || file.kind === "text") {
		return (
			<a className={chip} href={file.downloadUrl} download={file.name} title={t("Download {name}", { name: file.name })}>
				{inner}
				<Download aria-hidden className="size-3 shrink-0 text-subtle" />
			</a>
		);
	}
	return (
		<>
			<button type="button" className={chip} onClick={() => setOpen(true)} title={file.name}>
				{inner}
			</button>
			{open && file.kind === "image" ? <LazyLightbox items={[{ src: file.url, alt: file.name, name: file.name, downloadUrl: file.downloadUrl }]} index={0} onIndexChange={() => undefined} onClose={close} /> : null}
			{open && file.kind !== "image" ? (
				<Suspense fallback={null}>
					<PreviewDialog file={file} onClose={close} />
				</Suspense>
			) : null}
		</>
	);
}
