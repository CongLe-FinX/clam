import type { Handoff } from "@clam/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowRightLeft, ChevronRight, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { errorMessage } from "@/lib/api";
import { cn, relativeTime } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty-state";
import { PageContainer, PageHeader } from "@/ui/page";
import { Skeleton } from "@/ui/skeleton";
import { isActiveHandoff, useHandoffs } from "./api.ts";
import { progressLine } from "./meta.ts";
import { Countdown, FailureBadge, NodeFlow, RoleChip, StateChip, useNow } from "./parts.tsx";

type Scope = "active" | "history";
type RoleFilter = "all" | "target" | "source";
type KindFilter = "all" | "task" | "session";

function Segmented<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (v: T) => void; options: ReadonlyArray<{ id: T; label: string; count?: number }> }) {
	return (
		<div role="radiogroup" aria-label={label} className="inline-flex rounded-lg bg-surface-2 p-0.5">
			{options.map((o) => (
				<button
					key={o.id}
					type="button"
					role="radio"
					aria-checked={value === o.id}
					onClick={() => onChange(o.id)}
					className={cn(
						"inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring coarse:h-11 coarse:px-3.5",
						value === o.id ? "bg-surface-3 text-foreground" : "text-muted-foreground hover:text-foreground",
					)}
				>
					{o.label}
					{o.count ? <span className="tabular font-mono text-2xs text-subtle">{o.count}</span> : null}
				</button>
			))}
		</div>
	);
}

export default function HandoffCenterPage() {
	const q = useHandoffs();
	const now = useNow();
	const [scope, setScope] = useState<Scope>("active");
	const [role, setRole] = useState<RoleFilter>("all");
	const [kind, setKind] = useState<KindFilter>("all");

	const all = q.data;
	const activeCount = useMemo(() => (all ?? []).filter(isActiveHandoff).length, [all]);
	const rows = useMemo(
		() =>
			(all ?? [])
				.filter((h) => (scope === "active") === isActiveHandoff(h) && (role === "all" || h.role === role) && (kind === "all" || h.kind === kind))
				.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
		[all, scope, role, kind],
	);

	return (
		<PageContainer>
			<PageHeader
				title="Handoffs"
				description="Move an in-flight task to another machine. The target restores the files and context, sets up dependencies, validates, and only then takes over."
				actions={
					<Button variant="outline" size="sm" onClick={() => void q.refetch()} loading={q.isFetching && !q.isPending} aria-label="Refresh handoffs">
						<RefreshCw /> Refresh
					</Button>
				}
			/>
			<div className="flex flex-wrap items-center gap-2">
				<Segmented
					label="Active or history"
					value={scope}
					onChange={setScope}
					options={[
						{ id: "active", label: "Active", count: activeCount },
						{ id: "history", label: "History" },
					]}
				/>
				<Segmented
					label="Direction"
					value={role}
					onChange={setRole}
					options={[
						{ id: "all", label: "All" },
						{ id: "target", label: "Incoming" },
						{ id: "source", label: "Outgoing" },
					]}
				/>
				<Segmented
					label="Kind"
					value={kind}
					onChange={setKind}
					options={[
						{ id: "all", label: "Any kind" },
						{ id: "task", label: "Tasks" },
						{ id: "session", label: "Sessions" },
					]}
				/>
			</div>

			{q.isPending ? (
				<div className="flex flex-col gap-2" aria-busy aria-label="Loading handoffs">
					<Skeleton className="h-20" />
					<Skeleton className="h-20" />
					<Skeleton className="h-20" />
				</div>
			) : q.isError ? (
				<EmptyState
					icon={ArrowRightLeft}
					title="Could not load handoffs"
					description={errorMessage(q.error)}
					action={
						<Button variant="outline" onClick={() => void q.refetch()}>
							<RefreshCw /> Retry
						</Button>
					}
				/>
			) : rows.length === 0 ? (
				<EmptyState
					icon={ArrowRightLeft}
					title={scope === "active" ? "No handoffs in progress" : "No handoff history"}
					description={
						scope === "active"
							? "Open a running task and choose “Hand off…” to move it to another machine. Handoffs offered to this machine show up here too."
							: "Finished, cancelled and failed handoffs appear here."
					}
				/>
			) : (
				<ul className="flex flex-col gap-2">
					{rows.map((h) => (
						<li key={h.id}>
							<Row h={h} now={now} />
						</li>
					))}
				</ul>
			)}
		</PageContainer>
	);
}

function Row({ h, now }: { h: Handoff; now: number }) {
	const needsDecision = h.actions.includes("accept");
	const needsApproval = h.actions.includes("approve_setup") && h.setup.some((c) => c.state === "pending_approval");
	const needsYou = needsDecision || needsApproval;
	return (
		<Link
			to="/handoffs/$handoffId"
			params={{ handoffId: h.id }}
			preload="intent"
			className={cn(
				"group flex min-h-[4.5rem] items-center gap-3 rounded-xl bg-surface-1 p-3.5 shadow-[inset_0_0_0_1px_var(--border)] outline-none transition-[background-color,box-shadow] hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring",
				needsYou && "shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--accent)_45%,transparent)]",
			)}
		>
			<div className="flex min-w-0 flex-1 flex-col gap-1.5">
				<div className="flex flex-wrap items-center gap-1.5">
					<StateChip state={h.state} />
					<RoleChip role={h.role} />
					<Badge variant="outline">{h.kind === "task" ? "Task" : "Session"}</Badge>
					<FailureBadge h={h} />
					{needsDecision ? <Badge variant="accent">Needs your decision</Badge> : needsApproval ? <Badge variant="accent">Setup needs approval</Badge> : null}
				</div>
				<div className="truncate text-sm font-medium">{h.title}</div>
				<NodeFlow h={h} />
				<div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-subtle">
					<span className="truncate">{progressLine(h)}</span>
					<Countdown h={h} now={now} />
					<span>{relativeTime(h.updatedAt, now)}</span>
				</div>
			</div>
			<ChevronRight className="size-4 shrink-0 text-subtle transition-transform group-hover:translate-x-0.5" aria-hidden />
		</Link>
	);
}
