import type { Context } from "@clam/contracts";
import { ArrowLeft, FileQuestion, GitBranch, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { LazyMarkdown } from "@/components/lazy-markdown";
import { ApiError, errorMessage } from "@/lib/api";
import { relativeTime } from "@/lib/utils";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty-state";
import { Skeleton } from "@/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";
import { ConflictResolver } from "./conflict.tsx";
import { ContextEditor } from "./editor.tsx";
import { contextTypeInfo, syncBadge } from "./format.ts";
import { useContext, useContextMutations } from "./hooks.ts";
import { SyncChip, TypeBadge } from "./list-row.tsx";
import { authorKindLabel, authorLabel, VersionsPanel } from "./versions.tsx";

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex min-w-0 flex-col gap-0.5">
			<dt className="text-2xs font-medium uppercase tracking-wider text-subtle">{label}</dt>
			<dd className="min-w-0 truncate text-[13px]">{children}</dd>
		</div>
	);
}

function stamp(iso: string): string {
	return `${relativeTime(iso)} · ${new Date(iso).toLocaleString()}`;
}

function SyncPanel({ context, nodeNames }: { context: Context; nodeNames: Map<string, string> }) {
	const badge = syncBadge(context, nodeNames);
	const holders = context.sync.syncedTo.map((nodeId) => ({ nodeId, name: nodeNames.get(nodeId) ?? nodeId.slice(0, 8) }));
	return (
		<section aria-label="Sync" className="flex min-w-0 flex-col gap-2 rounded-xl bg-surface-2/60 p-3 shadow-[inset_0_0_0_1px_var(--border)]">
			<div className="flex flex-wrap items-center gap-2">
				<h3 className="text-2xs font-semibold uppercase tracking-wider text-subtle">Sync</h3>
				<SyncChip context={context} nodeNames={nodeNames} />
			</div>
			<p className="text-xs text-muted-foreground">{badge.detail}</p>
			{context.shareable ? (
				<>
					{holders.length > 0 ? (
						<ul aria-label="Machines holding the current version" className="flex flex-wrap gap-1.5">
							{holders.map((h) => (
								<li key={h.nodeId} className="rounded-md bg-surface-3 px-2 py-1 text-2xs text-muted-foreground">
									{h.name}
								</li>
							))}
						</ul>
					) : null}
					<p className="text-2xs text-subtle">Shareable contexts are sent machine-to-machine to every member of this workspace and may be exported to .clmesh/ in the project's Git repository after the secret scanner. Edits made on two machines at once are never merged automatically.</p>
				</>
			) : (
				<p className="text-2xs text-subtle">Turn on “Shareable” when editing to sync this with the other member machines of the workspace.</p>
			)}
			{context.gitPath ? (
				<p className="flex min-w-0 items-center gap-1.5 text-2xs text-subtle">
					<GitBranch className="size-3 shrink-0" aria-hidden />
					<span className="truncate font-mono" title={context.gitPath}>
						{context.gitPath}
					</span>
				</p>
			) : null}
		</section>
	);
}

function DetailSkeleton() {
	return (
		<div aria-busy className="flex flex-col gap-4 p-4 sm:p-6">
			<Skeleton className="h-7 w-2/3" />
			<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
				{[0, 1, 2, 3].map((i) => (
					<Skeleton key={i} className="h-9" />
				))}
			</div>
			<Skeleton className="h-20 rounded-xl" />
			<Skeleton className="h-48 rounded-xl" />
		</div>
	);
}

/** Right pane: view / edit / history / conflict resolution for one context. */
export function ContextDetail({
	id,
	projectNames,
	nodeNames,
	onBack,
	onDeleted,
	onDirtyChange,
}: {
	id: string;
	projectNames: Map<string, string>;
	nodeNames: Map<string, string>;
	/** Mobile: back to the list. */
	onBack: () => void;
	onDeleted: () => void;
	onDirtyChange: (dirty: boolean) => void;
}) {
	const q = useContext(id);
	const { remove } = useContextMutations();
	const [editing, setEditing] = useState(false);
	const [tab, setTab] = useState("content");
	const [confirmDelete, setConfirmDelete] = useState(false);

	const back = (
		<Button variant="ghost" size="icon" onClick={onBack} aria-label="Back to the list" className="-ml-2 lg:hidden">
			<ArrowLeft />
		</Button>
	);

	if (q.isPending) {
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				<div className="px-2 pt-2 lg:hidden">{back}</div>
				<DetailSkeleton />
			</div>
		);
	}
	if (q.error || !q.data) {
		const gone = q.error instanceof ApiError && q.error.status === 404;
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				<div className="px-2 pt-2 lg:hidden">{back}</div>
				<EmptyState
					icon={FileQuestion}
					title={gone ? "This context no longer exists" : "Could not load this context"}
					description={gone ? "It was deleted on this machine or on another member machine." : errorMessage(q.error)}
					action={
						gone ? (
							<Button size="sm" variant="outline" onClick={onBack}>
								Back to the list
							</Button>
						) : (
							<Button size="sm" variant="outline" onClick={() => void q.refetch()}>
								<RefreshCw /> Retry
							</Button>
						)
					}
				/>
			</div>
		);
	}

	const c = q.data;
	const inConflict = c.sync.state === "conflict";
	const scope = c.projectId ? (projectNames.get(c.projectId) ?? "Project") : "Workspace-wide";

	return (
		<div className="scrollbar-thin flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain">
			<div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-3 sm:px-6 lg:py-5">
				<header className="flex min-w-0 items-start gap-2">
					{back}
					<div className="flex min-w-0 flex-1 flex-col gap-1.5">
						<h2 className="break-words text-lg font-semibold tracking-tight">{c.title}</h2>
						<div className="flex flex-wrap items-center gap-1.5">
							<TypeBadge type={c.type} />
							<SyncChip context={c} nodeNames={nodeNames} />
						</div>
					</div>
					{editing ? null : (
						<div className="flex shrink-0 items-center gap-1.5">
							<Button size="md" variant="outline" onClick={() => setEditing(true)} disabled={inConflict} title={inConflict ? "Resolve the conflict first" : undefined}>
								<Pencil /> <span className="max-sm:sr-only">Edit</span>
							</Button>
							<Button size="md" variant="ghost" onClick={() => setConfirmDelete(true)} aria-label="Delete this context" className="text-danger hover:text-danger">
								<Trash2 /> <span className="max-sm:sr-only">Delete</span>
							</Button>
						</div>
					)}
				</header>

				{inConflict ? <ConflictResolver context={c} nodeNames={nodeNames} /> : null}

				{editing ? (
					<ContextEditor
						context={c}
						onCancel={() => setEditing(false)}
						onDone={() => {
							setEditing(false);
						}}
						onDirtyChange={onDirtyChange}
					/>
				) : (
					<>
						<dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
							<Meta label="Type">{contextTypeInfo(c.type).label}</Meta>
							<Meta label="Scope">{scope}</Meta>
							<Meta label="Author">
								<span title={`${authorLabel(c.author)} (${authorKindLabel(c.author)})`}>
									{authorLabel(c.author)} <span className="text-2xs text-subtle">({authorKindLabel(c.author)})</span>
								</span>
							</Meta>
							<Meta label="Version">v{c.version}</Meta>
							<Meta label="Created">
								<span title={new Date(c.createdAt).toLocaleString()}>{relativeTime(c.createdAt)}</span>
							</Meta>
							<Meta label="Updated">
								<span title={stamp(c.updatedAt)}>{relativeTime(c.updatedAt)}</span>
							</Meta>
						</dl>
						<SyncPanel context={c} nodeNames={nodeNames} />
						<Tabs value={tab} onValueChange={setTab} className="flex min-w-0 flex-col gap-3">
							<TabsList className="w-fit">
								<TabsTrigger value="content">Content</TabsTrigger>
								<TabsTrigger value="versions">History · v{c.version}</TabsTrigger>
							</TabsList>
							<TabsContent value="content" className="min-w-0">
								{c.body.trim() ? (
									<article className="min-w-0 rounded-xl bg-surface-1 p-4 shadow-[inset_0_0_0_1px_var(--border)]">
										<LazyMarkdown text={c.body} />
									</article>
								) : (
									<EmptyState
										title="No content yet"
										description="This context only has a title."
										action={
											<Button size="sm" variant="outline" onClick={() => setEditing(true)} disabled={inConflict}>
												<Pencil /> Add content
											</Button>
										}
									/>
								)}
							</TabsContent>
							<TabsContent value="versions" className="min-w-0">
								<VersionsPanel context={c} />
							</TabsContent>
						</Tabs>
					</>
				)}
			</div>
			<ConfirmDialog
				open={confirmDelete}
				onOpenChange={(o) => !remove.isPending && setConfirmDelete(o)}
				title="Delete this context?"
				description={
					c.shareable
						? "This context is shareable, so it is removed for every member machine of this workspace too, not only on this machine. This cannot be undone."
						: "This context is private to this machine. It is deleted here and cannot be recovered."
				}
				confirmLabel="Delete"
				danger
				loading={remove.isPending}
				onConfirm={() =>
					remove.mutate(c.id, {
						onSuccess: () => {
							setConfirmDelete(false);
							toast.success("Context deleted");
							onDeleted();
						},
						onError: (e) => {
							setConfirmDelete(false);
							toast.error("Could not delete", { description: errorMessage(e) });
						},
					})
				}
			/>
		</div>
	);
}
