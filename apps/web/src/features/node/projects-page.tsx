import type { Project } from "@clam/contracts";
import { Link } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Folder, FolderGit2, GitBranch, MessageSquare, Plus, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDebounced } from "@/features/projects/session-list";
import { errorMessage } from "@/lib/api";
import { useProjects, useWorkspaces } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { relativeTime } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty-state";
import { PageHeader } from "@/ui/page";
import { Skeleton } from "@/ui/skeleton";

const CARD_H = 128;
const GAP = 12;

function columnsFor(width: number): number {
	return width >= 1000 ? 3 : width >= 640 ? 2 : 1;
}

export default function NodeProjectsPage() {
	const openDialog = useUi((s) => s.openDialog);
	const projects = useProjects();
	const workspaces = useWorkspaces();
	const [search, setSearch] = useState("");
	const needle = useDebounced(search).trim().toLowerCase();
	const wsNames = useMemo(() => new Map((workspaces.data ?? []).map((w) => [w.id, w.name] as const)), [workspaces.data]);

	const visible = useMemo(() => {
		// Chat folders belong to their chats (see Chats), not to the project list.
		const all = (projects.data ?? []).filter((p) => p.origin !== "chat").sort((a, b) => Date.parse(b.lastActivityAt ?? b.updatedAt) - Date.parse(a.lastActivityAt ?? a.updatedAt));
		if (!needle) return all;
		return all.filter(
			(p) =>
				p.name.toLowerCase().includes(needle) ||
				p.path.toLowerCase().includes(needle) ||
				(wsNames.get(p.workspaceId) ?? "").toLowerCase().includes(needle) ||
				(p.repository ? `${p.repository.owner}/${p.repository.name}`.toLowerCase().includes(needle) : false),
		);
	}, [projects.data, needle, wsNames]);

	const scrollRef = useRef<HTMLDivElement>(null);
	const [cols, setCols] = useState(1);
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const ro = new ResizeObserver(([entry]) => setCols(columnsFor(entry?.contentRect.width ?? 0)));
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	const rowCount = Math.ceil(visible.length / cols);
	const v = useVirtualizer({ count: rowCount, getScrollElement: () => scrollRef.current, estimateSize: () => CARD_H + GAP, overscan: 4 });

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="mx-auto flex w-full max-w-[1400px] shrink-0 flex-col gap-4 px-4 pt-5 sm:px-6 lg:px-8 lg:pt-7">
				<PageHeader
					title="Projects"
					description="Every project on this machine, across workspaces."
					actions={
						<Button variant="primary" onClick={() => openDialog({ kind: "create-project" })}>
							<Plus /> Add project
						</Button>
					}
				/>
				<div className="relative max-w-md">
					<Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
					<input
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder="Search name, path, workspace or repository"
						aria-label="Search projects"
						className="h-8 w-full rounded-lg bg-surface-1 pl-8 pr-3 text-[13px] shadow-[inset_0_0_0_1px_var(--border-strong)] outline-none placeholder:text-subtle focus-visible:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_3px_var(--accent-soft)] coarse:h-11"
					/>
				</div>
			</div>

			<div ref={scrollRef} className="scrollbar-thin mt-4 min-h-0 flex-1 overflow-y-auto overscroll-contain">
				<div className="mx-auto w-full max-w-[1400px] px-4 pb-6 sm:px-6 lg:px-8">
					{projects.isPending ? (
						<div aria-busy className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
							{Array.from({ length: 6 }, (_, i) => (
								<Skeleton key={i} className="rounded-xl" style={{ height: CARD_H }} />
							))}
						</div>
					) : projects.error ? (
						<EmptyState
							icon={FolderGit2}
							title="Could not load projects"
							description={errorMessage(projects.error)}
							action={
								<Button size="sm" variant="outline" onClick={() => void projects.refetch()}>
									<RefreshCw /> Retry
								</Button>
							}
						/>
					) : visible.length === 0 ? (
						<EmptyState
							icon={FolderGit2}
							title={needle ? "No matching projects" : "No projects yet"}
							description={needle ? "Try a different search." : "Add a local directory as a project to start running agents in it."}
							action={
								needle ? undefined : (
									<Button variant="primary" size="sm" onClick={() => openDialog({ kind: "create-project" })}>
										<Plus /> Add project
									</Button>
								)
							}
						/>
					) : (
						<ul className="relative w-full" style={{ height: v.getTotalSize() }}>
							{v.getVirtualItems().map((row) => (
								<li
									key={row.key}
									className="absolute inset-x-0 top-0 grid gap-3"
									style={{ height: CARD_H, transform: `translateY(${row.start}px)`, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
								>
									{visible.slice(row.index * cols, row.index * cols + cols).map((p) => (
										<ProjectCard key={p.id} project={p} workspaceName={wsNames.get(p.workspaceId)} />
									))}
								</li>
							))}
						</ul>
					)}
				</div>
			</div>
		</div>
	);
}

function ProjectCard({ project: p, workspaceName }: { project: Project; workspaceName?: string }) {
	return (
		<Link
			to="/projects/$projectId"
			params={{ projectId: p.id }}
			preload="intent"
			className="group flex h-full min-w-0 flex-col justify-between rounded-xl bg-surface-1 p-3.5 shadow-[inset_0_0_0_1px_var(--border)] outline-none transition-[background-color,box-shadow,transform] duration-150 hover:bg-surface-2 hover:shadow-[inset_0_0_0_1px_var(--border-strong)] focus-visible:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_3px_var(--accent-soft)] active:scale-[0.99]"
		>
			<div className="flex min-w-0 flex-col gap-1">
				<div className="flex items-center justify-between gap-2">
					<span className="truncate text-sm font-semibold tracking-tight">{p.name}</span>
					{workspaceName ? (
						<Badge variant="outline" className="max-w-[45%] shrink-0 truncate">
							{workspaceName}
						</Badge>
					) : null}
				</div>
				<span className="truncate font-mono text-xs text-muted-foreground" title={p.path}>
					{p.path}
				</span>
			</div>
			<div className="flex items-center justify-between gap-2 text-xs text-subtle">
				<div className="flex min-w-0 items-center gap-3">
					{p.repository ? (
						<Badge variant="neutral" className="min-w-0 gap-1">
							<GitBranch />
							<span className="truncate font-mono">
								{p.repository.owner}/{p.repository.name}
							</span>
						</Badge>
					) : p.vcs === "git" ? (
						<Badge variant="neutral" className="gap-1">
							<GitBranch /> Local Git
						</Badge>
					) : (
						<Badge variant="neutral" className="gap-1" title="No Git repository needed: sessions, tasks and shared sessions work on the folder.">
							<Folder /> {p.managed ? "Managed folder" : "Plain folder"}
						</Badge>
					)}
				</div>
				<div className="flex shrink-0 items-center gap-3 tabular">
					<span className="inline-flex items-center gap-1">
						<MessageSquare className="size-3" />
						{p.sessionCount}
					</span>
					<span>{p.lastActivityAt ? relativeTime(p.lastActivityAt) : "—"}</span>
				</div>
			</div>
		</Link>
	);
}
