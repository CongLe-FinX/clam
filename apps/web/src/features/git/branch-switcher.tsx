import type { GitBranch, GitStatus } from "@clam/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Check, ChevronDown, Cloud, GitBranch as BranchIcon, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { errorMessage } from "@/lib/api";
import { cn, relativeTime } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Skeleton } from "@/ui/skeleton";
import { useBranches } from "./hooks.ts";
import { checkoutBranch, createBranch } from "./ops.ts";
import { normalizeRemoteBranch } from "./status-utils.ts";

export function BranchSwitcher({ projectId, status, open, onOpenChange, disabled }: { projectId: string; status: GitStatus; open: boolean; onOpenChange: (o: boolean) => void; disabled?: boolean }) {
	const qc = useQueryClient();
	const branches = useBranches(projectId, open);
	const [query, setQuery] = useState("");
	useEffect(() => {
		if (!open) setQuery("");
	}, [open]);

	const label = status.branch ?? (status.headSha ? `detached @ ${status.headSha.slice(0, 7)}` : "no branch");
	const needle = query.trim().toLowerCase();

	const { local, remote, exact } = useMemo(() => {
		const all = branches.data ?? [];
		const locals = all.filter((b) => !b.remote);
		const localNames = new Set(locals.map((b) => b.name));
		const remotes = all.filter((b) => b.remote && !b.name.endsWith("/HEAD") && !localNames.has(normalizeRemoteBranch(b.name)));
		const match = (b: GitBranch) => !needle || b.name.toLowerCase().includes(needle);
		return { local: locals.filter(match), remote: remotes.filter(match), exact: all.some((b) => normalizeRemoteBranch(b.name) === query.trim()) };
	}, [branches.data, needle, query]);

	const pick = (b: GitBranch) => {
		if (b.current) return onOpenChange(false);
		onOpenChange(false);
		void checkoutBranch(qc, projectId, b.remote ? normalizeRemoteBranch(b.name) : b.name);
	};
	const create = () => {
		const name = query.trim();
		onOpenChange(false);
		void createBranch(qc, projectId, name, status.branch ?? undefined);
	};
	const canCreate = query.trim().length > 0 && !exact && !/\s/.test(query.trim());

	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			<PopoverTrigger asChild>
				<button
					type="button"
					disabled={disabled}
					aria-label={`Branch: ${label}. Switch branch`}
					className="group inline-flex h-8 max-w-[14rem] min-w-0 items-center gap-1.5 rounded-lg bg-surface-2 px-2.5 text-[13px] font-medium outline-none transition-colors hover:bg-surface-3 focus-visible:shadow-[0_0_0_2px_var(--accent)] disabled:opacity-60 coarse:h-11"
				>
					<BranchIcon aria-hidden className="size-3.5 shrink-0 text-accent" />
					<span className="min-w-0 truncate font-mono text-xs">{label}</span>
					<ChevronDown aria-hidden className="size-3.5 shrink-0 text-subtle transition-transform group-data-[state=open]:rotate-180" />
				</button>
			</PopoverTrigger>
			<PopoverContent align="start" className="flex w-[22rem] flex-col gap-2 p-2">
				<input
					autoFocus
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && canCreate && local.length + remote.length === 0) create();
					}}
					placeholder="Find or create a branch…"
					aria-label="Find or create a branch"
					spellCheck={false}
					autoCapitalize="off"
					className="h-8 w-full rounded-lg bg-surface-2 px-2.5 font-mono text-xs outline-none placeholder:font-sans placeholder:text-subtle focus-visible:shadow-[inset_0_0_0_1px_var(--accent)] coarse:h-11"
				/>
				<div className="scrollbar-thin max-h-72 overflow-y-auto overscroll-contain">
					{branches.isPending ? (
						<div className="flex flex-col gap-1.5 p-1">
							<Skeleton className="h-8" />
							<Skeleton className="h-8" />
							<Skeleton className="h-8" />
						</div>
					) : branches.error ? (
						<p className="px-2 py-3 text-xs text-danger">{errorMessage(branches.error)}</p>
					) : (
						<>
							{canCreate ? (
								<button
									type="button"
									onClick={create}
									className="mb-1 flex w-full items-center gap-2 rounded-md bg-accent-soft px-2 py-2 text-left text-[13px] text-accent outline-none hover:bg-accent-soft/80 focus-visible:shadow-[0_0_0_2px_var(--accent)]"
								>
									<Plus className="size-4 shrink-0" />
									<span className="min-w-0 truncate">
										Create <span className="font-mono font-medium">{query.trim()}</span>
										<span className="text-accent/70"> from {status.branch ?? "HEAD"}</span>
									</span>
								</button>
							) : null}
							<BranchGroup title="Local" items={local} onPick={pick} />
							<BranchGroup title="Remote" items={remote} onPick={pick} remote />
							{local.length + remote.length === 0 && !canCreate ? <p className="px-2 py-4 text-center text-xs text-subtle">No matching branches.</p> : null}
						</>
					)}
				</div>
				<p className="px-1 text-2xs text-subtle">Switching never discards changes: it is refused if your uncommitted work would be overwritten.</p>
			</PopoverContent>
		</Popover>
	);
}

function BranchGroup({ title, items, onPick, remote }: { title: string; items: GitBranch[]; onPick: (b: GitBranch) => void; remote?: boolean }) {
	if (items.length === 0) return null;
	return (
		<div className="mb-1">
			<div className="px-2 pb-1 pt-1.5 text-2xs font-semibold uppercase tracking-wider text-subtle">{title}</div>
			{items.map((b) => (
				<button
					key={`${b.remote}:${b.name}`}
					type="button"
					onClick={() => onPick(b)}
					className={cn(
						"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-surface-3 focus-visible:bg-surface-3 coarse:py-2.5",
						b.current && "bg-surface-2",
					)}
				>
					{b.current ? <Check className="size-4 shrink-0 text-accent" /> : remote ? <Cloud className="size-4 shrink-0 text-subtle" /> : <BranchIcon className="size-4 shrink-0 text-subtle" />}
					<span className="flex min-w-0 flex-1 flex-col">
						<span className="truncate font-mono text-xs font-medium">{b.name}</span>
						<span className="truncate text-2xs text-subtle">
							{b.subject} · {relativeTime(b.committedAt)}
						</span>
					</span>
					{!b.remote && ((b.ahead ?? 0) > 0 || (b.behind ?? 0) > 0) ? (
						<span className="flex shrink-0 items-center gap-1.5 font-mono text-2xs text-muted-foreground tabular">
							{(b.ahead ?? 0) > 0 ? (
								<span className="inline-flex items-center">
									<ArrowUp className="size-3" />
									{b.ahead}
								</span>
							) : null}
							{(b.behind ?? 0) > 0 ? (
								<span className="inline-flex items-center">
									<ArrowDown className="size-3" />
									{b.behind}
								</span>
							) : null}
						</span>
					) : null}
				</button>
			))}
		</div>
	);
}
