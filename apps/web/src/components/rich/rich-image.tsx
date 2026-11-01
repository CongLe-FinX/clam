import { ExternalLink, ImageOff } from "lucide-react";
import { useCallback, useState } from "react";
import { cn } from "@/lib/utils";
import { LazyLightbox } from "./lazy-lightbox.tsx";
import { t } from "@/i18n";

/** Shown when a picture cannot be loaded: names the path instead of a broken-image icon. */
export function BrokenImageCard({ label, detail, className }: { label: string; detail?: string; className?: string }) {
	return (
		<span className={cn("inline-flex max-w-full items-center gap-2.5 rounded-lg bg-surface-2 px-3 py-2 text-left align-middle shadow-[inset_0_0_0_1px_var(--border)]", className)}>
			<ImageOff aria-hidden className="size-4 shrink-0 text-subtle" />
			<span className="min-w-0">
				<span className="block truncate text-[13px] font-medium text-foreground">{label}</span>
				<span className="block text-2xs text-subtle">{detail ?? t("Image not available")}</span>
			</span>
		</span>
	);
}

/** Remote pictures are blocked by the page CSP (img-src 'self' data: blob:), so they become an explicit open-in-new-tab card. */
export function RemoteImageCard({ src, alt, className }: { src: string; alt?: string; className?: string }) {
	let host = src;
	try {
		host = new URL(src).host;
	} catch {
		/* keep raw */
	}
	return (
		<span className={cn("inline-flex max-w-full items-center gap-3 rounded-lg bg-surface-2 px-3 py-2 align-middle shadow-[inset_0_0_0_1px_var(--border)]", className)}>
			<span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-info/12 text-info">
				<ExternalLink className="size-4" />
			</span>
			<span className="min-w-0">
				<span className="block truncate text-[13px] font-medium text-foreground">{alt || t("Remote image")}</span>
				<span className="block truncate text-2xs text-subtle" title={src}>
					{host} · {src}
				</span>
			</span>
			<a href={src} target="_blank" rel="noreferrer noopener" className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-accent outline-none hover:bg-accent-soft focus-visible:ring-2 focus-visible:ring-ring coarse:py-2.5">
				{t("Open image")}
			</a>
		</span>
	);
}

export interface RichImageProps {
	src: string;
	alt?: string;
	className?: string;
	/** Name shown on the fallback card when the image fails (path or file name). */
	label?: string;
}

/** One image: space reserved while loading, lazy decode, click opens the shared lightbox, failure → friendly card. */
export function RichImage({ src, alt = "", className, label }: RichImageProps) {
	const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
	const [open, setOpen] = useState(false);
	const close = useCallback(() => setOpen(false), []);
	if (state === "failed") return <BrokenImageCard label={label || alt || src} className={className} />;
	return (
		<>
			<button
				type="button"
				onClick={() => setOpen(true)}
				aria-label={alt ? t("View image: {alt}", { alt }) : t("View image")}
				className={cn(
					"relative block max-w-full overflow-hidden rounded-lg bg-surface-2 align-middle shadow-[inset_0_0_0_1px_var(--border)] outline-none focus-visible:ring-2 focus-visible:ring-ring",
					state === "loading" && "aspect-[16/10] w-full max-w-sm animate-pulse",
					className,
				)}
			>
				<img
					src={src}
					alt={alt}
					loading="lazy"
					decoding="async"
					onLoad={() => setState("ready")}
					onError={() => setState("failed")}
					className={cn("block max-h-[min(26rem,60dvh)] max-w-full cursor-zoom-in object-contain transition-opacity duration-200", state === "loading" ? "size-full opacity-0" : "opacity-100")}
				/>
			</button>
			{open ? <LazyLightbox items={[{ src, alt: alt || label || t("Image"), name: label || alt }]} index={0} onIndexChange={() => undefined} onClose={close} /> : null}
		</>
	);
}
