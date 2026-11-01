import { Download, ExternalLink, Loader2 } from "lucide-react";
import { createContext, lazy, memo, Suspense, useCallback, useContext, useState } from "react";
import { fileCategory, fileExt } from "@/lib/file-kind";
import { cn, formatBytes } from "@/lib/utils";
import { type RichFile } from "./assets.ts";
import { CATEGORY_LABEL, FileIcon } from "./file-icon.tsx";
import { BrokenImageCard } from "./rich-image.tsx";
import { LazyLightbox } from "./lazy-lightbox.tsx";
import { useInView } from "./use-in-view.ts";
import { t, tr } from "@/i18n";

const PreviewDialog = lazy(() => import("./preview-dialog.tsx"));

/** FileStrip publishes its images here so one lightbox can page through all of them. */
export const ImageGroupContext = createContext<readonly RichFile[] | null>(null);

const action =
	"inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring coarse:h-11 coarse:px-3 [&_svg]:size-3.5";

export interface FileTileProps {
	file: RichFile;
	/** Called by "Open" (session view: open in the Files panel). Without it the tile opens its own viewer. */
	onOpen?: (file: RichFile) => void;
	className?: string;
}

const Meta = ({ file }: { file: RichFile }) => {
	const cat = fileCategory(file.name, file.mimeType);
	const ext = fileExt(file.name);
	const parts = [ext && cat !== "image" ? ext : tr(CATEGORY_LABEL[cat]), file.size ? formatBytes(file.size) : null].filter(Boolean);
	return (
		<span className="block truncate text-2xs text-subtle">
			{parts.join(" · ")}
			{file.pending ? <span className="ml-1.5 inline-flex items-center gap-1 text-warning"><Loader2 className="size-3 animate-spin" aria-hidden />{t("fetching from a member")}</span> : null}
		</span>
	);
};

function Actions({ file, onOpen, openLabel, direct }: { file: RichFile; onOpen: () => void; openLabel?: string; direct?: boolean }) {
	return (
		<span className="flex shrink-0 items-center gap-0.5">
			{direct ? (
				<a className={action} href={file.url} target="_blank" rel="noreferrer noopener" aria-label={t("Open {name}", { name: file.name })} title={t("Open")}>
					<ExternalLink aria-hidden /> <span className="hidden @[22rem]:inline">{openLabel ?? t("Open")}</span>
				</a>
			) : (
				<button type="button" className={action} onClick={onOpen} aria-label={t("Open {name}", { name: file.name })} title={t("Open")}>
					<ExternalLink aria-hidden /> <span className="hidden @[22rem]:inline">{openLabel ?? t("Open")}</span>
				</button>
			)}
			<a className={action} href={file.downloadUrl} download={file.name} aria-label={t("Download {name}", { name: file.name })} title={t("Download")}>
				<Download aria-hidden /> <span className="hidden @[22rem]:inline">{t("Download")}</span>
			</a>
		</span>
	);
}

const shell = "rich-card @container w-full max-w-sm overflow-hidden rounded-xl bg-surface-1 shadow-[inset_0_0_0_1px_var(--border-strong)]";

/** One file rendered by what it is: image thumbnail, inline video/audio player, PDF first-page card, or a typed file card. */
export const FileTile = memo(function FileTile({ file, onOpen, className }: FileTileProps) {
	const group = useContext(ImageGroupContext);
	const [lightbox, setLightbox] = useState<number | null>(null);
	const [dialog, setDialog] = useState(false);
	const [failed, setFailed] = useState(false);
	const [ref, inView] = useInView<HTMLDivElement>(300, file.kind !== "pdf");
	const closeLightbox = useCallback(() => setLightbox(null), []);
	const closeDialog = useCallback(() => setDialog(false), []);
	const cat = fileCategory(file.name, file.mimeType);

	const images = group?.some((f) => f.key === file.key) ? group.filter((f) => f.kind === "image") : [file];
	const openLightbox = () => setLightbox(Math.max(0, images.findIndex((f) => f.key === file.key)));
	const open = () => {
		if (onOpen) onOpen(file);
		else if (file.kind === "image") openLightbox();
		else setDialog(true);
	};
	const direct = !onOpen && file.kind !== "image" && file.kind !== "pdf" && file.kind !== "video" && file.kind !== "audio";
	const caption = (
		<div className="flex items-center gap-2 px-3 py-2">
			<span className="min-w-0 flex-1">
				<span className="block truncate text-[13px] font-medium" title={file.name}>{file.name}</span>
				<Meta file={file} />
			</span>
			<Actions file={file} onOpen={open} direct={direct} />
		</div>
	);

	let body: React.ReactNode;
	if (file.kind === "image" && !failed) {
		body = (
			<>
				<button
					type="button"
					onClick={openLightbox}
					aria-label={t("View image {name}", { name: file.name })}
					className="relative block aspect-[4/3] w-full overflow-hidden bg-surface-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
				>
					<img src={file.url} alt={file.name} loading="lazy" decoding="async" onError={() => setFailed(true)} className="size-full cursor-zoom-in object-cover transition-transform duration-200 hover:scale-[1.02]" />
				</button>
				{caption}
			</>
		);
	} else if (file.kind === "image") {
		body = (
			<div className="p-2.5">
				<BrokenImageCard label={file.path ?? file.name} className="w-full" />
			</div>
		);
	} else if (file.kind === "video") {
		body = (
			<>
				<div className="aspect-video w-full bg-black">
					{inView ? (
						// biome-ignore lint/a11y/useMediaCaption: agent-produced media has no caption track
						<video src={file.url} controls preload="metadata" playsInline className="size-full object-contain" />
					) : null}
				</div>
				{caption}
			</>
		);
	} else if (file.kind === "audio") {
		body = (
			<div className="flex flex-col gap-2 p-3">
				<div className="flex items-center gap-3">
					<FileIcon category="audio" />
					<span className="min-w-0 flex-1">
						<span className="block truncate text-[13px] font-medium" title={file.name}>{file.name}</span>
						<Meta file={file} />
					</span>
					<a className={action} href={file.downloadUrl} download={file.name} aria-label={t("Download {name}", { name: file.name })}><Download aria-hidden /></a>
				</div>
				{inView ? (
					// biome-ignore lint/a11y/useMediaCaption: agent-produced media has no caption track
					<audio src={file.url} controls preload="metadata" className="h-9 w-full coarse:h-11" />
				) : <div className="h-9" />}
			</div>
		);
	} else if (file.kind === "pdf") {
		body = (
			<>
				<button type="button" onClick={open} aria-label={t("Open {name}", { name: file.name })} className="relative block h-44 w-full overflow-hidden bg-surface-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
					{/* Browsers without an embedded PDF viewer (iOS Safari, headless) leave the frame empty: the icon behind it keeps the card meaningful. */}
					<span aria-hidden className="absolute inset-0 grid place-items-center"><FileIcon category="pdf" /></span>
					{inView ? <iframe src={`${file.url}#page=1&view=FitH&toolbar=0&navpanes=0`} title={t("{name} preview", { name: file.name })} tabIndex={-1} loading="lazy" className="pointer-events-none relative h-[200%] w-full origin-top border-0 bg-transparent" /> : null}
					<span className="absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-surface-1/80 to-transparent" />
				</button>
				{caption}
			</>
		);
	} else {
		body = (
			<div className="flex items-center gap-3 p-3">
				<FileIcon category={cat} />
				<span className="min-w-0 flex-1">
					<span className="block truncate text-[13px] font-medium" title={file.name}>{file.name}</span>
					<Meta file={file} />
				</span>
				<Actions file={file} onOpen={open} direct={direct} />
			</div>
		);
	}

	return (
		<div ref={ref} className={cn(shell, className)}>
			{body}
			{lightbox !== null ? (
				<LazyLightbox
					items={images.map((f) => ({ src: f.url, alt: f.name, name: f.name, downloadUrl: f.downloadUrl }))}
					index={lightbox}
					onIndexChange={setLightbox}
					onClose={closeLightbox}
				/>
			) : null}
			{dialog ? (
				<Suspense fallback={null}>
					<PreviewDialog file={file} onClose={closeDialog} />
				</Suspense>
			) : null}
		</div>
	);
});
