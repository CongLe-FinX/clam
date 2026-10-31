import type { FilesPreview, Task } from "@clam/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRight, CircleAlert, FolderOpen, RotateCw, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useState } from "react";
import { errorMessage } from "@/lib/api";
import { useProjects } from "@/lib/queries";
import { cn, formatBytes } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { Field } from "@/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { Skeleton } from "@/ui/skeleton";
import { useApplyTaskFiles, useTaskFilesPreview } from "./hooks.ts";

type Status = FilesPreview["files"][number]["status"];
type Row = FilesPreview["files"][number];

const STATUS_META: Record<Status, { label: string; variant: "success" | "accent" | "warning" | "neutral" }> = {
	new: { label: "new", variant: "success" },
	update: { label: "update", variant: "accent" },
	conflict: { label: "conflict", variant: "warning" },
	unchanged: { label: "unchanged", variant: "neutral" },
};
const STATUS_ORDER: Status[] = ["new", "update", "conflict", "unchanged"];

const SKIP_REASON = {
	unchanged: "already identical",
	conflict: "changed locally and not marked Overwrite",
	not_selected: "not selected",
} as const;

/** Colours a unified diff: additions, removals, hunk headers. */
function DiffView({ diff, isNew }: { diff: string | undefined; isNew?: boolean }) {
	if (diff === undefined || diff === "") {
		return <p className="px-3 py-2 text-xs text-subtle">{isNew ? "New file — it will be created as received (no earlier version to compare)." : "Binary or large file — no preview."}</p>;
	}
	const lines = diff.split("\n");
	return (
		<pre className="scrollbar-thin max-h-80 overflow-auto bg-surface-1 py-1.5 font-mono text-2xs leading-relaxed" aria-label="Unified diff">
			{lines.map((line, i) => {
				const head = line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ");
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional and never reordered
					<div
						key={i}
						className={cn(
							"min-w-max px-3",
							head ? "text-subtle" : line.startsWith("@@") ? "bg-accent-soft/60 text-accent" : line.startsWith("+") ? "bg-success/10 text-success" : line.startsWith("-") ? "bg-danger/10 text-danger" : "text-muted-foreground",
						)}
					>
						{line === "" ? " " : line}
					</div>
				);
			})}
		</pre>
	);
}

function FileRow({ row, checked, diff, onToggle }: { row: Row; checked: boolean; diff: string | undefined; onToggle: () => void }) {
	const [open, setOpen] = useState(false);
	const id = useId();
	const unchanged = row.status === "unchanged";
	const conflict = row.status === "conflict";
	const meta = STATUS_META[row.status];
	return (
		<li className={cn("border-b last:border-0", unchanged && "opacity-60")}>
			<div className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5">
				<button
					type="button"
					aria-expanded={open}
					aria-label={`${open ? "Hide" : "Show"} diff for ${row.path}`}
					onClick={() => setOpen((o) => !o)}
					className="inline-flex size-7 shrink-0 items-center justify-center rounded text-subtle outline-none hover:text-foreground focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:size-10"
				>
					<ChevronRight className={cn("size-4 transition-transform", open && "rotate-90")} aria-hidden />
				</button>
				<input
					id={id}
					type="checkbox"
					checked={checked}
					disabled={unchanged}
					onChange={onToggle}
					aria-label={conflict ? `Overwrite ${row.path}` : `Apply ${row.path}`}
					className="size-4 shrink-0 accent-[var(--accent)] coarse:size-5"
				/>
				<label htmlFor={id} className="min-w-0 flex-1 basis-40 cursor-pointer break-all font-mono text-xs has-[:disabled]:cursor-default">
					{row.path}
				</label>
				<span className="flex shrink-0 items-center gap-2">
					<Badge variant={meta.variant}>{meta.label}</Badge>
					<span className="tabular font-mono text-2xs text-subtle">{formatBytes(row.size)}</span>
				</span>
				{conflict ? (
					<p className="flex basis-full items-start gap-1.5 pl-9 text-xs text-warning coarse:pl-12">
						<TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
						<span>
							Changed locally too — will only be replaced if you tick <strong>Overwrite</strong>.
						</span>
					</p>
				) : null}
			</div>
			{open ? (
				<div className="border-t bg-surface-1">
					<DiffView diff={unchanged ? "" : diff} isNew={row.status === "new"} />
				</div>
			) : null}
		</li>
	);
}

export default function FilesApplyDialog({ task, onClose }: { task: Task; onClose: () => void }) {
	const projects = useProjects();
	const apply = useApplyTaskFiles(task.id);
	const [projectId, setProjectId] = useState(task.projectId ?? "");
	const [filter, setFilter] = useState<Status | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const preview = useTaskFilesPreview(task.id, projectId);

	const sorted = useMemo(() => [...(projects.data ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [projects.data]);
	// A single project is the obvious target when the task carries none.
	useEffect(() => {
		if (!projectId && sorted.length === 1 && sorted[0]) setProjectId(sorted[0].id);
	}, [projectId, sorted]);

	const files = preview.data?.files;
	// Safe defaults: new and update are preselected, conflicts and unchanged files are not.
	useEffect(() => {
		setSelected(new Set((files ?? []).filter((f) => f.status === "new" || f.status === "update").map((f) => f.path)));
	}, [files]);

	const counts = useMemo(() => {
		const c: Record<Status, number> = { new: 0, update: 0, conflict: 0, unchanged: 0 };
		for (const f of files ?? []) c[f.status]++;
		return c;
	}, [files]);
	const visible = useMemo(() => (files ?? []).filter((f) => filter === null || f.status === filter), [files, filter]);
	const chosen = useMemo(() => (files ?? []).filter((f) => f.status !== "unchanged" && selected.has(f.path)), [files, selected]);
	const overwriting = chosen.filter((f) => f.status === "conflict").length;

	const toggle = (path: string) =>
		setSelected((prev) => {
			const next = new Set(prev);
			if (!next.delete(path)) next.add(path);
			return next;
		});
	const summary = STATUS_ORDER.filter((s) => counts[s] > 0)
		.map((s) => `${counts[s]} ${STATUS_META[s].label}`)
		.join(" · ");

	const submit = () => {
		if (!projectId || chosen.length === 0) return;
		apply.mutate({
			projectId,
			paths: chosen.map((f) => f.path),
			overwrite: chosen.filter((f) => f.status === "conflict").map((f) => f.path),
		});
	};

	const target = projects.data?.find((p) => p.id === projectId);
	const result = apply.data;

	return (
		<Dialog open onOpenChange={(o) => !o && !apply.isPending && onClose()}>
			<DialogContent sheetOnMobile className="max-w-3xl">
				<DialogHeader>
					<DialogTitle>{result ? "Files applied" : "Preview & apply files"}</DialogTitle>
					<DialogDescription>
						{result
							? `Written to ${target?.name ?? "the project"}.`
							: `The executor returned ${task.result?.files ? `${task.result.files.fileCount} ${task.result.files.fileCount === 1 ? "file" : "files"} (${formatBytes(task.result.files.size)})` : "a file bundle"}. Review the changes, then choose what to write into a local project.`}
					</DialogDescription>
				</DialogHeader>

				{result ? (
					<div className="scrollbar-thin -mx-1 flex min-h-0 flex-col gap-3 overflow-y-auto px-1" role="status">
						<p className="text-[13px]">
							<strong>{result.written.length}</strong> {result.written.length === 1 ? "file" : "files"} written
							{result.skipped.length > 0 ? (
								<>
									, <strong>{result.skipped.length}</strong> skipped
								</>
							) : null}
							.
						</p>
						{result.written.length > 0 ? (
							<ul className="scrollbar-thin max-h-48 overflow-y-auto rounded-lg bg-surface-2 py-1">
								{result.written.map((p) => (
									<li key={p} className="break-all px-3 py-1 font-mono text-xs">
										{p}
									</li>
								))}
							</ul>
						) : null}
						{result.skipped.length > 0 ? (
							<div className="flex flex-col gap-1">
								<h3 className="text-2xs font-semibold uppercase tracking-wider text-subtle">Skipped</h3>
								<ul className="scrollbar-thin max-h-48 overflow-y-auto rounded-lg bg-surface-2 py-1">
									{result.skipped.map((s) => (
										<li key={s.path} className="flex flex-wrap items-baseline gap-x-2 px-3 py-1">
											<span className="break-all font-mono text-xs">{s.path}</span>
											<span className="text-2xs text-subtle">{SKIP_REASON[s.reason]}</span>
										</li>
									))}
								</ul>
							</div>
						) : null}
						<DialogFooter className="sticky bottom-0 -mx-1 bg-overlay px-1 pt-1">
							<Button variant="ghost" onClick={onClose}>
								Close
							</Button>
							<Button asChild variant="primary">
								<Link to="/projects/$projectId" params={{ projectId }} onClick={onClose}>
									<FolderOpen /> Open project
								</Link>
							</Button>
						</DialogFooter>
					</div>
				) : (
					<div className="scrollbar-thin -mx-1 flex min-h-0 flex-col gap-3 overflow-y-auto px-1">
						<Field label="Apply to project" hint="Only projects on this machine. Files are written relative to the project folder.">
							{() => (
								<Select value={projectId} onValueChange={(v) => setProjectId(v)} disabled={apply.isPending}>
									<SelectTrigger>
										<SelectValue placeholder={projects.isPending ? "Loading projects…" : "Choose a project"} />
									</SelectTrigger>
									<SelectContent>
										{sorted.map((p) => (
											<SelectItem key={p.id} value={p.id}>
												<span className="inline-flex items-center gap-2">
													{p.name}
													<span className="text-2xs text-subtle">{p.vcs === "git" ? "git" : p.managed ? "managed folder" : "folder"}</span>
												</span>
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							)}
						</Field>
						{projects.isError ? (
							<p role="alert" className="flex items-center gap-2 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
								<span className="min-w-0 flex-1">{errorMessage(projects.error)}</span>
								<Button type="button" size="sm" variant="ghost" onClick={() => void projects.refetch()}>
									<RotateCw /> Retry
								</Button>
							</p>
						) : null}
						{projects.isSuccess && sorted.length === 0 ? <p className="rounded-lg bg-surface-2 px-3 py-2 text-[13px] text-muted-foreground">There is no project on this machine yet. Create a project first, then apply the files into it.</p> : null}

						{!projectId ? null : preview.isPending ? (
							<div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading preview">
								<Skeleton className="h-8" />
								<Skeleton className="h-11" />
								<Skeleton className="h-11" />
								<Skeleton className="h-11" />
							</div>
						) : preview.isError ? (
							<div role="alert" className="flex items-start gap-2 rounded-lg bg-danger/10 px-3 py-2.5 text-[13px] text-danger">
								<CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
								<span className="min-w-0 flex-1">{errorMessage(preview.error)}</span>
								<Button type="button" size="sm" variant="outline" onClick={() => void preview.refetch()}>
									<RotateCw /> Retry
								</Button>
							</div>
						) : (files?.length ?? 0) === 0 ? (
							<p className="rounded-lg bg-surface-2 px-3 py-2 text-[13px] text-muted-foreground">The executor's bundle contains no files.</p>
						) : (
							<>
								<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
									<p className="tabular text-[13px] font-medium" aria-live="polite">
										{summary}
									</p>
									<div className="flex items-center gap-1 sm:ml-auto">
										<Button type="button" size="sm" variant="ghost" onClick={() => setSelected(new Set((files ?? []).filter((f) => f.status === "new" || f.status === "update").map((f) => f.path)))}>
											Select all
										</Button>
										<Button type="button" size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
											Select none
										</Button>
									</div>
								</div>
								<div role="group" aria-label="Filter by status" className="flex flex-wrap gap-1.5">
									<FilterChip active={filter === null} onClick={() => setFilter(null)}>
										All {files?.length}
									</FilterChip>
									{STATUS_ORDER.filter((s) => counts[s] > 0).map((s) => (
										<FilterChip key={s} active={filter === s} onClick={() => setFilter(filter === s ? null : s)}>
											{STATUS_META[s].label} {counts[s]}
										</FilterChip>
									))}
								</div>
								<p className="text-2xs text-subtle">“Select all” picks new and updated files. Conflicts are never selected for you.</p>
								<ul className="scrollbar-thin max-h-[40dvh] min-h-24 overflow-y-auto rounded-lg shadow-[inset_0_0_0_1px_var(--border)]" aria-label="Files">
									{visible.map((row) => (
										<FileRow key={row.path} row={row} checked={selected.has(row.path)} diff={preview.data?.diffs[row.path]} onToggle={() => toggle(row.path)} />
									))}
								</ul>
								{overwriting > 0 ? (
									<p role="status" className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
										<TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
										{overwriting} locally changed {overwriting === 1 ? "file" : "files"} will be overwritten.
									</p>
								) : null}
							</>
						)}

						{apply.error ? (
							<p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
								{errorMessage(apply.error)}
							</p>
						) : null}
						<DialogFooter className="sticky bottom-0 -mx-1 bg-overlay px-1 pt-1">
							<Button variant="ghost" onClick={onClose} disabled={apply.isPending}>
								Cancel
							</Button>
							<Button variant="primary" loading={apply.isPending} disabled={!projectId || !preview.isSuccess || chosen.length === 0} onClick={submit}>
								Apply {chosen.length} {chosen.length === 1 ? "file" : "files"}
							</Button>
						</DialogFooter>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
	return (
		<button
			type="button"
			aria-pressed={active}
			onClick={onClick}
			className={cn(
				"inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-medium capitalize outline-none transition-colors focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:h-10",
				active ? "bg-accent-soft text-accent" : "bg-surface-2 text-muted-foreground hover:text-foreground",
			)}
		>
			{children}
		</button>
	);
}
