import type { Context, ContextExportResult, ContextImportResult, ContextType, Project } from "@clam/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRight, Download, GitBranch, Info, Lightbulb, Plus, RefreshCw, ShieldAlert, TriangleAlert, Upload } from "lucide-react";
import { lazy, type ReactNode, Suspense, useMemo, useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card, CardContent } from "@/ui/card";
import { EmptyState } from "@/ui/empty-state";
import { Skeleton } from "@/ui/skeleton";
import { CONTEXT_TYPES } from "./format.ts";
import { useContextMutations, useContexts, useNodeNames } from "./hooks.ts";
import { ContextRow } from "./list-row.tsx";

const ContextEditorDialog = lazy(() => import("./editor-dialog.tsx"));

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
	return (
		<button
			type="button"
			aria-pressed={active}
			onClick={onClick}
			className={cn(
				"inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium outline-none transition-colors focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:h-11 coarse:px-3.5 [&_svg]:size-3.5",
				active ? "bg-accent-soft text-accent" : "bg-surface-2 text-muted-foreground hover:bg-surface-3 hover:text-foreground",
			)}
		>
			{children}
		</button>
	);
}

/** Collapsible list of paths. */
function PathList({ label, items, defaultOpen }: { label: string; items: string[]; defaultOpen?: boolean }) {
	if (items.length === 0) return null;
	return (
		<details open={defaultOpen} className="group rounded-lg bg-surface-2/60 px-3 py-2 text-xs">
			<summary className="flex min-h-6 cursor-pointer list-none items-center gap-1.5 font-medium outline-none focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:min-h-11 [&::-webkit-details-marker]:hidden">
				<ChevronRight className="size-3.5 shrink-0 transition-transform group-open:rotate-90" aria-hidden />
				{label} <span className="tabular text-subtle">{items.length}</span>
			</summary>
			<ul className="mt-1.5 flex flex-col gap-0.5 pb-1 pl-5 font-mono text-2xs text-muted-foreground">
				{items.map((p) => (
					<li key={p} className="break-all">
						{p}
					</li>
				))}
			</ul>
		</details>
	);
}

function ExportReport({ result, contexts, workspaceId }: { result: ContextExportResult; contexts: Context[]; workspaceId: string }) {
	return (
		<div className="flex flex-col gap-2" role="status" aria-live="polite">
			<p className="text-xs text-muted-foreground">
				<span className="font-medium text-foreground">Export finished:</span> {plural(result.written.length, "file")} written, {result.unchanged.length} unchanged
				{result.refused.length > 0 ? `, ${result.refused.length} blocked` : ""}. Files are in the working tree only; nothing was committed.
			</p>
			{result.refused.length > 0 ? (
				<div role="alert" className="flex flex-col gap-2 rounded-lg bg-danger/10 p-3 shadow-[inset_0_0_0_1px_var(--danger)]">
					<div className="flex items-start gap-2 text-xs text-danger">
						<ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
						<p className="font-medium">Blocked by the secret scanner — nothing was written for these. Remove the secret from the context, then export again.</p>
					</div>
					<ul className="flex flex-col gap-1.5">
						{result.refused.map((r) => {
							const ctx = contexts.find((c) => c.id === r.contextId);
							return (
								<li key={`${r.contextId}:${r.path}:${r.line}`} className="flex flex-col gap-0.5 rounded-md bg-surface-1/70 px-2.5 py-1.5 text-xs">
									<span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
										{ctx ? (
											<Link to="/workspaces/$workspaceId/context" params={{ workspaceId }} search={{ id: ctx.id }} className="font-medium hover:underline">
												{ctx.title}
											</Link>
										) : (
											<span className="font-mono text-2xs">{r.contextId}</span>
										)}
										<Badge variant="danger">{r.rule}</Badge>
										<span className="tabular text-2xs text-subtle">line {r.line}</span>
									</span>
									<span className="break-all font-mono text-2xs text-muted-foreground">{r.path}</span>
								</li>
							);
						})}
					</ul>
				</div>
			) : null}
			<PathList label="Written" items={result.written} />
			{result.removed.length > 0 ? (
				<>
					<p className="text-xs text-muted-foreground">Removed from the working tree because the context was unshared or deleted:</p>
					<PathList label="Removed" items={result.removed} />
				</>
			) : null}
			<PathList label="Unchanged" items={result.unchanged} />
		</div>
	);
}

function ImportReport({ result, contexts, workspaceId, projectId }: { result: ContextImportResult; contexts: Context[]; workspaceId: string; projectId: string }) {
	const byRef = (ref: string) => contexts.find((c) => c.id === ref || c.gitPath === ref);
	return (
		<div className="flex flex-col gap-2" role="status" aria-live="polite">
			<p className="text-xs text-muted-foreground">
				<span className="font-medium text-foreground">Import finished:</span> {result.created.length} created, {result.updated.length} updated, {result.unchanged.length} unchanged
				{result.conflicts.length > 0 ? `, ${result.conflicts.length} in conflict` : ""}.
			</p>
			{result.conflicts.length > 0 ? (
				<div role="alert" className="flex flex-col gap-2 rounded-lg bg-warning/10 p-3 shadow-[inset_0_0_0_1px_var(--warning)]">
					<div className="flex items-start gap-2 text-xs text-warning">
						<TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
						<p className="font-medium">Conflicts are never auto-merged — resolve them in Shared Context.</p>
					</div>
					<ul className="flex flex-col gap-1">
						{result.conflicts.map((ref) => {
							const c = byRef(ref);
							return (
								<li key={ref} className="text-xs">
									<Link
										to="/workspaces/$workspaceId/context"
										params={{ workspaceId }}
										search={c ? { id: c.id, project: projectId } : { project: projectId }}
										className="inline-flex min-h-6 items-center gap-1 break-all font-medium hover:underline coarse:min-h-11"
									>
										{c ? c.title : <span className="font-mono text-2xs">{ref}</span>} <ChevronRight className="size-3" aria-hidden />
									</Link>
								</li>
							);
						})}
					</ul>
				</div>
			) : null}
			{result.skipped.length > 0 ? (
				<details className="rounded-lg bg-surface-2 px-3 py-2 text-xs">
					<summary className="cursor-pointer select-none font-medium coarse:min-h-11 coarse:leading-[2.75rem]">{plural(result.skipped.length, "file")} ignored</summary>
					<ul className="mt-1.5 flex flex-col gap-1">
						{result.skipped.map((k) => (
							<li key={k.path} className="flex flex-col gap-0.5">
								<span className="break-all font-mono text-2xs">{k.path}</span>
								<span className="text-2xs text-muted-foreground">{k.reason}</span>
							</li>
						))}
					</ul>
				</details>
			) : null}
			<PathList label="Created" items={result.created} />
			<PathList label="Updated" items={result.updated} />
			<PathList label="Unchanged" items={result.unchanged} />
		</div>
	);
}

function GitSyncCard({ project, contexts }: { project: Project; contexts: Context[] }) {
	const { exportClmesh, importClmesh } = useContextMutations();
	const shareable = contexts.filter((c) => c.shareable).length;
	const privateCount = contexts.length - shareable;

	const doExport = () =>
		exportClmesh.mutate(project.id, {
			onSuccess: (r) => {
				if (r.refused.length > 0) toast.warning(`${plural(r.refused.length, "context")} blocked by the secret scanner`);
				else toast.success(r.written.length ? `Exported ${plural(r.written.length, "file")} to .clmesh/` : "Nothing to export — .clmesh/ is up to date");
			},
			onError: (e) => toast.error("Export failed", { description: errorMessage(e) }),
		});
	const doImport = () =>
		importClmesh.mutate(project.id, {
			onSuccess: (r) => {
				const n = r.created.length + r.updated.length;
				if (r.conflicts.length > 0) toast.warning(`Imported ${n}, ${plural(r.conflicts.length, "conflict")} to resolve`);
				else toast.success(n ? `Imported ${n} ${n === 1 ? "context" : "contexts"} from .clmesh/` : "Nothing new in .clmesh/");
			},
			onError: (e) => toast.error("Import failed", { description: errorMessage(e) }),
		});

	return (
		<Card>
			<CardContent className="flex flex-col gap-3">
				<div className="flex items-center gap-2">
					<GitBranch className="size-4 shrink-0 text-accent" aria-hidden />
					<h3 className="text-[13px] font-semibold tracking-tight">Git sync (.clmesh/)</h3>
				</div>
				<p className="text-xs text-muted-foreground">
					Only <span className="font-medium text-foreground">shareable</span> contexts reach Git. Private contexts stay on this machine. Export writes files into the working tree — it never commits or pushes; review and commit them like any other change.
				</p>
				<div className="flex flex-wrap gap-1.5" aria-label="Sharing summary">
					<Badge variant="success">{shareable} shareable</Badge>
					<Badge variant="neutral">{privateCount} private</Badge>
				</div>
				<div className="flex flex-wrap gap-2">
					<Button variant="outline" onClick={doExport} loading={exportClmesh.isPending} disabled={importClmesh.isPending || shareable === 0} title={shareable === 0 ? "Mark a context shareable first" : undefined}>
						<Upload /> Export shareable contexts to .clmesh/
					</Button>
					<Button variant="outline" onClick={doImport} loading={importClmesh.isPending} disabled={exportClmesh.isPending}>
						<Download /> Import from .clmesh/
					</Button>
				</div>
				{exportClmesh.isError ? (
					<p role="alert" className="text-xs text-danger">
						{errorMessage(exportClmesh.error)}
					</p>
				) : null}
				{importClmesh.isError ? (
					<p role="alert" className="text-xs text-danger">
						{errorMessage(importClmesh.error)}
					</p>
				) : null}
				{exportClmesh.data ? <ExportReport result={exportClmesh.data} contexts={contexts} workspaceId={project.workspaceId} /> : null}
				{importClmesh.data ? <ImportReport result={importClmesh.data} contexts={contexts} workspaceId={project.workspaceId} projectId={project.id} /> : null}
				<p className="text-2xs text-subtle">Import after a pull to bring teammates' contexts in. Shareable contexts also sync machine-to-machine to workspace members, with or without Git.</p>
			</CardContent>
		</Card>
	);
}

/** Project page → 'Context' tab: this project's shared context (project memory), with Git sync for git projects. */
export default function ProjectContextTab({ project }: { project: Project }) {
	const navigate = useNavigate();
	const q = useContexts({ projectId: project.id });
	const nodeNames = useNodeNames(project.workspaceId);
	const [type, setType] = useState<ContextType | "all">("all");
	const [adding, setAdding] = useState(false);

	const all = q.data ?? [];
	const counts = useMemo(() => {
		const m = new Map<ContextType, number>();
		for (const c of all) m.set(c.type, (m.get(c.type) ?? 0) + 1);
		return m;
	}, [all]);
	const visible = useMemo(() => (type === "all" ? all : all.filter((c) => c.type === type)), [all, type]);
	const sorted = useMemo(() => [...visible].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)), [visible]);
	const conflicts = all.filter((c) => c.sync.state === "conflict").length;
	const isGit = project.vcs === "git";

	const open = (id: string) => void navigate({ to: "/workspaces/$workspaceId/context", params: { workspaceId: project.workspaceId }, search: { id, project: project.id } });

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex min-w-0 flex-col gap-0.5">
					<h2 className="text-[15px] font-semibold tracking-tight">Project context</h2>
					<p className="text-xs text-muted-foreground">Memory, plans and decisions for {project.name}. Agents get a short preface of it in new sessions.</p>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<Button asChild variant="ghost">
						<Link to="/workspaces/$workspaceId/context" params={{ workspaceId: project.workspaceId }} search={{ project: project.id }}>
							Open in Shared Context
						</Link>
					</Button>
					<Button variant="primary" onClick={() => setAdding(true)}>
						<Plus /> Add context
					</Button>
				</div>
			</div>

			{conflicts > 0 ? (
				<div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-danger/10 px-3 py-2.5 text-xs shadow-[inset_0_0_0_1px_var(--danger)]">
					<TriangleAlert className="size-4 shrink-0 text-danger" aria-hidden />
					<p className="min-w-0 flex-1 basis-56 text-danger">
						<span className="font-medium">{plural(conflicts, "context")} in conflict.</span> Another machine edited the same version — nothing was merged.
					</p>
					<Button asChild size="sm" variant="outline">
						<Link to="/workspaces/$workspaceId/context" params={{ workspaceId: project.workspaceId }} search={{ project: project.id }}>
							Resolve
						</Link>
					</Button>
				</div>
			) : null}

			{isGit ? (
				<GitSyncCard project={project} contexts={all} />
			) : (
				<div className="flex items-start gap-2 rounded-lg bg-surface-2/60 px-3 py-2.5 text-xs text-muted-foreground">
					<Info className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
					<p>Contexts sync machine-to-machine to workspace members; no Git repository is needed.</p>
				</div>
			)}

			{q.isPending ? (
				<div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading contexts">
					<Skeleton className="h-7 w-2/3" />
					<Skeleton className="h-14" />
					<Skeleton className="h-14" />
					<Skeleton className="h-14" />
				</div>
			) : q.isError ? (
				<EmptyState
					icon={TriangleAlert}
					title="Could not load contexts"
					description={errorMessage(q.error)}
					className="py-8"
					action={
						<Button variant="outline" loading={q.isFetching} onClick={() => void q.refetch()}>
							<RefreshCw /> Retry
						</Button>
					}
				/>
			) : all.length === 0 ? (
				<EmptyState
					icon={Lightbulb}
					title="No project memory yet"
					description="Project memory holds what agents and teammates should remember about this project: conventions, decisions, plans. Agents get it as a short preface in new sessions and can read and add to it with host tools. Contexts are private until you mark them shareable."
					action={
						<Button variant="primary" onClick={() => setAdding(true)}>
							<Plus /> Add the first context
						</Button>
					}
				/>
			) : (
				<div className="flex flex-col gap-2">
					<div role="group" aria-label="Filter by type" className="scrollbar-thin -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
						<Chip active={type === "all"} onClick={() => setType("all")}>
							All <span className="tabular opacity-70">{all.length}</span>
						</Chip>
						{CONTEXT_TYPES.filter((t) => counts.has(t.id) || type === t.id).map((t) => (
							<Chip key={t.id} active={type === t.id} onClick={() => setType(t.id)}>
								<t.icon aria-hidden /> {t.plural} <span className="tabular opacity-70">{counts.get(t.id) ?? 0}</span>
							</Chip>
						))}
					</div>
					{sorted.length === 0 ? (
						<p className="px-1 py-6 text-center text-[13px] text-muted-foreground">No contexts of this type.</p>
					) : (
						<ul className="flex flex-col gap-0.5 rounded-xl bg-surface-1 p-1 shadow-[inset_0_0_0_1px_var(--border)]" aria-label="Project contexts">
							{sorted.map((c) => (
								<li key={c.id}>
									<ContextRow context={c} nodeNames={nodeNames} onSelect={() => open(c.id)} />
								</li>
							))}
						</ul>
					)}
				</div>
			)}

			{adding ? (
				<Suspense fallback={null}>
					<ContextEditorDialog
						workspaceId={project.workspaceId}
						projectId={project.id}
						onClose={() => setAdding(false)}
						onSaved={(c) => {
							setAdding(false);
							toast.success(`Added “${c.title}”`);
						}}
					/>
				</Suspense>
			) : null}
		</div>
	);
}
