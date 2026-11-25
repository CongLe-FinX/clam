import { type FileContent, type FileEntry, routes } from "@clam/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertTriangle, Check, ChevronRight, Download, ExternalLink, FileQuestion, FileX, Pencil, RefreshCw, Save, WrapText, X } from "lucide-react";
import { Fragment, type KeyboardEvent, lazy, type ReactNode, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { CopyButton, HlLineView } from "@/components/code-block";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { LazyMarkdown } from "@/components/lazy-markdown";
import { projectAssets } from "@/components/rich/assets";
import { t } from "@/i18n";
import { api, ApiError, errorText, localUrl } from "@/lib/api";
import { isMediaKind, previewKind } from "@/lib/file-kind";
import { type HlLine, highlightLines, langFromPath } from "@/lib/highlight";
import { qk } from "@/lib/queries";
import { uploadFile } from "@/lib/upload";
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
	/** Extra toolbar controls (Quick Look: previous / next file, terminal), placed before the copy and download buttons. */
	actions?: ReactNode;
	/** Open another file of the project in this viewer (a document's links: `[License](LICENSE)`, `docs/guide.md`). */
	onOpenFile?: (path: string) => void;
	/** The editor holds changes that are not saved (the host asks before closing or leaving the file). */
	onDirtyChange?: (dirty: boolean) => void;
}

/** The text being edited and the version of the file it started from (`seq` remounts the editor with fresh text). */
interface EditSession {
	content: string;
	modifiedAt: string;
	seq: number;
}

const CodeEditor = lazy(() => import("@/components/code-editor.tsx"));

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

export function FileViewer({ projectId, path, className, onClose, actions, onOpenFile, onDirtyChange }: FileViewerProps) {
	const qc = useQueryClient();
	const kind = previewKind(path);
	const media = isMediaKind(kind);
	const rawUrl = localUrl(routes.projectRaw(projectId), { path });
	const downloadUrl = localUrl(routes.projectRaw(projectId), { path, download: 1 });
	// Relative links and images in a markdown file point next to it (`images/x.png` beside `docs/guide.md`), not at the project root.
	const assets = useMemo(() => projectAssets(projectId, path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""), [projectId, path]);
	const q = useQuery({
		queryKey: qk.projectFile(projectId, path),
		queryFn: ({ signal }) => api.get<FileContent>(routes.projectFile(projectId), { path }, { signal }),
		enabled: !media,
	});
	const [wrap, setWrap] = useWrapPref();
	const [mode, setMode] = useState<"preview" | "source">("preview");
	const isMd = /\.(md|mdx)$/i.test(path);
	const isHtml = /\.html?$/i.test(path);
	const previewable = isMd || isHtml;
	const pageUrl = localUrl(routes.projectRaw(projectId), { path, page: 1 });
	const data = q.data;
	const lang = data?.language ?? langFromPath(path);
	const segments = path.split("/");
	const name = segments.at(-1) ?? path;

	// ── editing ── the editor starts from the version read (`edit`); `draft` is what is typed. A save sends that version's modifiedAt, so
	// a change written meanwhile (an agent, a teammate) is reported as a conflict instead of being overwritten.
	const editable = !media && data != null && data.content !== null && !data.binary && !data.truncated;
	const [edit, setEdit] = useState<EditSession | null>(null);
	const [draft, setDraft] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [conflict, setConflict] = useState<{ deleted: boolean } | null>(null);
	const [confirmDiscard, setConfirmDiscard] = useState(false);
	const dirty = edit !== null && draft !== null && draft !== edit.content;

	const startEditing = (from: FileContent) => {
		setEdit((prev) => ({ content: from.content ?? "", modifiedAt: from.modifiedAt, seq: (prev?.seq ?? 0) + 1 }));
		setDraft(null);
		setConflict(null);
	};
	const stopEditing = () => {
		setEdit(null);
		setDraft(null);
		setConflict(null);
	};

	// A new (empty) text file opens straight in the editor.
	const opened = useRef(false);
	useEffect(() => {
		if (opened.current || !data || !editable) return;
		opened.current = true;
		if (data.size === 0) startEditing(data);
		// biome-ignore lint/correctness/useExhaustiveDependencies: once per file (the viewer is keyed by path)
	}, [data, editable]);

	// The file changed on disk while it is open in the editor: without local changes the editor follows it (like VS Code); with
	// changes it stays, and a banner offers to load the new version.
	const changedOnDisk = edit !== null && data != null && data.content !== null && data.modifiedAt !== edit.modifiedAt;
	useEffect(() => {
		if (changedOnDisk && !dirty && data) startEditing(data);
		// biome-ignore lint/correctness/useExhaustiveDependencies: reacts to the file's version only
	}, [changedOnDisk, dirty]);

	useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
	useEffect(() => {
		if (!dirty) return;
		const warn = (e: BeforeUnloadEvent) => e.preventDefault();
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [dirty]);

	const save = async (force = false) => {
		if (!edit || saving) return;
		const text = draft ?? edit.content;
		setSaving(true);
		try {
			const url = localUrl(routes.projectUpload(projectId), force ? { path, overwrite: 1 } : { path, expectedModifiedAt: edit.modifiedAt });
			const file = new File([text], name, { type: "text/plain" });
			const entry = await uploadFile<FileEntry>(url, file).promise;
			// The upload answers with the written file's stat; these fallbacks only keep the types whole.
			const modifiedAt = entry.modifiedAt ?? edit.modifiedAt;
			setEdit({ content: text, modifiedAt, seq: edit.seq });
			setConflict(null);
			qc.setQueryData<FileContent>(qk.projectFile(projectId, path), (prev) => (prev ? { ...prev, content: text, size: entry.size ?? file.size, modifiedAt } : prev));
			void qc.invalidateQueries({ queryKey: ["local", "project", projectId, "files"] });
			toast.success(t("Saved {name}", { name }));
		} catch (e) {
			if (e instanceof ApiError && e.code === "file_changed") {
				const details = e.details;
				setConflict({ deleted: typeof details === "object" && details !== null && "modifiedAt" in details && details.modifiedAt === null });
			} else toast.error(t("Could not save {name}: {error}", { name, error: errorText(e) }));
		} finally {
			setSaving(false);
		}
	};

	/** Drop the local changes and edit the file as it is on disk now. */
	const loadFromDisk = async () => {
		const fresh = await q.refetch();
		if (fresh.data && fresh.data.content !== null) startEditing(fresh.data);
		else stopEditing();
	};

	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		// The editor handles Cmd/Ctrl+S itself; this catches it from the toolbar and anywhere else in the viewer.
		if (!edit || e.defaultPrevented || e.key.toLowerCase() !== "s" || !(e.metaKey || e.ctrlKey)) return;
		e.preventDefault();
		void save();
	};

	// Reset to the rendered preview whenever another markdown file opens.
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed on path
	useEffect(() => setMode("preview"), [path]);

	return (
		<div className={cn("flex h-full min-h-0 flex-col bg-background", className)} onKeyDown={onKeyDown}>
			<div className="flex h-10 shrink-0 items-center gap-1 border-b px-2 coarse:h-12">
				<nav aria-label={t("File path")} className="scrollbar-none flex min-w-0 flex-1 items-center overflow-x-auto font-mono text-xs">
					{segments.map((seg, i) => (
						<Fragment key={i}>
							{i > 0 ? <ChevronRight aria-hidden className="mx-0.5 size-3 shrink-0 text-subtle" /> : null}
							<span className={cn("shrink-0 whitespace-nowrap", i === segments.length - 1 ? "font-medium text-foreground" : "text-subtle")}>{seg}</span>
						</Fragment>
					))}
					{dirty ? (
						<span role="status" aria-label={t("Unsaved changes")} title={t("Unsaved changes")} className="ml-1.5 size-2 shrink-0 animate-pop-in rounded-full bg-accent" />
					) : null}
				</nav>
				{data ? <span className="hidden shrink-0 font-mono text-2xs text-subtle tabular sm:inline">{formatBytes(data.size)}</span> : null}
				{lang ? (
					<Badge variant="outline" className="hidden shrink-0 sm:inline-flex">
						{lang}
					</Badge>
				) : null}
				{edit ? (
					<>
						<Tip label={t("Save")} shortcut="⌘S">
							<Button size="sm" variant={dirty ? "primary" : "secondary"} loading={saving} disabled={!dirty && !conflict} onClick={() => void save()} className="shrink-0">
								<Save /> <span className="hidden sm:inline">{t("Save")}</span>
							</Button>
						</Tip>
						<Tip label={t("Stop editing")}>
							<Button size="sm" variant="ghost" onClick={() => (dirty ? setConfirmDiscard(true) : stopEditing())} className="shrink-0" aria-label={t("Stop editing")}>
								<Check /> <span className="hidden sm:inline">{t("Done")}</span>
							</Button>
						</Tip>
					</>
				) : editable ? (
					<Tip label={t("Edit this file")}>
						<Button size="sm" variant="ghost" onClick={() => data && startEditing(data)} className="shrink-0" aria-label={t("Edit this file")}>
							<Pencil /> <span className="hidden sm:inline">{t("Edit")}</span>
						</Button>
					</Tip>
				) : null}
				{previewable && data?.content != null && !edit ? (
					<div role="group" aria-label={isHtml ? t("Page view") : t("Markdown view")} className="flex shrink-0 rounded-md bg-surface-2 p-0.5 text-2xs font-medium">
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
				{data?.content != null && (edit || !(previewable && mode === "preview")) ? (
					<Tip label={wrap ? t("Disable line wrap") : t("Wrap lines")}>
						<Button variant="ghost" size="icon-sm" aria-label={t("Toggle line wrap")} aria-pressed={wrap} onClick={() => setWrap(!wrap)} className={cn(wrap && "bg-surface-3 text-foreground")}>
							<WrapText />
						</Button>
					</Tip>
				) : null}
				{isHtml && mode === "preview" && data?.content != null ? (
					<Tip label={t("Open the page in a new tab")}>
						<Button asChild variant="ghost" size="icon-sm">
							<a href={pageUrl} target="_blank" rel="noreferrer noopener" aria-label={t("Open the page in a new tab")}>
								<ExternalLink />
							</a>
						</Button>
					</Tip>
				) : null}
				{actions}
				<span className="hidden sm:contents"><CopyButton text={path} label={t("Copy path")} /></span>
				<Tip label={t("Download")}>
					<Button asChild variant="ghost" size="icon-sm">
						<a href={downloadUrl} download={segments.at(-1)} aria-label={t("Download {name}", { name: segments.at(-1) ?? path })}>
							<Download />
						</a>
					</Button>
				</Tip>
				{data?.content != null && !edit ? <CopyButton text={data.content} label={t("Copy contents")} /> : null}
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

			{edit && (conflict || (changedOnDisk && dirty)) ? (
				<div role="alert" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b bg-warning/10 px-3 py-1.5 text-xs text-warning">
					<AlertTriangle className="size-3.5 shrink-0" aria-hidden />
					<span className="min-w-0 flex-1">
						{conflict?.deleted
							? t("{name} was deleted after you opened it. Save to create it again with your text.", { name })
							: t("{name} changed on disk after you opened it (an agent or someone else wrote it).", { name })}
					</span>
					<span className="flex shrink-0 items-center gap-1.5">
						{conflict ? (
							<Button size="sm" variant="outline" loading={saving} onClick={() => void save(true)}>
								{conflict.deleted ? t("Save mine") : t("Overwrite with mine")}
							</Button>
						) : null}
						{conflict?.deleted ? null : (
							<Button size="sm" variant="ghost" onClick={() => void loadFromDisk()}>
								<RefreshCw /> {t("Load theirs")}
							</Button>
						)}
					</span>
				</div>
			) : null}

			<div className="min-h-0 flex-1">
				{edit ? (
					<Suspense fallback={<ViewerSkeleton />}>
						<CodeEditor key={`${path}:${edit.seq}`} initial={edit.content} path={path} onChange={setDraft} onSave={() => void save()} wrap={wrap} autoFocus />
					</Suspense>
				) : media ? (
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
							<LazyMarkdown text={data.content} assets={assets} document onOpenFile={onOpenFile} />
						</div>
					</div>
				) : isHtml && mode === "preview" ? (
					// The page runs in its own sandbox (opaque origin, no network calls: see PAGE_CSP on the server); the attribute repeats it
					// for browsers that ignore a framed document's CSP sandbox.
					<iframe
						key={path}
						src={pageUrl}
						title={segments.at(-1) ?? path}
						sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals"
						referrerPolicy="no-referrer"
						className="h-full w-full border-0 bg-white"
					/>
				) : (
					<CodeView content={data.content} lang={lang} wrap={wrap} />
				)}
			</div>
			<ConfirmDialog
				open={confirmDiscard}
				onOpenChange={setConfirmDiscard}
				title={t("Discard unsaved changes?")}
				description={t("Your changes to {name} are not saved.", { name })}
				confirmLabel={t("Discard")}
				danger
				onConfirm={() => {
					setConfirmDiscard(false);
					stopEditing();
				}}
			/>
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
