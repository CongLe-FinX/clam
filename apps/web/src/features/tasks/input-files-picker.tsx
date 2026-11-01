import { type FileEntry, routes } from "@clam/contracts";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, File, Folder, FolderOpen, Paperclip, RotateCw, X } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { t } from "@/i18n";
import { api, errorText } from "@/lib/api";
import { qk } from "@/lib/queries";
import { cn, formatBytes, formatNumber } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Skeleton } from "@/ui/skeleton";

/** The server accepts at most this many `inputPaths`. */
export const MAX_INPUT_PATHS = 500;

/** Entries the bundle builder always leaves out — shown muted and not selectable. */
const EXCLUDED_NAMES = new Set([".git", "node_modules", ".DS_Store", ".next", ".turbo", ".cache", "__pycache__", ".venv", "venv", "dist", "build", "target", ".idea"]);
const isExcluded = (name: string) => EXCLUDED_NAMES.has(name) || name === ".env" || name.startsWith(".env.");

const isInside = (path: string, folder: string) => path.startsWith(`${folder}/`);

interface PickerCtx {
	projectId: string;
	selected: Set<string>;
	limitReached: boolean;
	toggle: (entry: FileEntry) => void;
}

function useDir(projectId: string, path: string, enabled: boolean) {
	return useQuery({
		queryKey: qk.projectFiles(projectId, path),
		queryFn: ({ signal }) => api.get<FileEntry[]>(routes.projectFiles(projectId), { path }, { signal }),
		enabled,
		// Files change outside the UI (agents, sync): always look again when the tree is opened.
		staleTime: 0,
		refetchOnMount: "always",
	});
}

const byKindThenName = (a: FileEntry, b: FileEntry) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1);

function Level({ ctx, path, depth, covered }: { ctx: PickerCtx; path: string; depth: number; covered: boolean }) {
	const dir = useDir(ctx.projectId, path, true);
	const entries = useMemo(() => (dir.data ?? []).filter((e) => e.kind !== "symlink").sort(byKindThenName), [dir.data]);
	const pad = { paddingLeft: 8 + depth * 16 };
	if (dir.isPending) {
		return (
			<div className="flex flex-col gap-1 py-1" style={pad} aria-busy="true">
				<Skeleton className="h-5 w-2/3" />
				<Skeleton className="h-5 w-1/2" />
			</div>
		);
	}
	if (dir.isError) {
		return (
			<div className="flex items-center gap-2 py-1.5 text-xs text-danger" style={pad} role="alert">
				<span className="min-w-0 flex-1 truncate">{errorText(dir.error)}</span>
				<Button type="button" size="sm" variant="ghost" onClick={() => void dir.refetch()}>
					<RotateCw /> {t("Retry")}
				</Button>
			</div>
		);
	}
	if (entries.length === 0) {
		return (
			<p className="py-1.5 text-xs text-subtle" style={pad}>
				{t("Empty folder")}
			</p>
		);
	}
	return (
		<ul role="group" className="flex flex-col">
			{entries.map((e) => (
				<Node key={e.path} ctx={ctx} entry={e} depth={depth} covered={covered} />
			))}
		</ul>
	);
}

function Node({ ctx, entry, depth, covered }: { ctx: PickerCtx; entry: FileEntry; depth: number; covered: boolean }) {
	const [open, setOpen] = useState(false);
	const id = useId();
	const isDir = entry.kind === "dir";
	const excluded = isExcluded(entry.name);
	const direct = ctx.selected.has(entry.path);
	const checked = direct || covered;
	const disabled = excluded || covered || (!direct && ctx.limitReached);
	const label = excluded ? t("{name} (excluded from the bundle)", { name: entry.name }) : covered ? t("{name} (included through its folder)", { name: entry.name }) : entry.name;
	return (
		<li role="treeitem" aria-expanded={isDir ? open : undefined} aria-selected={checked}>
			<div
				className={cn("flex min-h-8 items-center gap-1.5 rounded-md pr-2 hover:bg-surface-2 coarse:min-h-11", excluded && "opacity-50")}
				style={{ paddingLeft: 4 + depth * 16 }}
			>
				{isDir ? (
					<button
						type="button"
						aria-label={open ? t("Collapse {name}", { name: entry.name }) : t("Expand {name}", { name: entry.name })}
						onClick={() => setOpen((o) => !o)}
						className="inline-flex size-6 shrink-0 items-center justify-center rounded text-subtle outline-none hover:text-foreground focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:size-9"
					>
						<ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} aria-hidden />
					</button>
				) : (
					<span className="size-6 shrink-0 coarse:size-9" aria-hidden />
				)}
				<input
					id={id}
					type="checkbox"
					checked={checked}
					disabled={disabled}
					aria-label={label}
					onChange={() => ctx.toggle(entry)}
					className="size-4 shrink-0 accent-[var(--accent)] coarse:size-5"
				/>
				<label htmlFor={id} className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-[13px] has-[:disabled]:cursor-default">
					{isDir ? (open ? <FolderOpen className="size-3.5 shrink-0 text-accent" aria-hidden /> : <Folder className="size-3.5 shrink-0 text-accent" aria-hidden />) : <File className="size-3.5 shrink-0 text-subtle" aria-hidden />}
					<span className="truncate">{entry.name}</span>
				</label>
				{excluded ? <span className="shrink-0 text-2xs text-subtle">{t("excluded")}</span> : !isDir && entry.size !== null ? <span className="tabular shrink-0 font-mono text-2xs text-subtle">{formatBytes(entry.size)}</span> : null}
			</div>
			{isDir && open ? <Level ctx={ctx} path={entry.path} depth={depth + 1} covered={checked} /> : null}
		</li>
	);
}

/**
 * Multi-select files/folders from a project's tree (lazy per-folder listing). A selected folder covers everything below it,
 * so choosing a folder drops its selected descendants. Emits project-relative paths for `inputPaths`.
 */
export function InputFilesPicker({ projectId, value, onChange }: { projectId: string; value: string[]; onChange: (paths: string[]) => void }) {
	const [open, setOpen] = useState(false);
	const selected = useMemo(() => new Set(value), [value]);
	const limitReached = value.length >= MAX_INPUT_PATHS;

	const ctx: PickerCtx = {
		projectId,
		selected,
		limitReached,
		toggle: (entry) => {
			if (selected.has(entry.path)) {
				onChange(value.filter((p) => p !== entry.path));
				return;
			}
			const next = entry.kind === "dir" ? value.filter((p) => !isInside(p, entry.path)) : value;
			onChange([...next, entry.path]);
		},
	};

	return (
		<div className="flex flex-col gap-2">
			<div className="flex flex-wrap items-center gap-2">
				<Button type="button" size="sm" variant="outline" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
					<Paperclip /> {open ? t("Hide file tree") : value.length > 0 ? t("Change input files") : t("Choose input files")}
				</Button>
				<span className="tabular text-xs text-muted-foreground" aria-live="polite">
					{value.length === 0 ? t("None selected") : limitReached ? t("{count} selected (maximum {max})", { count: formatNumber(value.length), max: formatNumber(MAX_INPUT_PATHS) }) : t("{count} selected", { count: formatNumber(value.length) })}
				</span>
				{value.length > 0 ? (
					<Button type="button" size="sm" variant="ghost" onClick={() => onChange([])}>
						{t("Clear")}
					</Button>
				) : null}
			</div>
			{value.length > 0 ? (
				<ul className="flex flex-wrap gap-1.5" aria-label={t("Selected input files")}>
					{value.map((p) => (
						<li key={p} className="inline-flex max-w-full items-center gap-1 rounded-md bg-surface-3 py-0.5 pl-2 pr-0.5 font-mono text-2xs coarse:py-1">
							<span className="truncate" title={p}>
								{p}
							</span>
							<button
								type="button"
								aria-label={t("Remove {path}", { path: p })}
								onClick={() => onChange(value.filter((x) => x !== p))}
								className="inline-flex size-5 shrink-0 items-center justify-center rounded text-subtle outline-none hover:bg-surface-2 hover:text-foreground focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:size-8"
							>
								<X className="size-3" aria-hidden />
							</button>
						</li>
					))}
				</ul>
			) : null}
			{open ? (
				<div role="tree" aria-multiselectable="true" aria-label={t("Project files")} className="scrollbar-thin max-h-64 overflow-y-auto rounded-lg bg-surface-1 py-1 shadow-[inset_0_0_0_1px_var(--border)]">
					<Level ctx={ctx} path="" depth={0} covered={false} />
				</div>
			) : null}
			<p className="text-xs text-subtle">{t("Copied to the executor as a read-only bundle. Large files and ignored folders (node_modules, .git, build output, .env…) are left out, and a total size cap applies.")}</p>
		</div>
	);
}
