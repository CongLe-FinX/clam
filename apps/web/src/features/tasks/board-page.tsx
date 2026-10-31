import type { Task } from "@clam/contracts";
import { Link, useParams } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ListChecks, Plus, RefreshCw } from "lucide-react";
import { AnimatePresence, LayoutGroup, MotionConfig, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useBreakpoint } from "@/hooks/use-breakpoint";
import { errorMessage } from "@/lib/api";
import { useProjects, useTasks, useWorkspaces } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty-state";
import { PageHeader } from "@/ui/page";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { Skeleton } from "@/ui/skeleton";
import { type BoardColumn, COLUMNS, columnOf, otherParty } from "./format.ts";
import { TaskCard } from "./task-card.tsx";

/** Above this many cards a column is virtualized (and loses the move animation). */
const VIRTUALIZE_AFTER = 40;
type Direction = "all" | "incoming" | "outgoing";

function useNow(intervalMs = 30_000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(t);
	}, [intervalMs]);
	return now;
}

export default function TaskBoardPage() {
	const { workspaceId } = useParams({ strict: false }) as { workspaceId?: string };
	const openDialog = useUi((s) => s.openDialog);
	const tasks = useTasks();
	const projects = useProjects();
	const workspace = useWorkspaces().data?.find((w) => w.id === workspaceId);
	const bp = useBreakpoint();
	const now = useNow();
	const [dir, setDir] = useState<Direction>("all");
	const [peer, setPeer] = useState("all");
	const [project, setProject] = useState("all");
	const [segment, setSegment] = useState<BoardColumn | null>(null);

	const projectName = useMemo(() => new Map((projects.data ?? []).map((p) => [p.id, p.name])), [projects.data]);
	const inScope = useMemo(() => (tasks.data ?? []).filter((t) => !workspaceId || t.workspaceId === workspaceId), [tasks.data, workspaceId]);
	const peerOptions = useMemo(() => {
		const m = new Map<string, string>();
		for (const t of inScope) m.set(otherParty(t).nodeId, otherParty(t).nodeName);
		return [...m].sort((a, b) => a[1].localeCompare(b[1]));
	}, [inScope]);
	const projectOptions = useMemo(() => (projects.data ?? []).filter((p) => !workspaceId || p.workspaceId === workspaceId), [projects.data, workspaceId]);

	const columns = useMemo(() => {
		const out: Record<BoardColumn, Task[]> = { offered: [], active: [], done: [], closed: [] };
		for (const t of inScope) {
			if (dir !== "all" && t.direction !== dir) continue;
			if (peer !== "all" && otherParty(t).nodeId !== peer) continue;
			if (project !== "all" && t.projectId !== project) continue;
			out[columnOf(t.status)].push(t);
		}
		for (const list of Object.values(out)) list.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
		return out;
	}, [inScope, dir, peer, project]);

	const total = COLUMNS.reduce((n, c) => n + columns[c.id].length, 0);
	const filtering = dir !== "all" || peer !== "all" || project !== "all";
	const mobileColumn = segment ?? (columns.offered.length > 0 ? "offered" : "active");

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="mx-auto flex w-full max-w-[1500px] shrink-0 flex-col gap-3 px-4 pb-3 pt-5 sm:px-6 lg:px-8 lg:pt-7">
				<PageHeader
					eyebrow={workspaceId ? <Link to="/workspaces/$workspaceId" params={{ workspaceId }} className="hover:text-foreground">{workspace?.name ?? "Workspace"}</Link> : "Agent Network"}
					title="Tasks"
					description={bp === "mobile" ? undefined : "Work you delegated to agents on other machines, and work other machines asked this one to do."}
					actions={
						<Button variant="primary" onClick={() => openDialog({ kind: "delegate-task", workspaceId })}>
							<Plus /> Delegate a task
						</Button>
					}
				/>
				<div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
					<div role="group" aria-label="Direction" className="col-span-2 flex rounded-lg bg-surface-2 p-0.5 sm:col-span-1">
						{(["all", "incoming", "outgoing"] as const).map((d) => (
							<button
								key={d}
								type="button"
								aria-pressed={dir === d}
								onClick={() => setDir(d)}
								className={cn(
									"inline-flex h-7 flex-1 items-center justify-center rounded-md px-3 text-xs font-medium capitalize outline-none transition-colors focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:h-10 sm:flex-none",
									dir === d ? "bg-surface-3 text-foreground" : "text-muted-foreground hover:text-foreground",
								)}
							>
								{d}
							</button>
						))}
					</div>
					<Select value={peer} onValueChange={setPeer}>
						<SelectTrigger aria-label="Filter by machine" className="sm:w-48">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">All machines</SelectItem>
							{peerOptions.map(([id, name]) => (
								<SelectItem key={id} value={id}>
									{name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Select value={project} onValueChange={setProject}>
						<SelectTrigger aria-label="Filter by project" className="sm:w-48">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">All projects</SelectItem>
							{projectOptions.map((p) => (
								<SelectItem key={p.id} value={p.id}>
									{p.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</div>

			{tasks.isPending ? (
				<div aria-busy className="mx-auto grid w-full max-w-[1500px] grid-cols-1 gap-3 px-4 sm:px-6 md:grid-cols-4 lg:px-8">
					{[0, 1, 2, 3].map((i) => (
						<Skeleton key={i} className="h-48 rounded-xl" />
					))}
				</div>
			) : tasks.error ? (
				<EmptyState
					icon={ListChecks}
					title="Could not load tasks"
					description={errorMessage(tasks.error)}
					action={
						<Button size="sm" variant="outline" onClick={() => void tasks.refetch()}>
							<RefreshCw /> Retry
						</Button>
					}
				/>
			) : inScope.length === 0 ? (
				<EmptyState
					icon={ListChecks}
					title="No tasks yet"
					description="Delegate a task to an agent on a paired machine, or wait for another machine to send you one. Agents can also delegate on their own."
					action={
						<Button variant="primary" onClick={() => openDialog({ kind: "delegate-task", workspaceId })}>
							<Plus /> Delegate a task
						</Button>
					}
				/>
			) : bp === "mobile" ? (
				<div className="flex min-h-0 flex-1 flex-col">
					<div role="tablist" aria-label="Task status" className="scrollbar-none mx-4 mb-2 flex shrink-0 gap-1 overflow-x-auto rounded-lg bg-surface-2 p-0.5">
						{COLUMNS.map((c) => (
							<button
								key={c.id}
								type="button"
								role="tab"
								aria-selected={mobileColumn === c.id}
								onClick={() => setSegment(c.id)}
								className={cn(
									"inline-flex h-10 flex-1 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-xs font-medium outline-none transition-colors",
									mobileColumn === c.id ? "bg-surface-3 text-foreground" : "text-muted-foreground",
								)}
							>
								{c.id === "closed" ? "Closed" : c.label}
								<span className="tabular font-mono text-2xs text-subtle">{columns[c.id].length}</span>
							</button>
						))}
					</div>
					<div className="min-h-0 flex-1 px-4">
						<ColumnList tasks={columns[mobileColumn]} projectName={projectName} now={now} empty={filtering ? "No tasks match the filters." : "Nothing here."} />
					</div>
				</div>
			) : (
				<MotionConfig reducedMotion="user">
					<LayoutGroup>
						<div className="mx-auto grid min-h-0 w-full max-w-[1500px] flex-1 grid-cols-4 gap-3 px-4 pb-4 sm:px-6 lg:px-8">
							{COLUMNS.map((c) => (
								<section key={c.id} aria-label={c.label} className="flex min-h-0 flex-col rounded-2xl bg-surface-2/60 shadow-[inset_0_0_0_1px_var(--border)]">
									<header className="flex shrink-0 items-baseline gap-2 px-3 pb-1.5 pt-3" title={c.hint}>
										<h2 className="whitespace-nowrap text-xs font-semibold">{c.label}</h2>
										<span className="tabular font-mono text-2xs text-subtle">{columns[c.id].length}</span>
									</header>
									<div className="min-h-0 flex-1 px-2 pb-2">
										<ColumnList tasks={columns[c.id]} projectName={projectName} now={now} empty={filtering ? "No tasks match." : "Nothing here."} animate />
									</div>
								</section>
							))}
						</div>
					</LayoutGroup>
				</MotionConfig>
			)}
			{total === 0 && inScope.length > 0 && filtering ? (
				<div className="px-4 pb-4 text-center">
					<Button
						size="sm"
						variant="outline"
						onClick={() => {
							setDir("all");
							setPeer("all");
							setProject("all");
						}}
					>
						Clear filters
					</Button>
				</div>
			) : null}
		</div>
	);
}

function ColumnList({ tasks, projectName, now, empty, animate }: { tasks: Task[]; projectName: Map<string, string>; now: number; empty: string; animate?: boolean }) {
	if (tasks.length > VIRTUALIZE_AFTER) return <VirtualCards tasks={tasks} projectName={projectName} now={now} />;
	return (
		<div className="scrollbar-thin h-full overflow-y-auto overscroll-contain">
			{tasks.length === 0 ? <p className="px-2 py-6 text-center text-xs text-subtle">{empty}</p> : null}
			<ul className="flex flex-col gap-2 pb-1">
				<AnimatePresence initial={false}>
					{tasks.map((t) => (
						<motion.li
							key={t.id}
							layout={animate ? "position" : false}
							layoutId={animate ? t.id : undefined}
							initial={animate ? { opacity: 0, scale: 0.97 } : false}
							animate={{ opacity: 1, scale: 1 }}
							exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.12 } }}
							transition={{ type: "spring", stiffness: 520, damping: 40, mass: 0.7 }}
						>
							<TaskCard task={t} projectName={t.projectId ? projectName.get(t.projectId) : undefined} now={now} />
						</motion.li>
					))}
				</AnimatePresence>
			</ul>
		</div>
	);
}

function VirtualCards({ tasks, projectName, now }: { tasks: Task[]; projectName: Map<string, string>; now: number }) {
	const ref = useRef<HTMLDivElement>(null);
	const v = useVirtualizer({ count: tasks.length, getScrollElement: () => ref.current, estimateSize: () => 118, overscan: 8, getItemKey: (i) => tasks[i]?.id ?? i });
	return (
		<div ref={ref} className="scrollbar-thin h-full overflow-y-auto overscroll-contain [overflow-anchor:none]">
			<div className="relative w-full" style={{ height: v.getTotalSize() }}>
				{v.getVirtualItems().map((item) => {
					const t = tasks[item.index];
					if (!t) return null;
					return (
						<div key={item.key} data-index={item.index} ref={v.measureElement} className="absolute left-0 top-0 w-full pb-2" style={{ transform: `translateY(${item.start}px)` }}>
							<TaskCard task={t} projectName={t.projectId ? projectName.get(t.projectId) : undefined} now={now} />
						</div>
					);
				})}
			</div>
		</div>
	);
}
