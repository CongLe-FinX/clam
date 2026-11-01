import type { Context, ContextExportResult, ContextImportResult, ContextType, Project } from "@clam/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRight, Download, GitBranch, Info, Lightbulb, Plus, RefreshCw, ShieldAlert, TriangleAlert, Upload } from "lucide-react";
import { lazy, type ReactNode, Suspense, useMemo, useState } from "react";
import { toast } from "sonner";
import { errorText } from "@/lib/api";
import { T, t, tr } from "@/i18n";
import { cn, formatNumber } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card, CardContent } from "@/ui/card";
import { EmptyState } from "@/ui/empty-state";
import { Skeleton } from "@/ui/skeleton";
import { CONTEXT_TYPES } from "./format.ts";
import { useContextMutations, useContexts, useNodeNames } from "./hooks.ts";
import { ContextRow } from "./list-row.tsx";

const ContextEditorDialog = lazy(() => import("./editor-dialog.tsx"));

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
				<span className="font-medium text-foreground">{t("Export finished:")}</span>{" "}
				{result.refused.length > 0
					? t("{written, plural, one {# file} other {# files}} written, {unchanged} unchanged, {blocked} blocked. Files are in the working tree only; nothing was committed.", { written: result.written.length, unchanged: result.unchanged.length, blocked: result.refused.length })
					: t("{written, plural, one {# file} other {# files}} written, {unchanged} unchanged. Files are in the working tree only; nothing was committed.", { written: result.written.length, unchanged: result.unchanged.length })}
			</p>
			{result.refused.length > 0 ? (
				<div role="alert" className="flex flex-col gap-2 rounded-lg bg-danger/10 p-3 shadow-[inset_0_0_0_1px_var(--danger)]">
					<div className="flex items-start gap-2 text-xs text-danger">
						<ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
						<p className="font-medium">{t("Blocked by the secret scanner — nothing was written for these. Remove the secret from the context, then export again.")}</p>
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
										<span className="tabular text-2xs text-subtle">{t("line {line}", { line: r.line })}</span>
									</span>
									<span className="break-all font-mono text-2xs text-muted-foreground">{r.path}</span>
								</li>
							);
						})}
					</ul>
				</div>
			) : null}
			<PathList label={t("Written")} items={result.written} />
			{result.removed.length > 0 ? (
				<>
					<p className="text-xs text-muted-foreground">{t("Removed from the working tree because the context was unshared or deleted:")}</p>
					<PathList label={t("Removed")} items={result.removed} />
				</>
			) : null}
			<PathList label={t("Unchanged")} items={result.unchanged} />
		</div>
	);
}

function ImportReport({ result, contexts, workspaceId, projectId }: { result: ContextImportResult; contexts: Context[]; workspaceId: string; projectId: string }) {
	const byRef = (ref: string) => contexts.find((c) => c.id === ref || c.gitPath === ref);
	return (
		<div className="flex flex-col gap-2" role="status" aria-live="polite">
			<p className="text-xs text-muted-foreground">
				<span className="font-medium text-foreground">{t("Import finished:")}</span>{" "}
				{result.conflicts.length > 0
					? t("{created} created, {updated} updated, {unchanged} unchanged, {conflicts} in conflict.", { created: result.created.length, updated: result.updated.length, unchanged: result.unchanged.length, conflicts: result.conflicts.length })
					: t("{created} created, {updated} updated, {unchanged} unchanged.", { created: result.created.length, updated: result.updated.length, unchanged: result.unchanged.length })}
			</p>
			{result.conflicts.length > 0 ? (
				<div role="alert" className="flex flex-col gap-2 rounded-lg bg-warning/10 p-3 shadow-[inset_0_0_0_1px_var(--warning)]">
					<div className="flex items-start gap-2 text-xs text-warning">
						<TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
						<p className="font-medium">{t("Conflicts are never auto-merged — resolve them in Shared Context.")}</p>
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
					<summary className="cursor-pointer select-none font-medium coarse:min-h-11 coarse:leading-[2.75rem]">{t("{count, plural, one {# file ignored} other {# files ignored}}", { count: result.skipped.length })}</summary>
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
			<PathList label={t("Created")} items={result.created} />
			<PathList label={t("Updated")} items={result.updated} />
			<PathList label={t("Unchanged")} items={result.unchanged} />
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
				if (r.refused.length > 0) toast.warning(t("{count, plural, one {# context blocked by the secret scanner} other {# contexts blocked by the secret scanner}}", { count: r.refused.length }));
				else toast.success(r.written.length ? t("{count, plural, one {Exported # file to .clmesh/} other {Exported # files to .clmesh/}}", { count: r.written.length }) : t("Nothing to export — .clmesh/ is up to date"));
			},
			onError: (e) => toast.error(t("Export failed"), { description: errorText(e) }),
		});
	const doImport = () =>
		importClmesh.mutate(project.id, {
			onSuccess: (r) => {
				const n = r.created.length + r.updated.length;
				if (r.conflicts.length > 0) toast.warning(t("Imported {n}, {count, plural, one {# conflict} other {# conflicts}} to resolve", { n, count: r.conflicts.length }));
				else toast.success(n ? t("{count, plural, one {Imported # context from .clmesh/} other {Imported # contexts from .clmesh/}}", { count: n }) : t("Nothing new in .clmesh/"));
			},
			onError: (e) => toast.error(t("Import failed"), { description: errorText(e) }),
		});

	return (
		<Card>
			<CardContent className="flex flex-col gap-3">
				<div className="flex items-center gap-2">
					<GitBranch className="size-4 shrink-0 text-accent" aria-hidden />
					<h3 className="text-[13px] font-semibold tracking-tight">{t("Git sync (.clmesh/)")}</h3>
				</div>
				<p className="text-xs text-muted-foreground">
					<T text="Only <b>shareable</b> contexts reach Git. Private contexts stay on this machine. Export writes files into the working tree — it never commits or pushes; review and commit them like any other change." tags={{ b: <span className="font-medium text-foreground" /> }} />
				</p>
				<div className="flex flex-wrap gap-1.5" aria-label={t("Sharing summary")}>
					<Badge variant="success">{t("{count} shareable", { count: formatNumber(shareable) })}</Badge>
					<Badge variant="neutral">{t("{count} private", { count: formatNumber(privateCount) })}</Badge>
				</div>
				<div className="flex flex-wrap gap-2">
					<Button variant="outline" onClick={doExport} loading={exportClmesh.isPending} disabled={importClmesh.isPending || shareable === 0} title={shareable === 0 ? t("Mark a context shareable first") : undefined}>
						<Upload /> {t("Export shareable contexts to .clmesh/")}
					</Button>
					<Button variant="outline" onClick={doImport} loading={importClmesh.isPending} disabled={exportClmesh.isPending}>
						<Download /> {t("Import from .clmesh/")}
					</Button>
				</div>
				{exportClmesh.isError ? (
					<p role="alert" className="text-xs text-danger">
						{errorText(exportClmesh.error)}
					</p>
				) : null}
				{importClmesh.isError ? (
					<p role="alert" className="text-xs text-danger">
						{errorText(importClmesh.error)}
					</p>
				) : null}
				{exportClmesh.data ? <ExportReport result={exportClmesh.data} contexts={contexts} workspaceId={project.workspaceId} /> : null}
				{importClmesh.data ? <ImportReport result={importClmesh.data} contexts={contexts} workspaceId={project.workspaceId} projectId={project.id} /> : null}
				<p className="text-2xs text-subtle">{t("Import after a pull to bring teammates' contexts in. Shareable contexts also sync machine-to-machine to workspace members, with or without Git.")}</p>
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
					<h2 className="text-[15px] font-semibold tracking-tight">{t("Project context")}</h2>
					<p className="text-xs text-muted-foreground">{t("Memory, plans and decisions for {name}. Agents get a short preface of it in new sessions.", { name: project.name })}</p>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<Button asChild variant="ghost">
						<Link to="/workspaces/$workspaceId/context" params={{ workspaceId: project.workspaceId }} search={{ project: project.id }}>
							{t("Open in Shared Context")}
						</Link>
					</Button>
					<Button variant="primary" onClick={() => setAdding(true)}>
						<Plus /> {t("Add context")}
					</Button>
				</div>
			</div>

			{conflicts > 0 ? (
				<div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-danger/10 px-3 py-2.5 text-xs shadow-[inset_0_0_0_1px_var(--danger)]">
					<TriangleAlert className="size-4 shrink-0 text-danger" aria-hidden />
					<p className="min-w-0 flex-1 basis-56 text-danger">
						<T text="<b>{count, plural, one {# context} other {# contexts}} in conflict.</b> Another machine edited the same version — nothing was merged." params={{ count: conflicts }} tags={{ b: <span className="font-medium" /> }} />
					</p>
					<Button asChild size="sm" variant="outline">
						<Link to="/workspaces/$workspaceId/context" params={{ workspaceId: project.workspaceId }} search={{ project: project.id }}>
							{t("Resolve")}
						</Link>
					</Button>
				</div>
			) : null}

			{isGit ? (
				<GitSyncCard project={project} contexts={all} />
			) : (
				<div className="flex items-start gap-2 rounded-lg bg-surface-2/60 px-3 py-2.5 text-xs text-muted-foreground">
					<Info className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
					<p>{t("Contexts sync machine-to-machine to workspace members; no Git repository is needed.")}</p>
				</div>
			)}

			{q.isPending ? (
				<div className="flex flex-col gap-2" aria-busy="true" aria-label={t("Loading contexts")}>
					<Skeleton className="h-7 w-2/3" />
					<Skeleton className="h-14" />
					<Skeleton className="h-14" />
					<Skeleton className="h-14" />
				</div>
			) : q.isError ? (
				<EmptyState
					icon={TriangleAlert}
					title={t("Could not load contexts")}
					description={errorText(q.error)}
					className="py-8"
					action={
						<Button variant="outline" loading={q.isFetching} onClick={() => void q.refetch()}>
							<RefreshCw /> {t("Retry")}
						</Button>
					}
				/>
			) : all.length === 0 ? (
				<EmptyState
					icon={Lightbulb}
					title={t("No project memory yet")}
					description={t("Project memory holds what agents and teammates should remember about this project: conventions, decisions, plans. Agents get it as a short preface in new sessions and can read and add to it with host tools. Contexts are private until you mark them shareable.")}
					action={
						<Button variant="primary" onClick={() => setAdding(true)}>
							<Plus /> {t("Add the first context")}
						</Button>
					}
				/>
			) : (
				<div className="flex flex-col gap-2">
					<div role="group" aria-label={t("Filter by type")} className="scrollbar-thin -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
						<Chip active={type === "all"} onClick={() => setType("all")}>
							{t("All")} <span className="tabular opacity-70">{all.length}</span>
						</Chip>
						{CONTEXT_TYPES.filter((ct) => counts.has(ct.id) || type === ct.id).map((ct) => (
							<Chip key={ct.id} active={type === ct.id} onClick={() => setType(ct.id)}>
								<ct.icon aria-hidden /> {tr(ct.plural)} <span className="tabular opacity-70">{counts.get(ct.id) ?? 0}</span>
							</Chip>
						))}
					</div>
					{sorted.length === 0 ? (
						<p className="px-1 py-6 text-center text-[13px] text-muted-foreground">{t("No contexts of this type.")}</p>
					) : (
						<ul className="flex flex-col gap-0.5 rounded-xl bg-surface-1 p-1 shadow-[inset_0_0_0_1px_var(--border)]" aria-label={t("Project contexts")}>
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
							toast.success(t("Added “{title}”", { title: c.title }));
						}}
					/>
				</Suspense>
			) : null}
		</div>
	);
}
