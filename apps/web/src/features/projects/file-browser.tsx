import { type FileEntry, routes } from "@clam/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
	ArrowDown,
	ArrowUp,
	ChevronRight,
	FilePlus,
	Folder,
	FolderOpen,
	FolderPlus,
	FolderTree,
	LayoutGrid,
	Link2,
	List,
	Move,
	PanelLeftClose,
	PanelLeftOpen,
	RefreshCw,
	Search,
	Terminal,
	Upload,
	X,
} from "lucide-react";
import { Fragment, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { type ImperativePanelHandle, Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { toast } from "sonner";
import { CATEGORY_LABEL } from "@/components/rich/file-icon.tsx";
import { fileMention } from "@/features/session/file-mention.ts";
import { t, tr } from "@/i18n";
import { api, errorText, localUrl } from "@/lib/api";
import { fileCategory, previewKind } from "@/lib/file-kind";
import { qk } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { hasFiles } from "@/lib/upload";
import { cn, formatBytes, relativeTime } from "@/lib/utils";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty-state";
import { Skeleton } from "@/ui/skeleton";
import { Tip } from "@/ui/tooltip";
import { coarsePointer, createEntry, DragGrip, EntryMenu, type EntryReference, MenuButton, type MenuTarget, menuTargetOf, moveEntry, NameInput, type NewKind, useEntryDrag } from "./entry-ops.tsx";
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
	// No composer here: "Add to a new chat" opens a new session of the project whose first prompt starts with the mention.
	const openDialog = useUi((s) => s.openDialog);
	const reference = useMemo<EntryReference>(
		() => ({ label: t("Add to a new chat"), onSelect: (path, isDir) => openDialog({ kind: "create-session", projectId, prompt: `${fileMention(path, isDir)} ` }) }),
		[openDialog, projectId],
	);

	const main = (
		<FolderPane
			projectId={projectId}
			dir={dir}
			onDir={setDir}
			onOpenFile={onOpenFile}
			reference={reference}
			tree={md ? { collapsed: treeCollapsed, toggle: () => (treeCollapsed ? treeRef.current?.expand() : treeRef.current?.collapse()) } : undefined}
		/>
	);
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
				<FileExplorer projectId={projectId} selectedPath={dir || null} onOpenFile={onOpenFile} onSelectDir={setDir} reference={reference} bare className="border-r" />
			</Panel>
			<PanelResizeHandle aria-label={t("Resize folder tree")} />
			<Panel id="folder" order={2} minSize={40} className="min-w-0">
				{main}
			</Panel>
		</PanelGroup>
	);
}

// ───────────────────────────── current folder ─────────────────────────────

function FolderPane({
	projectId,
	dir,
	onDir,
	onOpenFile,
	reference,
	tree,
}: {
	projectId: string;
	dir: string;
	onDir: (d: string) => void;
	onOpenFile: (p: string) => void;
	reference: EntryReference;
	tree?: { collapsed: boolean; toggle: () => void };
}) {
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
	const [creating, setCreating] = useState<NewKind | null>(null);
	/** The entry whose name is being edited in place (menu → Rename, or F2). */
	const [renaming, setRenaming] = useState<string | null>(null);
	const [menu, setMenu] = useState<MenuTarget | null>(null);
	/** Touch screens: "drag to move" shows a grip on each row (off by default: a finger on a row scrolls the list); otherwise a "⋯". */
	const [touchMove, setTouchMove] = useState(false);
	const scrollRef = useRef<HTMLDivElement>(null);

	// A different folder starts with a clean filter and no name box.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on folder change only
	useEffect(() => {
		setFilter("");
		setCreating(null);
		setRenaming(null);
	}, [dir]);

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
	const taken = useMemo(() => new Set((q.data ?? []).map((e) => e.name)), [q.data]);

	const activate = useCallback(
		(e: FileEntry) => {
			if (e.kind === "dir") onDir(e.path);
			else onOpenFile(e.path);
		},
		[onDir, onOpenFile],
	);
	const refresh = () => void qc.invalidateQueries({ queryKey: ["local", "project", projectId, "files"] });
	const crumbs = dir ? dir.split("/") : [];
	const startCreate = (kind: NewKind) => {
		setFilter("");
		setRenaming(null);
		setCreating(kind);
	};
	/** Creates the empty file (it opens in the editor) or the folder in the folder on show; a name with `/` creates its folders too. */
	const create = async (kind: NewKind, name: string): Promise<string | null> => {
		const path = dir ? `${dir}/${name}` : name;
		const failed = await createEntry(projectId, kind, path);
		if (failed) return failed;
		setCreating(null);
		refresh();
		if (kind === "file") onOpenFile(path);
		return null;
	};
	const rename = async (path: string, name: string): Promise<string | null> => {
		const failed = await moveEntry(projectId, path, dir ? `${dir}/${name}` : name);
		if (failed) return failed;
		setRenaming(null);
		refresh();
		return null;
	};
	// Drag a row onto a folder of the list, a folder of the path above it, or (from the tree) the list itself.
	const drag = useEntryDrag({
		projectId,
		scrollRef,
		onMove: (from, _kind, to) => {
			const name = from.slice(from.lastIndexOf("/") + 1);
			void moveEntry(projectId, from, to ? `${to}/${name}` : name).then((error) => {
				if (error) toast.error(t("Could not move {name}", { name }), { description: error });
				else refresh();
			});
		},
	});
	const controls: RowControls = {
		touch: coarsePointer ? (touchMove ? "drag" : "menu") : null,
		moving: drag.moving,
		dropDir: drag.dropDir,
		menuPath: menu?.path ?? null,
		renaming,
		onMenu: setMenu,
		onGrip: drag.startTouch,
		renameBox: (e, icon) => (
			<NameInput
				kind={e.kind === "dir" ? "dir" : "file"}
				initial={e.name}
				label={t("New name for {name}", { name: e.name })}
				taken={new Set([...taken].filter((n) => n !== e.name))}
				onSubmit={(name) => rename(e.path, name)}
				onCancel={() => setRenaming(null)}
				icon={icon}
				inputClassName="h-7 md:text-[13px]"
			/>
		),
	};

	return (
		<div
			className="relative flex h-full min-h-0 flex-col bg-background"
			onDragStart={drag.dropProps.onDragStart}
			onDragEnd={drag.dropProps.onDragEnd}
			onDragEnter={(e) => {
				if (!hasFiles(e)) return;
				e.preventDefault();
				dragDepth.current++;
				setDragging(true);
			}}
			onDragOver={(e) => {
				if (!hasFiles(e)) return drag.dropProps.onDragOver(e);
				e.preventDefault();
				e.dataTransfer.dropEffect = "copy";
			}}
			onDragLeave={(e) => {
				if (!hasFiles(e)) return drag.dropProps.onDragLeave(e);
				dragDepth.current = Math.max(0, dragDepth.current - 1);
				if (dragDepth.current === 0) setDragging(false);
			}}
			onDrop={(e) => {
				if (!hasFiles(e)) return drag.dropProps.onDrop(e);
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
						data-drop-dir=""
						className={cn(
							"inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 outline-none transition-colors hover:bg-surface-2 focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:h-10",
							dir === "" ? "font-medium text-foreground" : "text-muted-foreground",
							drag.dropDir === "" && "bg-accent-soft text-accent shadow-[inset_0_0_0_1px_var(--accent)]",
						)}
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
									data-drop-dir={path}
									className={cn(
										"h-7 shrink-0 whitespace-nowrap rounded-md px-1.5 outline-none transition-colors hover:bg-surface-2 focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:h-10",
										last ? "font-medium text-foreground" : "text-muted-foreground",
										drag.dropDir === path && "bg-accent-soft text-accent shadow-[inset_0_0_0_1px_var(--accent)]",
									)}
								>
									{seg}
								</button>
							</Fragment>
						);
					})}
				</nav>
			</div>

			{/* On a phone the filter has the first line to itself and the buttons go on the next one. */}
			<div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-2 py-1.5 coarse:py-2">
				<div className="relative w-full min-w-0 sm:w-auto sm:max-w-sm sm:flex-1">
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
				<div role="group" aria-label={t("Folder view")} className="flex shrink-0 rounded-lg bg-surface-2 p-0.5 sm:order-last">
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
				<span className="flex-1" />
				<Tip label={t("Refresh")}>
					<Button variant="ghost" size="icon-sm" aria-label={t("Refresh folder")} onClick={refresh} className="sm:order-last">
						<RefreshCw className={cn(q.isFetching && "animate-spin")} />
					</Button>
				</Tip>
				<Tip label={dir ? t("New file in /{dir}", { dir }) : t("New file")}>
					<Button variant="ghost" size="icon-sm" aria-label={t("New file")} onClick={() => startCreate("file")} className="sm:order-last">
						<FilePlus />
					</Button>
				</Tip>
				<Tip label={dir ? t("New folder in /{dir}", { dir }) : t("New folder")}>
					<Button variant="ghost" size="icon-sm" aria-label={t("New folder")} onClick={() => startCreate("dir")} className="sm:order-last">
						<FolderPlus />
					</Button>
				</Tip>
				{coarsePointer ? (
					<Button variant="ghost" size="icon-sm" aria-label={t("Drag to move")} aria-pressed={touchMove} onClick={() => setTouchMove((on) => !on)} className={cn("sm:order-last", touchMove && "bg-accent-soft text-accent")}>
						<Move />
					</Button>
				) : null}
				<Tip label={dir ? t("Upload to /{dir}", { dir }) : t("Upload files")}>
					<Button variant="outline" size="sm" aria-label={t("Upload files")} onClick={() => fileInput.current?.click()} className="coarse:h-11 sm:order-last">
						<Upload /> <span className="hidden lg:inline">{t("Upload")}</span>
					</Button>
				</Tip>
				<Tip label={t("Open terminal here")}>
					<Button asChild variant="ghost" size="icon-sm" aria-label={t("Open terminal here")} className="hidden sm:order-last sm:inline-flex">
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

			<div
				data-drop-dir={dir}
				onContextMenu={(e) => {
					const target = menuTargetOf(e, document.activeElement instanceof HTMLElement ? document.activeElement : null);
					if (!target) return;
					e.preventDefault();
					setMenu(target);
				}}
				onKeyDown={(e) => {
					const row = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>("[data-path]") : null;
					if (e.key !== "F2" || !row?.dataset.path) return;
					e.preventDefault();
					setRenaming(row.dataset.path);
				}}
				className={cn("flex min-h-0 flex-1 flex-col transition-[background-color,box-shadow]", drag.dropDir === dir && "bg-accent-soft/50 shadow-[inset_0_0_0_2px_var(--accent)]")}
			>
				{creating ? (
					<div className="flex h-11 shrink-0 items-center border-b px-3 coarse:h-14">
						<NameInput
							kind={creating}
							label={creating === "dir" ? (dir ? t("Name of the new folder in /{dir}", { dir }) : t("Name of the new folder")) : dir ? t("Name of the new file in /{dir}", { dir }) : t("Name of the new file")}
							taken={taken}
							onSubmit={(name) => create(creating, name)}
							onCancel={() => setCreating(null)}
							inputClassName="h-7 md:text-[13px]"
						/>
					</div>
				) : null}
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
						creating ? null : needle ? (
							<EmptyState icon={Search} title={t("No matching files")} description={t("No file in this folder matches “{query}”.", { query: filter.trim() })} />
						) : (
							<EmptyState icon={FolderOpen} title={t("This folder is empty")} description={t("Drop files here or use Upload to add some.")} />
						)
					) : view === "list" ? (
						<ListView entries={entries} scrollRef={scrollRef} controls={controls} sort={sort} onSort={(key) => setSort((s) => (s.key === key ? { key, asc: !s.asc } : { key, asc: true }))} onActivate={activate} />
					) : (
						<GridView projectId={projectId} entries={entries} scrollRef={scrollRef} controls={controls} onActivate={activate} />
					)}
				</div>
			</div>
			<UploadDock uploads={uploads} />
			{menu ? <EntryMenu target={menu} reference={reference} onRename={setRenaming} onClose={() => setMenu(null)} /> : null}
			{drag.ghost}
			{dragging ? (
				<div aria-hidden className="pointer-events-none absolute inset-1 z-10 grid place-items-center rounded-xl bg-accent-soft text-xs font-medium text-accent shadow-[inset_0_0_0_2px_var(--accent)]">
					{dir ? t("Drop to upload into /{dir}", { dir }) : t("Drop to upload into the project folder")}
				</div>
			) : null}
		</div>
	);
}

/**
 * What every row of the list or grid shares: the drag, the menu, the name box of a rename, and a touch screen's control. A row carries
 * `data-path` / `data-kind` (what is dragged, what the menu is about) and, a folder, `data-drop-dir` (where a drop on it lands).
 */
interface RowControls {
	/** A touch screen's control on each row: the "⋯" of its menu, or the grip that drags it. Null: a mouse (right-click, drag the row). */
	touch: "menu" | "drag" | null;
	moving: string | null;
	dropDir: string | null;
	menuPath: string | null;
	renaming: string | null;
	onMenu: (target: MenuTarget) => void;
	onGrip: (e: ReactPointerEvent, entry: { path: string; kind: FileEntry["kind"]; name: string }) => void;
	renameBox: (e: FileEntry, icon: boolean) => ReactNode;
}

function RowControl({ entry, c, className }: { entry: FileEntry; c: RowControls; className?: string }) {
	if (c.touch === "drag") return <DragGrip name={entry.name} onPointerDown={(ev) => c.onGrip(ev, { path: entry.path, kind: entry.kind, name: entry.name })} className={className} />;
	if (c.touch === "menu") return <MenuButton path={entry.path} dir={entry.kind === "dir"} name={entry.name} onOpen={c.onMenu} className={className} />;
	return null;
}

// ───────────────────────────── list ─────────────────────────────

const COLS = "md:grid-cols-[minmax(0,1fr)_6rem_8.5rem_9rem]";

function EntryIcon({ entry, className }: { entry: FileEntry; className?: string }) {
	if (entry.kind === "dir") return <Folder aria-hidden className={cn("shrink-0 text-accent", className)} />;
	const { Icon, tone } = fileIcon(entry.name);
	return <Icon aria-hidden className={cn("shrink-0", tone, className)} />;
}

function ListView({
	entries,
	scrollRef,
	controls: c,
	sort,
	onSort,
	onActivate,
}: {
	entries: FileEntry[];
	scrollRef: RefObject<HTMLDivElement | null>;
	controls: RowControls;
	sort: { key: SortKey; asc: boolean };
	onSort: (k: SortKey) => void;
	onActivate: (e: FileEntry) => void;
}) {
	const rowHeight = coarsePointer ? 56 : 40;
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
							<li
								key={item.key}
								data-path={e.path}
								data-kind={e.kind}
								data-drop-dir={dirRow ? e.path : undefined}
								draggable={c.touch === null && c.renaming !== e.path}
								className={cn(
									"absolute inset-x-0 top-0 flex items-center border-b border-border/50 transition-colors",
									c.moving === e.path && "opacity-50",
									c.dropDir === e.path && "bg-accent-soft shadow-[inset_0_0_0_1px_var(--accent)]",
									c.menuPath === e.path && "shadow-[inset_0_0_0_1px_var(--accent)]",
									c.renaming === e.path && "z-10",
								)}
								style={{ height: rowHeight, transform: `translateY(${item.start}px)` }}
							>
								{c.renaming === e.path ? (
									<div className="flex size-full items-center px-3">{c.renameBox(e, true)}</div>
								) : (
									<>
										<button
											type="button"
											data-row={item.index}
											onClick={() => onActivate(e)}
											className={cn("grid h-full min-w-0 flex-1 grid-cols-[minmax(0,1fr)] items-center gap-2 px-3 text-left text-[13px] outline-none transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:shadow-[inset_0_0_0_1px_var(--accent)]", COLS)}
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
										<RowControl entry={e} c={c} className="mr-1.5 size-11" />
									</>
								)}
							</li>
						);
					})}
				</ul>
			</div>
		</div>
	);
}

// ───────────────────────────── grid ─────────────────────────────

function GridView({ projectId, entries, scrollRef, controls: c, onActivate }: { projectId: string; entries: FileEntry[]; scrollRef: RefObject<HTMLDivElement | null>; controls: RowControls; onActivate: (e: FileEntry) => void }) {
	return (
		<div ref={scrollRef} className="scrollbar-thin h-full overflow-y-auto overscroll-contain p-3">
			<ul role="list" aria-label={t("Files in this folder")} className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(10rem,1fr))]">
				{entries.map((e) => {
					const thumb = e.kind === "file" && previewKind(e.name) === "image" && (e.size ?? 0) <= 8_000_000;
					const preview = (
						<span className="relative grid aspect-[4/3] w-full place-items-center overflow-hidden bg-surface-2">
							{thumb ? (
								<img src={localUrl(routes.projectRaw(projectId), { path: e.path })} alt="" loading="lazy" decoding="async" draggable={false} className="size-full object-cover" />
							) : (
								<EntryIcon entry={e} className="size-9" />
							)}
						</span>
					);
					return (
						<li
							key={e.path}
							data-path={e.path}
							data-kind={e.kind}
							data-drop-dir={e.kind === "dir" ? e.path : undefined}
							draggable={c.touch === null && c.renaming !== e.path}
							className={cn("relative [content-visibility:auto] [contain-intrinsic-size:auto_9rem]", c.moving === e.path && "opacity-50")}
						>
							{c.renaming === e.path ? (
								<div className="flex w-full flex-col rounded-xl bg-surface-1 shadow-[inset_0_0_0_1px_var(--accent)]">
									<span className="overflow-hidden rounded-t-xl">{preview}</span>
									<div className="px-2 py-1.5">{c.renameBox(e, false)}</div>
								</div>
							) : (
								<button
									type="button"
									onClick={() => onActivate(e)}
									title={e.name}
									className={cn(
										"group flex w-full flex-col overflow-hidden rounded-xl bg-surface-1 text-left shadow-[inset_0_0_0_1px_var(--border)] outline-none transition-[transform,box-shadow] duration-150 hover:-translate-y-px hover:shadow-[inset_0_0_0_1px_var(--border-strong)] focus-visible:shadow-[inset_0_0_0_2px_var(--accent)]",
										(c.dropDir === e.path || c.menuPath === e.path) && "shadow-[inset_0_0_0_2px_var(--accent)] hover:shadow-[inset_0_0_0_2px_var(--accent)]",
										c.dropDir === e.path && "bg-accent-soft",
									)}
								>
									{preview}
									<span className="flex min-w-0 flex-col gap-0.5 px-2.5 py-2">
										<span className="truncate text-[13px] font-medium">{e.name}</span>
										<span className="truncate text-2xs text-subtle">{e.kind === "dir" ? t("Folder") : e.size === null ? typeLabel(e) : `${typeLabel(e)} · ${formatBytes(e.size)}`}</span>
									</span>
								</button>
							)}
							{c.renaming === e.path ? null : <RowControl entry={e} c={c} className="absolute right-1 top-1 bg-overlay/85 shadow-[inset_0_0_0_1px_var(--border)] backdrop-blur" />}
						</li>
					);
				})}
			</ul>
		</div>
	);
}
