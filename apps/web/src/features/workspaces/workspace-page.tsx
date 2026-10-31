import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { Bot, FolderGit2, FolderPlus, GitBranch, Layers, MessageSquarePlus, Pencil, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { SessionRow } from "@/components/session-row";
import { ApiError, errorMessage } from "@/lib/api";
import { useAgents, useProjects, useSessions, useWorkspace } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { relativeTime } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";
import { EmptyState } from "@/ui/empty-state";
import { PageContainer, PageHeader, SectionTitle } from "@/ui/page";
import { Skeleton } from "@/ui/skeleton";
import { StatusDot } from "@/ui/status-dot";
import { useDeleteWorkspace } from "./workspaces-page.tsx";

export default function WorkspacePage() {
	const { workspaceId } = useParams({ strict: false }) as { workspaceId: string };
	const navigate = useNavigate();
	const ws = useWorkspace(workspaceId);
	const projects = useProjects(workspaceId);
	const agents = useAgents();
	const sessions = useSessions();
	const openDialog = useUi((s) => s.openDialog);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const del = useDeleteWorkspace(() => void navigate({ to: "/workspaces" }));

	const projectIds = useMemo(() => new Set((projects.data ?? []).map((p) => p.id)), [projects.data]);
	const names = useMemo(() => new Map((projects.data ?? []).map((p) => [p.id, p.name])), [projects.data]);
	const recent = useMemo(
		() => (sessions.data ?? []).filter((s) => projectIds.has(s.projectId)).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 8),
		[sessions.data, projectIds],
	);

	if (ws.isError) {
		const notFound = ws.error instanceof ApiError && ws.error.status === 404;
		return (
			<EmptyState
				className="h-full"
				icon={Layers}
				title={notFound ? "Workspace not found" : "Could not load workspace"}
				description={notFound ? "It may have been deleted." : errorMessage(ws.error)}
				action={
					<Button asChild variant="outline">
						<Link to="/workspaces">All workspaces</Link>
					</Button>
				}
			/>
		);
	}

	return (
		<PageContainer wide>
			<PageHeader
				eyebrow={
					<Link to="/workspaces" className="hover:text-foreground">
						Workspaces
					</Link>
				}
				title={ws.data?.name ?? <Skeleton className="h-7 w-48" />}
				description={ws.data ? ws.data.description || undefined : undefined}
				actions={
					<>
						<Button variant="ghost" size="icon" aria-label="Edit workspace" onClick={() => openDialog({ kind: "edit-workspace", workspaceId })}>
							<Pencil />
						</Button>
						<Button variant="ghost" size="icon" aria-label="Delete workspace" onClick={() => setConfirmDelete(true)}>
							<Trash2 />
						</Button>
						<Button variant="primary" onClick={() => openDialog({ kind: "create-project", workspaceId })}>
							<FolderPlus /> Add project
						</Button>
					</>
				}
			/>

			<section className="flex flex-col gap-3">
				<SectionTitle>Projects</SectionTitle>
				{projects.isLoading ? (
					<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
						{[0, 1].map((i) => (
							<Skeleton key={i} className="h-28 rounded-xl" />
						))}
					</div>
				) : null}
				{projects.isSuccess && projects.data.length === 0 ? (
					<Card>
						<EmptyState
							icon={FolderGit2}
							title="No projects in this workspace"
							description="Add a project directory so agents can work in it."
							action={
								<Button variant="primary" onClick={() => openDialog({ kind: "create-project", workspaceId })}>
									<FolderPlus /> Add project
								</Button>
							}
						/>
					</Card>
				) : null}
				<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
					{projects.data?.map((p) => (
						<Card key={p.id} className="transition-[box-shadow,transform] duration-200 hover:-translate-y-px hover:shadow-[inset_0_0_0_1px_var(--border-strong)]">
							<Link to="/projects/$projectId" params={{ projectId: p.id }} preload="intent" className="flex flex-col gap-2.5 rounded-xl p-4 outline-none">
								<div className="flex items-center gap-2.5">
									<FolderGit2 className="size-4 shrink-0 text-accent" />
									<h3 className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight">{p.name}</h3>
									{p.repository ? (
										<Badge variant="outline" className="gap-1">
											<GitBranch /> {p.repository.owner}/{p.repository.name}
										</Badge>
									) : null}
								</div>
								<p className="truncate font-mono text-2xs text-subtle">{p.path}</p>
								<div className="flex items-center justify-between text-xs text-muted-foreground">
									<span>
										{p.sessionCount} {p.sessionCount === 1 ? "session" : "sessions"}
									</span>
									<span className="text-subtle">{p.lastActivityAt ? `Active ${relativeTime(p.lastActivityAt)}` : "No activity yet"}</span>
								</div>
							</Link>
						</Card>
					))}
				</div>
			</section>

			<div className="grid gap-4 lg:grid-cols-5">
				<Card className="lg:col-span-3">
					<CardHeader>
						<CardTitle>Recent sessions</CardTitle>
						<Button variant="ghost" size="sm" disabled={(projects.data?.length ?? 0) === 0} onClick={() => openDialog({ kind: "create-session", projectId: projects.data?.[0]?.id })}>
							<MessageSquarePlus /> New
						</Button>
					</CardHeader>
					<div className="mt-3 border-t">
						{sessions.isLoading ? <Skeleton className="m-3 h-12" /> : null}
						{sessions.isSuccess && recent.length === 0 ? <p className="p-4 text-[13px] text-subtle">No sessions in this workspace yet.</p> : null}
						{recent.map((s) => (
							<SessionRow key={s.id} session={s} projectName={names.get(s.projectId)} />
						))}
					</div>
				</Card>
				<Card className="lg:col-span-2">
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							<Bot className="size-4 text-muted-foreground" /> Agents
						</CardTitle>
						<Link to="/workspaces/$workspaceId/agents" params={{ workspaceId }} preload="intent" className="text-xs text-muted-foreground hover:text-foreground">
							Manage
						</Link>
					</CardHeader>
					<CardContent className="flex flex-col gap-2.5 pt-3">
						{agents.isLoading ? <Skeleton className="h-10" /> : null}
						{agents.data?.map((a) => (
							<div key={a.id} className="flex items-center gap-2.5 text-[13px]">
								<StatusDot status={a.status} />
								<span className="font-medium">{a.name}</span>
								<span className="min-w-0 flex-1 truncate text-xs text-subtle">{a.role}</span>
								<span className="flex flex-wrap justify-end gap-1">
									{a.capabilities.slice(0, 3).map((c) => (
										<Badge key={c}>{c}</Badge>
									))}
								</span>
							</div>
						))}
						{agents.isSuccess && agents.data.length === 0 ? <p className="text-[13px] text-subtle">No agents on this node.</p> : null}
					</CardContent>
				</Card>
			</div>

			<ConfirmDialog
				open={confirmDelete}
				onOpenChange={setConfirmDelete}
				title={`Delete “${ws.data?.name ?? "workspace"}”?`}
				description="The workspace and its project entries are removed from CL Agent Mesh. Files on disk are not touched."
				confirmLabel="Delete workspace"
				danger
				loading={del.isPending}
				onConfirm={() => del.mutate(workspaceId)}
			/>
		</PageContainer>
	);
}
