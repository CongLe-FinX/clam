import type { AgentSession } from "@clam/contracts";
import { routes } from "@clam/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Archive, ArchiveRestore, ExternalLink, MoreHorizontal, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Link } from "@tanstack/react-router";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { SessionRow } from "@/components/session-row";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/ui/dropdown-menu";

/** Returns `value` after it has been stable for `ms`. */
export function useDebounced<T>(value: T, ms = 180): T {
	const [v, setV] = useState(value);
	useEffect(() => {
		const t = setTimeout(() => setV(value), ms);
		return () => clearTimeout(t);
	}, [value, ms]);
	return v;
}

type SessionSnapshot = Array<[readonly unknown[], AgentSession[] | undefined]>;

/** Optimistic archive/unarchive/delete over every cached session list. Rolls back on error. */
export function useSessionActions() {
	const qc = useQueryClient();
	const snapshot = async (): Promise<SessionSnapshot> => {
		await qc.cancelQueries({ queryKey: qk.sessionsAll });
		return qc.getQueriesData<AgentSession[]>({ queryKey: qk.sessionsAll }).filter(([k]) => k.length === 3);
	};
	const rollback = (snap?: SessionSnapshot) => {
		for (const [key, data] of snap ?? []) qc.setQueryData(key, data);
	};
	const settle = () => {
		void qc.invalidateQueries({ queryKey: qk.sessionsAll });
		void qc.invalidateQueries({ queryKey: qk.projectsAll });
	};

	const archive = useMutation({
		mutationFn: ({ id, archived }: { id: string; archived: boolean }) => api.patch<AgentSession>(routes.session(id), { archived }),
		onMutate: async ({ id, archived }) => {
			const snap = await snapshot();
			for (const [key, data] of snap) {
				const f = key[2] as { archived: boolean } | undefined;
				if (!data || !f) continue;
				const hit = data.find((s) => s.id === id);
				if (!hit) continue;
				// Lists of the old archive state lose the row; lists of the new state gain it.
				if (f.archived === archived) continue;
				qc.setQueryData<AgentSession[]>(key, data.filter((s) => s.id !== id));
			}
			const moved = snap.flatMap(([, d]) => d ?? []).find((s) => s.id === id);
			if (moved) {
				for (const [key, data] of snap) {
					const f = key[2] as { projectId: string | null; archived: boolean } | undefined;
					if (!data || !f || f.archived !== archived || (f.projectId && f.projectId !== moved.projectId)) continue;
					if (!data.some((s) => s.id === id)) qc.setQueryData<AgentSession[]>(key, [{ ...moved, archived }, ...data]);
				}
			}
			return { snap };
		},
		onError: (e, v, ctx) => {
			rollback(ctx?.snap);
			toast.error(v.archived ? "Could not archive session" : "Could not restore session", { description: errorMessage(e) });
		},
		onSuccess: (_d, v) => toast.success(v.archived ? "Session archived" : "Session restored"),
		onSettled: settle,
	});

	const remove = useMutation({
		mutationFn: (id: string) => api.delete(routes.session(id)),
		onMutate: async (id) => {
			const snap = await snapshot();
			for (const [key, data] of snap) if (data) qc.setQueryData<AgentSession[]>(key, data.filter((s) => s.id !== id));
			return { snap };
		},
		onError: (e, _id, ctx) => {
			rollback(ctx?.snap);
			toast.error("Could not delete session", { description: errorMessage(e) });
		},
		onSuccess: () => toast.success("Session deleted"),
		onSettled: settle,
	});

	return { archive, remove };
}

export function SessionSkeletonRows({ count = 6 }: { count?: number }) {
	return (
		<div aria-hidden className="flex flex-col">
			{Array.from({ length: count }, (_, i) => (
				<div key={i} className="flex min-h-14 items-center gap-3 border-b px-4 py-2.5 coarse:min-h-16">
					<div className="size-2 rounded-full bg-surface-3" />
					<div className="flex flex-1 flex-col gap-1.5">
						<div className="h-3 w-2/5 animate-pulse rounded bg-surface-2" />
						<div className="h-2.5 w-1/4 animate-pulse rounded bg-surface-2" />
					</div>
					<div className="h-2.5 w-12 animate-pulse rounded bg-surface-2" />
				</div>
			))}
		</div>
	);
}

/** Virtualized list of sessions with a row menu (open / archive / delete). Fills its parent's height. */
export function SessionList({
	sessions,
	projectNames,
	empty,
	className,
}: {
	sessions: AgentSession[];
	projectNames?: ReadonlyMap<string, string>;
	empty?: ReactNode;
	className?: string;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const { archive, remove } = useSessionActions();
	const [pendingDelete, setPendingDelete] = useState<AgentSession | null>(null);
	const v = useVirtualizer({
		count: sessions.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => 60,
		overscan: 8,
		getItemKey: (i) => sessions[i]?.id ?? i,
	});

	return (
		<>
			<div ref={scrollRef} className={cn("scrollbar-thin h-full overflow-y-auto overscroll-contain", className)}>
				{sessions.length === 0 ? (
					empty
				) : (
					<ul className="relative w-full" style={{ height: v.getTotalSize() }}>
						{v.getVirtualItems().map((item) => {
							const s = sessions[item.index] as AgentSession;
							return (
								<li
									key={item.key}
									data-index={item.index}
									ref={v.measureElement}
									className="absolute inset-x-0 top-0 flex items-center border-b"
									style={{ transform: `translateY(${item.start}px)` }}
								>
									<SessionRow session={s} projectName={projectNames?.get(s.projectId)} className={cn("min-w-0 flex-1 border-b-0", s.archived && "opacity-60")} />
									{s.archived ? (
										<Badge variant="outline" className="mr-1 hidden shrink-0 sm:inline-flex">
											Archived
										</Badge>
									) : null}
									<DropdownMenu>
										<DropdownMenuTrigger asChild>
											<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${s.title || "session"}`} className="mr-2 shrink-0">
												<MoreHorizontal />
											</Button>
										</DropdownMenuTrigger>
										<DropdownMenuContent>
											<DropdownMenuItem asChild>
												<Link to="/sessions/$sessionId" params={{ sessionId: s.id }}>
													<ExternalLink /> Open
												</Link>
											</DropdownMenuItem>
											<DropdownMenuItem onSelect={() => archive.mutate({ id: s.id, archived: !s.archived })}>
												{s.archived ? <ArchiveRestore /> : <Archive />}
												{s.archived ? "Restore" : "Archive"}
											</DropdownMenuItem>
											<DropdownMenuSeparator />
											<DropdownMenuItem danger onSelect={() => setPendingDelete(s)}>
												<Trash2 /> Delete…
											</DropdownMenuItem>
										</DropdownMenuContent>
									</DropdownMenu>
								</li>
							);
						})}
					</ul>
				)}
			</div>
			<ConfirmDialog
				open={pendingDelete !== null}
				onOpenChange={(o) => {
					if (!o) setPendingDelete(null);
				}}
				title="Delete session?"
				description={
					<>
						<span className="font-medium text-foreground">{pendingDelete?.title || "Untitled session"}</span> and its history will be permanently removed from this machine.
					</>
				}
				confirmLabel="Delete"
				danger
				onConfirm={() => {
					if (pendingDelete) remove.mutate(pendingDelete.id);
					setPendingDelete(null);
				}}
			/>
		</>
	);
}
