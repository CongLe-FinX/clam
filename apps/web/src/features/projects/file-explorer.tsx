import { type FileEntry, routes } from "@clam/contracts";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
	AlertCircle,
	ChevronRight,
	File,
	FileArchive,
	FileCode,
	FileCog,
	FileImage,
	FileJson,
	FileLock,
	FileTerminal,
	FileText,
	Folder,
	FolderOpen,
	Link2,
	RefreshCw,
	Search,
	X,
} from "lucide-react";
import { type KeyboardEvent, memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Tip } from "@/ui/tooltip";

export interface FileExplorerProps {
	projectId: string;
	selectedPath?: string | null;
	onOpenFile: (path: string) => void;
	className?: string;
}

// ───────────────────────────── persisted expanded set ─────────────────────────────

const storageKey = (projectId: string) => `clam.explorer.${projectId}`;

function loadExpanded(projectId: string): Set<string> {
	try {
		const raw = localStorage.getItem(storageKey(projectId));
		const arr: unknown = raw ? JSON.parse(raw) : [];
		return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : []);
	} catch {
		return new Set();
	}
}

function useExpanded(projectId: string) {
	const [state, setState] = useState(() => ({ projectId, set: loadExpanded(projectId) }));
	let current = state;
	if (state.projectId !== projectId) {
		current = { projectId, set: loadExpanded(projectId) };
		setState(current);
	}
	const update = useCallback(
		(fn: (prev: Set<string>) => Set<string>) => {
			setState((s) => {
				const set = fn(s.set);
				if (set === s.set) return s;
				try {
					localStorage.setItem(storageKey(s.projectId), JSON.stringify([...set]));
				} catch {
					/* storage unavailable or full: expansion just isn't remembered */
				}
				return { ...s, set };
			});
		},
		[],
	);
	return [current.set, update] as const;
}

// ───────────────────────────── icons ─────────────────────────────

const CODE_EXT = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "java", "c", "h", "cpp", "cc", "hpp", "rb", "php", "swift", "kt", "css", "scss", "html", "htm", "vue", "svelte", "sql", "lua", "zig"]);
const IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "avif", "bmp"]);
const ARCHIVE_EXT = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar"]);
const CONFIG_EXT = new Set(["yml", "yaml", "toml", "ini", "conf", "cfg", "env"]);
const TEXT_EXT = new Set(["md", "mdx", "txt", "rst", "log", "csv"]);

function fileIcon(name: string): { Icon: typeof File; tone: string } {
	const lower = name.toLowerCase();
	if (lower.endsWith(".lock") || lower === "pnpm-lock.yaml" || lower === "package-lock.json") return { Icon: FileLock, tone: "text-subtle" };
	if (lower.startsWith(".env")) return { Icon: FileCog, tone: "text-warning" };
	const ext = lower.includes(".") ? (lower.split(".").pop() as string) : "";
	if (ext === "json" || ext === "jsonc" || ext === "jsonl") return { Icon: FileJson, tone: "text-warning" };
	if (ext === "sh" || ext === "bash" || ext === "zsh") return { Icon: FileTerminal, tone: "text-success" };
	if (CODE_EXT.has(ext)) return { Icon: FileCode, tone: "text-accent" };
	if (IMG_EXT.has(ext)) return { Icon: FileImage, tone: "text-info" };
	if (ARCHIVE_EXT.has(ext)) return { Icon: FileArchive, tone: "text-subtle" };
	if (CONFIG_EXT.has(ext)) return { Icon: FileCog, tone: "text-muted-foreground" };
	if (TEXT_EXT.has(ext)) return { Icon: FileText, tone: "text-muted-foreground" };
	return { Icon: File, tone: "text-subtle" };
}

// ───────────────────────────── row model ─────────────────────────────

type Row =
	| { type: "entry"; key: string; entry: FileEntry; depth: number; expanded: boolean; hint?: string }
	| { type: "loading"; key: string; depth: number }
	| { type: "empty"; key: string; depth: number }
	| { type: "error"; key: string; depth: number; path: string; message: string };

const byKindThenName = (a: FileEntry, b: FileEntry) => {
	const ad = a.kind === "dir" ? 0 : 1;
	const bd = b.kind === "dir" ? 0 : 1;
	return ad - bd || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
};

const INDENT = 14;
const BASE_PAD = 8;

const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
function ancestorsOf(p: string): string[] {
	const parts = p.split("/");
	const out: string[] = [];
	for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
	return out;
}

interface DirState {
	entries?: FileEntry[];
	loading: boolean;
	error?: string;
}

// ───────────────────────────── component ─────────────────────────────

export function FileExplorer({ projectId, selectedPath, onOpenFile, className }: FileExplorerProps) {
	const qc = useQueryClient();
	const [expanded, updateExpanded] = useExpanded(projectId);
	const [filter, setFilter] = useState("");
	const [activeKey, setActiveKey] = useState<string | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const filterRef = useRef<HTMLInputElement>(null);
	const treeId = useId();
	const [coarse] = useState(() => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches);
	const rowHeight = coarse ? 36 : 28;

	// Reveal the selected file's ancestors when it changes (deep link / outside selection).
	useEffect(() => {
		if (!selectedPath) return;
		const anc = ancestorsOf(selectedPath);
		updateExpanded((prev) => (anc.every((a) => prev.has(a)) ? prev : new Set([...prev, ...anc])));
		setActiveKey(selectedPath);
	}, [selectedPath, updateExpanded]);

	const dirPaths = useMemo(() => ["", ...[...expanded].sort()], [expanded]);
	const results = useQueries({
		queries: dirPaths.map((path) => ({
			queryKey: qk.projectFiles(projectId, path),
			queryFn: ({ signal }: { signal: AbortSignal }) => api.get<FileEntry[]>(routes.projectFiles(projectId), { path }, { signal }),
		})),
	});

	const dirs = useMemo(() => {
		const m = new Map<string, DirState>();
		dirPaths.forEach((p, i) => {
			const r = results[i];
			if (!r) return;
			m.set(p, { entries: r.data ? [...r.data].sort(byKindThenName) : undefined, loading: r.isPending, error: r.error ? errorMessage(r.error) : undefined });
		});
		return m;
		// biome-ignore lint/correctness/useExhaustiveDependencies: results is a fresh array each render; depend on its contents
	}, [dirPaths, ...results.map((r) => r.data), ...results.map((r) => r.error), ...results.map((r) => r.isPending)]);

	const q = filter.trim().toLowerCase();
	const rows = useMemo<Row[]>(() => {
		if (q) {
			const out: Row[] = [];
			for (const [dir, st] of dirs) {
				for (const e of st.entries ?? []) {
					if (e.name.toLowerCase().includes(q)) out.push({ type: "entry", key: e.path, entry: e, depth: 0, expanded: false, hint: dir });
				}
			}
			out.sort((a, b) => (a.type === "entry" && b.type === "entry" ? byKindThenName(a.entry, b.entry) : 0));
			return out;
		}
		const out: Row[] = [];
		const walk = (dir: string, depth: number) => {
			const st = dirs.get(dir);
			if (!st || (st.loading && !st.entries)) {
				out.push({ type: "loading", key: `loading:${dir}`, depth });
				return;
			}
			if (st.error && !st.entries) {
				out.push({ type: "error", key: `error:${dir}`, depth, path: dir, message: st.error });
				return;
			}
			if (!st.entries?.length) {
				out.push({ type: "empty", key: `empty:${dir}`, depth });
				return;
			}
			for (const e of st.entries) {
				const open = e.kind === "dir" && expanded.has(e.path);
				out.push({ type: "entry", key: e.path, entry: e, depth, expanded: open });
				if (open) walk(e.path, depth + 1);
			}
		};
		walk("", 0);
		return out;
	}, [dirs, expanded, q]);

	const v = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => rowHeight,
		overscan: 12,
		getItemKey: (i) => rows[i]?.key ?? i,
	});

	const activeIndex = useMemo(() => {
		if (activeKey === null) return -1;
		return rows.findIndex((r) => r.key === activeKey);
	}, [rows, activeKey]);

	// Bring the selected row into view once it exists.
	const revealed = useRef<string | null>(null);
	useEffect(() => {
		if (!selectedPath || revealed.current === selectedPath) return;
		const idx = rows.findIndex((r) => r.key === selectedPath);
		if (idx >= 0) {
			revealed.current = selectedPath;
			v.scrollToIndex(idx, { align: "auto" });
		}
	}, [rows, selectedPath, v]);

	const toggleDir = useCallback(
		(path: string, force?: boolean) => {
			updateExpanded((prev) => {
				const want = force ?? !prev.has(path);
				if (want === prev.has(path)) return prev;
				const next = new Set(prev);
				if (want) next.add(path);
				else next.delete(path);
				return next;
			});
		},
		[updateExpanded],
	);

	const activate = useCallback(
		(row: Row) => {
			if (row.type === "entry") {
				setActiveKey(row.key);
				if (row.entry.kind === "dir") toggleDir(row.entry.path);
				else onOpenFile(row.entry.path);
			}
		},
		[onOpenFile, toggleDir],
	);

	const moveTo = (idx: number) => {
		let i = Math.max(0, Math.min(rows.length - 1, idx));
		// Skip non-entry rows (loading / empty / error) when moving.
		const dir = idx >= activeIndex ? 1 : -1;
		while (rows[i] && rows[i]?.type !== "entry" && i + dir >= 0 && i + dir < rows.length) i += dir;
		const r = rows[i];
		if (r?.type === "entry") {
			setActiveKey(r.key);
			v.scrollToIndex(i, { align: "auto" });
		}
	};

	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		if (!rows.length) return;
		const idx = activeIndex < 0 ? 0 : activeIndex;
		const row = rows[idx];
		switch (e.key) {
			case "ArrowDown":
				e.preventDefault();
				moveTo(activeIndex < 0 ? 0 : idx + 1);
				break;
			case "ArrowUp":
				e.preventDefault();
				moveTo(idx - 1);
				break;
			case "Home":
				e.preventDefault();
				moveTo(0);
				break;
			case "End":
				e.preventDefault();
				moveTo(rows.length - 1);
				break;
			case "ArrowRight":
				if (row?.type === "entry" && row.entry.kind === "dir" && !q) {
					e.preventDefault();
					if (!row.expanded) toggleDir(row.entry.path, true);
					else moveTo(idx + 1);
				}
				break;
			case "ArrowLeft":
				if (row?.type === "entry" && !q) {
					e.preventDefault();
					if (row.entry.kind === "dir" && row.expanded) toggleDir(row.entry.path, false);
					else {
						const parent = parentOf(row.entry.path);
						if (parent) {
							setActiveKey(parent);
							const pi = rows.findIndex((r) => r.key === parent);
							if (pi >= 0) v.scrollToIndex(pi, { align: "auto" });
						}
					}
				}
				break;
			case "Enter":
			case " ":
				if (row) {
					e.preventDefault();
					activate(row);
				}
				break;
			default:
		}
	};

	const refresh = () => {
		void qc.invalidateQueries({ queryKey: ["local", "project", projectId, "files"] });
	};
	const refreshing = results.some((r) => r.isFetching);
	const prefetchDir = (path: string) => {
		void qc.prefetchQuery({ queryKey: qk.projectFiles(projectId, path), queryFn: ({ signal }) => api.get<FileEntry[]>(routes.projectFiles(projectId), { path }, { signal }) });
	};

	const activeId = activeIndex >= 0 && rows[activeIndex] ? `${treeId}-${activeIndex}` : undefined;

	return (
		<div className={cn("flex h-full min-h-0 flex-col bg-surface-1", className)}>
			<div className="flex shrink-0 items-center gap-1.5 border-b px-2 py-1.5">
				<div className="relative min-w-0 flex-1">
					<Search aria-hidden className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
					<input
						ref={filterRef}
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Escape") setFilter("");
							else if (e.key === "ArrowDown") {
								e.preventDefault();
								scrollRef.current?.focus();
								if (rows.length) moveTo(0);
							}
						}}
						placeholder="Filter files"
						aria-label="Filter loaded files by name"
						className="h-7 w-full rounded-md bg-surface-2 pl-7 pr-7 text-xs outline-none placeholder:text-subtle focus-visible:shadow-[inset_0_0_0_1px_var(--accent)] coarse:h-10"
					/>
					{filter ? (
						<button type="button" aria-label="Clear filter" onClick={() => setFilter("")} className="absolute right-1.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-subtle hover:text-foreground coarse:size-8">
							<X className="size-3" />
						</button>
					) : null}
				</div>
				<Tip label="Refresh">
					<Button variant="ghost" size="icon-sm" aria-label="Refresh file tree" onClick={refresh}>
						<RefreshCw className={cn(refreshing && "animate-spin")} />
					</Button>
				</Tip>
			</div>

			<div
				ref={scrollRef}
				role="tree"
				aria-label="Project files"
				aria-activedescendant={activeId}
				tabIndex={0}
				onKeyDown={onKeyDown}
				onFocus={() => {
					if (activeKey === null && rows[0]?.type === "entry") setActiveKey(rows[0].key);
				}}
				className="scrollbar-thin min-h-0 flex-1 overflow-auto overscroll-contain outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--accent)]"
			>
				{q && rows.length === 0 ? (
					<p className="px-4 py-6 text-center text-xs text-subtle">No loaded files match “{filter.trim()}”. Expand folders to load more.</p>
				) : null}
				<div className="relative w-full min-w-max" style={{ height: v.getTotalSize() }}>
					{v.getVirtualItems().map((item) => {
						const row = rows[item.index] as Row;
						return (
							<div key={item.key} className="absolute inset-x-0 top-0" style={{ height: rowHeight, transform: `translateY(${item.start}px)` }}>
								<TreeRow
									id={`${treeId}-${item.index}`}
									row={row}
									selected={row.type === "entry" && row.key === selectedPath}
									active={item.index === activeIndex}
									onActivate={activate}
									onRetry={refresh}
									onHoverDir={prefetchDir}
								/>
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}

const TreeRow = memo(function TreeRow({
	id,
	row,
	selected,
	active,
	onActivate,
	onRetry,
	onHoverDir,
}: {
	id: string;
	row: Row;
	selected: boolean;
	active: boolean;
	onActivate: (row: Row) => void;
	onRetry: () => void;
	onHoverDir: (path: string) => void;
}) {
	const pad = BASE_PAD + row.depth * INDENT;
	const guides = Array.from({ length: row.depth }, (_, i) => (
		<span key={i} aria-hidden className="pointer-events-none absolute inset-y-0 w-px bg-border" style={{ left: BASE_PAD + i * INDENT + 8 }} />
	));

	if (row.type === "loading") {
		return (
			<div role="none" className="relative flex h-full items-center" style={{ paddingLeft: pad + 20 }}>
				{guides}
				<div className="h-2.5 w-28 animate-pulse rounded bg-surface-3" />
			</div>
		);
	}
	if (row.type === "empty") {
		return (
			<div role="none" className="relative flex h-full items-center text-2xs italic text-subtle" style={{ paddingLeft: pad + 20 }}>
				{guides}
				Empty
			</div>
		);
	}
	if (row.type === "error") {
		return (
			<div role="none" className="relative flex h-full items-center gap-2 pr-2 text-xs text-danger" style={{ paddingLeft: pad + 4 }}>
				{guides}
				<AlertCircle className="size-3.5 shrink-0" />
				<span className="truncate" title={row.message}>
					{row.message}
				</span>
				<button type="button" onClick={onRetry} className="shrink-0 rounded px-1.5 py-0.5 font-medium text-accent hover:bg-surface-3 coarse:py-2">
					Retry
				</button>
			</div>
		);
	}

	const { entry } = row;
	const isDir = entry.kind === "dir";
	const { Icon, tone } = fileIcon(entry.name);
	return (
		<div
			id={id}
			role="treeitem"
			tabIndex={-1}
			aria-level={row.depth + 1}
			aria-selected={selected}
			aria-expanded={isDir ? row.expanded : undefined}
			onClick={() => onActivate(row)}
			onPointerEnter={isDir && !row.expanded ? () => onHoverDir(entry.path) : undefined}
			className={cn(
				"relative flex h-full cursor-pointer select-none items-center gap-1.5 pr-3 text-[13px] transition-colors hover:bg-surface-2",
				selected && "bg-accent-soft text-foreground hover:bg-accent-soft",
				active && "shadow-[inset_0_0_0_1px_var(--accent)]",
			)}
			style={{ paddingLeft: pad }}
		>
			{guides}
			{isDir ? (
				<ChevronRight aria-hidden className={cn("size-3.5 shrink-0 text-subtle transition-transform duration-150", row.expanded && "rotate-90")} />
			) : (
				<span aria-hidden className="size-3.5 shrink-0" />
			)}
			{isDir ? (
				row.expanded ? (
					<FolderOpen aria-hidden className="size-4 shrink-0 text-accent" />
				) : (
					<Folder aria-hidden className="size-4 shrink-0 text-muted-foreground" />
				)
			) : (
				<Icon aria-hidden className={cn("size-4 shrink-0", tone)} />
			)}
			<span className={cn("whitespace-nowrap", selected ? "font-medium" : isDir ? "text-foreground" : "text-muted-foreground")}>{entry.name}</span>
			{entry.kind === "symlink" ? <Link2 aria-label="Symbolic link" className="size-3 shrink-0 text-subtle" /> : null}
			{row.hint ? <span className="whitespace-nowrap font-mono text-2xs text-subtle">{row.hint}</span> : null}
		</div>
	);
});
