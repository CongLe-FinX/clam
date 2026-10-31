import * as D from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, Download, Maximize2, Minimize2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { LightboxProps } from "./lazy-lightbox.tsx";

const btn =
	"grid size-9 place-items-center rounded-lg bg-white/10 text-white outline-none transition-colors hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-ring coarse:size-11";

/** Full-screen image viewer: Esc closes, ←/→ move through the group, click toggles fit / actual size. */
export default function Lightbox({ items, index, onIndexChange, onClose }: LightboxProps) {
	const [actual, setActual] = useState(false);
	const [failed, setFailed] = useState(false);
	const item = items[index];
	const count = items.length;
	useEffect(() => {
		setActual(false);
		setFailed(false);
	}, [index]);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (count < 2) return;
			if (e.key === "ArrowLeft") onIndexChange((index - 1 + count) % count);
			else if (e.key === "ArrowRight") onIndexChange((index + 1) % count);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [index, count, onIndexChange]);
	if (!item) return null;
	return (
		<D.Root open onOpenChange={(o) => !o && onClose()}>
			<D.Portal>
				<D.Overlay className="clam-overlay fixed inset-0 z-[70] bg-black/85" />
				<D.Content
					aria-describedby={undefined}
					className="clam-overlay fixed inset-0 z-[71] flex flex-col outline-none pt-safe pb-safe px-safe"
				>
					<D.Title className="sr-only">{item.alt || item.name || "Image"}</D.Title>
					<div className="flex items-center gap-2 px-3 py-2 text-white">
						<span className="min-w-0 flex-1 truncate text-[13px] font-medium">{item.name || item.alt}</span>
						{count > 1 ? <span className="tabular text-xs text-white/70">{index + 1} / {count}</span> : null}
						<button type="button" className={btn} aria-label={actual ? "Fit to screen" : "Actual size"} onClick={() => setActual((v) => !v)}>
							{actual ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
						</button>
						{item.downloadUrl ? (
							<a className={btn} href={item.downloadUrl} download={item.name} aria-label="Download image">
								<Download className="size-4" />
							</a>
						) : null}
						<D.Close className={btn} aria-label="Close">
							<X className="size-4" />
						</D.Close>
					</div>
					<div className="relative flex min-h-0 flex-1 items-center justify-center" onClick={(e) => e.target === e.currentTarget && onClose()}>
						<div className={cn("scrollbar-thin flex size-full", actual ? "overflow-auto" : "items-center justify-center")} onClick={(e) => e.target === e.currentTarget && onClose()}>
							{failed ? (
								<p className="m-auto text-sm text-white/80">This image could not be loaded.</p>
							) : (
								<img
									key={item.src}
									src={item.src}
									alt={item.alt}
									decoding="async"
									onError={() => setFailed(true)}
									onClick={() => setActual((v) => !v)}
									className={cn("select-none", actual ? "m-auto max-w-none cursor-zoom-out" : "max-h-full max-w-full cursor-zoom-in object-contain")}
								/>
							)}
						</div>
						{count > 1 ? (
							<>
								<button type="button" aria-label="Previous image" className={cn(btn, "absolute left-2 top-1/2 -translate-y-1/2")} onClick={() => onIndexChange((index - 1 + count) % count)}>
									<ChevronLeft className="size-5" />
								</button>
								<button type="button" aria-label="Next image" className={cn(btn, "absolute right-2 top-1/2 -translate-y-1/2")} onClick={() => onIndexChange((index + 1) % count)}>
									<ChevronRight className="size-5" />
								</button>
							</>
						) : null}
					</div>
				</D.Content>
			</D.Portal>
		</D.Root>
	);
}
