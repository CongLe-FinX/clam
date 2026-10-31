import type { AgentSession } from "@clam/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { Archive, FolderTree, MessagesSquare, MoreHorizontal, Pencil, Plus, RefreshCw } from "lucide-react";
import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { errorMessage } from "@/lib/api";
import { useSessions } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { cn, relativeTime } from "@/lib/utils";
import { SessionKindBadge, sessionDot } from "@/components/session-status";
import { Button } from "@/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/ui/dropdown-menu";
import { EmptyState } from "@/ui/empty-state";
import { Skeleton } from "@/ui/skeleton";
import { StatusDot } from "@/ui/status-dot";
import { Tabs, TabsList, TabsTrigger } from "@/ui/tabs";
import { useUpdateSession } from "./session-actions.ts";

const FileExplorer = lazy(() => import("@/features/projects/file-explorer.tsx").then((m) => ({ default: m.FileExplorer })));

function ThreadRow({ s, current, onNavigate }: { s: AgentSession; current: boolean; onNavigate?: () => void }) {
	const update = useUpdateSession();
	const navigate = useNavigate();
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(s.title);
	const cancelled = useRef(false);

	const commit = () => {
		setEditing(false);
		const title = draft.trim();
		if (cancelled.current || !title || title === s.title) return;
		update.mutate({ id: s.id, patch: { title } });
	};

	return (
		<li className="group/row relative">
			{editing ? (
				<div className="flex min-h-9 items-center gap-2 px-2.5 coarse:min-h-12">
					<StatusDot status={sessionDot(s.status)} label={s.status} />
					<input
						autoFocus
						value={draft}
						onFocus={(e) => e.currentTarget.select()}
						onChange={(e) => setDraft(e.target.value)}
						onBlur={commit}
						onKeyDown={(e) => {
							if (e.key === "Enter") e.currentTarget.blur();
							else if (e.key === "Escape") {
								cancelled.current = true;
								e.currentTarget.blur();
							}
						}}
						maxLength={120}
						aria-label="Thread title"
						className="h-7 min-w-0 flex-1 rounded-md bg-surface-1 px-2 text-[13px] shadow-[inset_0_0_0_1px_var(--accent)] outline-none coarse:h-10"
					/>
				</div>
			) : (
				<>
					<Link
						to="/sessions/$sessionId"
						params={{ sessionId: s.id }}
						preload="intent"
						onClick={onNavigate}
						aria-current={current ? "page" : undefined}
						className={cn(
							"flex min-h-9 items-center gap-2 rounded-lg px-2.5 py-1.5 pr-9 outline-none transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 coarse:min-h-12",
							current && "bg-surface-3 hover:bg-surface-3",
						)}
					>
						<StatusDot status={sessionDot(s.status)} label={s.status} />
						<span className="flex min-w-0 flex-1 flex-col">
							<span className="flex min-w-0 items-center gap-1.5">
								<span className={cn("truncate text-[13px]", current ? "font-medium" : "text-foreground/90")}>{s.title || "Untitled session"}</span>
								<SessionKindBadge session={s} className="shrink-0" />
							</span>
							<span className="truncate text-2xs text-subtle">
								{relativeTime(s.updatedAt)}
								{s.model ? <span className="font-mono"> · {s.model.split("/").pop()}</span> : null}
							</span>
						</span>
					</Link>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<button
								type="button"
								aria-label={`Actions for ${s.title || "thread"}`}
								className="absolute right-1 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-md text-subtle opacity-0 outline-none transition-opacity hover:bg-surface-3 hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100 data-[state=open]:opacity-100 coarse:size-10 coarse:opacity-100"
							>
								<MoreHorizontal className="size-4" />
							</button>
						</DropdownMenuTrigger>
						<DropdownMenuContent>
							<DropdownMenuItem
								onSelect={() => {
									cancelled.current = false;
									setDraft(s.title);
									setEditing(true);
								}}
							>
								<Pencil /> Rename
							</DropdownMenuItem>
							<DropdownMenuItem
								danger
								onSelect={() => {
									update.mutate({ id: s.id, patch: { archived: true } });
									if (current) void navigate({ to: "/projects/$projectId", params: { projectId: s.projectId } });
								}}
							>
								<Archive /> Archive
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</>
			)}
		</li>
	);
}

export function ThreadsPanel({
	session,
	selectedFile,
	onOpenFile,
	onNavigate,
	className,
}: {
	session: AgentSession;
	selectedFile: string | null;
	onOpenFile: (path: string) => void;
	/** Called after switching thread (closes overlay sheets). */
	onNavigate?: () => void;
	className?: string;
}) {
	const [tab, setTab] = useState<"threads" | "files">("threads");
	const [filesSeen, setFilesSeen] = useState(false);
	const openDialog = useUi((s) => s.openDialog);
	const threads = useSessions({ projectId: session.projectId });
	const sorted = useMemo(() => [...(threads.data ?? [])].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)), [threads.data]);

	return (
		<div className={cn("flex h-full min-h-0 flex-col bg-surface-1", className)}>
			<div className="flex shrink-0 items-center justify-between gap-2 border-b px-2.5 py-2">
				<Tabs
					value={tab}
					onValueChange={(v) => {
						setTab(v as "threads" | "files");
						if (v === "files") setFilesSeen(true);
					}}
				>
					<TabsList>
						<TabsTrigger value="threads">
							<MessagesSquare /> Threads
						</TabsTrigger>
						<TabsTrigger value="files">
							<FolderTree /> Files
						</TabsTrigger>
					</TabsList>
				</Tabs>
				{tab === "threads" ? (
					<Button size="sm" variant="secondary" onClick={() => openDialog({ kind: "create-session", projectId: session.projectId })}>
						<Plus /> New
					</Button>
				) : null}
			</div>

			<div className={cn("scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5", tab !== "threads" && "hidden")}>
				{threads.isPending ? (
					<div className="flex flex-col gap-1.5 p-1" aria-busy="true">
						{[0, 1, 2, 3].map((i) => (
							<Skeleton key={i} className="h-9" />
						))}
					</div>
				) : threads.isError ? (
					<EmptyState
						icon={RefreshCw}
						title="Could not load threads"
						description={errorMessage(threads.error)}
						className="py-8"
						action={
							<Button size="sm" variant="outline" onClick={() => void threads.refetch()}>
								Retry
							</Button>
						}
					/>
				) : sorted.length === 0 ? (
					<EmptyState icon={MessagesSquare} title="No threads yet" className="py-8" />
				) : (
					<ul className="flex flex-col gap-0.5" aria-label="Threads in this project">
						{sorted.map((s) => (
							<ThreadRow key={s.id} s={s} current={s.id === session.id} onNavigate={onNavigate} />
						))}
					</ul>
				)}
			</div>

			{filesSeen ? (
				<div className={cn("min-h-0 flex-1", tab !== "files" && "hidden")}>
					<Suspense
						fallback={
							<div className="flex flex-col gap-1.5 p-3" aria-busy="true">
								{[0, 1, 2, 3, 4, 5].map((i) => (
									<Skeleton key={i} className="h-6" />
								))}
							</div>
						}
					>
						<FileExplorer projectId={session.projectId} selectedPath={selectedFile} onOpenFile={onOpenFile} className="h-full" />
					</Suspense>
				</div>
			) : null}
		</div>
	);
}
