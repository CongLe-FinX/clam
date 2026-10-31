import { FileQuestion } from "lucide-react";
import { useState } from "react";
import { type PreviewKind } from "@/lib/file-kind";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/ui/empty-state";

/**
 * Renders a file the browser can show natively from its bytes URL: image, video/audio (the server answers Range requests, so seeking works),
 * PDF. `src` must serve the bytes inline; downloads go through a separate `?download=1` link.
 */
export default function FilePreview({ kind, src, name, className }: { kind: PreviewKind; src: string; name: string; className?: string }) {
	const [failed, setFailed] = useState(false);
	if (failed) return <EmptyState icon={FileQuestion} title="Can’t preview this file" description="Your browser could not play or display it. Use Download to open it in another app." />;
	switch (kind) {
		case "image":
			return (
				<div className={cn("scrollbar-thin grid h-full place-items-center overflow-auto bg-surface-1 p-4", className)}>
					<img src={src} alt={name} onError={() => setFailed(true)} className="max-h-full max-w-full rounded-lg object-contain shadow-[0_0_0_1px_var(--border)]" />
				</div>
			);
		case "video":
			return (
				<div className={cn("grid h-full place-items-center bg-black/90 p-2", className)}>
					{/* biome-ignore lint/a11y/useMediaCaption: user-generated media has no caption track */}
					<video src={src} controls preload="metadata" playsInline onError={() => setFailed(true)} className="max-h-full max-w-full rounded-lg" />
				</div>
			);
		case "audio":
			return (
				<div className={cn("grid h-full place-items-center bg-surface-1 p-6", className)}>
					<div className="flex w-full max-w-md flex-col gap-3 rounded-xl bg-surface-2 p-4 shadow-[inset_0_0_0_1px_var(--border)]">
						<span className="truncate text-[13px] font-medium">{name}</span>
						{/* biome-ignore lint/a11y/useMediaCaption: user-generated media has no caption track */}
						<audio src={src} controls preload="metadata" onError={() => setFailed(true)} className="w-full" />
					</div>
				</div>
			);
		case "pdf":
			return <iframe src={src} title={name} onError={() => setFailed(true)} className={cn("h-full w-full border-0 bg-surface-1", className)} />;
		default:
			return null;
	}
}
