import type { Project } from "@clam/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, ArrowDown, ArrowUp, Check, CloudDownload, FolderGit2, GitBranch, Plus, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { useDebounced } from "@/features/projects/session-list";
import { errorMessage } from "@/lib/api";
import { useWorkspaces } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { cn, relativeTime } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty-state";
import { PageContainer, PageHeader } from "@/ui/page";
import { Skeleton } from "@/ui/skeleton";
import { type GitOverviewEntry, useOverview } from "./hooks.ts";

function EntryRow({ entry, workspace, onOpen }: { entry: GitOverviewEntry; workspace?: string; onOpen: (p: Project) => void }) {
	const { project, status, error } = entry;
	const dirty = status?.files.length ?? 0;
	return (
		<li>
			<button
				type="button"
				onClick={() => onOpen(project)}
				className="group grid w-full grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1.5 border-b px-3 py-3 text-left outline-none transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:shadow-[inset_0_0_0_2px_var(--accent)] sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto_auto_auto] sm:px-4"
			>
				<span className="flex min-w-0 flex-col gap-0.5">
					<span className="flex min-w-0 items-center gap-2">
						<FolderGit2 aria-hidden className="size-4 shrink-0 text-subtle" />
						<span className="truncate text-[13px] font-medium">{project.name}</span>
						{workspace ? <span className="hidden shrink-0 text-2xs text-subtle sm:inline">{workspace}</span> : null}
					</span>
					<span className="truncate pl-6 font-mono text-2xs text-subtle" title={project.path}>
						{project.repository ? `${project.repository.owner}/${project.repository.name}` : project.path}
					</span>
				</span>
				{error ? (
					<span className="col-span-2 flex min-w-0 items-center gap-2 text-xs text-danger sm:col-span-4 sm:col-start-2">
						<AlertTriangle aria-hidden className="size-3.5 shrink-0" />
						<span className="truncate">{error}</span>
					</span>
				) : !status || !status.isRepo ? (
					<span className="col-span-2 text-xs text-subtle sm:col-span-4 sm:col-start-2">Not a Git repository</span>
				) : (
					<>
						<span className="flex min-w-0 items-center gap-1.5 sm:order-none">
							<Badge variant="neutral" className="max-w-full">
								<GitBranch aria-hidden />
								<span className="truncate font-mono">{status.branch ?? (status.detached ? `detached ${status.headSha?.slice(0, 7) ?? ""}` : "—")}</span>
							</Badge>
							{status.ahead > 0 ? (
								<Badge variant="accent" className="tabular">
									<ArrowUp aria-hidden />
									{status.ahead}
								</Badge>
							) : null}
							{status.behind > 0 ? (
								<Badge variant="warning" className="tabular">
									<ArrowDown aria-hidden />
									{status.behind}
								</Badge>
							) : null}
						</span>
						<span className="flex items-center justify-end">
							{dirty > 0 ? (
								<Badge variant="warning" className="tabular">
									{dirty} changed
								</Badge>
							) : (
								<Badge variant="success">
									<Check aria-hidden /> clean
								</Badge>
							)}
						</span>
						<span className="hidden items-center justify-end gap-1 text-2xs text-subtle sm:flex" title={status.lastFetchedAt ?? "Never fetched"}>
							<CloudDownload aria-hidden className="size-3.5" />
							{status.lastFetchedAt ? relativeTime(status.lastFetchedAt) : "never fetched"}
						</span>
						<span className={cn("hidden text-subtle transition-transform group-hover:translate-x-0.5 sm:block")}>›</span>
					</>
				)}
			</button>
		</li>
	);
}

export default function GitPage() {
	const navigate = useNavigate();
	const openDialog = useUi((s) => s.openDialog);
	const q = useOverview();
	const workspaces = useWorkspaces();
	const [search, setSearch] = useState("");
	const needle = useDebounced(search).trim().toLowerCase();
	const wsNames = useMemo(() => new Map((workspaces.data ?? []).map((w) => [w.id, w.name] as const)), [workspaces.data]);

	const entries = useMemo(() => {
		const all = [...(q.data ?? [])].sort((a, b) => (b.status?.files.length ?? 0) - (a.status?.files.length ?? 0) || a.project.name.localeCompare(b.project.name));
		if (!needle) return all;
		return all.filter((e) => `${e.project.name} ${e.project.path} ${e.status?.branch ?? ""}`.toLowerCase().includes(needle));
	}, [q.data, needle]);

	const open = (p: Project) => void navigate({ to: "/projects/$projectId", params: { projectId: p.id }, search: { tab: "git" } });

	return (
		<PageContainer wide>
			<PageHeader
				title="Git"
				description="Branch, sync state and local changes of every project on this node."
				actions={
					<>
						<Button variant="outline" onClick={() => void q.refetch()} disabled={q.isFetching} aria-label="Refresh">
							<RefreshCw className={cn(q.isFetching && "animate-spin")} /> Refresh
						</Button>
						<Button variant="primary" onClick={() => openDialog({ kind: "create-project", mode: "clone" })}>
							<Plus /> Clone repository
						</Button>
					</>
				}
			/>
			<input
				value={search}
				onChange={(e) => setSearch(e.target.value)}
				placeholder="Search projects or branches"
				aria-label="Search projects"
				className="h-8 w-full max-w-md rounded-lg bg-surface-1 px-3 text-[13px] shadow-[inset_0_0_0_1px_var(--border-strong)] outline-none placeholder:text-subtle focus-visible:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_3px_var(--accent-soft)] coarse:h-11"
			/>
			<div className="overflow-hidden rounded-xl bg-surface-1 shadow-[inset_0_0_0_1px_var(--border)]">
				{q.isPending ? (
					<div className="flex flex-col gap-px p-2" aria-busy>
						{Array.from({ length: 5 }, (_, i) => (
							<Skeleton key={i} className="h-14" />
						))}
					</div>
				) : q.error ? (
					<EmptyState
						icon={FolderGit2}
						title="Could not load git overview"
						description={errorMessage(q.error)}
						action={
							<Button size="sm" variant="outline" onClick={() => void q.refetch()}>
								<RefreshCw /> Retry
							</Button>
						}
					/>
				) : entries.length === 0 ? (
					<EmptyState
						icon={FolderGit2}
						title={needle ? "No matching projects" : "No projects yet"}
						description={needle ? "Try a different search." : "Clone a GitHub repository or add a local directory to see its Git state here."}
						action={
							needle ? undefined : (
								<Button variant="primary" size="sm" onClick={() => openDialog({ kind: "create-project", mode: "clone" })}>
									<Plus /> Clone repository
								</Button>
							)
						}
					/>
				) : (
					<ul>
						{entries.map((e) => (
							<EntryRow key={e.project.id} entry={e} workspace={wsNames.get(e.project.workspaceId)} onOpen={open} />
						))}
					</ul>
				)}
			</div>
		</PageContainer>
	);
}
