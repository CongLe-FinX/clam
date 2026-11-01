import { type BrowserDownload, routes } from "@clam/contracts";
import { Download } from "lucide-react";
import { t } from "@/i18n";
import { useState } from "react";
import { localUrl } from "@/lib/api";
import { cn, formatBytes } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Progress } from "@/ui/progress";
import { Tip } from "@/ui/tooltip";

export function downloadHref(name: string): string {
	return localUrl(routes.browserDownload(name));
}

function progressText(d: BrowserDownload): string {
	if (d.state === "completed") return formatBytes(d.size);
	if (d.state === "canceled") return t("Canceled");
	if (d.size > 0) return t("{received} of {size}", { received: formatBytes(d.received), size: formatBytes(d.size) });
	return formatBytes(d.received);
}

/** Downloads the machine's browser has made, newest first. Files land on the machine; the link fetches a copy. */
export function DownloadsList({ downloads, className }: { downloads: BrowserDownload[]; className?: string }) {
	if (downloads.length === 0) return <p className={cn("px-2 py-6 text-center text-xs text-subtle", className)}>{t("Nothing downloaded yet.")}</p>;
	const sorted = [...downloads].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
	return (
		<ul className={cn("scrollbar-thin max-h-80 divide-y overflow-y-auto", className)}>
			{sorted.map((d) => {
				const pct = d.size > 0 ? (d.received / d.size) * 100 : 0;
				return (
					<li key={d.name} className="flex flex-col gap-1.5 px-2 py-2">
						<div className="flex items-center gap-2">
							<div className="min-w-0 flex-1">
								<p className="truncate text-[13px] font-medium" title={d.name}>
									{d.name}
								</p>
								<p className="truncate text-2xs text-subtle" title={d.sourceUrl}>
									{progressText(d)} · {d.sourceUrl}
								</p>
							</div>
							{d.state === "completed" ? (
								<Button asChild variant="outline" size="sm">
									<a href={downloadHref(d.name)} download={d.name}>
										<Download /> {t("Save")}
									</a>
								</Button>
							) : null}
						</div>
						{d.state === "inProgress" ? <Progress value={pct} className="h-1" /> : null}
					</li>
				);
			})}
		</ul>
	);
}

/** Toolbar button with a badge for downloads not yet looked at. */
export function DownloadsButton({ downloads }: { downloads: BrowserDownload[] }) {
	const [seen, setSeen] = useState(0);
	const [open, setOpen] = useState(false);
	const unseen = Math.max(0, downloads.length - seen);
	const active = downloads.some((d) => d.state === "inProgress");
	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (next) setSeen(downloads.length);
			}}
		>
			<Tip label={t("Downloads")}>
				<PopoverTrigger asChild>
					<Button variant="ghost" size="icon" aria-label={unseen > 0 ? t("Downloads ({count} new)", { count: unseen }) : t("Downloads")} className="relative">
						<Download className={cn(active && "animate-pulse")} />
						{unseen > 0 ? <span className="absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 font-mono text-2xs font-semibold text-accent-foreground coarse:right-1.5 coarse:top-1.5">{unseen}</span> : null}
					</Button>
				</PopoverTrigger>
			</Tip>
			<PopoverContent align="end" className="w-96 p-1.5">
				<DownloadsList downloads={downloads} />
			</PopoverContent>
		</Popover>
	);
}
