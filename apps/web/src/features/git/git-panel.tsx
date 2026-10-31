import type { GitCommit, GitFileStatus, GitStatus } from "@clam/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { FolderGit2, GitCommitHorizontal, GitPullRequest, History, RefreshCw, Settings2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useBreakpoint } from "@/hooks/use-breakpoint";
import { errorMessage } from "@/lib/api";
import { useProject } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty-state";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/ui/sheet";
import { Skeleton } from "@/ui/skeleton";
import { type ChangeSelection, ChangesList } from "./changes-list.tsx";
import { CommitBox } from "./commit-box.tsx";
import { ConflictCheck } from "./conflict-check.tsx";
import { DiffPane, type DiffView } from "./diff-pane.tsx";
import { useGitStatus } from "./hooks.ts";
import { HistoryList } from "./history-list.tsx";
import { NoticeBanner } from "./notice-banner.tsx";
import { discardPaths, setStaged } from "./ops.ts";
import { CreatePullRequestDialog, PullRequestsPanel } from "./pull-requests.tsx";
import { RepoPanel } from "./repo-panel.tsx";
import { useGitUi } from "./store.ts";
import { type ChangeGroup, splitPath } from "./status-utils.ts";
import { GitToolbar } from "./toolbar.tsx";

type Tab = "changes" | "history" | "prs" | "repo";

export interface GitWorkbenchProps {
	projectId: string;
	/** Present when opened from an agent session: enables commit attribution. */
	sessionId?: string;
	className?: string;
}

function useElementWidth(): [React.RefObject<HTMLDivElement | null>, number] {
	const ref = useRef<HTMLDivElement>(null);
	const [w, setW] = useState(0);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const ro = new ResizeObserver(([e]) => setW(Math.round(e?.contentRect.width ?? 0)));
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	return [ref, w];
}

export default function GitWorkbench({ projectId, sessionId, className }: GitWorkbenchProps) {
	const status = useGitStatus(projectId, { live: true });
	if (status.isPending) {
		return (
			<div className={cn("flex h-full flex-col gap-3 p-3", className)} aria-busy aria-label="Loading git status">
				<Skeleton className="h-8 w-2/3" />
				<Skeleton className="h-6" />
				<Skeleton className="h-6 w-5/6" />
				<Skeleton className="h-6 w-4/6" />
			</div>
		);
	}
	if (status.error || !status.data) {
		return (
			<EmptyState
				className={cn("h-full", className)}
				icon={FolderGit2}
				title="Could not read git status"
				description={errorMessage(status.error)}
				action={
					<Button size="sm" variant="outline" onClick={() => void status.refetch()}>
						<RefreshCw /> Retry
					</Button>
				}
			/>
		);
	}
	if (!status.data.isRepo) {
		return (
			<EmptyState
				className={cn("h-full", className)}
				icon={FolderGit2}
				title="Not a Git repository"
				description="This project is a plain folder — no repository is needed. Sessions, tasks and shared sessions work with its files as they are. To use Git here, initialize a repository in the folder or clone a GitHub repository as a new project."
			/>
		);
	}
	return <Workbench projectId={projectId} sessionId={sessionId} status={status.data} className={className} />;
}

const TABS: Array<{ id: Tab; label: string; icon: typeof History }> = [
	{ id: "changes", label: "Changes", icon: GitCommitHorizontal },
	{ id: "history", label: "History", icon: History },
	{ id: "prs", label: "Pull requests", icon: GitPullRequest },
	{ id: "repo", label: "Repo", icon: Settings2 },
];

function defaultView(status: GitStatus): DiffView {
	const staged = status.files.some((f) => f.staged && f.kind !== "conflicted");
	const unstaged = status.files.some((f) => f.unstaged || f.kind === "untracked");
	return { kind: "changes", scope: staged && !unstaged ? "staged" : "unstaged", focus: null };
}

function Workbench({ projectId, sessionId, status, className }: GitWorkbenchProps & { status: GitStatus }) {
	const qc = useQueryClient();
	const project = useProject(projectId).data;
	const bp = useBreakpoint();
	const mobile = bp === "mobile";
	const [boxRef, width] = useElementWidth();
	// Desktop: resizable list | diff. Tablet: the diff opens as an overlay panel. Mobile: the diff is a pushed detail view.
	const split = bp === "desktop" && width >= 720;
	const compactBar = width > 0 && width < 520;

	const [tab, setTab] = useState<Tab>("changes");
	const [view, setView] = useState<DiffView>(() => defaultView(status));
	const [selected, setSelected] = useState<ChangeSelection | null>(null);
	const [detailOpen, setDetailOpen] = useState(false);
	const [prDialog, setPrDialog] = useState(false);
	const [branchOpen, setBranchOpen] = useState(false);
	const [discard, setDiscard] = useState<GitFileStatus[] | null>(null);
	const [discarding, setDiscarding] = useState(false);
	const commitRef = useRef<HTMLTextAreaElement>(null);
	const busy = useGitUi((s) => s.busy[projectId]);
	const working = busy !== null && busy !== undefined;

	// Palette → panel handoff (Commit / Create PR / Switch branch).
	const intent = useGitUi((s) => s.intent);
	const clearIntent = useGitUi((s) => s.clearIntent);
	useEffect(() => {
		if (!intent || intent.projectId !== projectId) return;
		clearIntent();
		if (intent.action === "commit") {
			setTab("changes");
			setDetailOpen(false);
			requestAnimationFrame(() => commitRef.current?.focus());
		} else if (intent.action === "create-pr") setPrDialog(true);
		else setBranchOpen(true);
	}, [intent, projectId, clearIntent]);

	const focusPath = useCallback(
		(path: string, scope: "unstaged" | "staged" | "head") => {
			setView({ kind: "changes", scope, focus: { path, nonce: Date.now() } });
			if (!split) setDetailOpen(true);
		},
		[split],
	);
	const onSelectFile = useCallback(
		(file: GitFileStatus, group: ChangeGroup) => {
			setSelected({ group, path: file.path });
			focusPath(file.path, group === "staged" ? "staged" : group === "conflicted" ? "head" : "unstaged");
		},
		[focusPath],
	);
	const onSelectCommit = useCallback(
		(c: GitCommit) => {
			setSelected(null);
			setView({ kind: "commit", sha: c.sha, shortSha: c.shortSha, subject: c.subject, focus: null });
			if (!split) setDetailOpen(true);
		},
		[split],
	);
	const onViewChange = useCallback((v: DiffView) => {
		setView(v);
		if (v.kind === "changes") setSelected(null);
	}, []);
	const onStage = useCallback((paths: string[], stage: boolean) => void setStaged(qc, projectId, paths, stage), [qc, projectId]);

	const confirmDiscard = async () => {
		if (!discard) return;
		setDiscarding(true);
		const ok = await discardPaths(
			qc,
			projectId,
			discard.map((f) => f.path),
		);
		setDiscarding(false);
		if (ok) setDiscard(null);
	};

	const changeCount = status.files.length;
	const list = (
		<div className="flex h-full min-h-0 flex-col">
			<div role="tablist" aria-label="Git sections" className="scrollbar-none flex shrink-0 items-center gap-0.5 overflow-x-auto border-b px-1.5 py-1.5">
				{TABS.map(({ id, label, icon: Icon }) => (
					<button
						key={id}
						type="button"
						role="tab"
						aria-selected={tab === id}
						onClick={() => setTab(id)}
						className={cn(
							"inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium outline-none transition-colors focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:h-10",
							tab === id ? "bg-surface-3 text-foreground" : "text-muted-foreground hover:bg-surface-2 hover:text-foreground",
						)}
					>
						<Icon className="size-3.5" aria-hidden />
						{label}
						{id === "changes" && changeCount > 0 ? <span className="tabular rounded bg-accent-soft px-1 font-mono text-2xs text-accent">{changeCount}</span> : null}
					</button>
				))}
			</div>
			<div className="min-h-0 flex-1">
				{tab === "changes" ? (
					<div className="flex h-full min-h-0 flex-col">
						<ConflictCheck projectId={projectId} status={status} />
						<ChangesList
							status={status}
							selected={selected}
							disabled={working}
							onSelect={onSelectFile}
							onStage={onStage}
							onDiscard={setDiscard}
							className="min-h-0 flex-1"
						/>
						<CommitBox projectId={projectId} status={status} sessionId={sessionId} compact={mobile || compactBar} textareaRef={commitRef} busy={busy === "commit" || busy === "commit-push"} />
					</div>
				) : tab === "history" ? (
					<HistoryList projectId={projectId} selectedSha={view.kind === "commit" ? view.sha : null} onSelect={onSelectCommit} className="h-full" />
				) : tab === "prs" ? (
					<PullRequestsPanel projectId={projectId} status={status} onCreate={() => setPrDialog(true)} active />
				) : project ? (
					<RepoPanel project={project} status={status} onShowChanges={() => setTab("changes")} />
				) : (
					<Skeleton className="m-3 h-40" />
				)}
			</div>
		</div>
	);

	const diffPane = (extra?: { onBack?: () => void; onClose?: () => void }) => (
		<DiffPane projectId={projectId} status={status} view={view} onViewChange={onViewChange} onBack={extra?.onBack} onClose={extra?.onClose} />
	);

	const openBlockingPath = (path: string) => {
		setTab("changes");
		const f = status.files.find((x) => x.path === path);
		if (f) onSelectFile(f, f.kind === "conflicted" ? "conflicted" : f.staged && !f.unstaged ? "staged" : f.kind === "untracked" ? "untracked" : "changes");
		else focusPath(path, "head");
	};

	return (
		<div ref={boxRef} className={cn("flex h-full min-h-0 flex-col bg-surface-1/30", className)}>
			{mobile && detailOpen ? (
				<div className="animate-slide-up h-full min-h-0">{diffPane({ onBack: () => setDetailOpen(false) })}</div>
			) : (
				<>
					<GitToolbar projectId={projectId} status={status} compact={compactBar || mobile} branchOpen={branchOpen} onBranchOpenChange={setBranchOpen} />
					<NoticeBanner projectId={projectId} onOpenPath={openBlockingPath} />
					<div className="min-h-0 flex-1 border-t">
						{split ? (
							<PanelGroup direction="horizontal" autoSaveId={`clam.git.split.${sessionId ? "session" : "page"}`} className="h-full">
								<Panel id="git-list" order={1} defaultSize={38} minSize={26} maxSize={60} className="min-w-0">
									{list}
								</Panel>
								<PanelResizeHandle aria-label="Resize git panels" />
								<Panel id="git-diff" order={2} minSize={30} className="min-w-0">
									{diffPane()}
								</Panel>
							</PanelGroup>
						) : (
							list
						)}
					</div>
				</>
			)}

			{!split && !mobile ? (
				<Sheet open={detailOpen} onOpenChange={setDetailOpen}>
					<SheetContent side="right" className="w-[min(96vw,960px)] p-0" aria-describedby={undefined}>
						<SheetTitle className="sr-only">Diff</SheetTitle>
						<SheetDescription className="sr-only">Changes for the selected file or commit.</SheetDescription>
						{detailOpen ? diffPane({ onClose: () => setDetailOpen(false) }) : null}
					</SheetContent>
				</Sheet>
			) : null}

			{prDialog ? (
				<CreatePullRequestDialog
					projectId={projectId}
					status={status}
					onClose={() => setPrDialog(false)}
					onCreated={() => {
						setPrDialog(false);
						setTab("prs");
					}}
				/>
			) : null}

			<ConfirmDialog
				open={discard !== null}
				onOpenChange={(o) => !o && !discarding && setDiscard(null)}
				title={discard?.every((f) => f.kind === "untracked") ? "Delete untracked files?" : "Discard changes?"}
				danger
				loading={discarding}
				confirmLabel={discard?.every((f) => f.kind === "untracked") ? "Delete files" : "Discard changes"}
				onConfirm={() => void confirmDiscard()}
				description={
					discard ? (
						<span className="flex flex-col gap-2">
							<span>
								This permanently {discard.every((f) => f.kind === "untracked") ? "deletes" : "reverts"} {discard.length === 1 ? "this file" : `these ${discard.length} files`} in your working tree. It cannot be undone.
							</span>
							<span className="scrollbar-thin block max-h-40 overflow-y-auto rounded-lg bg-surface-2 px-2.5 py-2">
								{discard.slice(0, 40).map((f) => (
									<span key={f.path} className="block truncate font-mono text-xs text-foreground" title={f.path}>
										{splitPath(f.path).dir}
										<span className="font-semibold">{splitPath(f.path).name}</span>
										<span className="ml-2 font-sans text-2xs text-subtle">{f.kind === "untracked" ? "untracked — will be deleted" : f.kind}</span>
									</span>
								))}
								{discard.length > 40 ? <span className="block pt-1 text-2xs text-subtle">and {discard.length - 40} more…</span> : null}
							</span>
						</span>
					) : null
				}
			/>
		</div>
	);
}
