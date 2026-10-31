import type { AgentSession, ProviderQuota, QuotaLimit } from "@clam/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Bot, Cloud, Cpu, FolderPlus, Gauge, Layers, MessageSquarePlus, Network, Server, ShieldCheck, Sparkles, UserPlus } from "lucide-react";
import { useMemo } from "react";
import { Stat } from "@/components/stat";
import { TasksCard } from "@/features/tasks/overview-card";
import { SessionRow } from "@/components/session-row";
import { runtimeDot } from "@/components/session-status";
import { errorMessage } from "@/lib/api";
import {
	isAwaitingApproval,
	useAgents,
	useHealth,
	useNode,
	useOmpProviders,
	usePairingRequests,
	usePeers,
	useProjects,
	useRuntime,
	useSessions,
	useTunnel,
	useUsageQuota,
	useUsageRecorded,
	useWorkspaces,
} from "@/lib/queries";
import { useUi } from "@/lib/store";
import { formatCompact, formatCost, formatDuration, relativeTime, shortFingerprint } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";
import { EmptyState } from "@/ui/empty-state";
import { PageContainer, PageHeader } from "@/ui/page";
import { Progress } from "@/ui/progress";
import { Skeleton } from "@/ui/skeleton";
import { StatusDot } from "@/ui/status-dot";

function CardLink({ to, children }: { to: "/settings/omp" | "/settings/usage" | "/node/runtime" | "/agents" | "/node/sessions" | "/network/nodes" | "/settings/tunnel"; children: string }) {
	return (
		<Link to={to} preload="intent" className="inline-flex items-center gap-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
			{children}
			<ArrowUpRight className="size-3" />
		</Link>
	);
}

export default function OverviewPage() {
	const node = useNode();
	const health = useHealth();
	const workspaces = useWorkspaces();
	const projects = useProjects();
	const sessions = useSessions();
	const openDialog = useUi((s) => s.openDialog);

	const projectName = useMemo(() => new Map((projects.data ?? []).map((p) => [p.id, p.name])), [projects.data]);
	const recent = useMemo(() => [...(sessions.data ?? [])].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 6), [sessions.data]);
	const firstRun = workspaces.isSuccess && workspaces.data.length === 0;

	return (
		<PageContainer wide>
			<PageHeader
				eyebrow="CL Agent Mesh"
				title={node.data ? node.data.name : "Overview"}
				description={node.data ? `${node.data.platform}/${node.data.arch} · ${node.data.hostname} · ${node.data.bindAddress}:${node.data.port}` : "Distributed AI Agents. One Shared Workspace."}
				actions={
					<>
						<Button variant="outline" onClick={() => openDialog({ kind: "create-project" })} disabled={firstRun}>
							<FolderPlus /> Add project
						</Button>
						<Button variant="primary" onClick={() => openDialog({ kind: "create-session" })} disabled={(projects.data?.length ?? 0) === 0}>
							<MessageSquarePlus /> New session
						</Button>
					</>
				}
			/>

			{firstRun ? <GettingStarted /> : null}

			<div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
				<NodeHealthCard className="lg:col-span-1" />
				<OmpCard className="lg:col-span-1" />
				<UsageCard className="lg:col-span-1" />
			</div>

			<div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
				<Card className="lg:col-span-3">
					<CardHeader>
						<CardTitle>Recent sessions</CardTitle>
						<CardLink to="/node/sessions">All sessions</CardLink>
					</CardHeader>
					<div className="mt-3 border-t">
						{sessions.isLoading ? <ListSkeleton /> : null}
						{sessions.isError ? <p className="p-4 text-[13px] text-danger">{errorMessage(sessions.error)}</p> : null}
						{sessions.isSuccess && recent.length === 0 ? (
							<EmptyState icon={MessageSquarePlus} title="No sessions yet" description="Start an agent session in a project to see it here." />
						) : null}
						{recent.map((s: AgentSession) => (
							<SessionRow key={s.id} session={s} projectName={projectName.get(s.projectId)} />
						))}
					</div>
				</Card>
				<div className="flex flex-col gap-4 lg:col-span-2">
					<TasksCard />
					<NetworkCard />
					<AgentsCard />
					<RuntimesCard />
				</div>
			</div>

			<div className="flex items-center gap-2 text-xs text-subtle">
				<ShieldCheck className="size-3.5" />
				Local node · listening on loopback only · fingerprint <span className="font-mono">{node.data ? shortFingerprint(node.data.fingerprint) : "—"}</span>
			</div>
			{health.isError ? <p className="text-xs text-danger">{errorMessage(health.error)}</p> : null}
		</PageContainer>
	);
}

function ListSkeleton() {
	return (
		<div className="flex flex-col gap-px p-2">
			{[0, 1, 2].map((i) => (
				<Skeleton key={i} className="h-12" />
			))}
		</div>
	);
}

function GettingStarted() {
	const openDialog = useUi((s) => s.openDialog);
	const omp = useOmpProviders();
	const steps = [
		{ icon: Layers, title: "Create a workspace", body: "Group the projects an AI team works on together.", action: "New workspace", run: () => openDialog({ kind: "create-workspace" }) },
		{ icon: FolderPlus, title: "Add a project", body: "Point to a directory on this machine.", action: "Add project", run: () => openDialog({ kind: "create-project" }) },
		{ icon: Sparkles, title: "Start an agent session", body: "Chat with an OMP agent that can read and edit the project.", action: "New session", run: () => openDialog({ kind: "create-session" }) },
	];
	return (
		<Card className="overflow-hidden bg-gradient-to-br from-accent-soft to-surface-1">
			<CardContent className="flex flex-col gap-4">
				<div>
					<h2 className="text-[15px] font-semibold tracking-tight">Welcome to CL Agent Mesh</h2>
					<p className="text-[13px] text-muted-foreground">Three steps to your first agent session.</p>
					{omp.data && !omp.data.install.installed ? (
						<p className="mt-2 text-[13px] text-warning">OMP is not installed on this node — agent sessions need it. See Settings → OMP Providers.</p>
					) : null}
				</div>
				<div className="grid gap-3 sm:grid-cols-3">
					{steps.map((s, i) => (
						<div key={s.title} className="flex flex-col gap-2 rounded-xl bg-surface-1/70 p-3 shadow-[inset_0_0_0_1px_var(--border)]">
							<div className="flex items-center gap-2 text-[13px] font-medium">
								<span className="grid size-5 place-items-center rounded-md bg-accent-soft font-mono text-2xs text-accent">{i + 1}</span>
								{s.title}
							</div>
							<p className="flex-1 text-xs text-muted-foreground">{s.body}</p>
							<Button variant={i === 0 ? "primary" : "outline"} size="sm" className="self-start" onClick={s.run}>
								<s.icon /> {s.action}
							</Button>
						</div>
					))}
				</div>
			</CardContent>
		</Card>
	);
}

function NodeHealthCard({ className }: { className?: string }) {
	const health = useHealth();
	const node = useNode();
	const h = health.data;
	return (
		<Card className={className}>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Server className="size-4 text-muted-foreground" /> Node health
				</CardTitle>
				{h ? (
					<Badge variant={h.status === "ok" ? "success" : h.status === "degraded" ? "warning" : "danger"}>
						<StatusDot status={h.status} className="size-1.5 [&>span]:size-1.5" /> {h.status}
					</Badge>
				) : null}
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<div className="grid grid-cols-3 gap-3">
					<Stat label="Uptime" value={h ? formatDuration(h.uptimeMs) : "—"} loading={health.isLoading} />
					<Stat label="Runtimes" value={h?.activeRuntimes ?? "—"} loading={health.isLoading} />
					<Stat label="Memory" value={h ? `${Math.round(h.memory.rss / 1048576)} MB` : "—"} loading={health.isLoading} />
				</div>
				<ul className="flex flex-col gap-1.5">
					{health.isLoading ? <Skeleton className="h-16" /> : null}
					{h?.checks.map((c) => (
						<li key={c.name} className="flex items-center gap-2 text-[13px]">
							<StatusDot status={c.status} />
							<span className="font-medium">{c.name}</span>
							<span className="min-w-0 flex-1 truncate text-xs text-subtle">{c.message}</span>
							{c.latencyMs !== undefined ? <span className="font-mono text-2xs text-subtle">{Math.round(c.latencyMs)} ms</span> : null}
						</li>
					))}
				</ul>
				{node.data ? <p className="text-xs text-subtle">v{node.data.version} · started {relativeTime(node.data.startedAt)}</p> : null}
				{health.isError ? <p className="text-xs text-danger">{errorMessage(health.error)}</p> : null}
			</CardContent>
		</Card>
	);
}

function OmpCard({ className }: { className?: string }) {
	const omp = useOmpProviders();
	const d = omp.data;
	const authed = d?.providers.filter((p) => p.authenticated) ?? [];
	return (
		<Card className={className}>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Cpu className="size-4 text-muted-foreground" /> OMP runtime
				</CardTitle>
				<CardLink to="/settings/omp">Manage</CardLink>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{omp.isLoading ? <Skeleton className="h-24" /> : null}
				{omp.isError ? <p className="text-[13px] text-danger">{errorMessage(omp.error)}</p> : null}
				{d ? (
					<>
						<div className="grid grid-cols-2 gap-3">
							<Stat label="Status" value={d.install.installed ? "Installed" : "Not installed"} mono={false} sub={d.install.version ?? undefined} />
							<Stat label="Providers" value={`${authed.length}/${d.providers.length}`} sub="authenticated" />
						</div>
						<div className="flex flex-col gap-1">
							<span className="text-2xs font-medium uppercase tracking-wider text-subtle">Default model</span>
							<span className="truncate font-mono text-[13px]">{d.defaultModel ?? "Not set"}</span>
						</div>
						{d.install.binaryPath ? <span className="truncate font-mono text-2xs text-subtle">{d.install.binaryPath}</span> : null}
						{d.install.error ? <p className="text-xs text-danger">{d.install.error}</p> : null}
						{authed.length > 0 ? (
							<div className="flex flex-wrap gap-1.5">
								{authed.map((p) => (
									<Badge key={p.id} variant="success">
										{p.name}
									</Badge>
								))}
							</div>
						) : d.install.installed ? (
							<p className="text-xs text-warning">No provider is logged in yet.</p>
						) : null}
					</>
				) : null}
			</CardContent>
		</Card>
	);
}

function pickQuotaLimit(q: ProviderQuota): QuotaLimit | undefined {
	const withFraction = q.limits.filter((l) => l.used !== null && l.limit !== null && l.limit > 0);
	return withFraction.sort((a, b) => (b.used ?? 0) / (b.limit ?? 1) - (a.used ?? 0) / (a.limit ?? 1))[0] ?? q.limits[0];
}

function UsageCard({ className }: { className?: string }) {
	const recorded = useUsageRecorded();
	const quota = useUsageQuota();
	const o = recorded.data?.overall;
	return (
		<Card className={className}>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Gauge className="size-4 text-muted-foreground" /> Usage
				</CardTitle>
				<CardLink to="/settings/usage">Details</CardLink>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<div>
					<div className="mb-2 flex items-center gap-2 text-2xs font-medium uppercase tracking-wider text-subtle">
						OMP recorded <Badge variant="neutral">last 24 h</Badge>
					</div>
					{recorded.isError ? (
						<p className="text-xs text-warning">Unavailable — {errorMessage(recorded.error)}</p>
					) : (
						<div className="grid grid-cols-3 gap-3">
							<Stat label="Requests" value={o ? formatCompact(o.requests) : "—"} loading={recorded.isLoading} />
							<Stat label="Tokens" value={o ? formatCompact(o.tokens.total) : "—"} loading={recorded.isLoading} />
							<Stat label="Cost" value={o ? formatCost(o.cost) : "—"} loading={recorded.isLoading} />
						</div>
					)}
				</div>
				<div>
					<div className="mb-2 text-2xs font-medium uppercase tracking-wider text-subtle">Provider quota</div>
					{quota.isLoading ? <Skeleton className="h-10" /> : null}
					{quota.isError ? <p className="text-xs text-warning">Unavailable — {errorMessage(quota.error)}</p> : null}
					<ul className="flex flex-col gap-2.5">
						{quota.data?.providers.map((p, idx) => {
							const l = p.availability === "available" ? pickQuotaLimit(p) : undefined;
							const frac = l && l.used !== null && l.limit ? (l.used / l.limit) * 100 : null;
							return (
								<li key={`${p.provider}-${p.account ?? ""}-${idx}`} className="flex flex-col gap-1">
									<div className="flex items-center justify-between gap-2 text-[13px]">
										<span className="flex min-w-0 items-baseline gap-1.5 truncate">
											<span className="font-medium">{p.provider}</span>
											{p.account ? <span className="truncate font-mono text-2xs text-subtle">{p.account}</span> : null}
										</span>
										<span className="shrink-0 font-mono text-2xs text-subtle">
											{p.availability === "available" && l ? (frac !== null ? `${Math.round(frac)}% · ${l.windowLabel ?? l.label}` : l.label) : p.availability === "error" ? "Error" : "Unavailable"}
										</span>
									</div>
									{frac !== null ? <Progress value={frac} tone={frac > 90 ? "danger" : frac > 70 ? "warning" : "accent"} /> : null}
								</li>
							);
						})}
						{quota.data && quota.data.providers.length === 0 ? <li className="text-xs text-subtle">No provider reports quota.</li> : null}
					</ul>
				</div>
			</CardContent>
		</Card>
	);
}

const TUNNEL_VARIANT = { stopped: "neutral", starting: "warning", running: "success", reconnecting: "warning", error: "danger" } as const;

function NetworkCard() {
	const peers = usePeers();
	const tunnel = useTunnel();
	const requests = usePairingRequests();
	const openDialog = useUi((s) => s.openDialog);
	const list = peers.data ?? [];
	const count = (s: string) => list.filter((p) => p.status === s).length;
	const waiting = (requests.data ?? []).filter(isAwaitingApproval).length;
	const t = tunnel.data;
	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Network className="size-4 text-muted-foreground" /> Network
				</CardTitle>
				<CardLink to="/network/nodes">Connected nodes</CardLink>
			</CardHeader>
			<CardContent className="flex flex-col gap-3.5 pt-3">
				{peers.isLoading ? <Skeleton className="h-10" /> : null}
				{peers.isError ? <p className="text-[13px] text-danger">{errorMessage(peers.error)}</p> : null}
				{peers.isSuccess ? (
					list.length === 0 ? (
						<div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
							<span className="flex-1">No node is paired yet.</span>
							<Button size="sm" variant="outline" onClick={() => openDialog({ kind: "invite-node" })}>
								<UserPlus /> Invite a node
							</Button>
						</div>
					) : (
						<div className="grid grid-cols-4 gap-3">
							<Stat label="Online" value={count("online")} />
							<Stat label="Degraded" value={count("degraded")} />
							<Stat label="Offline" value={count("offline")} />
							<Stat label="Revoked" value={count("revoked")} />
						</div>
					)
				) : null}
				{waiting > 0 ? (
					<div className="flex flex-wrap items-center gap-2 rounded-lg bg-accent-soft px-3 py-2 text-[13px]">
						<span className="flex-1">
							<strong>{waiting}</strong> pairing {waiting === 1 ? "request waits" : "requests wait"} for your approval.
						</span>
						<Button size="sm" variant="primary" onClick={() => openDialog({ kind: "pairing-requests" })}>
							Review
						</Button>
					</div>
				) : null}
				<div className="flex items-center gap-2 border-t pt-3 text-[13px]">
					<Cloud className="size-4 shrink-0 text-muted-foreground" />
					<span className="font-medium">Tunnel</span>
					{t ? <Badge variant={TUNNEL_VARIANT[t.state]}>{t.state}</Badge> : <Skeleton className="h-4 w-16" />}
					<span className="min-w-0 flex-1 truncate text-right font-mono text-2xs text-subtle">{t?.publicUrl ?? (t ? `mode: ${t.config.mode}` : "")}</span>
					<CardLink to="/settings/tunnel">Manage</CardLink>
				</div>
			</CardContent>
		</Card>
	);
}

function AgentsCard() {
	const agents = useAgents();
	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Bot className="size-4 text-muted-foreground" /> Agents
				</CardTitle>
				<CardLink to="/agents">Manage</CardLink>
			</CardHeader>
			<CardContent className="flex flex-col gap-2 pt-3">
				{agents.isLoading ? <Skeleton className="h-10" /> : null}
				{agents.isError ? <p className="text-[13px] text-danger">{errorMessage(agents.error)}</p> : null}
				{agents.data?.length === 0 ? <p className="text-[13px] text-subtle">No agents registered.</p> : null}
				{agents.data?.map((a) => (
					<div key={a.id} className="flex items-center gap-2.5 text-[13px]">
						<StatusDot status={a.status} />
						<span className="font-medium">{a.name}</span>
						<span className="min-w-0 flex-1 truncate text-xs text-subtle">{a.role}</span>
						<Badge>{a.activeSessions} active</Badge>
					</div>
				))}
			</CardContent>
		</Card>
	);
}

function RuntimesCard() {
	const runtime = useRuntime();
	const sessions = useSessions();
	const titles = useMemo(() => new Map((sessions.data ?? []).map((s) => [s.id, s.title])), [sessions.data]);
	const active = (runtime.data ?? []).filter((r) => r.state !== "stopped");
	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Cpu className="size-4 text-muted-foreground" /> Active runtimes
				</CardTitle>
				<CardLink to="/node/runtime">Runtime</CardLink>
			</CardHeader>
			<CardContent className="flex flex-col gap-2 pt-3">
				{runtime.isLoading ? <Skeleton className="h-10" /> : null}
				{runtime.isError ? <p className="text-[13px] text-danger">{errorMessage(runtime.error)}</p> : null}
				{runtime.isSuccess && active.length === 0 ? <p className="text-[13px] text-subtle">No runtime is running. They start on demand when you open a session.</p> : null}
				{active.map((r) => (
					<Link key={r.sessionId} to="/sessions/$sessionId" params={{ sessionId: r.sessionId }} className="flex items-center gap-2.5 rounded-md text-[13px] hover:text-accent">
						<StatusDot status={runtimeDot(r.state)} />
						<span className="min-w-0 flex-1 truncate">{titles.get(r.sessionId) ?? r.sessionId}</span>
						<span className="font-mono text-2xs text-subtle">{r.state}</span>
						{r.pid ? <span className="font-mono text-2xs text-subtle">pid {r.pid}</span> : null}
					</Link>
				))}
			</CardContent>
		</Card>
	);
}
