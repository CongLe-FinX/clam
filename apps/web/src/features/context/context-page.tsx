import type { Context, ContextSearchHit } from "@clam/contracts";
import { Link, useBlocker, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { BookMarked, Plus, RefreshCw, Search, SearchX, TriangleAlert, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { errorMessage } from "@/lib/api";
import { useProjects, useWorkspaces } from "@/lib/queries";
import { cn } from "@/lib/utils";
import type { ContextSearch } from "@/app/router.tsx";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty-state";
import { Input } from "@/ui/input";
import { PageHeader } from "@/ui/page";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { Skeleton } from "@/ui/skeleton";
import { ContextDetail } from "./detail.tsx";
import ContextEditorDialog from "./editor-dialog.tsx";
import { CONTEXT_TYPES, splitSnippet } from "./format.ts";
import { useContextSearch, useContexts, useNodeNames } from "./hooks.ts";
import { ContextRow } from "./list-row.tsx";

type RowContext = Omit<Context, "body">;
interface Item {
	context: RowContext;
	snippet?: string;
}

function Snippet({ text }: { text: string }) {
	return (
		<>
			{splitSnippet(text).map((s, i) =>
				s.hit ? (
					<mark key={i} className="rounded-sm bg-accent-soft px-0.5 font-medium text-foreground">
						{s.text}
					</mark>
				) : (
					<span key={i}>{s.text}</span>
				),
			)}
		</>
	);
}

function ListSkeleton() {
	return (
		<div aria-busy aria-label="Loading contexts" className="flex flex-col gap-2 px-3 py-2">
			{[0, 1, 2, 3, 4, 5].map((i) => (
				<Skeleton key={i} className="h-[72px] rounded-lg" />
			))}
		</div>
	);
}

const isFinePointer = (): boolean => typeof matchMedia === "function" && matchMedia("(pointer: fine)").matches;

export default function ContextPage() {
	const { workspaceId } = useParams({ strict: false }) as { workspaceId: string };
	const search = useSearch({ strict: false }) as ContextSearch;
	const navigate = useNavigate();
	const workspace = useWorkspaces().data?.find((w) => w.id === workspaceId);
	const projects = useProjects(workspaceId);
	const nodeNames = useNodeNames(workspaceId);
	const projectNames = useMemo(() => new Map((projects.data ?? []).filter((p) => p.workspaceId === workspaceId).map((p) => [p.id, p.name])), [projects.data, workspaceId]);

	const selectedId = search.id;
	const q = search.q ?? "";
	const projectFilter = search.project;
	const concreteProject = projectFilter && projectFilter !== "workspace" ? projectFilter : undefined;
	const typeFilter = search.type;
	const [conflictsOnly, setConflictsOnly] = useState(false);

	// ── URL helpers ──
	const searchRef = useRef(search);
	searchRef.current = search;
	const go = useCallback(
		(patch: Partial<ContextSearch>, replace = false) => {
			void navigate({ to: "/workspaces/$workspaceId/context", params: { workspaceId }, search: { ...searchRef.current, ...patch }, replace });
		},
		[navigate, workspaceId],
	);

	// ── unsaved-edit guard (route changes + browser back) ──
	const dirtyRef = useRef(false);
	const onDirtyChange = useCallback((d: boolean) => {
		dirtyRef.current = d;
	}, []);
	const blocker = useBlocker({ shouldBlockFn: () => dirtyRef.current, enableBeforeUnload: () => dirtyRef.current, withResolver: true });

	// ── search box (debounced → ?q=) ──
	const [qInput, setQInput] = useState(q);
	const lastPushed = useRef(q);
	const inputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (q !== lastPushed.current) {
			lastPushed.current = q;
			setQInput(q);
		}
	}, [q]);
	useEffect(() => {
		const v = qInput.trim();
		if (v === lastPushed.current) return;
		const t = setTimeout(() => {
			lastPushed.current = v;
			go({ q: v || undefined }, true);
		}, 250);
		return () => clearTimeout(t);
	}, [qInput, go]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: focus once on mount
	useEffect(() => {
		if (!selectedId && isFinePointer()) inputRef.current?.focus();
	}, []);

	// ── data ──
	const list = useContexts({ workspaceId });
	const hits = useContextSearch(q, { workspaceId, projectId: concreteProject });
	const searching = q.trim().length > 0;
	const source = searching ? hits : list;

	const baseItems = useMemo<Item[]>(() => {
		if (searching) return (hits.data ?? []).map((h: ContextSearchHit) => ({ context: h.context, snippet: h.snippet }));
		return [...(list.data ?? [])]
			.sort((a, b) => Number(b.sync.state === "conflict") - Number(a.sync.state === "conflict") || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
			.map((c) => ({ context: c }));
	}, [searching, hits.data, list.data]);

	const scoped = useMemo(
		() =>
			baseItems.filter(({ context: c }) => {
				if (projectFilter === "workspace") return c.projectId === null;
				if (projectFilter) return c.projectId === projectFilter;
				return true;
			}),
		[baseItems, projectFilter],
	);
	const counts = useMemo(() => {
		const m = new Map<string, number>();
		for (const { context: c } of scoped) m.set(c.type, (m.get(c.type) ?? 0) + 1);
		return m;
	}, [scoped]);
	const conflictCount = useMemo(() => (list.data ?? []).filter((c) => c.sync.state === "conflict").length, [list.data]);
	const visible = useMemo(
		() => scoped.filter(({ context: c }) => (!typeFilter || c.type === typeFilter) && (!conflictsOnly || c.sync.state === "conflict")),
		[scoped, typeFilter, conflictsOnly],
	);
	const filtering = Boolean(typeFilter || projectFilter || conflictsOnly);

	// ── create dialog (?new=1) ──
	const savedId = useRef<string | null>(null);
	const creating = search.new === "1";
	const closeCreate = () => {
		const id = savedId.current;
		savedId.current = null;
		go({ new: undefined, ...(id ? { id } : {}) }, !id);
	};

	const newButton = (
		<Button variant="primary" onClick={() => go({ new: "1" })}>
			<Plus /> New
		</Button>
	);

	const listBody: ReactNode = source.isPending ? (
		<ListSkeleton />
	) : source.error ? (
		<EmptyState
			icon={BookMarked}
			title={searching ? "Search failed" : "Could not load contexts"}
			description={errorMessage(source.error)}
			action={
				<Button size="sm" variant="outline" onClick={() => void source.refetch()}>
					<RefreshCw /> Retry
				</Button>
			}
		/>
	) : visible.length === 0 ? (
		searching ? (
			<EmptyState
				icon={SearchX}
				title={`No results for “${q}”`}
				description={filtering ? "Try another search or clear the filters." : "Search covers titles and content of every context you can see."}
				action={
					filtering ? (
						<Button
							size="sm"
							variant="outline"
							onClick={() => {
								setConflictsOnly(false);
								go({ type: undefined, project: undefined }, true);
							}}
						>
							Clear filters
						</Button>
					) : undefined
				}
			/>
		) : (list.data ?? []).length === 0 ? (
			<EmptyState
				icon={BookMarked}
				title="No shared context yet"
				description="Save memories, plans and decisions here so you and your agents don't lose them. Contexts are private to this machine unless you make them shareable."
				action={newButton}
			/>
		) : (
			<EmptyState
				icon={SearchX}
				title="Nothing matches these filters"
				action={
					<Button
						size="sm"
						variant="outline"
						onClick={() => {
							setConflictsOnly(false);
							go({ type: undefined, project: undefined }, true);
						}}
					>
						Clear filters
					</Button>
				}
			/>
		)
	) : (
		<ul aria-label="Contexts" className="flex flex-col gap-0.5 px-2 py-2">
			{visible.map(({ context: c, snippet }) => (
				<li key={c.id}>
					<ContextRow
						context={c}
						nodeNames={nodeNames}
						selected={c.id === selectedId}
						projectName={c.projectId ? (projectNames.get(c.projectId) ?? "Project") : null}
						snippet={snippet ? <Snippet text={snippet} /> : undefined}
						onSelect={() => go({ id: c.id })}
					/>
				</li>
			))}
		</ul>
	);

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className={cn("mx-auto w-full max-w-[1500px] shrink-0 px-4 pb-3 pt-5 sm:px-6 lg:px-8 lg:pt-7", selectedId && "max-lg:hidden")}>
				<PageHeader
					eyebrow={
						<Link to="/workspaces/$workspaceId" params={{ workspaceId }} className="rounded-sm outline-none hover:text-foreground focus-visible:shadow-[0_0_0_2px_var(--accent)]">
							{workspace?.name ?? "Workspace"}
						</Link>
					}
					title="Shared Context"
					description={<span className="hidden sm:inline">Memories, plans and decisions your team and agents can rely on. Private by default; shareable ones sync to every member machine.</span>}
					actions={newButton}
				/>
			</div>

			<div className="flex min-h-0 flex-1 border-t">
				<aside aria-label="Context list" className={cn("flex min-h-0 w-full flex-col lg:w-[360px] lg:shrink-0 lg:border-r", selectedId && "max-lg:hidden")}>
					<div className="flex shrink-0 flex-col gap-2 px-3 pb-2 pt-3">
						<div className="relative">
							<Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle" aria-hidden />
							<Input
								ref={inputRef}
								type="search"
								value={qInput}
								onChange={(e) => setQInput(e.target.value)}
								placeholder="Search memories, plans, decisions…"
								aria-label="Search contexts"
								className="pl-8 pr-9 [&::-webkit-search-cancel-button]:hidden"
							/>
							{qInput ? (
								<button
									type="button"
									aria-label="Clear search"
									onClick={() => {
										setQInput("");
										lastPushed.current = "";
										go({ q: undefined }, true);
										inputRef.current?.focus();
									}}
									className="absolute right-1 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-md text-subtle outline-none hover:text-foreground focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:size-10"
								>
									<X className="size-3.5" />
								</button>
							) : null}
						</div>
						<Select value={projectFilter ?? "all"} onValueChange={(v) => go({ project: v === "all" ? undefined : v }, true)}>
							<SelectTrigger aria-label="Filter by scope">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">All scopes</SelectItem>
								<SelectItem value="workspace">Workspace-wide</SelectItem>
								{[...projectNames].map(([id, name]) => (
									<SelectItem key={id} value={id}>
										{name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<div role="group" aria-label="Filter by type" className="flex flex-wrap gap-1.5">
							{[{ id: undefined, label: "All", total: scoped.length }, ...CONTEXT_TYPES.map((t) => ({ id: t.id, label: t.plural, total: counts.get(t.id) ?? 0 }))].map((t) => {
								const active = typeFilter === t.id;
								return (
									<button
										key={t.id ?? "all"}
										type="button"
										aria-pressed={active}
										onClick={() => go({ type: t.id }, true)}
										className={cn(
											"inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium outline-none transition-colors focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:h-11",
											active ? "bg-accent-soft text-accent" : "bg-surface-2 text-muted-foreground hover:text-foreground",
										)}
									>
										{t.label}
										<span className="tabular font-mono text-2xs">{t.total}</span>
									</button>
								);
							})}
						</div>
						{conflictCount > 0 ? (
							<button
								type="button"
								aria-pressed={conflictsOnly}
								onClick={() => setConflictsOnly((v) => !v)}
								className={cn(
									"flex min-h-9 items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs font-medium text-danger outline-none transition-colors focus-visible:shadow-[0_0_0_2px_var(--danger)] coarse:min-h-11",
									conflictsOnly ? "bg-danger/20" : "bg-danger/10 hover:bg-danger/15",
								)}
							>
								<TriangleAlert className="size-3.5 shrink-0" aria-hidden />
								<span className="flex-1">
									{conflictCount} {conflictCount === 1 ? "context is" : "contexts are"} in conflict
								</span>
								<span className="shrink-0 underline-offset-2">{conflictsOnly ? "Show all" : "Review"}</span>
							</button>
						) : null}
					</div>
					<div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-contain">{listBody}</div>
				</aside>

				<section aria-label="Context detail" className={cn("min-h-0 min-w-0 flex-1 flex-col", selectedId ? "flex" : "hidden lg:flex")}>
					{selectedId ? (
						<ContextDetail
							key={selectedId}
							id={selectedId}
							projectNames={projectNames}
							nodeNames={nodeNames}
							onBack={() => go({ id: undefined })}
							onDeleted={() => go({ id: undefined }, true)}
							onDirtyChange={onDirtyChange}
						/>
					) : (
						<EmptyState
							className="m-auto"
							icon={BookMarked}
							title="Select a context"
							description="Pick one from the list to read it, edit it, see its history or resolve a sync conflict — or add a new one."
							action={newButton}
						/>
					)}
				</section>
			</div>

			{creating ? (
				<ContextEditorDialog
					workspaceId={workspaceId}
					projectId={concreteProject}
					onSaved={(c) => {
						savedId.current = c.id;
					}}
					onClose={closeCreate}
				/>
			) : null}
			<ConfirmDialog
				open={blocker.status === "blocked"}
				onOpenChange={(o) => {
					if (!o) blocker.reset?.();
				}}
				title="Discard your unsaved edits?"
				description="You are in the middle of editing a context. Leaving now loses your changes."
				confirmLabel="Discard and leave"
				danger
				onConfirm={() => {
					dirtyRef.current = false;
					blocker.proceed?.();
				}}
			/>
		</div>
	);
}
