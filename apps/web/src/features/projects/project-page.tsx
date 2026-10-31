import { type AgentSession, type Project, routes } from "@clam/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { Check, FileCode2, FolderGit2, FolderTree, GitBranch, MessageSquare, MoreHorizontal, Pencil, Plus, RefreshCw, Search, Send, Trash2, X } from "lucide-react";
import { type KeyboardEvent, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyButton } from "@/components/code-block";
import { useGitStatus } from "@/features/git/hooks";
import { ApiError, api, errorMessage } from "@/lib/api";
import { qk, useProject, useSessions } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { cn, relativeTime } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/ui/dropdown-menu";
import { EmptyState } from "@/ui/empty-state";
import { Skeleton } from "@/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";
import { Tip } from "@/ui/tooltip";
import { FileExplorer } from "./file-explorer.tsx";
import { FileViewer } from "./file-viewer.tsx";
import { SessionList, SessionSkeletonRows, useDebounced } from "./session-list.tsx";

const GitWorkbench = lazy(() => import("@/features/git/git-panel.tsx"));

const mqWide = typeof matchMedia === "function" ? matchMedia("(min-width: 1024px)") : null;
function useIsWide(): boolean {
	return useSyncExternalStore(
		(cb) => {
			mqWide?.addEventListener("change", cb);
			return () => mqWide?.removeEventListener("change", cb);
		},
		() => mqWide?.matches ?? true,
		() => true,
	);
}

export default function ProjectPage() {
	const { projectId } = useParams({ strict: false }) as { projectId: string };
	const { file, tab } = useSearch({ strict: false }) as { file?: string; tab?: "git" };
	const navigate = useNavigate();
	const project = useProject(projectId);
	const wide = useIsWide();

	const openFile = useCallback(
		(path: string) => void navigate({ to: "/projects/$projectId", params: { projectId }, search: { file: path, tab: undefined } }),
		[navigate, projectId],
	);
	const closeFile = useCallback(() => void navigate({ to: "/projects/$projectId", params: { projectId }, search: { file: undefined, tab: undefined }, replace: true }), [navigate, projectId]);
	const setTab = useCallback(
		(next: "workspace" | "git") => void navigate({ to: "/projects/$projectId", params: { projectId }, search: { file: undefined, tab: next === "git" ? "git" : undefined }, replace: true }),
		[navigate, projectId],
	);

	if (project.isPending) return <ProjectSkeleton />;
	if (project.error) {
		const notFound = project.error instanceof ApiError && project.error.status === 404;
		return (
			<div className="grid h-full place-items-center">
				<EmptyState
					icon={FolderGit2}
					title={notFound ? "Project not found" : "Could not load project"}
					description={notFound ? "It may have been deleted from this node." : errorMessage(project.error)}
					action={
						notFound ? (
							<Button asChild variant="outline" size="sm">
								<Link to="/node/projects">Browse projects</Link>
							</Button>
						) : (
							<Button variant="outline" size="sm" onClick={() => void project.refetch()}>
								<RefreshCw /> Retry
							</Button>
						)
					}
				/>
			</div>
		);
	}

	const p = project.data;
	return (
		<div className="flex h-full min-h-0 flex-col">
			<ProjectHeader project={p} compact={tab === "git" && !wide} />
			<ProjectTabs projectId={p.id} tab={tab === "git" ? "git" : "workspace"} onChange={setTab} />
			{tab === "git" ? (
				<div className="min-h-0 flex-1">
					<Suspense fallback={<GitTabSkeleton />}>
						<GitWorkbench projectId={p.id} />
					</Suspense>
				</div>
			) : wide ? (
				<PanelGroup direction="horizontal" autoSaveId="clam.project.cols" className="min-h-0 flex-1">
					<Panel id="threads" order={1} defaultSize={30} minSize={22} maxSize={48} className="min-w-0">
						<ThreadsPane projectId={p.id} />
					</Panel>
					<PanelResizeHandle aria-label="Resize threads pane" />
					<Panel id="files" order={2} minSize={40} className="min-w-0">
						<PanelGroup direction="horizontal" autoSaveId="clam.project.files" className="h-full">
							<Panel id="explorer" order={1} defaultSize={32} minSize={20} maxSize={60} className="min-w-0">
								<FileExplorer projectId={p.id} selectedPath={file ?? null} onOpenFile={openFile} />
							</Panel>
							<PanelResizeHandle aria-label="Resize file explorer" />
							<Panel id="viewer" order={2} minSize={30} className="min-w-0">
								{file ? (
									<FileViewer key={file} projectId={p.id} path={file} onClose={closeFile} />
								) : (
									<EmptyState icon={FileCode2} title="No file open" description="Pick a file from the tree to view it here. The open file is kept in the URL." className="h-full" />
								)}
							</Panel>
						</PanelGroup>
					</Panel>
				</PanelGroup>
			) : (
				<CompactLayout project={p} file={file} onOpenFile={openFile} onCloseFile={closeFile} />
			)}
		</div>
	);
}

// ───────────────────────────── tabs ─────────────────────────────

function ProjectTabs({ projectId, tab, onChange }: { projectId: string; tab: "workspace" | "git"; onChange: (t: "workspace" | "git") => void }) {
	const status = useGitStatus(projectId).data;
	const dirty = status?.isRepo ? status.files.length : 0;
	const items = [
		{ id: "workspace" as const, label: "Workspace", icon: FolderTree },
		{ id: "git" as const, label: "Git", icon: GitBranch },
	];
	return (
		<div role="tablist" aria-label="Project views" className="flex shrink-0 items-center gap-1 border-b bg-surface-1/40 px-3 py-1.5 sm:px-4">
			{items.map(({ id, label, icon: Icon }) => (
				<button
					key={id}
					type="button"
					role="tab"
					aria-selected={tab === id}
					onClick={() => onChange(id)}
					className={cn(
						"inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium outline-none transition-colors focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:h-11",
						tab === id ? "bg-surface-3 text-foreground" : "text-muted-foreground hover:bg-surface-2 hover:text-foreground",
					)}
				>
					<Icon className="size-4" aria-hidden />
					{label}
					{id === "git" && dirty > 0 ? <span className="tabular rounded bg-accent-soft px-1.5 font-mono text-2xs text-accent">{dirty}</span> : null}
					{id === "git" && status?.isRepo && (status.ahead > 0 || status.behind > 0) ? (
						<span className="tabular font-mono text-2xs text-subtle">
							{status.ahead > 0 ? `↑${status.ahead}` : ""}
							{status.behind > 0 ? `↓${status.behind}` : ""}
						</span>
					) : null}
				</button>
			))}
		</div>
	);
}

function GitTabSkeleton() {
	return (
		<div className="flex h-full flex-col gap-3 p-3" aria-busy aria-label="Loading git">
			<Skeleton className="h-8 w-2/3" />
			<Skeleton className="h-6" />
			<Skeleton className="h-6 w-5/6" />
		</div>
	);
}

// ───────────────────────────── compact (tablet / mobile) ─────────────────────────────

function CompactLayout({ project, file, onOpenFile, onCloseFile }: { project: Project; file?: string; onOpenFile: (p: string) => void; onCloseFile: () => void }) {
	const [tab, setTab] = useState("threads");
	// A file appearing in the URL (opened or deep-linked) shows the viewer; closing/back returns to the tree.
	useEffect(() => {
		setTab((t) => (file ? "viewer" : t === "viewer" ? "files" : t));
	}, [file]);

	return (
		<Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
			<div className="shrink-0 border-b px-3 py-2">
				<TabsList className="w-full">
					<TabsTrigger value="threads" className="flex-1">
						<MessageSquare /> Threads
					</TabsTrigger>
					<TabsTrigger value="files" className="flex-1">
						<FolderTree /> Files
					</TabsTrigger>
					{file ? (
						<TabsTrigger value="viewer" className="flex-1">
							<FileCode2 /> Viewer
						</TabsTrigger>
					) : null}
				</TabsList>
			</div>
			<TabsContent value="threads" className="min-h-0 flex-1">
				<ThreadsPane projectId={project.id} />
			</TabsContent>
			<TabsContent value="files" className="min-h-0 flex-1">
				<FileExplorer projectId={project.id} selectedPath={file ?? null} onOpenFile={onOpenFile} />
			</TabsContent>
			{file ? (
				<TabsContent value="viewer" className="min-h-0 flex-1">
					<FileViewer key={file} projectId={project.id} path={file} onClose={onCloseFile} />
				</TabsContent>
			) : null}
		</Tabs>
	);
}

// ───────────────────────────── header ─────────────────────────────

function ProjectHeader({ project, compact }: { project: Project; compact?: boolean }) {
	const qc = useQueryClient();
	const navigate = useNavigate();
	const openDialog = useUi((s) => s.openDialog);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(project.name);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (editing) inputRef.current?.select();
	}, [editing]);

	const rename = useMutation({
		mutationFn: (name: string) => api.patch<Project>(routes.project(project.id), { name }),
		onMutate: async (name) => {
			await qc.cancelQueries({ queryKey: qk.project(project.id) });
			const prev = qc.getQueryData<Project>(qk.project(project.id));
			qc.setQueryData<Project>(qk.project(project.id), (p) => (p ? { ...p, name } : p));
			return { prev };
		},
		onError: (e, _n, ctx) => {
			if (ctx?.prev) qc.setQueryData(qk.project(project.id), ctx.prev);
			toast.error("Could not rename project", { description: errorMessage(e) });
		},
		onSuccess: (next) => qc.setQueryData(qk.project(project.id), next),
		onSettled: () => void qc.invalidateQueries({ queryKey: qk.projectsAll }),
	});

	const del = useMutation({
		mutationFn: () => api.delete(routes.project(project.id)),
		onSuccess: () => {
			toast.success(`Deleted ${project.name}`);
			qc.removeQueries({ queryKey: qk.project(project.id) });
			void qc.invalidateQueries({ queryKey: qk.projectsAll });
			void qc.invalidateQueries({ queryKey: qk.workspaces });
			void qc.invalidateQueries({ queryKey: qk.sessionsAll });
			void navigate({ to: "/workspaces/$workspaceId", params: { workspaceId: project.workspaceId } });
		},
		onError: (e) => {
			setConfirmDelete(false);
			toast.error("Could not delete project", { description: errorMessage(e) });
		},
	});

	const commit = () => {
		const name = draft.trim();
		setEditing(false);
		if (name && name !== project.name) rename.mutate(name);
		else setDraft(project.name);
	};
	const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter") commit();
		else if (e.key === "Escape") {
			setEditing(false);
			setDraft(project.name);
		}
	};
	const repo = project.repository;

	return (
		<header className="shrink-0 border-b bg-surface-1/60 px-4 py-3 sm:px-5">
			<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<div className="flex min-w-0 items-center gap-1.5">
						{editing ? (
							<>
								<input
									ref={inputRef}
									value={draft}
									maxLength={80}
									aria-label="Project name"
									onChange={(e) => setDraft(e.target.value)}
									onKeyDown={onKey}
									onBlur={commit}
									className="h-8 min-w-0 flex-1 rounded-md bg-surface-2 px-2 text-lg font-semibold tracking-tight outline-none shadow-[inset_0_0_0_1px_var(--accent)] sm:max-w-md"
								/>
								<Button variant="ghost" size="icon-sm" aria-label="Save name" onMouseDown={(e) => e.preventDefault()} onClick={commit}>
									<Check />
								</Button>
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label="Cancel rename"
									onMouseDown={(e) => e.preventDefault()}
									onClick={() => {
										setEditing(false);
										setDraft(project.name);
									}}
								>
									<X />
								</Button>
							</>
						) : (
							<>
								<h1 className="truncate text-lg font-semibold tracking-tight">{project.name}</h1>
								<Tip label="Rename project">
									<Button
										variant="ghost"
										size="icon-sm"
										aria-label="Rename project"
										onClick={() => {
											setDraft(project.name);
											setEditing(true);
										}}
									>
										<Pencil />
									</Button>
								</Tip>
							</>
						)}
					</div>
					<div className={cn("flex min-w-0 items-center gap-0.5", compact && "hidden")}>
						<span className="truncate font-mono text-xs text-muted-foreground" title={project.path}>
							{project.path}
						</span>
						<CopyButton text={project.path} label="Copy path" className="size-6" />
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<Button variant="primary" onClick={() => openDialog({ kind: "create-session", projectId: project.id })}>
						<Plus /> New session
					</Button>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button variant="outline" size="icon" aria-label="Project actions">
								<MoreHorizontal />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent>
							<DropdownMenuItem disabled={!project.repository} onSelect={() => openDialog({ kind: "delegate-task", projectId: project.id, workspaceId: project.workspaceId })}>
								<Send /> Delegate a task…
							</DropdownMenuItem>
							<DropdownMenuItem danger onSelect={() => setConfirmDelete(true)}>
								<Trash2 /> Delete project…
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>

			<div className={cn("mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground", compact && "hidden")}>
				{repo ? (
					<a
						href={repo.htmlUrl}
						target="_blank"
						rel="noreferrer noopener"
						className="inline-flex min-w-0 items-center gap-1.5 rounded-md bg-surface-2 px-2 py-1 outline-none transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:shadow-[0_0_0_2px_var(--accent)]"
					>
						<GitBranch className="size-3.5 shrink-0" />
						<span className="truncate font-mono">
							{repo.owner}/{repo.name}
						</span>
						{repo.defaultBranch ? <Badge variant="outline">{repo.defaultBranch}</Badge> : null}
						{repo.accountId ? <span className="hidden font-mono text-2xs text-subtle sm:inline">acct {repo.accountId.slice(0, 8)}</span> : null}
					</a>
				) : (
					<span className="inline-flex items-center gap-1.5 text-subtle">
						<GitBranch className="size-3.5" />
						No repository linked
						<span className="hidden sm:inline">
							· link one from{" "}
							<Link to="/settings/github" className="text-muted-foreground underline underline-offset-2 hover:text-foreground">
								Settings → GitHub Accounts
							</Link>
						</span>
					</span>
				)}
				<span className="tabular">
					{project.sessionCount} {project.sessionCount === 1 ? "session" : "sessions"}
				</span>
				<span className="tabular">Last activity {project.lastActivityAt ? relativeTime(project.lastActivityAt) : "—"}</span>
			</div>

			<ConfirmDialog
				open={confirmDelete}
				onOpenChange={setConfirmDelete}
				title="Delete project?"
				description={
					<>
						<span className="font-medium text-foreground">{project.name}</span> and its {project.sessionCount} {project.sessionCount === 1 ? "session" : "sessions"} will be removed from CL Agent Mesh. Files on disk are not touched.
					</>
				}
				confirmLabel="Delete project"
				danger
				loading={del.isPending}
				onConfirm={() => del.mutate()}
			/>
		</header>
	);
}

// ───────────────────────────── threads ─────────────────────────────

type ThreadFilter = "all" | "running" | "archived";
const FILTERS: Array<{ id: ThreadFilter; label: string }> = [
	{ id: "all", label: "All" },
	{ id: "running", label: "Running" },
	{ id: "archived", label: "Archived" },
];

function ThreadsPane({ projectId }: { projectId: string }) {
	const openDialog = useUi((s) => s.openDialog);
	const [filter, setFilter] = useState<ThreadFilter>("all");
	const [search, setSearch] = useState("");
	const debounced = useDebounced(search);

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex shrink-0 flex-col gap-2 border-b p-2.5">
				<div className="flex items-center gap-2">
					<div className="relative min-w-0 flex-1">
						<Search aria-hidden className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
						<input
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							placeholder="Search threads"
							aria-label="Search threads"
							className="h-8 w-full rounded-lg bg-surface-2 pl-7 pr-2 text-[13px] outline-none placeholder:text-subtle focus-visible:shadow-[inset_0_0_0_1px_var(--accent)] coarse:h-11"
						/>
					</div>
				</div>
				<div role="group" aria-label="Thread filter" className="flex gap-1">
					{FILTERS.map((f) => (
						<button
							key={f.id}
							type="button"
							aria-pressed={filter === f.id}
							onClick={() => setFilter(f.id)}
							className={cn(
								"h-7 rounded-md px-2.5 text-xs font-medium outline-none transition-colors coarse:h-10 coarse:px-3.5",
								filter === f.id ? "bg-surface-3 text-foreground" : "text-muted-foreground hover:bg-surface-2 hover:text-foreground",
							)}
						>
							{f.label}
						</button>
					))}
				</div>
			</div>
			<div className="min-h-0 flex-1">
				<ThreadsList
					key={filter === "archived" ? "archived" : "active"}
					projectId={projectId}
					archived={filter === "archived"}
					running={filter === "running"}
					search={debounced}
					onNew={() => openDialog({ kind: "create-session", projectId })}
				/>
			</div>
		</div>
	);
}

function ThreadsList({ projectId, archived, running, search, onNew }: { projectId: string; archived: boolean; running: boolean; search: string; onNew: () => void }) {
	const q = useSessions({ projectId, archived });
	const needle = search.trim().toLowerCase();
	const visible = useMemo<AgentSession[]>(() => {
		const all = q.data ?? [];
		return all
			.filter((s) => (!running || s.status === "running") && (!needle || s.title.toLowerCase().includes(needle) || (s.model ?? "").toLowerCase().includes(needle)))
			.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
	}, [q.data, running, needle]);

	if (q.isPending) return <SessionSkeletonRows />;
	if (q.error) {
		return (
			<EmptyState
				icon={MessageSquare}
				title="Could not load threads"
				description={errorMessage(q.error)}
				action={
					<Button size="sm" variant="outline" onClick={() => void q.refetch()}>
						<RefreshCw /> Retry
					</Button>
				}
			/>
		);
	}
	const filtered = running || needle !== "";
	return (
		<SessionList
			sessions={visible}
			empty={
				<EmptyState
					icon={MessageSquare}
					title={filtered ? "No matching threads" : archived ? "No archived threads" : "No threads yet"}
					description={filtered ? "Try a different filter or search." : archived ? "Archived threads show up here." : "Start a session to have an agent work in this project."}
					action={
						!archived && !filtered ? (
							<Button variant="primary" size="sm" onClick={onNew}>
								<Plus /> New session
							</Button>
						) : undefined
					}
				/>
			}
		/>
	);
}

function ProjectSkeleton() {
	return (
		<div className="flex h-full flex-col" aria-busy>
			<div className="flex flex-col gap-2 border-b px-5 py-4">
				<Skeleton className="h-6 w-56" />
				<Skeleton className="h-3.5 w-80 max-w-full" />
				<Skeleton className="mt-1 h-6 w-64 max-w-full" />
			</div>
			<div className="flex min-h-0 flex-1">
				<div className="w-full flex-1 lg:w-1/3 lg:flex-none lg:border-r">
					<SessionSkeletonRows count={8} />
				</div>
				<div className="hidden flex-1 flex-col gap-2 p-4 lg:flex">
					{Array.from({ length: 10 }, (_, i) => (
						<Skeleton key={i} className="h-5" style={{ width: `${40 + ((i * 17) % 50)}%` }} />
					))}
				</div>
			</div>
		</div>
	);
}
