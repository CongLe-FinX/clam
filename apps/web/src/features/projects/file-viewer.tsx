import { type FileContent, routes } from "@clam/contracts";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertTriangle, ChevronRight, Download, FileQuestion, FileX, RefreshCw, WrapText, X } from "lucide-react";
import { Fragment, lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { CopyButton, HlLineView } from "@/components/code-block";
import { LazyMarkdown } from "@/components/lazy-markdown";
import { t } from "@/i18n";
import { api, errorText, localUrl } from "@/lib/api";
import { isMediaKind, previewKind } from "@/lib/file-kind";
import { type HlLine, highlightLines, langFromPath } from "@/lib/highlight";
import { qk } from "@/lib/queries";
import { cn, formatBytes, formatNumber } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty-state";
import { Skeleton } from "@/ui/skeleton";
import { Tip } from "@/ui/tooltip";

export interface FileViewerProps {
	projectId: string;
	path: string;
	className?: string;
	onClose?: () => void;
}

const LINE_HEIGHT = 20;
const WRAP_KEY = "clam.viewer.wrap";

function useWrapPref() {
	const [wrap, setWrap] = useState(() => {
		try {
			return localStorage.getItem(WRAP_KEY) === "1";
		} catch {
			return false;
		}
	});
	const set = (v: boolean) => {
		setWrap(v);
		try {
			localStorage.setItem(WRAP_KEY, v ? "1" : "0");
		} catch {
			/* preference just isn't remembered */
		}
	};
	return [wrap, set] as const;
}

const FilePreview = lazy(() => import("@/components/file-preview.tsx"));

export function FileViewer({ projectId, path, className, onClose }: FileViewerProps) {
	const kind = previewKind(path);
	const media = isMediaKind(kind);
	const rawUrl = localUrl(routes.projectRaw(projectId), { path });
	const downloadUrl = localUrl(routes.projectRaw(projectId), { path, download: 1 });
	const q = useQuery({
		queryKey: qk.projectFile(projectId, path),
		queryFn: ({ signal }) => api.get<FileContent>(routes.projectFile(projectId), { path }, { signal }),
		enabled: !media,
	});
	const [wrap, setWrap] = useWrapPref();
	const [mode, setMode] = useState<"preview" | "source">("preview");
	const isMd = /\.(md|mdx)$/i.test(path);
	const data = q.data;
	const lang = data?.language ?? langFromPath(path);
	const segments = path.split("/");

	// Reset to the rendered preview whenever another markdown file opens.
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed on path
	useEffect(() => setMode("preview"), [path]);

	return (
		<div className={cn("flex h-full min-h-0 flex-col bg-background", className)}>
			<div className="flex h-10 shrink-0 items-center gap-1 border-b px-2 coarse:h-12">
				<nav aria-label={t("File path")} className="scrollbar-none flex min-w-0 flex-1 items-center overflow-x-auto font-mono text-xs">
					{segments.map((seg, i) => (
						<Fragment key={i}>
							{i > 0 ? <ChevronRight aria-hidden className="mx-0.5 size-3 shrink-0 text-subtle" /> : null}
							<span className={cn("shrink-0 whitespace-nowrap", i === segments.length - 1 ? "font-medium text-foreground" : "text-subtle")}>{seg}</span>
						</Fragment>
					))}
				</nav>
				{data ? <span className="hidden shrink-0 font-mono text-2xs text-subtle tabular sm:inline">{formatBytes(data.size)}</span> : null}
				{lang ? (
					<Badge variant="outline" className="hidden shrink-0 sm:inline-flex">
						{lang}
					</Badge>
				) : null}
				{isMd && data?.content != null ? (
					<div role="group" aria-label={t("Markdown view")} className="flex shrink-0 rounded-md bg-surface-2 p-0.5 text-2xs font-medium">
						{(["preview", "source"] as const).map((m) => (
							<button
								key={m}
								type="button"
								aria-pressed={mode === m}
								onClick={() => setMode(m)}
								className={cn("rounded px-2 py-1 first-letter:uppercase outline-none transition-colors coarse:px-3 coarse:py-2", mode === m ? "bg-surface-3 text-foreground" : "text-muted-foreground hover:text-foreground")}
							>
								{m === "preview" ? t("Preview") : t("Source")}
							</button>
						))}
					</div>
				) : null}
				{data?.content != null && !(isMd && mode === "preview") ? (
					<Tip label={wrap ? t("Disable line wrap") : t("Wrap lines")}>
						<Button variant="ghost" size="icon-sm" aria-label={t("Toggle line wrap")} aria-pressed={wrap} onClick={() => setWrap(!wrap)} className={cn(wrap && "bg-surface-3 text-foreground")}>
							<WrapText />
						</Button>
					</Tip>
				) : null}
				<span className="hidden sm:contents"><CopyButton text={path} label={t("Copy path")} /></span>
				<Tip label={t("Download")}>
					<Button asChild variant="ghost" size="icon-sm">
						<a href={downloadUrl} download={segments.at(-1)} aria-label={t("Download {name}", { name: segments.at(-1) ?? path })}>
							<Download />
						</a>
					</Button>
				</Tip>
				{data?.content != null ? <CopyButton text={data.content} label={t("Copy contents")} /> : null}
				{onClose ? (
					<Tip label={t("Close file")}>
						<Button variant="ghost" size="icon-sm" aria-label={t("Close file")} onClick={onClose}>
							<X />
						</Button>
					</Tip>
				) : null}
			</div>

			{data?.truncated ? (
				<div role="status" className="flex shrink-0 items-center gap-2 border-b bg-warning/10 px-3 py-1.5 text-xs text-warning">
					<AlertTriangle className="size-3.5 shrink-0" />
					<span>{t("Showing the beginning of this file only ({size} total).", { size: formatBytes(data.size) })}</span>
				</div>
			) : null}

			<div className="min-h-0 flex-1">
				{media ? (
					<Suspense fallback={<ViewerSkeleton />}>
						<FilePreview key={path} kind={kind} src={rawUrl} name={segments.at(-1) ?? path} />
					</Suspense>
				) : q.isPending ? (
					<ViewerSkeleton />
				) : q.error ? (
					<EmptyState
						icon={FileX}
						title={t("Could not open file")}
						description={errorText(q.error)}
						action={
							<Button size="sm" variant="outline" onClick={() => void q.refetch()}>
								<RefreshCw /> {t("Retry")}
							</Button>
						}
					/>
				) : !data ? null : data.binary ? (
					<EmptyState icon={FileQuestion} title={t("Binary file")} description={t("This file can’t be shown as text ({size}).", { size: formatBytes(data.size) })} action={<DownloadLink href={downloadUrl} name={segments.at(-1) ?? path} />} />
				) : data.content === null ? (
					<EmptyState icon={FileQuestion} title={t("File too large to preview")} description={t("This file is {size}, which exceeds the preview limit.", { size: formatBytes(data.size) })} action={<DownloadLink href={downloadUrl} name={segments.at(-1) ?? path} />} />
				) : isMd && mode === "preview" ? (
					<div className="scrollbar-thin h-full overflow-y-auto overscroll-contain px-4 py-4 sm:px-6">
						<div className="mx-auto max-w-3xl">
							<LazyMarkdown text={data.content} />
						</div>
					</div>
				) : (
					<CodeView content={data.content} lang={lang} wrap={wrap} />
				)}
			</div>
		</div>
	);
}

function ViewerSkeleton() {
	const widths = ["w-2/5", "w-3/5", "w-1/3", "w-4/5", "w-1/2", "w-2/3", "w-1/4", "w-3/4"];
	return (
		<div aria-busy className="flex flex-col gap-2.5 p-4">
			{Array.from({ length: 14 }, (_, i) => (
				<Skeleton key={i} className={cn("h-3", widths[i % widths.length])} />
			))}
		</div>
	);
}

function CodeView({ content, lang, wrap }: { content: string; lang: string | null; wrap: boolean }) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const lines = useMemo(() => content.split("\n"), [content]);
	const [tokens, setTokens] = useState<{ content: string; lines: HlLine[] } | null>(null);

	useEffect(() => {
		let alive = true;
		setTokens(null);
		highlightLines(content, lang)
			.then((l) => {
				if (alive && l) setTokens({ content, lines: l });
			})
			.catch(() => undefined);
		return () => {
			alive = false;
		};
	}, [content, lang]);
	const hl = tokens && tokens.content === content ? tokens.lines : null;

	const maxLen = useMemo(() => {
		let m = 0;
		for (const l of lines) if (l.length > m) m = l.length;
		return m;
	}, [lines]);
	const gutterCh = String(lines.length).length + 2;

	const v = useVirtualizer({
		count: lines.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => LINE_HEIGHT,
		overscan: 30,
	});
	// Row heights differ between wrapped and unwrapped modes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measure on wrap toggle
	useEffect(() => v.measure(), [wrap, v]);

	return (
		<div ref={scrollRef} className="scrollbar-thin h-full overflow-auto overscroll-contain font-mono text-[12.5px]" style={{ lineHeight: `${LINE_HEIGHT}px` }}>
			<div className="relative" style={{ height: v.getTotalSize(), width: wrap ? "100%" : `calc(${gutterCh}ch + ${maxLen}ch + 32px)`, minWidth: "100%" }}>
				{v.getVirtualItems().map((item) => {
					const text = lines[item.index] as string;
					const line = hl?.[item.index];
					return (
						<div
							key={item.key}
							data-index={item.index}
							ref={wrap ? v.measureElement : undefined}
							className="absolute left-0 top-0 flex w-full hover:bg-surface-1"
							style={{ transform: `translateY(${item.start}px)`, height: wrap ? undefined : LINE_HEIGHT }}
						>
							<span
								aria-hidden
								className="sticky left-0 z-[1] shrink-0 select-none bg-background pr-3 text-right text-subtle tabular"
								style={{ width: `${gutterCh}ch`, paddingLeft: "0.5ch" }}
							>
								{item.index + 1}
							</span>
							<code className={cn("block min-w-0 flex-1 pl-2 pr-4", wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre")}>
								{line ? <HlLineView line={line} /> : text || " "}
								{line && line.length === 0 ? " " : null}
							</code>
						</div>
					);
				})}
			</div>
			<span className="sr-only">{t("{count, plural, one {# line} other {# lines}}", { count: lines.length })}</span>
		</div>
	);
}

function DownloadLink({ href, name }: { href: string; name: string }) {
	return (
		<Button asChild size="sm" variant="outline">
			<a href={href} download={name}>
				<Download /> {t("Download")}
			</a>
		</Button>
	);
}
