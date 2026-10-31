import type { GitStatus } from "@clam/contracts";
import { ArrowLeft, ChevronDown, ChevronUp, ChevronsDownUp, ChevronsUpDown, Columns2, FileDiff, FileText, RefreshCw, Rows2, X } from "lucide-react";
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { errorMessage } from "@/lib/api";
import { cn, formatNumber } from "@/lib/utils";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty-state";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Skeleton } from "@/ui/skeleton";
import { Tip } from "@/ui/tooltip";
import { totalChanges } from "./diff-model.ts";
import { DiffViewer, type DiffViewerHandle } from "./diff-viewer.tsx";
import { type DiffRequest, useDiff } from "./hooks.ts";
import { groupFiles, KIND_LETTER, KIND_TONE, splitPath } from "./status-utils.ts";

export type DiffView =
	| { kind: "changes"; scope: "unstaged" | "staged" | "head"; focus: { path: string; nonce: number } | null }
	| { kind: "commit"; sha: string; shortSha: string; subject: string; focus: { path: string; nonce: number } | null };

const MODE_KEY = "clam.git.diffMode";
const mqSplit = typeof matchMedia === "function" ? matchMedia("(min-width: 1024px)") : null;
/** Side-by-side needs room: only offered on viewports ≥ 1024 px. */
function useSplitAllowed(): boolean {
	return useSyncExternalStore(
		(cb) => {
			mqSplit?.addEventListener("change", cb);
			return () => mqSplit?.removeEventListener("change", cb);
		},
		() => mqSplit?.matches ?? true,
		() => true,
	);
}

function useModePref(): [boolean, (split: boolean) => void] {
	const [split, setSplit] = useState(() => {
		try {
			return localStorage.getItem(MODE_KEY) === "split";
		} catch {
			return false;
		}
	});
	return [
		split,
		(v) => {
			setSplit(v);
			try {
				localStorage.setItem(MODE_KEY, v ? "split" : "unified");
			} catch {
				/* preference only */
			}
		},
	];
}

const SCOPES: Array<{ id: "unstaged" | "staged" | "head"; label: string }> = [
	{ id: "unstaged", label: "Unstaged" },
	{ id: "staged", label: "Staged" },
	{ id: "head", label: "All vs HEAD" },
];

export function DiffPane({
	projectId,
	status,
	view,
	onViewChange,
	onBack,
	onClose,
	className,
}: {
	projectId: string;
	status: GitStatus;
	view: DiffView;
	onViewChange: (v: DiffView) => void;
	/** Mobile: pushed detail view → back to the list. */
	onBack?: () => void;
	/** Overlay: close button. */
	onClose?: () => void;
	className?: string;
}) {
	const req = useMemo<DiffRequest>(() => (view.kind === "commit" ? { scope: "commit", commit: view.sha } : { scope: view.scope }), [view]);
	const q = useDiff(projectId, req);
	const splitAllowed = useSplitAllowed();
	const [wantSplit, setWantSplit] = useModePref();
	const mode = splitAllowed && wantSplit ? "split" : "unified";
	const handle = useRef<DiffViewerHandle>(null);
	const [active, setActive] = useState(0);
	const onActive = useCallback((i: number) => setActive(i), []);

	const files = q.data?.files ?? [];
	const totals = useMemo(() => totalChanges(files), [files]);
	const groups = useMemo(() => groupFiles(status.files), [status.files]);
	const counts = { unstaged: groups.changes.length + groups.untracked.length, staged: groups.staged.length, head: status.files.length };

	return (
		<div className={cn("flex h-full min-h-0 flex-col bg-background", className)}>
			<div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b bg-surface-1/60 px-2.5 py-2">
				{onBack ? (
					<Button variant="ghost" size="sm" onClick={onBack} className="-ml-1">
						<ArrowLeft /> Changes
					</Button>
				) : null}
				{view.kind === "changes" ? (
					<div role="group" aria-label="Diff scope" className="flex rounded-lg bg-surface-2 p-0.5">
						{SCOPES.map((s) => (
							<button
								key={s.id}
								type="button"
								aria-pressed={view.scope === s.id}
								onClick={() => onViewChange({ kind: "changes", scope: s.id, focus: null })}
								className={cn(
									"inline-flex h-6 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium outline-none transition-colors coarse:h-9",
									view.scope === s.id ? "bg-surface-3 text-foreground" : "text-muted-foreground hover:text-foreground",
								)}
							>
								{s.label}
								<span className="tabular font-mono text-2xs text-subtle">{counts[s.id]}</span>
							</button>
						))}
					</div>
				) : (
					<div className="flex min-w-0 items-center gap-2">
						<span className="shrink-0 rounded bg-surface-3 px-1.5 py-0.5 font-mono text-2xs">{view.shortSha}</span>
						<span className="min-w-0 truncate text-[13px] font-medium" title={view.subject}>
							{view.subject}
						</span>
						<Button variant="ghost" size="sm" onClick={() => onViewChange({ kind: "changes", scope: "unstaged", focus: null })}>
							<X /> Back to changes
						</Button>
					</div>
				)}

				<div className="ml-auto flex items-center gap-1">
					{files.length > 0 ? (
						<span className="mr-1 hidden items-center gap-1.5 font-mono text-2xs tabular text-muted-foreground md:flex">
							{files.length} {files.length === 1 ? "file" : "files"}
							<span className="text-success">+{formatNumber(totals.additions)}</span>
							<span className="text-danger">−{formatNumber(totals.deletions)}</span>
						</span>
					) : null}
					<Tip label="Previous file (p)">
						<Button variant="ghost" size="icon-sm" aria-label="Previous file" disabled={files.length === 0} onClick={() => handle.current?.prev()}>
							<ChevronUp />
						</Button>
					</Tip>
					<Tip label="Next file (n)">
						<Button variant="ghost" size="icon-sm" aria-label="Next file" disabled={files.length === 0} onClick={() => handle.current?.next()}>
							<ChevronDown />
						</Button>
					</Tip>
					<FilePicker files={files} active={active} onPick={(p) => handle.current?.scrollToFile(p)} />
					<Tip label="Collapse all files">
						<Button variant="ghost" size="icon-sm" aria-label="Collapse all files" disabled={files.length === 0} onClick={() => handle.current?.collapseAll()}>
							<ChevronsDownUp />
						</Button>
					</Tip>
					<Tip label="Expand all files">
						<Button variant="ghost" size="icon-sm" aria-label="Expand all files" disabled={files.length === 0} onClick={() => handle.current?.expandAll()}>
							<ChevronsUpDown />
						</Button>
					</Tip>
					{splitAllowed ? (
						<div role="group" aria-label="Diff layout" className="ml-1 flex rounded-lg bg-surface-2 p-0.5">
							<Tip label="Unified">
								<button type="button" aria-label="Unified diff" aria-pressed={mode === "unified"} onClick={() => setWantSplit(false)} className={cn("grid size-6 place-items-center rounded-md outline-none transition-colors", mode === "unified" ? "bg-surface-3 text-foreground" : "text-subtle hover:text-foreground")}>
									<Rows2 className="size-3.5" />
								</button>
							</Tip>
							<Tip label="Split (side by side)">
								<button type="button" aria-label="Split diff" aria-pressed={mode === "split"} onClick={() => setWantSplit(true)} className={cn("grid size-6 place-items-center rounded-md outline-none transition-colors", mode === "split" ? "bg-surface-3 text-foreground" : "text-subtle hover:text-foreground")}>
									<Columns2 className="size-3.5" />
								</button>
							</Tip>
						</div>
					) : null}
					{onClose ? (
						<Button variant="ghost" size="icon-sm" aria-label="Close diff" onClick={onClose}>
							<X />
						</Button>
					) : null}
				</div>
			</div>

			<div className="min-h-0 flex-1">
				{q.isPending ? (
					<div className="flex flex-col gap-2 p-4" aria-busy>
						<Skeleton className="h-9" />
						{Array.from({ length: 9 }, (_, i) => (
							<Skeleton key={i} className="h-4" style={{ width: `${45 + ((i * 23) % 50)}%` }} />
						))}
					</div>
				) : q.error ? (
					<EmptyState
						icon={FileDiff}
						title="Could not load the diff"
						description={errorMessage(q.error)}
						action={
							<Button size="sm" variant="outline" onClick={() => void q.refetch()}>
								<RefreshCw /> Retry
							</Button>
						}
					/>
				) : files.length === 0 ? (
					<EmptyState
						icon={FileText}
						title={view.kind === "commit" ? "This commit has no file changes" : view.scope === "staged" ? "Nothing staged" : view.scope === "unstaged" ? "No unstaged changes" : "No changes since HEAD"}
						description={view.kind === "changes" && view.scope === "staged" ? "Stage files from the Changes list to review them here before committing." : "Edit a file — by hand or through an agent — and it shows up here live."}
					/>
				) : (
					<DiffViewer ref={handle} files={files} truncated={q.data?.truncated ?? false} mode={mode} focus={view.focus} onActiveFile={onActive} />
				)}
			</div>
		</div>
	);
}

function FilePicker({ files, active, onPick }: { files: Array<{ path: string; additions: number; deletions: number; status: string }>; active: number; onPick: (path: string) => void }) {
	const [open, setOpen] = useState(false);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<Tip label="Jump to file">
				<PopoverTrigger asChild>
					<Button variant="ghost" size="icon-sm" aria-label="Jump to file" disabled={files.length === 0}>
						<FileText />
					</Button>
				</PopoverTrigger>
			</Tip>
			<PopoverContent align="end" className="w-[min(26rem,calc(100vw-1rem))] p-1">
				<ul className="scrollbar-thin max-h-80 overflow-y-auto">
					{files.map((f, i) => {
						const { dir, name } = splitPath(f.path);
						const kind = (f.status in KIND_LETTER ? f.status : "modified") as keyof typeof KIND_LETTER;
						return (
							<li key={f.path}>
								<button
									type="button"
									onClick={() => {
										onPick(f.path);
										setOpen(false);
									}}
									className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-surface-3 focus-visible:bg-surface-3 coarse:py-2.5", i === active && "bg-surface-2")}
								>
									<span className={cn("w-4 shrink-0 text-center font-mono text-2xs font-semibold", KIND_TONE[kind])}>{KIND_LETTER[kind]}</span>
									<span className="min-w-0 flex-1 truncate text-xs">
										<span className="font-medium">{name}</span> <span className="font-mono text-2xs text-subtle">{dir}</span>
									</span>
									<span className="shrink-0 font-mono text-2xs tabular">
										<span className="text-success">+{f.additions}</span> <span className="text-danger">−{f.deletions}</span>
									</span>
								</button>
							</li>
						);
					})}
				</ul>
			</PopoverContent>
		</Popover>
	);
}
