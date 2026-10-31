import type { GitFileStatus, GitStatus } from "@clam/contracts";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, Minus, Plus, Undo2 } from "lucide-react";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/ui/empty-state";
import { Tip } from "@/ui/tooltip";
import { type ChangeGroup, GROUP_LABEL, GROUP_ORDER, groupFiles, KIND_LABEL, KIND_LETTER, KIND_TONE, splitPath } from "./status-utils.ts";

export interface ChangeSelection {
	group: ChangeGroup;
	path: string;
}

type ListRow =
	| { kind: "group"; key: string; group: ChangeGroup; files: GitFileStatus[] }
	| { kind: "file"; key: string; group: ChangeGroup; file: GitFileStatus };

const mqCoarse = typeof matchMedia === "function" ? matchMedia("(pointer: coarse)") : null;
function useCoarse(): boolean {
	return useSyncExternalStore(
		(cb) => {
			mqCoarse?.addEventListener("change", cb);
			return () => mqCoarse?.removeEventListener("change", cb);
		},
		() => mqCoarse?.matches ?? false,
		() => false,
	);
}

export interface ChangesListProps {
	status: GitStatus;
	selected: ChangeSelection | null;
	disabled?: boolean;
	onSelect: (file: GitFileStatus, group: ChangeGroup) => void;
	onStage: (paths: string[], stage: boolean) => void;
	onDiscard: (files: GitFileStatus[]) => void;
	className?: string;
}

/** Virtualized, grouped changes. Rows keep their identity across status updates, so a changed file slides to its new group instead of the list jumping. */
export function ChangesList({ status, selected, disabled, onSelect, onStage, onDiscard, className }: ChangesListProps) {
	const coarse = useCoarse();
	const rowH = coarse ? 44 : 30;
	const rows = useMemo<ListRow[]>(() => {
		const g = groupFiles(status.files);
		const out: ListRow[] = [];
		for (const group of GROUP_ORDER) {
			const files = g[group];
			if (files.length === 0) continue;
			out.push({ kind: "group", key: `g:${group}`, group, files });
			for (const file of files) out.push({ kind: "file", key: `${group}:${file.path}`, group, file });
		}
		return out;
	}, [status.files]);

	const prevKeys = useRef<Set<string> | null>(null);
	const fresh = new Set<string>();
	if (prevKeys.current) for (const r of rows) if (!prevKeys.current.has(r.key)) fresh.add(r.key);
	useEffect(() => {
		prevKeys.current = new Set(rows.map((r) => r.key));
	}, [rows]);

	const ref = useRef<HTMLDivElement>(null);
	const v = useVirtualizer({
		count: rows.length,
		getScrollElement: () => ref.current,
		estimateSize: () => rowH,
		getItemKey: (i) => rows[i]?.key ?? i,
		overscan: 12,
	});

	if (rows.length === 0) {
		return (
			<EmptyState
				icon={Check}
				title="Working tree clean"
				description={status.ahead > 0 ? `Nothing to commit. ${status.ahead} ${status.ahead === 1 ? "commit is" : "commits are"} waiting to be pushed.` : "Nothing to commit. Changes made by you or an agent show up here as they happen."}
				className={cn("min-h-0 flex-1 py-10", className)}
			/>
		);
	}

	return (
		<div ref={ref} className={cn("scrollbar-thin min-h-0 overflow-y-auto overscroll-contain [overflow-anchor:none]", className)}>
			<div className="relative w-full" style={{ height: v.getTotalSize() }}>
				{v.getVirtualItems().map((item) => {
					const row = rows[item.index];
					if (!row) return null;
					return (
						<div
							key={item.key}
							className={cn("absolute left-0 top-0 w-full transition-transform duration-200 ease-out", fresh.has(row.key) && "animate-fade-in")}
							style={{ height: rowH, transform: `translateY(${item.start}px)` }}
						>
							{row.kind === "group" ? (
								<GroupHeader group={row.group} files={row.files} disabled={disabled} onStage={onStage} onDiscard={onDiscard} />
							) : (
								<FileRow
									file={row.file}
									group={row.group}
									active={selected?.group === row.group && selected.path === row.file.path}
									disabled={disabled}
									onSelect={onSelect}
									onStage={onStage}
									onDiscard={onDiscard}
								/>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}

const iconBtn =
	"grid size-6 shrink-0 place-items-center rounded-md text-subtle outline-none transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:shadow-[0_0_0_2px_var(--accent)] disabled:pointer-events-none disabled:opacity-40 coarse:size-9";

function GroupHeader({
	group,
	files,
	disabled,
	onStage,
	onDiscard,
}: {
	group: ChangeGroup;
	files: GitFileStatus[];
	disabled?: boolean;
	onStage: ChangesListProps["onStage"];
	onDiscard: ChangesListProps["onDiscard"];
}) {
	const paths = files.map((f) => f.path);
	return (
		<div className="flex h-full items-center gap-1 border-b bg-surface-1 px-2.5">
			<h3 className={cn("text-2xs font-semibold uppercase tracking-wider", group === "conflicted" ? "text-danger" : "text-subtle")}>{GROUP_LABEL[group]}</h3>
			<span className="tabular rounded bg-surface-3 px-1 font-mono text-2xs text-muted-foreground">{files.length}</span>
			<div className="ml-auto flex items-center gap-0.5">
				{group === "changes" || group === "untracked" ? (
					<Tip label={group === "untracked" ? "Delete all untracked files…" : "Discard all changes…"}>
						<button type="button" aria-label={`Discard all ${GROUP_LABEL[group].toLowerCase()}`} disabled={disabled} onClick={() => onDiscard(files)} className={iconBtn}>
							<Undo2 className="size-3.5" />
						</button>
					</Tip>
				) : null}
				{group === "staged" ? (
					<Tip label="Unstage all">
						<button type="button" aria-label="Unstage all" disabled={disabled} onClick={() => onStage(paths, false)} className={iconBtn}>
							<Minus className="size-3.5" />
						</button>
					</Tip>
				) : (
					<Tip label={group === "conflicted" ? "Mark all as resolved" : "Stage all"}>
						<button type="button" aria-label={group === "conflicted" ? "Mark all as resolved" : `Stage all ${GROUP_LABEL[group].toLowerCase()}`} disabled={disabled} onClick={() => onStage(paths, true)} className={iconBtn}>
							<Plus className="size-3.5" />
						</button>
					</Tip>
				)}
			</div>
		</div>
	);
}

function FileRow({
	file,
	group,
	active,
	disabled,
	onSelect,
	onStage,
	onDiscard,
}: {
	file: GitFileStatus;
	group: ChangeGroup;
	active: boolean;
	disabled?: boolean;
	onSelect: ChangesListProps["onSelect"];
	onStage: ChangesListProps["onStage"];
	onDiscard: ChangesListProps["onDiscard"];
}) {
	const { dir, name } = splitPath(file.path);
	const staged = group === "staged";
	return (
		<div className={cn("group/file flex h-full items-center gap-1 px-1.5 transition-colors", active ? "bg-accent-soft" : "hover:bg-surface-2")}>
			<Tip label={staged ? "Unstage" : group === "conflicted" ? "Mark as resolved" : "Stage"}>
				<button
					type="button"
					aria-label={`${staged ? "Unstage" : group === "conflicted" ? "Mark resolved" : "Stage"} ${file.path}`}
					disabled={disabled}
					onClick={() => onStage([file.path], !staged)}
					className={iconBtn}
				>
					{staged ? <Minus className="size-3.5" /> : <Plus className="size-3.5" />}
				</button>
			</Tip>
			<button
				type="button"
				onClick={() => onSelect(file, group)}
				aria-current={active || undefined}
				title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}
				className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--accent)]"
			>
				<span className={cn("w-4 shrink-0 text-center font-mono text-2xs font-semibold", KIND_TONE[file.kind])} title={KIND_LABEL[file.kind]}>
					{KIND_LETTER[file.kind]}
				</span>
				<span className="min-w-0 truncate text-[13px]">
					<span className="font-medium">{name}</span>
					{dir ? <span className="ml-1.5 font-mono text-2xs text-subtle">{dir}</span> : null}
				</span>
			</button>
			{group === "changes" || group === "untracked" ? (
				<Tip label={group === "untracked" ? "Delete file…" : "Discard changes…"}>
					<button
						type="button"
						aria-label={`Discard ${file.path}`}
						disabled={disabled}
						onClick={() => onDiscard([file])}
						className={cn(iconBtn, "opacity-0 focus-visible:opacity-100 group-hover/file:opacity-100 coarse:opacity-100")}
					>
						<Undo2 className="size-3.5" />
					</button>
				</Tip>
			) : null}
		</div>
	);
}
