import type { Workspace } from "@clam/contracts";
import { routes } from "@clam/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FolderGit2, Layers, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { api, errorMessage } from "@/lib/api";
import { qk, useWorkspaces } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { relativeTime } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/ui/dropdown-menu";
import { EmptyState } from "@/ui/empty-state";
import { PageContainer, PageHeader } from "@/ui/page";
import { Skeleton } from "@/ui/skeleton";

export function useDeleteWorkspace(onDone?: () => void) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.delete(routes.workspace(id)),
		onSuccess: (_d, id) => {
			qc.setQueryData<Workspace[]>(qk.workspaces, (list) => list?.filter((w) => w.id !== id));
			qc.removeQueries({ queryKey: qk.workspace(id) });
			void qc.invalidateQueries({ queryKey: qk.projectsAll });
			toast.success("Workspace deleted");
			onDone?.();
		},
		onError: (e) => toast.error(errorMessage(e)),
	});
}

export default function WorkspacesPage() {
	const workspaces = useWorkspaces();
	const openDialog = useUi((s) => s.openDialog);
	const [toDelete, setToDelete] = useState<Workspace | null>(null);
	const del = useDeleteWorkspace(() => setToDelete(null));

	return (
		<PageContainer>
			<PageHeader
				title="Workspaces"
				description="A workspace groups projects and the agents that work on them."
				actions={
					<Button variant="primary" onClick={() => openDialog({ kind: "create-workspace" })}>
						<Plus /> New workspace
					</Button>
				}
			/>
			{workspaces.isLoading ? (
				<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{[0, 1, 2].map((i) => (
						<Skeleton key={i} className="h-32 rounded-xl" />
					))}
				</div>
			) : null}
			{workspaces.isError ? (
				<EmptyState title="Could not load workspaces" description={errorMessage(workspaces.error)} action={<Button onClick={() => void workspaces.refetch()}>Retry</Button>} />
			) : null}
			{workspaces.isSuccess && workspaces.data.length === 0 ? (
				<EmptyState
					icon={Layers}
					title="No workspaces yet"
					description="Create a workspace, then add the projects your agents will work on."
					action={
						<Button variant="primary" onClick={() => openDialog({ kind: "create-workspace" })}>
							<Plus /> New workspace
						</Button>
					}
				/>
			) : null}
			<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
				{workspaces.data?.map((w) => (
					<Card key={w.id} className="group relative transition-[box-shadow,transform] duration-200 hover:shadow-[inset_0_0_0_1px_var(--border-strong)] hover:-translate-y-px">
						<Link to="/workspaces/$workspaceId" params={{ workspaceId: w.id }} preload="intent" className="flex flex-col gap-3 rounded-xl p-4 outline-none">
							<div className="flex items-start gap-3">
								<div className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
									<Layers className="size-4" />
								</div>
								<div className="min-w-0 flex-1 pr-8">
									<h3 className="truncate text-sm font-semibold tracking-tight">{w.name}</h3>
									<p className="line-clamp-2 min-h-8 text-xs text-muted-foreground">{w.description || "No description"}</p>
								</div>
							</div>
							<div className="flex items-center gap-3 text-xs text-subtle">
								<span className="flex items-center gap-1">
									<FolderGit2 className="size-3.5" /> {w.projectCount} {w.projectCount === 1 ? "project" : "projects"}
								</span>
								<span>Updated {relativeTime(w.updatedAt)}</span>
							</div>
						</Link>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button variant="ghost" size="icon-sm" className="absolute right-2 top-2" aria-label={`Actions for ${w.name}`}>
									<MoreHorizontal />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent>
								<DropdownMenuItem onSelect={() => openDialog({ kind: "edit-workspace", workspaceId: w.id })}>
									<Pencil /> Edit
								</DropdownMenuItem>
								<DropdownMenuSeparator />
								<DropdownMenuItem danger onSelect={() => setToDelete(w)}>
									<Trash2 /> Delete
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</Card>
				))}
			</div>
			<ConfirmDialog
				open={toDelete !== null}
				onOpenChange={(o) => !o && setToDelete(null)}
				title={`Delete “${toDelete?.name ?? ""}”?`}
				description="The workspace and its project entries are removed from CL Agent Mesh. Files on disk are not touched."
				confirmLabel="Delete workspace"
				danger
				loading={del.isPending}
				onConfirm={() => toDelete && del.mutate(toDelete.id)}
			/>
		</PageContainer>
	);
}
