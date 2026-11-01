import { type AgentSession, type Project, routes } from "@clam/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { BookMarked, Check, Folder, FolderGit2, FolderTree, GitBranch, MessageSquare, MoreHorizontal, Pencil, Plus, RefreshCw, Search, Send, Terminal, Trash2, X } from "lucide-react";
import { type KeyboardEvent, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyButton } from "@/components/code-block";
import { useGitStatus } from "@/features/git/hooks";
import { msg, t, T, tr, type Msg } from "@/i18n";
import { ApiError, api, errorText } from "@/lib/api";
import { qk, useProject, useSessions } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { cn, relativeTime } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/ui/dropdown-menu";
import { EmptyState } from "@/ui/empty-state";
import { Skeleton } from "@/ui/skeleton";
import { Tip } from "@/ui/tooltip";
import { QuickLookHost, useQuickLook } from "./use-quick-look.tsx";
import { SessionList, SessionSkeletonRows, useDebounced } from "./session-list.tsx";

const GitWorkbench = lazy(() => import("@/features/git/git-panel.tsx"));
const ProjectContextTab = lazy(() => import("@/features/context/project-context-tab.tsx"));
const FileBrowser = lazy(() => import("./file-browser.tsx"));

type ProjectTab = "sessions" | "files" | "git" | "context";

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
	const { tab: rawTab } = useSearch({ strict: false }) as { tab?: "files" | "git" | "context" };
	const navigate = useNavigate();
	const project = useProject(projectId);
	const wide = useIsWide();
	const ql = useQuickLook();
	// A plain-folder project has no Git view: a stale `?tab=git` falls back to the sessions view.
	const stored = rawTab === "git" && project.data?.vcs === "none" ? undefined : rawTab;
	// Links from before the Files tab (`?file=…` on the workspace view) land on Files with the file open in Quick Look.
	const tab: ProjectTab = stored ?? (ql.file ? "files" : "sessions");

	useEffect(() => {
		if (ql.file && !rawTab) void navigate({ to: "/projects/$projectId", params: { projectId }, search: (prev) => ({ ...prev, tab: "files" as const }), replace: true });
	}, [ql.file, rawTab, navigate, projectId]);
	const setTab = useCallback(
		(next: ProjectTab) => void navigate({ to: "/projects/$projectId", params: { projectId }, search: { file: undefined, tab: next === "sessions" ? undefined : next }, replace: true }),
		[navigate, projectId],
	);

	if (project.isPending) return <ProjectSkeleton />;
	if (project.error) {
		const notFound = project.error instanceof ApiError && project.error.status === 404;
		return (
			<div className="grid h-full place-items-center">
				<EmptyState
					icon={FolderGit2}
					title={notFound ? t("Project not found") : t("Could not load project")}
					description={notFound ? t("It may have been deleted from this machine.") : errorText(project.error)}
					action={
						notFound ? (
							<Button asChild variant="outline" size="sm">
								<Link to="/node/projects">{t("Browse projects")}</Link>
							</Button>
						) : (
							<Button variant="outline" size="sm" onClick={() => void project.refetch()}>
								<RefreshCw /> {t("Retry")}
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
			<ProjectTabs projectId={p.id} vcs={p.vcs} tab={tab} onChange={setTab} />
			{tab === "context" ? (
				<div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-contain">
					<div className="mx-auto w-full max-w-4xl px-4 py-4 sm:px-6 sm:py-5">
						<Suspense fallback={<GitTabSkeleton />}>
							<ProjectContextTab project={p} />
						</Suspense>
					</div>
				</div>
			) : tab === "git" ? (
				<div className="min-h-0 flex-1">
					<Suspense fallback={<GitTabSkeleton />}>
						<GitWorkbench projectId={p.id} />
					</Suspense>
				</div>
			) : tab === "files" ? (
				<div className="min-h-0 flex-1">
					<Suspense fallback={<GitTabSkeleton />}>
						<FileBrowser projectId={p.id} openPath={ql.file} onOpenFile={ql.open} />
					</Suspense>
				</div>
			) : (
				<div className="min-h-0 flex-1">
					<div className="h-full max-w-[60rem]">
						<ThreadsPane projectId={p.id} />
					</div>
				</div>
			)}
			<QuickLookHost projectId={p.id} ql={ql} />
		</div>
	);
}

// ───────────────────────────── tabs ─────────────────────────────

function ProjectTabs({ projectId, vcs, tab, onChange }: { projectId: string; vcs: Project["vcs"]; tab: ProjectTab; onChange: (t: ProjectTab) => void }) {
	const status = useGitStatus(projectId, { enabled: vcs === "git" }).data;
	const dirty = status?.isRepo ? status.files.length : 0;
	const items = [
		{ id: "sessions" as const, label: t("Sessions"), icon: MessageSquare },
		{ id: "files" as const, label: t("Files"), icon: FolderTree },
		...(vcs === "git" ? [{ id: "git" as const, label: t("Git"), icon: GitBranch }] : []),
		{ id: "context" as const, label: t("Context"), icon: BookMarked },
	];
	return (
		<div role="tablist" aria-label={t("Project views")} className="flex shrink-0 items-center gap-1 border-b bg-surface-1/40 px-3 py-1.5 sm:px-4">
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
		<div className="flex h-full flex-col gap-3 p-3" aria-busy aria-label={t("Loading git")}>
			<Skeleton className="h-8 w-2/3" />
			<Skeleton className="h-6" />
			<Skeleton className="h-6 w-5/6" />
		</div>
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
	// Managed folders only: deleting the project never touches files unless this is ticked explicitly.
	const [deleteFiles, setDeleteFiles] = useState(false);
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
			toast.error(t("Could not rename project"), { description: errorText(e) });
		},
		onSuccess: (next) => qc.setQueryData(qk.project(project.id), next),
		onSettled: () => void qc.invalidateQueries({ queryKey: qk.projectsAll }),
	});

	const del = useMutation({
		mutationFn: () => api.delete(`${routes.project(project.id)}${project.managed && deleteFiles ? "?deleteFiles=true" : ""}`),
		onSuccess: () => {
			toast.success(t("Deleted {name}", { name: project.name }));
			qc.removeQueries({ queryKey: qk.project(project.id) });
			void qc.invalidateQueries({ queryKey: qk.projectsAll });
			void qc.invalidateQueries({ queryKey: qk.workspaces });
			void qc.invalidateQueries({ queryKey: qk.sessionsAll });
			void navigate({ to: "/workspaces/$workspaceId", params: { workspaceId: project.workspaceId } });
		},
		onError: (e) => {
			setConfirmDelete(false);
			toast.error(t("Could not delete project"), { description: errorText(e) });
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
									aria-label={t("Project name")}
									onChange={(e) => setDraft(e.target.value)}
									onKeyDown={onKey}
									onBlur={commit}
									className="h-8 min-w-0 flex-1 rounded-md bg-surface-2 px-2 text-lg font-semibold tracking-tight outline-none shadow-[inset_0_0_0_1px_var(--accent)] sm:max-w-md"
								/>
								<Button variant="ghost" size="icon-sm" aria-label={t("Save name")} onMouseDown={(e) => e.preventDefault()} onClick={commit}>
									<Check />
								</Button>
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label={t("Cancel rename")}
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
								<Tip label={t("Rename project")}>
									<Button
										variant="ghost"
										size="icon-sm"
										aria-label={t("Rename project")}
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
						<CopyButton text={project.path} label={t("Copy path")} className="size-6" />
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<Button variant="primary" onClick={() => openDialog({ kind: "create-session", projectId: project.id })}>
						<Plus /> {t("New session")}
					</Button>
					<Tip label={t("Open terminal here")}>
						<Button asChild variant="outline" size="icon" aria-label={t("Open terminal here")}>
							<Link to="/terminal" search={{ project: project.id }}>
								<Terminal />
							</Link>
						</Button>
					</Tip>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button variant="outline" size="icon" aria-label={t("Project actions")}>
								<MoreHorizontal />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent>
							<DropdownMenuItem onSelect={() => openDialog({ kind: "delegate-task", projectId: project.id, workspaceId: project.workspaceId })}>
								<Send /> {t("Delegate a task…")}
							</DropdownMenuItem>
							<DropdownMenuItem danger onSelect={() => setConfirmDelete(true)}>
								<Trash2 /> {t("Delete project…")}
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
						{repo.accountId ? <span className="hidden font-mono text-2xs text-subtle sm:inline">{t("acct {id}", { id: repo.accountId.slice(0, 8) })}</span> : null}
					</a>
				) : project.vcs === "none" ? (
					<span className="inline-flex items-center gap-1.5 rounded-md bg-surface-2 px-2 py-1" title={t("Sessions, tasks and shared sessions work on the files directly; no repository is needed.")}>
						<Folder className="size-3.5" />
						{project.managed ? t("Managed folder") : t("Plain folder")}
						<span className="hidden text-subtle sm:inline">{t("· no Git repository")}</span>
					</span>
				) : (
					<span className="inline-flex items-center gap-1.5 text-subtle">
						<GitBranch className="size-3.5" />
						{t("Local Git repository · no GitHub remote linked")}
						<span className="hidden sm:inline">
							<T
								text="· link one from <l>Settings → GitHub Accounts</l>"
								tags={{ l: <Link to="/settings/github" className="text-muted-foreground underline underline-offset-2 hover:text-foreground" /> }}
							/>
						</span>
					</span>
				)}
				<span className="tabular">
					{t("{count, plural, one {# session} other {# sessions}}", { count: project.sessionCount })}
				</span>
				<span className="tabular">{t("Last activity {when}", { when: project.lastActivityAt ? relativeTime(project.lastActivityAt) : "—" })}</span>
			</div>

			<ConfirmDialog
				open={confirmDelete}
				onOpenChange={(o) => {
					setConfirmDelete(o);
					if (!o) setDeleteFiles(false);
				}}
				title={t("Delete project?")}
				description={
					<>
						<T
							text="<b>{name}</b> and its {count, plural, one {# session} other {# sessions}} will be removed from CL Agent Mesh."
							params={{ name: project.name, count: project.sessionCount }}
							tags={{ b: <span className="font-medium text-foreground" /> }}
						/>{" "}
						{project.managed ? t("The folder CL Agent Mesh created for it is kept unless you tick the box below.") : t("Files on disk are not touched.")}
					</>
				}
				confirmLabel={t("Delete project")}
				danger
				loading={del.isPending}
				onConfirm={() => del.mutate()}
			>
				{project.managed ? (
					<label className="flex min-h-[44px] cursor-pointer items-start gap-2.5 rounded-lg bg-danger/10 p-3 text-xs text-foreground">
						<input type="checkbox" checked={deleteFiles} onChange={(e) => setDeleteFiles(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--danger)]" />
						<span>
							{t("Also delete the folder and all its files")}
							<span className="mt-0.5 block font-mono text-2xs text-muted-foreground" title={project.path}>
								{project.path}
							</span>
							<span className="mt-0.5 block text-danger">{t("This cannot be undone.")}</span>
						</span>
					</label>
				) : null}
			</ConfirmDialog>
		</header>
	);
}

// ───────────────────────────── threads ─────────────────────────────

type ThreadFilter = "all" | "running" | "archived";
const FILTERS: Array<{ id: ThreadFilter; label: Msg }> = [
	{ id: "all", label: msg("All") },
	{ id: "running", label: msg("Running") },
	{ id: "archived", label: msg("Archived") },
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
							placeholder={t("Search threads")}
							aria-label={t("Search threads")}
							className="h-8 w-full rounded-lg bg-surface-2 pl-7 pr-2 text-[13px] outline-none placeholder:text-subtle focus-visible:shadow-[inset_0_0_0_1px_var(--accent)] coarse:h-11"
						/>
					</div>
				</div>
				<div role="group" aria-label={t("Thread filter")} className="flex gap-1">
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
							{tr(f.label)}
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
				title={t("Could not load threads")}
				description={errorText(q.error)}
				action={
					<Button size="sm" variant="outline" onClick={() => void q.refetch()}>
						<RefreshCw /> {t("Retry")}
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
					title={filtered ? t("No matching threads") : archived ? t("No archived threads") : t("No threads yet")}
					description={filtered ? t("Try a different filter or search.") : archived ? t("Archived threads show up here.") : t("Start a session to have an agent work in this project.")}
					action={
						!archived && !filtered ? (
							<Button variant="primary" size="sm" onClick={onNew}>
								<Plus /> {t("New session")}
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
			<SessionSkeletonRows count={8} />
		</div>
	);
}
