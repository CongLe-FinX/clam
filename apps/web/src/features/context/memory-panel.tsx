import type { AgentSession, Context, ContextSearchHit, ContextType } from "@clam/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRight, ExternalLink, Info, Lightbulb, Plus, Search, TriangleAlert, X } from "lucide-react";
import { type FormEvent, useEffect, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { LazyMarkdown } from "@/components/lazy-markdown";
import { t, tr } from "@/i18n";
import { errorText } from "@/lib/api";
import { useProject } from "@/lib/queries";
import { cn, relativeTime } from "@/lib/utils";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty-state";
import { fieldClass, Input } from "@/ui/input";
import { Skeleton } from "@/ui/skeleton";
import { Switch } from "@/ui/switch";
import { Textarea } from "@/ui/textarea";
import { CONTEXT_TYPES, contextTypeInfo, splitSnippet } from "./format.ts";
import { useContext, useContextMutations, useContextSearch, useContexts, useNodeNames } from "./hooks.ts";
import { SyncChip } from "./list-row.tsx";

type Item = Omit<Context, "body"> & { body?: string };

function MemoryItem({ item, nodeNames, snippet, projectName }: { item: Item; nodeNames: Map<string, string>; snippet?: string; projectName?: string }) {
	const [open, setOpen] = useState(false);
	const panelId = useId();
	// Search hits carry no body: fetch it when expanded.
	const full = useContext(open && item.body === undefined ? item.id : undefined);
	const body = item.body ?? full.data?.body;
	return (
		<li className="rounded-lg bg-surface-2/60 shadow-[inset_0_0_0_1px_var(--border)]">
			<button
				type="button"
				aria-expanded={open}
				aria-controls={panelId}
				onClick={() => setOpen((o) => !o)}
				className="flex min-h-[44px] w-full min-w-0 items-start gap-2 rounded-lg px-2.5 py-2 text-left outline-none transition-colors hover:bg-surface-3/50 focus-visible:shadow-[0_0_0_2px_var(--accent)]"
			>
				<ChevronRight className={cn("mt-0.5 size-3.5 shrink-0 text-subtle transition-transform", open && "rotate-90")} aria-hidden />
				<span className="flex min-w-0 flex-1 flex-col gap-1">
					<span className="flex min-w-0 items-center gap-2">
						<span className="min-w-0 flex-1 truncate text-[13px] font-medium">{item.title}</span>
						<span className="shrink-0 text-2xs text-subtle tabular">{relativeTime(item.updatedAt)}</span>
					</span>
					{snippet ? (
						<span className="line-clamp-2 text-xs text-muted-foreground">
							{splitSnippet(snippet).map((s, i) =>
								s.hit ? (
									<mark key={i} className="rounded-sm bg-accent-soft px-0.5 text-foreground">
										{s.text}
									</mark>
								) : (
									<span key={i}>{s.text}</span>
								),
							)}
						</span>
					) : null}
					<span className="flex min-w-0 flex-wrap items-center gap-1.5">
						<SyncChip context={item} nodeNames={nodeNames} />
						<span className="truncate text-2xs text-subtle">{projectName ?? (item.projectId === null ? t("Workspace-wide") : t("This project"))}</span>
					</span>
				</span>
			</button>
			{open ? (
				<div id={panelId} className="flex flex-col gap-2 border-t px-3 py-2.5">
					{body === undefined ? (
						full.isError ? (
							<p role="alert" className="text-xs text-danger">
								{errorText(full.error)}
							</p>
						) : (
							<div className="flex flex-col gap-1.5" aria-busy="true">
								<Skeleton className="h-3 w-full" />
								<Skeleton className="h-3 w-2/3" />
							</div>
						)
					) : body.trim() ? (
						<div className="min-w-0 text-[13px]">
							<LazyMarkdown text={body} />
						</div>
					) : (
						<p className="text-xs text-subtle">{t("No content.")}</p>
					)}
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-subtle">
						<span>
							v{item.version} · {item.author.agentName ? `${item.author.agentName}@` : ""}
							{item.author.nodeName}
						</span>
						<Button asChild size="sm" variant="ghost" className="ml-auto">
							<Link to="/workspaces/$workspaceId/context" params={{ workspaceId: item.workspaceId }} search={{ id: item.id, ...(item.projectId ? { project: item.projectId } : {}) }}>
								<ExternalLink /> {t("Open")}
							</Link>
						</Button>
					</div>
				</div>
			) : null}
		</li>
	);
}

function AddForm({ workspaceId, projectId, onDone }: { workspaceId: string; projectId: string; onDone: () => void }) {
	const { create } = useContextMutations();
	const [type, setType] = useState<ContextType>("memory");
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const [shareable, setShareable] = useState(false);
	const ids = { type: useId(), title: useId(), body: useId(), share: useId() };
	const canSave = title.trim().length > 0 && !create.isPending;

	const submit = (e: FormEvent) => {
		e.preventDefault();
		if (!canSave) return;
		create.mutate(
			{ workspaceId, projectId, type, title: title.trim(), body, shareable },
			{
				onSuccess: (c) => {
					toast.success(t("Saved “{title}” to project memory", { title: c.title }));
					onDone();
				},
				onError: (err) => toast.error(t("Could not save"), { description: errorText(err) }),
			},
		);
	};

	return (
		<form onSubmit={submit} className="flex flex-col gap-2.5 rounded-xl bg-surface-2/60 p-3 shadow-[inset_0_0_0_1px_var(--border)]" aria-label={t("Add project memory")}>
			<div className="flex items-center gap-2">
				<h3 className="min-w-0 flex-1 text-[13px] font-semibold">{t("Add to this project's memory")}</h3>
				<Button type="button" size="icon-sm" variant="ghost" onClick={onDone} aria-label={t("Close form")}>
					<X />
				</Button>
			</div>
			<div className="flex flex-col gap-1">
				<label htmlFor={ids.type} className="text-2xs font-medium text-muted-foreground">
					{t("Type")}
				</label>
				<select id={ids.type} value={type} onChange={(e) => setType(e.target.value as ContextType)} className={cn(fieldClass, "h-8 coarse:h-11")} title={tr(contextTypeInfo(type).hint)}>
					{CONTEXT_TYPES.map((ct) => (
						<option key={ct.id} value={ct.id}>
							{tr(ct.label)}
						</option>
					))}
				</select>
			</div>
			<div className="flex flex-col gap-1">
				<label htmlFor={ids.title} className="text-2xs font-medium text-muted-foreground">
					{t("Title")}
				</label>
				<Input id={ids.title} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder={t("e.g. Tests run with pnpm test:unit")} autoFocus />
			</div>
			<div className="flex flex-col gap-1">
				<label htmlFor={ids.body} className="text-2xs font-medium text-muted-foreground">
					{t("Details (Markdown)")}
				</label>
				<Textarea id={ids.body} value={body} onChange={(e) => setBody(e.target.value)} rows={4} placeholder={t("What should agents and teammates remember?")} />
			</div>
			<div className="flex items-start gap-2.5">
				<Switch id={ids.share} checked={shareable} onCheckedChange={setShareable} aria-describedby={`${ids.share}-copy`} />
				<label htmlFor={ids.share} className="flex min-w-0 flex-col gap-0.5">
					<span className="text-xs font-medium">{t("Shareable")}</span>
					<span id={`${ids.share}-copy`} className="text-2xs text-subtle">
						{shareable ? t("Synced to this workspace's member machines (and can be exported to Git).") : t("Private: stays on this machine and is never sent anywhere.")}
					</span>
				</label>
			</div>
			{create.isError ? (
				<p role="alert" className="text-xs text-danger">
					{errorText(create.error)}
				</p>
			) : null}
			<div className="flex justify-end gap-2">
				<Button type="button" variant="ghost" onClick={onDone}>
					{t("Cancel")}
				</Button>
				<Button type="submit" variant="primary" loading={create.isPending} disabled={!canSave && !create.isPending}>
					{t("Save")}
				</Button>
			</div>
		</form>
	);
}

function Groups({ items, nodeNames, projectNames }: { items: Item[]; nodeNames: Map<string, string>; projectNames?: Map<string, string> }) {
	const groups = CONTEXT_TYPES.map((ct) => ({ ct, rows: items.filter((c) => c.type === ct.id) })).filter((g) => g.rows.length > 0);
	return (
		<div className="flex flex-col gap-3">
			{groups.map(({ ct, rows }) => (
				<section key={ct.id} aria-label={tr(ct.plural)} className="flex flex-col gap-1.5">
					<h3 className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-subtle [&_svg]:size-3">
						<ct.icon aria-hidden /> {tr(ct.plural)} <span className="tabular font-mono normal-case tracking-normal">{rows.length}</span>
					</h3>
					<ul className="flex flex-col gap-1.5">
						{rows.map((c) => (
							<MemoryItem key={c.id} item={c} nodeNames={nodeNames} projectName={c.projectId ? projectNames?.get(c.projectId) : undefined} />
						))}
					</ul>
				</section>
			))}
		</div>
	);
}

function SearchResults({ hits, nodeNames }: { hits: ContextSearchHit[]; nodeNames: Map<string, string> }) {
	return (
		<ul className="flex flex-col gap-1.5" aria-label={t("Search results")}>
			{hits.map((h) => (
				<MemoryItem key={h.context.id} item={h.context} nodeNames={nodeNames} snippet={h.snippet} />
			))}
		</ul>
	);
}

/** Session page → right-panel 'Memory' tab: this project's contexts plus workspace-wide ones, search and quick add. */
export default function MemoryPanel({ session }: { session: AgentSession }) {
	const project = useProject(session.projectId);
	const workspaceId = project.data?.workspaceId;
	const projectQ = useContexts({ projectId: session.projectId });
	const workspaceQ = useContexts({ workspaceId });
	const nodeNames = useNodeNames(workspaceId);
	const [adding, setAdding] = useState(false);
	const [text, setText] = useState("");
	const [q, setQ] = useState("");
	useEffect(() => {
		const timer = setTimeout(() => setQ(text.trim()), 250);
		return () => clearTimeout(timer);
	}, [text]);
	const search = useContextSearch(q, { workspaceId });

	const items = useMemo(() => {
		const byId = new Map<string, Context>();
		for (const c of projectQ.data ?? []) byId.set(c.id, c);
		for (const c of workspaceQ.data ?? []) if (c.projectId === null) byId.set(c.id, c);
		return [...byId.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
	}, [projectQ.data, workspaceQ.data]);
	const hits = useMemo(() => (search.data ?? []).filter((h) => h.context.projectId === null || h.context.projectId === session.projectId), [search.data, session.projectId]);

	const searching = q.length > 0;
	const pending = project.isPending || projectQ.isPending || (workspaceId !== undefined && workspaceQ.isPending);
	const error = project.error ?? projectQ.error ?? workspaceQ.error;
	const retry = () => void Promise.all([project.refetch(), projectQ.refetch(), workspaceQ.refetch()]);

	let content: React.ReactNode;
	if (searching) {
		content = search.isPending ? (
			<div className="flex flex-col gap-1.5" aria-busy="true">
				<Skeleton className="h-14" />
				<Skeleton className="h-14" />
			</div>
		) : search.isError ? (
			<EmptyState
				icon={TriangleAlert}
				title={t("Search failed")}
				description={errorText(search.error)}
				className="py-8"
				action={
					<Button variant="outline" onClick={() => void search.refetch()}>
						{t("Retry")}
					</Button>
				}
			/>
		) : hits.length === 0 ? (
			<p className="px-1 py-8 text-center text-[13px] text-muted-foreground">{t("No memory matches “{q}”.", { q })}</p>
		) : (
			<SearchResults hits={hits} nodeNames={nodeNames} />
		);
	} else if (pending && !error) {
		content = (
			<div className="flex flex-col gap-2" aria-busy="true" aria-label={t("Loading memory")}>
				<Skeleton className="h-4 w-24" />
				<Skeleton className="h-12" />
				<Skeleton className="h-12" />
				<Skeleton className="h-12" />
			</div>
		);
	} else if (error && items.length === 0) {
		content = (
			<EmptyState
				icon={TriangleAlert}
				title={t("Could not load memory")}
				description={errorText(error)}
				className="py-8"
				action={
					<Button variant="outline" onClick={retry}>
						{t("Retry")}
					</Button>
				}
			/>
		);
	} else if (items.length === 0) {
		content = (
			<EmptyState
				icon={Lightbulb}
				title={t("No project memory yet")}
				description={t("Add conventions, decisions or plans worth remembering. New sessions in this project start with a short preface of it.")}
				className="py-8"
				action={
					<Button variant="primary" onClick={() => setAdding(true)} disabled={!workspaceId}>
						<Plus /> {t("Add memory")}
					</Button>
				}
			/>
		);
	} else {
		content = <Groups items={items} nodeNames={nodeNames} />;
	}

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex shrink-0 flex-col gap-2 border-b px-3 py-2.5">
				<p className="flex items-start gap-1.5 text-2xs text-subtle">
					<Info className="mt-px size-3 shrink-0" aria-hidden />
					{t("New sessions in this project start with a short project-memory preface; agents can also read and add memory with host tools.")}
				</p>
				<div className="flex items-center gap-1.5">
					<div className="relative min-w-0 flex-1">
						<Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle" aria-hidden />
						<Input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder={t("Search memory")} aria-label={t("Search memory")} className="pl-8" disabled={!workspaceId} />
					</div>
					<Button variant="outline" size="md" onClick={() => setAdding((a) => !a)} disabled={!workspaceId} aria-expanded={adding} className="shrink-0">
						<Plus /> {t("Add")}
					</Button>
				</div>
			</div>
			<div className="scrollbar-thin flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain p-3">
				{adding && workspaceId ? <AddForm workspaceId={workspaceId} projectId={session.projectId} onDone={() => setAdding(false)} /> : null}
				{content}
			</div>
		</div>
	);
}
