import { type AgentSession, type SessionStatus, routes } from "@clam/contracts";
import { useQuery } from "@tanstack/react-query";
import { MessageSquare, Plus, RefreshCw, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { SessionList, SessionSkeletonRows, useDebounced } from "@/features/projects/session-list";
import { api, errorMessage } from "@/lib/api";
import { qk, useProjects, useSessions } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { cn, formatCompact, formatCost } from "@/lib/utils";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty-state";
import { PageHeader } from "@/ui/page";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { Switch } from "@/ui/switch";

type StatusFilter = "all" | SessionStatus;
const CHIPS: Array<{ id: StatusFilter; label: string }> = [
	{ id: "all", label: "All" },
	{ id: "running", label: "Running" },
	{ id: "idle", label: "Idle" },
	{ id: "error", label: "Error" },
	{ id: "stopped", label: "Stopped" },
];

export default function NodeSessionsPage() {
	const openDialog = useUi((s) => s.openDialog);
	const [search, setSearch] = useState("");
	const debounced = useDebounced(search);
	const [status, setStatus] = useState<StatusFilter>("all");
	const [projectId, setProjectId] = useState("all");
	const [showArchived, setShowArchived] = useState(false);

	const active = useSessions();
	// Archived sessions share the same live cache layout; only fetched when requested.
	const archived = useQuery({
		queryKey: qk.sessions({ archived: true }),
		queryFn: ({ signal }) => api.get<AgentSession[]>(routes.sessions, { archived: "true" }, { signal }),
		enabled: showArchived,
	});
	const projects = useProjects();
	const projectNames = useMemo(() => new Map((projects.data ?? []).map((p) => [p.id, p.name] as const)), [projects.data]);

	const merged = useMemo(() => (showArchived ? [...(active.data ?? []), ...(archived.data ?? [])] : (active.data ?? [])), [active.data, archived.data, showArchived]);

	const needle = debounced.trim().toLowerCase();
	const visible = useMemo(() => {
		return merged
			.filter((s) => {
				if (status !== "all" && s.status !== status) return false;
				if (projectId !== "all" && s.projectId !== projectId) return false;
				if (!needle) return true;
				return s.title.toLowerCase().includes(needle) || (s.model ?? "").toLowerCase().includes(needle) || (projectNames.get(s.projectId) ?? "").toLowerCase().includes(needle);
			})
			.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
	}, [merged, status, projectId, needle, projectNames]);

	const counts = useMemo(() => {
		const c: Record<StatusFilter, number> = { all: merged.length, running: 0, idle: 0, error: 0, stopped: 0 };
		for (const s of merged) c[s.status]++;
		return c;
	}, [merged]);

	const summary = useMemo(() => {
		let cost: number | null = null;
		let tokens: number | null = null;
		let running = 0;
		for (const s of visible) {
			if (s.status === "running") running++;
			if (s.stats) {
				cost = (cost ?? 0) + s.stats.cost;
				tokens = (tokens ?? 0) + s.stats.tokens.total;
			}
		}
		return { running, cost, tokens };
	}, [visible]);

	const loading = active.isPending || (showArchived && archived.isPending);
	const error = active.error ?? (showArchived ? archived.error : null);
	const filtered = status !== "all" || projectId !== "all" || needle !== "";

	return (
		<div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-4 px-4 pt-5 sm:px-6 lg:px-8 lg:pt-7">
			<PageHeader
				title="Agent Sessions"
				description="Every session on this node, across all projects."
				actions={
					<Button variant="primary" onClick={() => openDialog({ kind: "create-session" })}>
						<Plus /> New session
					</Button>
				}
			/>

			<dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-border shadow-[inset_0_0_0_1px_var(--border)] sm:grid-cols-4">
				<Stat label="Sessions" value={loading ? null : String(visible.length)} />
				<Stat label="Running" value={loading ? null : String(summary.running)} accent={summary.running > 0} />
				<Stat label="Tokens" value={loading ? null : summary.tokens === null ? "—" : formatCompact(summary.tokens)} />
				<Stat label="Cost" value={loading ? null : formatCost(summary.cost)} />
			</dl>

			<div className="flex flex-col gap-2.5">
				<div className="flex flex-wrap items-center gap-2">
					<div className="relative min-w-48 flex-1">
						<Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
						<input
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							placeholder="Search title, project or model"
							aria-label="Search sessions"
							className="h-8 w-full rounded-lg bg-surface-1 pl-8 pr-3 text-[13px] shadow-[inset_0_0_0_1px_var(--border-strong)] outline-none placeholder:text-subtle focus-visible:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_3px_var(--accent-soft)] coarse:h-11"
						/>
					</div>
					<Select value={projectId} onValueChange={setProjectId}>
						<SelectTrigger aria-label="Filter by project" className="w-44">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">All projects</SelectItem>
							{(projects.data ?? []).map((p) => (
								<SelectItem key={p.id} value={p.id}>
									{p.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground coarse:min-h-11">
						<Switch checked={showArchived} onCheckedChange={setShowArchived} aria-label="Show archived sessions" />
						Show archived
					</label>
				</div>
				<div role="group" aria-label="Filter by status" className="scrollbar-none flex gap-1 overflow-x-auto">
					{CHIPS.map((c) => (
						<button
							key={c.id}
							type="button"
							aria-pressed={status === c.id}
							onClick={() => setStatus(c.id)}
							className={cn(
								"inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium outline-none transition-colors coarse:h-10 coarse:px-3.5",
								status === c.id ? "bg-surface-3 text-foreground" : "text-muted-foreground hover:bg-surface-2 hover:text-foreground",
							)}
						>
							{c.label}
							<span className="tabular text-2xs text-subtle">{loading ? "" : counts[c.id]}</span>
						</button>
					))}
				</div>
			</div>

			<div className="min-h-0 flex-1 overflow-hidden rounded-t-xl bg-surface-1 shadow-[inset_0_0_0_1px_var(--border)]">
				{loading ? (
					<SessionSkeletonRows count={8} />
				) : error ? (
					<EmptyState
						icon={MessageSquare}
						title="Could not load sessions"
						description={errorMessage(error)}
						action={
							<Button
								size="sm"
								variant="outline"
								onClick={() => {
									void active.refetch();
									if (showArchived) void archived.refetch();
								}}
							>
								<RefreshCw /> Retry
							</Button>
						}
					/>
				) : (
					<SessionList
						sessions={visible}
						projectNames={projectNames}
						empty={
							<EmptyState
								icon={MessageSquare}
								title={filtered ? "No matching sessions" : "No sessions yet"}
								description={filtered ? "Adjust the search or filters to see more." : "Create a session in one of your projects to get an agent working."}
								action={
									filtered ? (
										<Button
											size="sm"
											variant="outline"
											onClick={() => {
												setSearch("");
												setStatus("all");
												setProjectId("all");
											}}
										>
											Clear filters
										</Button>
									) : (
										<Button variant="primary" size="sm" onClick={() => openDialog({ kind: "create-session" })}>
											<Plus /> New session
										</Button>
									)
								}
							/>
						}
					/>
				)}
			</div>
		</div>
	);
}

function Stat({ label, value, accent }: { label: string; value: string | null; accent?: boolean }) {
	return (
		<div className="flex flex-col gap-0.5 bg-surface-1 px-4 py-2.5">
			<dt className="text-2xs font-medium uppercase tracking-wider text-subtle">{label}</dt>
			<dd className={cn("font-mono text-base font-medium tabular", accent && "text-accent")}>{value ?? <span className="inline-block h-4 w-10 animate-pulse rounded bg-surface-3 align-middle" />}</dd>
		</div>
	);
}
