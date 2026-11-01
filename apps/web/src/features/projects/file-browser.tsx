import { type FileEntry, routes } from "@clam/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, ChevronRight, Folder, FolderOpen, FolderTree, LayoutGrid, Link2, List, PanelLeftClose, PanelLeftOpen, RefreshCw, Search, Terminal, Upload, X } from "lucide-react";
import { Fragment, type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { type ImperativePanelHandle, Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { CATEGORY_LABEL } from "@/components/rich/file-icon.tsx";
import { t, tr } from "@/i18n";
import { api, errorText, localUrl } from "@/lib/api";
import { fileCategory, previewKind } from "@/lib/file-kind";
import { qk } from "@/lib/queries";
import { hasFiles } from "@/lib/upload";
import { cn, formatBytes, relativeTime } from "@/lib/utils";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty-state";
import { Skeleton } from "@/ui/skeleton";
import { Tip } from "@/ui/tooltip";
import { FileExplorer } from "./file-explorer.tsx";
import { byKindThenName, fileIcon, parentOf } from "./file-utils.ts";
import { UploadDock, useProjectUploads } from "./uploads.tsx";

const mqMd = typeof matchMedia === "function" ? matchMedia("(min-width: 768px)") : null;
function useIsMd(): boolean {
	return useSyncExternalStore(
		(cb) => {
			mqMd?.addEventListener("change", cb);
			return () => mqMd?.removeEventListener("change", cb);
		},
		() => mqMd?.matches ?? true,
		() => true,
	);
}

type SortKey = "name" | "size" | "modified" | "type";
type View = "list" | "grid";
const VIEW_KEY = "clam.files.view";

function useViewPref() {
	const [view, setView] = useState<View>(() => {
		try {
			return localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "list";
		} catch {
			return "list";
		}
	});
	const set = (v: View) => {
		setView(v);
		try {
			localStorage.setItem(VIEW_KEY, v);
		} catch {
			/* preference just isn't remembered */
		}
	};
	return [view, set] as const;
}

const typeLabel = (e: FileEntry): string => (e.kind === "dir" ? t("Folder") : tr(CATEGORY_LABEL[fileCategory(e.name)]));
const modifiedMs = (e: FileEntry): number => (e.modifiedAt ? Date.parse(e.modifiedAt) : 0);

export interface FileBrowserProps {
	projectId: string;
	/** The file currently open in Quick Look; the browser starts in its folder. */
	openPath?: string | null;
	onOpenFile: (path: string) => void;
}

/**
 * The project's Files tab: a narrow collapsible folder tree beside a full list (or grid) of the current folder. Files open in Quick Look,
 * never in a pane of their own.
 */
export default function FileBrowser({ projectId, openPath, onOpenFile }: FileBrowserProps) {
	const md = useIsMd();
	const [dir, setDir] = useState(() => (openPath ? parentOf(openPath) : ""));
	const treeRef = useRef<ImperativePanelHandle>(null);
	const [treeCollapsed, setTreeCollapsed] = useState(false);

	const main = <FolderPane projectId={projectId} dir={dir} onDir={setDir} onOpenFile={onOpenFile} tree={md ? { collapsed: treeCollapsed, toggle: () => (treeCollapsed ? treeRef.current?.expand() : treeRef.current?.collapse()) } : undefined} />;
	if (!md) return <div className="h-full min-h-0">{main}</div>;
	return (
		<PanelGroup direction="horizontal" autoSaveId="clam.files.cols" className="h-full min-h-0">
			<Panel
				id="tree"
				order={1}
				ref={treeRef}
				defaultSize={20}
				minSize={14}
				maxSize={40}
				collapsible
				collapsedSize={0}
				onCollapse={() => setTreeCollapsed(true)}
				onExpand={() => setTreeCollapsed(false)}
				className="min-w-0"
			>
				<FileExplorer projectId={projectId} selectedPath={dir || null} onOpenFile={onOpenFile} onSelectDir={setDir} bare className="border-r" />
			</Panel>
			<PanelResizeHandle aria-label={t("Resize folder tree")} />
			<Panel id="folder" order={2} minSize={40} className="min-w-0">
				{main}
			</Panel>
		</PanelGroup>
	);
}

// ───────────────────────────── current folder ─────────────────────────────

function FolderPane({ projectId, dir, onDir, onOpenFile, tree }: { projectId: string; dir: string; onDir: (d: string) => void; onOpenFile: (p: string) => void; tree?: { collapsed: boolean; toggle: () => void } }) {
	const qc = useQueryClient();
	const q = useQuery({
		queryKey: qk.projectFiles(projectId, dir),
		queryFn: ({ signal }) => api.get<FileEntry[]>(routes.projectFiles(projectId), { path: dir }, { signal }),
	});
	const [view, setView] = useViewPref();
	const [filter, setFilter] = useState("");
	const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: "name", asc: true });
	const fileInput = useRef<HTMLInputElement>(null);
	const uploads = useProjectUploads(projectId);
	const dragDepth = useRef(0);
	const [dragging, setDragging] = useState(false);

	// A different folder starts with a clean filter.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on folder change only
	useEffect(() => setFilter(""), [dir]);

	const needle = filter.trim().toLowerCase();
	const entries = useMemo(() => {
		const list = (q.data ?? []).filter((e) => !needle || e.name.toLowerCase().includes(needle));
		const dirFirst = (a: FileEntry, b: FileEntry) => (a.kind === "dir" ? 0 : 1) - (b.kind === "dir" ? 0 : 1);
		const cmp: Record<SortKey, (a: FileEntry, b: FileEntry) => number> = {
			name: byKindThenName,
			size: (a, b) => dirFirst(a, b) || (a.size ?? 0) - (b.size ?? 0) || byKindThenName(a, b),
			modified: (a, b) => dirFirst(a, b) || modifiedMs(a) - modifiedMs(b) || byKindThenName(a, b),
			type: (a, b) => dirFirst(a, b) || typeLabel(a).localeCompare(typeLabel(b)) || byKindThenName(a, b),
		};
		const sorted = [...list].sort(cmp[sort.key]);
		if (sort.asc) return sorted;
		// Folders stay on top whichever way the column sorts.
		return [...sorted.filter((e) => e.kind === "dir").reverse(), ...sorted.filter((e) => e.kind !== "dir").reverse()];
	}, [q.data, needle, sort]);

	const activate = useCallback(
		(e: FileEntry) => {
			if (e.kind === "dir") onDir(e.path);
			else onOpenFile(e.path);
		},
		[onDir, onOpenFile],
	);
	const refresh = () => void qc.invalidateQueries({ queryKey: ["local", "project", projectId, "files"] });
	const crumbs = dir ? dir.split("/") : [];

	return (
		<div
			className="relative flex h-full min-h-0 flex-col bg-background"
			onDragEnter={(e) => {
				if (!hasFiles(e)) return;
				e.preventDefault();
				dragDepth.current++;
				setDragging(true);
			}}
			onDragOver={(e) => {
				if (!hasFiles(e)) return;
				e.preventDefault();
				e.dataTransfer.dropEffect = "copy";
			}}
			onDragLeave={(e) => {
				if (!hasFiles(e)) return;
				dragDepth.current = Math.max(0, dragDepth.current - 1);
				if (dragDepth.current === 0) setDragging(false);
			}}
			onDrop={(e) => {
				if (!hasFiles(e)) return;
				e.preventDefault();
				dragDepth.current = 0;
				setDragging(false);
				uploads.upload(Array.from(e.dataTransfer.files), dir);
			}}
		>
			<div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5 coarse:py-2">
				{tree ? (
					<Tip label={tree.collapsed ? t("Show folder tree") : t("Hide folder tree")}>
						<Button variant="ghost" size="icon-sm" aria-label={tree.collapsed ? t("Show folder tree") : t("Hide folder tree")} aria-pressed={!tree.collapsed} onClick={tree.toggle}>
							{tree.collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
						</Button>
					</Tip>
				) : null}
				<nav aria-label={t("Folder path")} className="scrollbar-none flex min-w-0 flex-1 items-center overflow-x-auto text-[13px]">
					<button
						type="button"
						onClick={() => onDir("")}
						aria-current={dir === "" ? "location" : undefined}
						className={cn("inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 outline-none transition-colors hover:bg-surface-2 focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:h-10", dir === "" ? "font-medium text-foreground" : "text-muted-foreground")}
					>
						<FolderTree className="size-3.5" aria-hidden /> {t("Project root")}
					</button>
					{crumbs.map((seg, i) => {
						const path = crumbs.slice(0, i + 1).join("/");
						const last = i === crumbs.length - 1;
						return (
							<Fragment key={path}>
								<ChevronRight aria-hidden className="size-3.5 shrink-0 text-subtle" />
								<button
									type="button"
									onClick={() => onDir(path)}
									aria-current={last ? "location" : undefined}
									className={cn("h-7 shrink-0 whitespace-nowrap rounded-md px-1.5 outline-none transition-colors hover:bg-surface-2 focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:h-10", last ? "font-medium text-foreground" : "text-muted-foreground")}
								>
									{seg}
								</button>
							</Fragment>
						);
					})}
				</nav>
			</div>

			<div className="flex shrink-0 items-center gap-1.5 border-b px-2 py-1.5 coarse:py-2">
				<div className="relative min-w-0 flex-1 sm:max-w-sm">
					<Search aria-hidden className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
					<input
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Escape") setFilter("");
						}}
						placeholder={t("Filter this folder")}
						aria-label={t("Filter this folder by name")}
						className="h-8 w-full rounded-lg bg-surface-2 pl-7 pr-7 text-base outline-none placeholder:text-subtle focus-visible:shadow-[inset_0_0_0_1px_var(--accent)] md:text-[13px] coarse:h-11"
					/>
					{filter ? (
						<button type="button" aria-label={t("Clear filter")} onClick={() => setFilter("")} className="absolute right-1.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-subtle hover:text-foreground coarse:size-8">
							<X className="size-3" />
						</button>
					) : null}
				</div>
				<span className="hidden flex-1 sm:block" />
				<div role="group" aria-label={t("Folder view")} className="flex shrink-0 rounded-lg bg-surface-2 p-0.5">
					{(["list", "grid"] as const).map((v) => (
						<Tip key={v} label={v === "list" ? t("List view") : t("Grid view")}>
							<button
								type="button"
								aria-label={v === "list" ? t("List view") : t("Grid view")}
								aria-pressed={view === v}
								onClick={() => setView(v)}
								className={cn("grid size-7 place-items-center rounded-md outline-none transition-colors focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:size-10 [&_svg]:size-3.5", view === v ? "bg-surface-3 text-foreground" : "text-muted-foreground hover:text-foreground")}
							>
								{v === "list" ? <List /> : <LayoutGrid />}
							</button>
						</Tip>
					))}
				</div>
				<Tip label={t("Refresh")}>
					<Button variant="ghost" size="icon-sm" aria-label={t("Refresh folder")} onClick={refresh}>
						<RefreshCw className={cn(q.isFetching && "animate-spin")} />
					</Button>
				</Tip>
				<Tip label={dir ? t("Upload to /{dir}", { dir }) : t("Upload files")}>
					<Button variant="outline" size="sm" aria-label={t("Upload files")} onClick={() => fileInput.current?.click()} className="coarse:h-11">
						<Upload /> <span className="hidden lg:inline">{t("Upload")}</span>
					</Button>
				</Tip>
				<Tip label={t("Open terminal here")}>
					<Button asChild variant="ghost" size="icon-sm" aria-label={t("Open terminal here")} className="hidden sm:inline-flex">
						<Link to="/terminal" search={{ project: projectId }}>
							<Terminal />
						</Link>
					</Button>
				</Tip>
				<input
					ref={fileInput}
					type="file"
					multiple
					hidden
					onChange={(e) => {
						uploads.upload(Array.from(e.target.files ?? []), dir);
						e.target.value = "";
					}}
				/>
			</div>

			<div className="min-h-0 flex-1">
				{q.isPending ? (
					<div className="flex flex-col gap-2 p-3" aria-busy aria-label={t("Loading files")}>
						{Array.from({ length: 9 }, (_, i) => (
							<Skeleton key={i} className="h-8" style={{ width: `${55 + ((i * 13) % 40)}%` }} />
						))}
					</div>
				) : q.error ? (
					<EmptyState
						icon={Folder}
						title={t("Could not load this folder")}
						description={errorText(q.error)}
						action={
							<Button size="sm" variant="outline" onClick={() => void q.refetch()}>
								<RefreshCw /> {t("Retry")}
							</Button>
						}
					/>
				) : entries.length === 0 ? (
					needle ? (
						<EmptyState icon={Search} title={t("No matching files")} description={t("No file in this folder matches “{query}”.", { query: filter.trim() })} />
					) : (
						<EmptyState icon={FolderOpen} title={t("This folder is empty")} description={t("Drop files here or use Upload to add some.")} />
					)
				) : view === "list" ? (
					<ListView entries={entries} sort={sort} onSort={(key) => setSort((s) => (s.key === key ? { key, asc: !s.asc } : { key, asc: true }))} onActivate={activate} />
				) : (
					<GridView projectId={projectId} entries={entries} onActivate={activate} />
				)}
			</div>
			<UploadDock uploads={uploads} />
			{dragging ? (
				<div aria-hidden className="pointer-events-none absolute inset-1 z-10 grid place-items-center rounded-xl bg-accent-soft text-xs font-medium text-accent shadow-[inset_0_0_0_2px_var(--accent)]">
					{dir ? t("Drop to upload into /{dir}", { dir }) : t("Drop to upload into the project folder")}
				</div>
			) : null}
		</div>
	);
}

// ───────────────────────────── list ─────────────────────────────

const COLS = "md:grid-cols-[minmax(0,1fr)_6rem_8.5rem_9rem]";

function EntryIcon({ entry, className }: { entry: FileEntry; className?: string }) {
	if (entry.kind === "dir") return <Folder aria-hidden className={cn("shrink-0 text-accent", className)} />;
	const { Icon, tone } = fileIcon(entry.name);
	return <Icon aria-hidden className={cn("shrink-0", tone, className)} />;
}

function ListView({ entries, sort, onSort, onActivate }: { entries: FileEntry[]; sort: { key: SortKey; asc: boolean }; onSort: (k: SortKey) => void; onActivate: (e: FileEntry) => void }) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const [coarse] = useState(() => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches);
	const rowHeight = coarse ? 56 : 40;
	const v = useVirtualizer({ count: entries.length, getScrollElement: () => scrollRef.current, estimateSize: () => rowHeight, overscan: 12, getItemKey: (i) => entries[i]?.path ?? i });

	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
		const cur = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-row]");
		const at = cur ? Number(cur.dataset.row) : -1;
		const to = e.key === "Home" ? 0 : e.key === "End" ? entries.length - 1 : Math.max(0, Math.min(entries.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)));
		e.preventDefault();
		v.scrollToIndex(to, { align: "auto" });
		requestAnimationFrame(() => scrollRef.current?.querySelector<HTMLElement>(`[data-row="${to}"]`)?.focus());
	};

	const head = (key: SortKey, label: string, className?: string) => (
		<button
			type="button"
			onClick={() => onSort(key)}
			aria-label={t("Sort by {column}", { column: label })}
			className={cn("inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-2xs font-medium uppercase tracking-wide outline-none transition-colors hover:text-foreground focus-visible:shadow-[0_0_0_2px_var(--accent)]", sort.key === key ? "text-foreground" : "text-subtle", className)}
		>
			{label}
			{sort.key === key ? sort.asc ? <ArrowUp aria-hidden className="size-3" /> : <ArrowDown aria-hidden className="size-3" /> : null}
		</button>
	);

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className={cn("hidden shrink-0 grid-cols-1 items-center gap-2 border-b bg-surface-1/60 px-3 md:grid", COLS)}>
				{head("name", t("Name"), "-ml-1.5 justify-self-start")}
				{head("size", t("Size"), "-mr-1.5 justify-self-end")}
				{head("modified", t("Modified"), "-ml-1.5 justify-self-start")}
				{head("type", t("Type"), "-ml-1.5 justify-self-start")}
			</div>
			<div ref={scrollRef} onKeyDown={onKeyDown} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-contain">
				<ul role="list" aria-label={t("Files in this folder")} className="relative w-full" style={{ height: v.getTotalSize() }}>
					{v.getVirtualItems().map((item) => {
						const e = entries[item.index] as FileEntry;
						const dirRow = e.kind === "dir";
						const when = e.modifiedAt ? relativeTime(e.modifiedAt) : "—";
						return (
							<li key={item.key} className="absolute inset-x-0 top-0" style={{ height: rowHeight, transform: `translateY(${item.start}px)` }}>
								<button
									type="button"
									data-row={item.index}
									onClick={() => onActivate(e)}
									className={cn("grid size-full grid-cols-[minmax(0,1fr)] items-center gap-2 border-b border-border/50 px-3 text-left text-[13px] outline-none transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:shadow-[inset_0_0_0_1px_var(--accent)]", COLS)}
								>
									<span className="flex min-w-0 items-center gap-2.5">
										<EntryIcon entry={e} className="size-[18px]" />
										<span className="flex min-w-0 flex-col">
											<span className={cn("truncate", dirRow ? "font-medium text-foreground" : "text-foreground/90")}>{e.name}</span>
											<span className="truncate text-2xs text-subtle md:hidden">{dirRow ? when : `${e.size === null ? "—" : formatBytes(e.size)} · ${when}`}</span>
										</span>
										{e.kind === "symlink" ? <Link2 aria-label={t("Symbolic link")} className="size-3 shrink-0 text-subtle" /> : null}
									</span>
									<span className="tabular hidden justify-self-end font-mono text-xs text-muted-foreground md:block">{dirRow || e.size === null ? "—" : formatBytes(e.size)}</span>
									<span className="hidden truncate text-xs text-muted-foreground md:block">{when}</span>
									<span className="hidden truncate text-xs text-muted-foreground md:block">{typeLabel(e)}</span>
								</button>
							</li>
						);
					})}
				</ul>
			</div>
		</div>
	);
}

// ───────────────────────────── grid ─────────────────────────────

function GridView({ projectId, entries, onActivate }: { projectId: string; entries: FileEntry[]; onActivate: (e: FileEntry) => void }) {
	return (
		<div className="scrollbar-thin h-full overflow-y-auto overscroll-contain p-3">
			<ul role="list" aria-label={t("Files in this folder")} className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(10rem,1fr))]">
				{entries.map((e) => {
					const thumb = e.kind === "file" && previewKind(e.name) === "image" && (e.size ?? 0) <= 8_000_000;
					return (
						<li key={e.path} className="[content-visibility:auto] [contain-intrinsic-size:auto_9rem]">
							<button
								type="button"
								onClick={() => onActivate(e)}
								title={e.name}
								className="group flex w-full flex-col overflow-hidden rounded-xl bg-surface-1 text-left shadow-[inset_0_0_0_1px_var(--border)] outline-none transition-[transform,box-shadow] duration-150 hover:-translate-y-px hover:shadow-[inset_0_0_0_1px_var(--border-strong)] focus-visible:shadow-[inset_0_0_0_2px_var(--accent)]"
							>
								<span className="relative grid aspect-[4/3] w-full place-items-center overflow-hidden bg-surface-2">
									{thumb ? (
										<img src={localUrl(routes.projectRaw(projectId), { path: e.path })} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
									) : (
										<EntryIcon entry={e} className="size-9" />
									)}
								</span>
								<span className="flex min-w-0 flex-col gap-0.5 px-2.5 py-2">
									<span className="truncate text-[13px] font-medium">{e.name}</span>
									<span className="truncate text-2xs text-subtle">{e.kind === "dir" ? t("Folder") : e.size === null ? typeLabel(e) : `${typeLabel(e)} · ${formatBytes(e.size)}`}</span>
								</span>
							</button>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
