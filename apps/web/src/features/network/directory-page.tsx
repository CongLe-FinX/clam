import type { DirectoryAgent, PeerStatus } from "@clam/contracts";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Link } from "@tanstack/react-router";
import { Bot, ChevronRight, Clock, RefreshCw, Plug, Search, Send } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { type Msg, msg, t, tr } from "@/i18n";
import { errorText } from "@/lib/api";
import { isActiveTask, useDirectory, usePeers, useTasks } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { cn, formatDateTime, formatNumber, relativeTime } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty-state";
import { Input } from "@/ui/input";
import { PageHeader } from "@/ui/page";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { Skeleton } from "@/ui/skeleton";
import { StatusDot } from "@/ui/status-dot";
import { PeerStatusBadge } from "./components";
import { ConnectDialog } from "./connect";
import { isStale } from "./format";

type NodeStatus = PeerStatus | "self";
interface Group {
	nodeId: string;
	nodeName: string;
	status: NodeStatus;
	fetchedAt: string | null;
	agents: DirectoryAgent[];
}
type Row = { kind: "header"; key: string; group: Group } | { kind: "agent"; key: string; group: Group; agent: DirectoryAgent } | { kind: "empty"; key: string; text: Msg };

const NODE_RANK: Record<NodeStatus, number> = { self: 0, online: 1, degraded: 2, offline: 3, revoked: 4 };
const AGENT_STATUS = ["online", "busy", "offline"] as const;
const AGENT_STATUS_LABEL: Record<(typeof AGENT_STATUS)[number], Msg> = { online: msg("Online"), busy: msg("Busy"), offline: msg("Offline") };

export default function AgentDirectoryPage() {
	const directory = useDirectory();
	const peers = usePeers();
	const openDialog = useUi((s) => s.openDialog);
	const tasks = useTasks();
	// Unfinished tasks per agent: tasks this machine delegated to a remote agent, and tasks running on its own agents.
	const taskCounts = useMemo(() => {
		const m = new Map<string, number>();
		for (const t of tasks.data ?? []) {
			if (!isActiveTask(t) || !t.executor.agentId) continue;
			const key = `${t.executor.nodeId}:${t.executor.agentId}`;
			m.set(key, (m.get(key) ?? 0) + 1);
		}
		return m;
	}, [tasks.data]);
	const [chooser, setChooser] = useState(false);
	const [node, setNode] = useState("all");
	const [status, setStatus] = useState("all");
	const [q, setQ] = useState("");
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), 30_000);
		return () => clearInterval(t);
	}, []);

	const groups = useMemo(() => {
		const map = new Map<string, Group>();
		for (const a of directory.data ?? []) {
			const g = map.get(a.nodeId) ?? { nodeId: a.nodeId, nodeName: a.nodeName, status: a.nodeStatus, fetchedAt: a.fetchedAt, agents: [] };
			g.agents.push(a);
			if (g.fetchedAt === null || Date.parse(a.fetchedAt) < Date.parse(g.fetchedAt)) g.fetchedAt = a.fetchedAt;
			map.set(a.nodeId, g);
		}
		// A paired node that reported no agents still deserves a header (so "online, 0 agents" is visible).
		for (const p of peers.data ?? []) {
			if (p.status !== "revoked" && !map.has(p.id)) map.set(p.id, { nodeId: p.id, nodeName: p.name, status: p.status, fetchedAt: null, agents: [] });
		}
		return [...map.values()].sort((a, b) => NODE_RANK[a.status] - NODE_RANK[b.status] || a.nodeName.localeCompare(b.nodeName));
	}, [directory.data, peers.data]);

	const query = q.trim().toLowerCase();
	const filtering = query !== "" || status !== "all";
	const rows = useMemo(() => {
		const out: Row[] = [];
		for (const g of groups) {
			if (node !== "all" && g.nodeId !== node) continue;
			const agents = g.agents
				.filter((a) => status === "all" || a.status === status)
				.filter((a) => !query || [a.name, a.role, a.runtime, a.nodeName, ...a.capabilities].some((s) => s.toLowerCase().includes(query)))
				.sort((a, b) => a.name.localeCompare(b.name));
			if (filtering && agents.length === 0) continue;
			out.push({ kind: "header", key: `h:${g.nodeId}`, group: g });
			if (agents.length === 0) out.push({ kind: "empty", key: `e:${g.nodeId}`, text: msg("No agents reported by this machine yet.") });
			for (const a of agents) out.push({ kind: "agent", key: `a:${g.nodeId}:${a.agentId}`, group: g, agent: a });
		}
		return out;
	}, [groups, node, status, query, filtering]);

	const total = directory.data?.length ?? 0;
	const scrollRef = useRef<HTMLDivElement>(null);
	const v = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: (i) => (rows[i]?.kind === "header" ? 52 : rows[i]?.kind === "empty" ? 40 : 76),
		getItemKey: (i) => rows[i]?.key ?? i,
		overscan: 10,
	});

	return (
		<div className="flex h-full flex-col">
			<div className="mx-auto flex w-full max-w-[1400px] shrink-0 flex-col gap-4 px-4 pb-3 pt-5 sm:px-6 lg:px-8 lg:pt-7">
				<PageHeader
					eyebrow={t("Agent Network")}
					title={t("Agent Directory")}
					description={t("Every agent on this machine and on the machines you paired with. Remote entries are cached and refreshed when a machine reports a change.")}
					actions={
						<Button variant="outline" onClick={() => setChooser(true)}>
							<Plug /> {t("Connect a machine")}
						</Button>
					}
				/>
				<div className="grid grid-cols-2 gap-2 sm:grid-cols-[minmax(0,1fr)_12rem_10rem]">
					<div className="relative col-span-2 sm:col-span-1">
						<Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
						<Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Search name, role, runtime, capability…")} aria-label={t("Search agents")} className="pl-8" />
					</div>
					<Select value={node} onValueChange={setNode}>
						<SelectTrigger aria-label={t("Filter by machine")}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">{t("All machines")}</SelectItem>
							{groups.map((g) => (
								<SelectItem key={g.nodeId} value={g.nodeId}>
									{g.status === "self" ? t("{name} (this machine)", { name: g.nodeName }) : g.nodeName}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Select value={status} onValueChange={setStatus}>
						<SelectTrigger aria-label={t("Filter by agent status")}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">{t("Any status")}</SelectItem>
							{AGENT_STATUS.map((s) => (
								<SelectItem key={s} value={s}>
									{tr(AGENT_STATUS_LABEL[s])}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</div>

			<div ref={scrollRef} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-contain [overflow-anchor:none]">
				<div className="mx-auto w-full max-w-[1400px] px-4 pb-6 sm:px-6 lg:px-8">
					{directory.isPending ? (
						<div aria-busy className="flex flex-col gap-2">
							{[0, 1, 2, 3].map((i) => (
								<Skeleton key={i} className="h-16 rounded-lg" />
							))}
						</div>
					) : directory.error ? (
						<EmptyState
							icon={Bot}
							title={t("Could not load the directory")}
							description={errorText(directory.error)}
							action={
								<Button size="sm" variant="outline" onClick={() => void directory.refetch()}>
									<RefreshCw /> {t("Retry")}
								</Button>
							}
						/>
					) : rows.length === 0 ? (
						<EmptyState
							icon={Bot}
							title={total === 0 && !filtering ? t("No agents yet") : t("No agents match")}
							description={total === 0 && !filtering ? t("Agents of this machine and of connected machines appear here.") : t("Try another search or clear the filters.")}
							action={
								filtering || node !== "all" ? (
									<Button
										size="sm"
										variant="outline"
										onClick={() => {
											setQ("");
											setStatus("all");
											setNode("all");
										}}
									>
										{t("Clear filters")}
									</Button>
								) : undefined
							}
						/>
					) : (
						<div className="relative w-full" style={{ height: v.getTotalSize() }}>
							{v.getVirtualItems().map((item) => {
								const row = rows[item.index];
								if (!row) return null;
								return (
									<div key={item.key} data-index={item.index} ref={v.measureElement} className="absolute left-0 top-0 w-full" style={{ transform: `translateY(${item.start}px)` }}>
										{row.kind === "header" ? (
											<GroupHeader group={row.group} now={now} />
										) : row.kind === "empty" ? (
											<p className="px-3 py-2.5 text-[13px] text-subtle">{tr(row.text)}</p>
										) : (
											<AgentRow
												agent={row.agent}
												nodeStatus={row.group.status}
												taskCount={taskCounts.get(`${row.agent.nodeId}:${row.agent.agentId}`) ?? 0}
												onDelegate={row.group.status === "self" ? undefined : () => openDialog({ kind: "delegate-task", peerId: row.agent.nodeId, agentId: row.agent.agentId })}
											/>
										)}
									</div>
								);
							})}
						</div>
					)}
				</div>
			</div>
			{chooser ? (
				<ConnectDialog
					onClose={() => setChooser(false)}
					onInvite={() => {
						setChooser(false);
						openDialog({ kind: "invite-node" });
					}}
					onJoin={() => {
						setChooser(false);
						openDialog({ kind: "join-node" });
					}}
				/>
			) : null}
		</div>
	);
}

function GroupHeader({ group, now }: { group: Group; now: number }) {
	const stale = group.fetchedAt !== null && group.status !== "self" && (isStale(group.fetchedAt, now) || group.status === "offline");
	const inner = (
		<>
			<span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{group.nodeName}</span>
			{group.status === "self" ? <Badge variant="accent">{t("This machine")}</Badge> : <PeerStatusBadge status={group.status} />}
			<span className="font-mono text-2xs text-subtle">{t("{count, plural, one {# agent} other {# agents}}", { count: group.agents.length })}</span>
			{group.fetchedAt && group.status !== "self" ? (
				<span className={cn("hidden items-center gap-1 text-2xs sm:inline-flex", stale ? "text-warning" : "text-subtle")} title={formatDateTime(group.fetchedAt)}>
					<Clock className="size-3" />
					{stale ? t("stale · ") : ""}
					{relativeTime(group.fetchedAt, now)}
				</span>
			) : null}
			{group.status === "self" ? null : <ChevronRight className="size-4 shrink-0 text-subtle" />}
		</>
	);
	const cls = "mt-3 flex h-10 items-center gap-2.5 border-b px-3 coarse:h-12";
	return group.status === "self" ? (
		<div className={cls}>{inner}</div>
	) : (
		<Link to="/network/nodes/$peerId" params={{ peerId: group.nodeId }} className={cn(cls, "outline-none hover:bg-surface-2/60")}>
			{inner}
		</Link>
	);
}

function AgentRow({ agent, nodeStatus, taskCount, onDelegate }: { agent: DirectoryAgent; nodeStatus: NodeStatus; taskCount: number; onDelegate?: () => void }) {
	const dim = nodeStatus !== "self" && nodeStatus !== "online";
	const caps = agent.capabilities;
	return (
		<div className={cn("flex min-h-[4.5rem] flex-col justify-center gap-1 border-b px-3 py-2.5", dim && "opacity-60")}>
			<div className="flex items-center gap-2.5">
				<StatusDot status={dim && agent.status !== "offline" ? "offline" : agent.status} label={dim ? t("{status} (last known)", { status: tr(AGENT_STATUS_LABEL[agent.status]) }) : tr(AGENT_STATUS_LABEL[agent.status])} />
				<span className="truncate text-[13px] font-medium">{agent.name}</span>
				{agent.status === "busy" && !dim ? <span className="text-2xs font-medium text-accent">{t("busy")}</span> : null}
				<span className="min-w-0 flex-1 truncate text-xs text-subtle">{agent.role}</span>
				<Badge>{agent.runtime}</Badge>
				{agent.activeSessions > 0 ? <Badge variant="accent">{t("{count} active", { count: formatNumber(agent.activeSessions) })}</Badge> : null}
				{taskCount > 0 ? (
					<Badge variant="warning" title={nodeStatus === "self" ? t("Delegated tasks this agent is working on") : t("Tasks you delegated to this agent that are not finished")}>
						{t("{count, plural, one {# task} other {# tasks}}", { count: taskCount })}
					</Badge>
				) : null}
				{onDelegate ? (
					<Button size="sm" variant="outline" className="shrink-0 coarse:h-11" onClick={onDelegate} aria-label={t("Delegate a task to {name}", { name: agent.name })}>
						<Send /> {t("Delegate")}
					</Button>
				) : null}
			</div>
			{caps.length > 0 ? (
				<div className="flex flex-wrap items-center gap-1 pl-[1.1rem]">
					{caps.slice(0, 4).map((c) => (
						<span key={c} className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">
							{c}
						</span>
					))}
					{caps.length > 4 ? <span className="text-2xs text-subtle">+{caps.length - 4}</span> : null}
				</div>
			) : null}
		</div>
	);
}
