import type { Context, ContextAuthor, ContextVersion } from "@clam/contracts";
import { History, RefreshCw } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { LazyMarkdown } from "@/components/lazy-markdown";
import { errorMessage } from "@/lib/api";
import { type DiffOp, diffStats, lineDiff } from "@/lib/line-diff";
import { cn, relativeTime } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty-state";
import { Skeleton } from "@/ui/skeleton";
import { useContextVersions } from "./hooks.ts";

/** `agent@node` for agents, the machine name for humans and the system. */
export function authorLabel(a: ContextAuthor): string {
	if (a.kind === "agent") return `${a.agentName ?? "agent"}@${a.nodeName}`;
	if (a.kind === "system") return `system@${a.nodeName}`;
	return a.nodeName;
}
export const authorKindLabel = (a: ContextAuthor): string => (a.kind === "agent" ? "agent" : a.kind === "system" ? "system" : "human");

export const shortSha = (sha: string): string => sha.slice(0, 7);

type Row = { kind: DiffOp["kind"]; text: string; a: number | null; b: number | null } | { kind: "skip"; count: number };

/** Line numbers + collapsed runs of unchanged lines (keeps `context` lines around each change). */
function buildRows(ops: DiffOp[], context: number): Row[] {
	const numbered: Array<Extract<Row, { text: string }>> = [];
	let a = 0;
	let b = 0;
	for (const o of ops) {
		if (o.kind === "same") numbered.push({ kind: "same", text: o.text, a: ++a, b: ++b });
		else if (o.kind === "del") numbered.push({ kind: "del", text: o.text, a: ++a, b: null });
		else numbered.push({ kind: "add", text: o.text, a: null, b: ++b });
	}
	const keep = new Array<boolean>(numbered.length).fill(false);
	numbered.forEach((r, i) => {
		if (r.kind === "same") return;
		for (let j = Math.max(0, i - context); j <= Math.min(numbered.length - 1, i + context); j++) keep[j] = true;
	});
	const rows: Row[] = [];
	let skipped = 0;
	numbered.forEach((r, i) => {
		if (keep[i]) {
			if (skipped) rows.push({ kind: "skip", count: skipped });
			skipped = 0;
			rows.push(r);
		} else skipped++;
	});
	if (skipped) rows.push({ kind: "skip", count: skipped });
	return rows;
}

/** +added / −removed chip for a diff. */
export function DiffStat({ ops, className }: { ops: DiffOp[]; className?: string }) {
	const { added, removed } = diffStats(ops);
	return (
		<span className={cn("tabular inline-flex items-center gap-2 font-mono text-2xs", className)}>
			<span className="text-success">+{added}</span>
			<span className="text-danger">−{removed}</span>
		</span>
	);
}

/** Unified line diff with old/new gutters. Never uses innerHTML. */
export const DiffView = memo(function DiffView({ ops, context = 3, className, label = "Changes" }: { ops: DiffOp[]; context?: number; className?: string; label?: string }) {
	const rows = useMemo(() => buildRows(ops, context), [ops, context]);
	const changed = ops.some((o) => o.kind !== "same");
	if (!changed) {
		return <p className={cn("rounded-lg bg-surface-2 px-3 py-3 text-xs text-muted-foreground", className)}>No differences.</p>;
	}
	return (
		<div role="group" aria-label={label} className={cn("scrollbar-thin max-h-96 overflow-y-auto rounded-lg bg-surface-1 font-mono text-xs leading-5 shadow-[inset_0_0_0_1px_var(--border)]", className)}>
			{rows.map((r, i) =>
				r.kind === "skip" ? (
					<div key={`s${i}`} className="bg-surface-2 px-3 py-0.5 text-center text-2xs text-subtle">
						⋯ {r.count} unchanged {r.count === 1 ? "line" : "lines"} ⋯
					</div>
				) : (
					<div
						key={`r${i}`}
						className={cn("grid grid-cols-[2.25rem_2.25rem_1.25rem_minmax(0,1fr)]", r.kind === "add" && "bg-success/10", r.kind === "del" && "bg-danger/10")}
					>
						<span aria-hidden className="select-none px-1 text-right text-2xs text-subtle tabular">
							{r.a ?? ""}
						</span>
						<span aria-hidden className="select-none px-1 text-right text-2xs text-subtle tabular">
							{r.b ?? ""}
						</span>
						<span aria-hidden className={cn("select-none text-center", r.kind === "add" && "text-success", r.kind === "del" && "text-danger")}>
							{r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""}
						</span>
						<span className="whitespace-pre-wrap break-words pr-2">
							{r.kind === "add" || r.kind === "del" ? <span className="sr-only">{r.kind === "add" ? "Added: " : "Removed: "}</span> : null}
							{r.text || " "}
						</span>
					</div>
				),
			)}
		</div>
	);
});

type Mode = "prev" | "current" | "text";
const MODES: Array<{ id: Mode; label: string }> = [
	{ id: "prev", label: "Vs previous" },
	{ id: "current", label: "Vs current" },
	{ id: "text", label: "Full text" },
];

function VersionDetail({ selected, previous, current }: { selected: ContextVersion; previous: ContextVersion | null; current: Pick<Context, "version" | "title" | "body"> }) {
	const [mode, setMode] = useState<Mode>("prev");
	const isCurrent = selected.version === current.version;
	const ops = useMemo(() => {
		if (mode === "prev") return lineDiff(previous?.body ?? "", selected.body);
		if (mode === "current") return lineDiff(selected.body, current.body);
		return [];
	}, [mode, previous, selected.body, current.body]);
	const titleFrom = mode === "prev" ? previous?.title : mode === "current" ? selected.title : undefined;
	const titleTo = mode === "prev" ? selected.title : mode === "current" ? current.title : undefined;
	return (
		<div className="flex min-w-0 flex-col gap-3">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<h3 className="min-w-0 truncate text-sm font-medium">
					v{selected.version} · {selected.title}
				</h3>
				{isCurrent ? <Badge variant="success">Current</Badge> : null}
				<span className="text-xs text-subtle">
					{authorLabel(selected.author)} · {relativeTime(selected.createdAt)} · <span className="font-mono">{shortSha(selected.sha256)}</span>
				</span>
			</div>
			<div role="group" aria-label="Compare" className="flex w-full rounded-lg bg-surface-2 p-0.5 sm:w-fit">
				{MODES.map((m) => (
					<button
						key={m.id}
						type="button"
						aria-pressed={mode === m.id}
						onClick={() => setMode(m.id)}
						className={cn(
							"inline-flex h-7 flex-1 items-center justify-center rounded-md px-3 text-xs font-medium outline-none transition-colors focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:h-11 sm:flex-none",
							mode === m.id ? "bg-surface-3 text-foreground" : "text-muted-foreground hover:text-foreground",
						)}
					>
						{m.label}
					</button>
				))}
			</div>
			{mode === "text" ? (
				<div className="min-w-0 rounded-lg bg-surface-1 p-4 shadow-[inset_0_0_0_1px_var(--border)]">
					{selected.body.trim() ? <LazyMarkdown text={selected.body} /> : <p className="text-xs text-subtle">Empty body.</p>}
				</div>
			) : (
				<>
					{titleFrom !== undefined && titleTo !== undefined && titleFrom !== titleTo ? (
						<p className="text-xs text-muted-foreground">
							Title: <span className="text-danger line-through">{titleFrom}</span> → <span className="text-success">{titleTo}</span>
						</p>
					) : null}
					<div className="flex items-center gap-2 text-xs text-muted-foreground">
						<DiffStat ops={ops} />
						<span>{mode === "prev" ? (previous ? `v${previous.version} → v${selected.version}` : "Initial version") : `v${selected.version} → current (v${current.version})`}</span>
					</div>
					<DiffView ops={ops} label={mode === "prev" ? "Changes vs previous version" : "Changes vs current version"} />
				</>
			)}
		</div>
	);
}

/** History of immutable versions with a body view and a line diff against the previous / current version. */
export function VersionsPanel({ context }: { context: Pick<Context, "id" | "version" | "title" | "body"> }) {
	const q = useContextVersions(context.id);
	const [sel, setSel] = useState<number | null>(null);
	const versions = useMemo(() => [...(q.data ?? [])].sort((a, b) => b.version - a.version), [q.data]);
	const selected = versions.find((v) => v.version === sel) ?? versions[0] ?? null;
	const previous = selected ? (versions.find((v) => v.version < selected.version) ?? null) : null;

	if (q.isPending) {
		return (
			<div aria-busy className="grid gap-4 md:grid-cols-[14rem_minmax(0,1fr)]">
				<div className="flex flex-col gap-2">
					{[0, 1, 2].map((i) => (
						<Skeleton key={i} className="h-11 rounded-lg" />
					))}
				</div>
				<Skeleton className="h-48 rounded-lg" />
			</div>
		);
	}
	if (q.error) {
		return (
			<EmptyState
				icon={History}
				title="Could not load the history"
				description={errorMessage(q.error)}
				action={
					<Button size="sm" variant="outline" onClick={() => void q.refetch()}>
						<RefreshCw /> Retry
					</Button>
				}
			/>
		);
	}
	if (!selected) return <EmptyState icon={History} title="No versions yet" description="Every save creates an immutable version you can compare here." />;

	return (
		<div className="grid min-w-0 gap-4 md:grid-cols-[14rem_minmax(0,1fr)]">
			<ul aria-label="Versions" className="scrollbar-thin flex max-h-56 min-w-0 flex-col gap-0.5 overflow-y-auto md:max-h-[28rem]">
				{versions.map((v) => (
					<li key={v.version}>
						<button
							type="button"
							onClick={() => setSel(v.version)}
							aria-current={v.version === selected.version ? "true" : undefined}
							className={cn(
								"flex min-h-[44px] w-full min-w-0 flex-col justify-center gap-0.5 rounded-lg px-3 py-1.5 text-left outline-none transition-colors focus-visible:shadow-[0_0_0_2px_var(--accent)]",
								v.version === selected.version ? "bg-surface-3" : "hover:bg-surface-2",
							)}
						>
							<span className="flex items-center gap-2 text-[13px] font-medium">
								v{v.version}
								{v.version === context.version ? <Badge variant="success">Current</Badge> : null}
								<span className="ml-auto font-mono text-2xs font-normal text-subtle">{shortSha(v.sha256)}</span>
							</span>
							<span className="truncate text-2xs text-subtle">
								{authorLabel(v.author)} · {relativeTime(v.createdAt)}
							</span>
						</button>
					</li>
				))}
			</ul>
			<VersionDetail key={selected.version} selected={selected} previous={previous} current={context} />
		</div>
	);
}
