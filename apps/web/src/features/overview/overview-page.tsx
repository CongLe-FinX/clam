import type { AgentSession, ProviderQuota, QuotaLimit } from "@clam/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Bot, Cloud, Cpu, FolderPlus, Gauge, Layers, MessageSquarePlus, Network, Server, ShieldCheck, Sparkles, UserPlus } from "lucide-react";
import { useMemo } from "react";
import { Stat } from "@/components/stat";
import { TasksCard } from "@/features/tasks/overview-card";
import { SessionRow } from "@/components/session-row";
import { RUNTIME_STATE_LABEL, runtimeDot } from "@/components/session-status";
import { TUNNEL_MODE_LABEL, TUNNEL_STATE } from "@/features/network/format";
import { renderServerText, T, t, tr } from "@/i18n";
import { limitLabel, windowText } from "@/features/usage/format";
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
import { formatBytes, formatCompact, formatCost, formatDuration, formatPercent, relativeTime, shortFingerprint } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";
import { EmptyState } from "@/ui/empty-state";
import { PageContainer, PageHeader } from "@/ui/page";
import { Progress } from "@/ui/progress";
import { Skeleton } from "@/ui/skeleton";
import { DOT_STATUS_LABEL, StatusDot } from "@/ui/status-dot";

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
				title={node.data ? node.data.name : t("Overview")}
				description={node.data ? `${node.data.platform}/${node.data.arch} · ${node.data.hostname} · ${node.data.bindAddress}:${node.data.port}` : t("Distributed AI Agents. One Shared Workspace.")}
				actions={
					<>
						<Button variant="primary" onClick={() => openDialog({ kind: "new-chat" })}>
							<MessageSquarePlus /> {t("New chat")}
						</Button>
						<Button variant="outline" onClick={() => openDialog({ kind: "create-project" })} disabled={firstRun}>
							<FolderPlus /> {t("Add project")}
						</Button>
						<Button variant="outline" onClick={() => openDialog({ kind: "create-session" })} disabled={(projects.data?.length ?? 0) === 0}>
							<MessageSquarePlus /> {t("New session")}
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
						<CardTitle>{t("Recent sessions")}</CardTitle>
						<CardLink to="/node/sessions">{t("All sessions")}</CardLink>
					</CardHeader>
					<div className="mt-3 border-t">
						{sessions.isLoading ? <ListSkeleton /> : null}
						{sessions.isError ? <p className="p-4 text-[13px] text-danger">{errorMessage(sessions.error)}</p> : null}
						{sessions.isSuccess && recent.length === 0 ? (
							<EmptyState icon={MessageSquarePlus} title={t("No sessions yet")} description={t("Start an agent session in a project to see it here.")} />
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
				<T
					text="This machine · listening on loopback only · fingerprint <m>{fingerprint}</m>"
					params={{ fingerprint: node.data ? shortFingerprint(node.data.fingerprint) : "—" }}
					tags={{ m: <span className="font-mono" /> }}
				/>
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
		{ icon: Layers, title: t("Create a workspace"), body: t("Group the projects an AI team works on together."), action: t("New workspace"), run: () => openDialog({ kind: "create-workspace" }) },
		{ icon: FolderPlus, title: t("Add a project"), body: t("Point to a directory on this machine."), action: t("Add project"), run: () => openDialog({ kind: "create-project" }) },
		{ icon: Sparkles, title: t("Start an agent session"), body: t("Chat with an OMP agent that can read and edit the project."), action: t("New session"), run: () => openDialog({ kind: "create-session" }) },
	];
	return (
		<Card className="overflow-hidden bg-gradient-to-br from-accent-soft to-surface-1">
			<CardContent className="flex flex-col gap-4">
				<div>
					<h2 className="text-[15px] font-semibold tracking-tight">{t("Welcome to CL Agent Mesh")}</h2>
					<p className="text-[13px] text-muted-foreground">{t("Three steps to your first agent session.")}</p>
					{omp.data && !omp.data.install.installed ? (
						<p className="mt-2 text-[13px] text-warning">{t("OMP is not installed on this machine — agent sessions need it. See Settings → OMP Providers.")}</p>
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
					<Server className="size-4 text-muted-foreground" /> {t("Machine health")}
				</CardTitle>
				{h ? (
					<Badge variant={h.status === "ok" ? "success" : h.status === "degraded" ? "warning" : "danger"}>
						<StatusDot status={h.status} className="size-1.5 [&>span]:size-1.5" /> {tr(DOT_STATUS_LABEL[h.status])}
					</Badge>
				) : null}
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<div className="grid grid-cols-3 gap-3">
					<Stat label={t("Uptime")} value={h ? formatDuration(h.uptimeMs) : "—"} loading={health.isLoading} />
					<Stat label={t("Runtimes")} value={h?.activeRuntimes ?? "—"} loading={health.isLoading} />
					<Stat label={t("Memory")} value={h ? formatBytes(h.memory.rss) : "—"} loading={health.isLoading} />
				</div>
				<ul className="flex flex-col gap-1.5">
					{health.isLoading ? <Skeleton className="h-16" /> : null}
					{h?.checks.map((c) => (
						<li key={c.name} className="flex items-center gap-2 text-[13px]">
							<StatusDot status={c.status} />
							<span className="font-medium">{c.name}</span>
							<span className="min-w-0 flex-1 truncate text-xs text-subtle">{c.message ? renderServerText(c.message, c.i18n) : null}</span>
							{c.latencyMs !== undefined ? <span className="font-mono text-2xs text-subtle">{Math.round(c.latencyMs)} ms</span> : null}
						</li>
					))}
				</ul>
				{node.data ? <p className="text-xs text-subtle">{t("v{version} · started {time}", { version: node.data.version, time: relativeTime(node.data.startedAt) })}</p> : null}
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
					<Cpu className="size-4 text-muted-foreground" /> {t("OMP runtime")}
				</CardTitle>
				<CardLink to="/settings/omp">{t("Manage")}</CardLink>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{omp.isLoading ? <Skeleton className="h-24" /> : null}
				{omp.isError ? <p className="text-[13px] text-danger">{errorMessage(omp.error)}</p> : null}
				{d ? (
					<>
						<div className="grid grid-cols-2 gap-3">
							<Stat label={t("Status")} value={d.install.installed ? t("Installed") : t("Not installed")} mono={false} sub={d.install.version ?? undefined} />
							<Stat label={t("Providers")} value={`${authed.length}/${d.providers.length}`} sub={t("authenticated")} />
						</div>
						<div className="flex flex-col gap-1">
							<span className="text-2xs font-medium uppercase tracking-wider text-subtle">{t("Default model")}</span>
							<span className="truncate font-mono text-[13px]">{d.defaultModel ?? t("Not set")}</span>
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
							<p className="text-xs text-warning">{t("No provider is logged in yet.")}</p>
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
					<Gauge className="size-4 text-muted-foreground" /> {t("Usage")}
				</CardTitle>
				<CardLink to="/settings/usage">{t("Details")}</CardLink>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<div>
					<div className="mb-2 flex items-center gap-2 text-2xs font-medium uppercase tracking-wider text-subtle">
						{t("OMP recorded")} <Badge variant="neutral">{t("last 24 h")}</Badge>
					</div>
					{recorded.isError ? (
						<p className="text-xs text-warning">{t("Unavailable — {error}", { error: errorMessage(recorded.error) })}</p>
					) : (
						<div className="grid grid-cols-3 gap-3">
							<Stat label={t("Requests")} value={o ? formatCompact(o.requests) : "—"} loading={recorded.isLoading} />
							<Stat label={t("Tokens")} value={o ? formatCompact(o.tokens.total) : "—"} loading={recorded.isLoading} />
							<Stat label={t("Cost")} value={o ? formatCost(o.cost) : "—"} loading={recorded.isLoading} />
						</div>
					)}
				</div>
				<div>
					<div className="mb-2 text-2xs font-medium uppercase tracking-wider text-subtle">{t("Provider quota")}</div>
					{quota.isLoading ? <Skeleton className="h-10" /> : null}
					{quota.isError ? <p className="text-xs text-warning">{t("Unavailable — {error}", { error: errorMessage(quota.error) })}</p> : null}
					<ul className="flex flex-col gap-2.5">
						{quota.data?.providers.map((p, idx) => {
							const l = p.availability === "available" ? pickQuotaLimit(p) : undefined;
							const frac = l && l.used !== null && l.limit ? (l.used / l.limit) * 100 : null;
							return (
								<li key={`${p.provider}-${p.account ?? ""}-${idx}`} className="flex flex-col gap-1">
									<div className="flex items-baseline justify-between gap-2 text-[13px]">
										<span className="min-w-0 truncate font-medium">{p.provider}</span>
										<span className="shrink-0 font-mono text-2xs text-subtle">
											{p.availability === "available" && l ? (frac !== null ? t("{percent} · {window}", { percent: formatPercent(frac / 100), window: windowText(l) ?? limitLabel(l) }) : limitLabel(l)) : p.availability === "error" ? t("Error") : t("Unavailable")}
										</span>
									</div>
									{p.account ? (
										<span className="break-all font-mono text-2xs text-subtle" title={p.account}>
											{p.account}
										</span>
									) : null}
									{frac !== null ? <Progress value={frac} tone={frac > 90 ? "danger" : frac > 70 ? "warning" : "accent"} /> : null}
								</li>
							);
						})}
						{quota.data && quota.data.providers.length === 0 ? <li className="text-xs text-subtle">{t("No provider reports quota.")}</li> : null}
					</ul>
				</div>
			</CardContent>
		</Card>
	);
}

function NetworkCard() {
	const peers = usePeers();
	const tunnel = useTunnel();
	const requests = usePairingRequests();
	const openDialog = useUi((s) => s.openDialog);
	const list = peers.data ?? [];
	const count = (s: string) => list.filter((p) => p.status === s).length;
	const waiting = (requests.data ?? []).filter(isAwaitingApproval).length;
	const tun = tunnel.data;
	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Network className="size-4 text-muted-foreground" /> {t("Network")}
				</CardTitle>
				<CardLink to="/network/nodes">{t("Machines")}</CardLink>
			</CardHeader>
			<CardContent className="flex flex-col gap-3.5 pt-3">
				{peers.isLoading ? <Skeleton className="h-10" /> : null}
				{peers.isError ? <p className="text-[13px] text-danger">{errorMessage(peers.error)}</p> : null}
				{peers.isSuccess ? (
					list.length === 0 ? (
						<div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
							<span className="flex-1">{t("No machine is paired yet.")}</span>
							<Button size="sm" variant="outline" onClick={() => openDialog({ kind: "invite-node" })}>
								<UserPlus /> {t("Invite a machine")}
							</Button>
						</div>
					) : (
						<div className="grid grid-cols-4 gap-3">
							<Stat label={t("Online")} value={count("online")} />
							<Stat label={t("Degraded")} value={count("degraded")} />
							<Stat label={t("Offline")} value={count("offline")} />
							<Stat label={t("Revoked")} value={count("revoked")} />
						</div>
					)
				) : null}
				{waiting > 0 ? (
					<div className="flex flex-wrap items-center gap-2 rounded-lg bg-accent-soft px-3 py-2 text-[13px]">
						<span className="flex-1">
							<T
								text="{count, plural, one {<b>#</b> pairing request waits for your approval.} other {<b>#</b> pairing requests wait for your approval.}}"
								params={{ count: waiting }}
								tags={{ b: <strong /> }}
							/>
						</span>
						<Button size="sm" variant="primary" onClick={() => openDialog({ kind: "pairing-requests" })}>
							{t("Review")}
						</Button>
					</div>
				) : null}
				<div className="flex items-center gap-2 border-t pt-3 text-[13px]">
					<Cloud className="size-4 shrink-0 text-muted-foreground" />
					<span className="font-medium">{t("Tunnel")}</span>
					{tun ? <Badge variant={TUNNEL_STATE[tun.state].variant}>{tr(TUNNEL_STATE[tun.state].label)}</Badge> : <Skeleton className="h-4 w-16" />}
					<span className="min-w-0 flex-1 truncate text-right font-mono text-2xs text-subtle">{tun?.publicUrl ?? (tun ? t("mode: {mode}", { mode: tr(TUNNEL_MODE_LABEL[tun.config.mode]) }) : "")}</span>
					<CardLink to="/settings/tunnel">{t("Manage")}</CardLink>
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
					<Bot className="size-4 text-muted-foreground" /> {t("Agents")}
				</CardTitle>
				<CardLink to="/agents">{t("Manage")}</CardLink>
			</CardHeader>
			<CardContent className="flex flex-col gap-2 pt-3">
				{agents.isLoading ? <Skeleton className="h-10" /> : null}
				{agents.isError ? <p className="text-[13px] text-danger">{errorMessage(agents.error)}</p> : null}
				{agents.data?.length === 0 ? <p className="text-[13px] text-subtle">{t("No agents registered.")}</p> : null}
				{agents.data?.map((a) => (
					<div key={a.id} className="flex items-center gap-2.5 text-[13px]">
						<StatusDot status={a.status} />
						<span className="font-medium">{a.name}</span>
						<span className="min-w-0 flex-1 truncate text-xs text-subtle">{a.role}</span>
						<Badge>{t("{count} active", { count: a.activeSessions })}</Badge>
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
					<Cpu className="size-4 text-muted-foreground" /> {t("Active runtimes")}
				</CardTitle>
				<CardLink to="/node/runtime">{t("Runtime")}</CardLink>
			</CardHeader>
			<CardContent className="flex flex-col gap-2 pt-3">
				{runtime.isLoading ? <Skeleton className="h-10" /> : null}
				{runtime.isError ? <p className="text-[13px] text-danger">{errorMessage(runtime.error)}</p> : null}
				{runtime.isSuccess && active.length === 0 ? <p className="text-[13px] text-subtle">{t("No runtime is running. They start on demand when you open a session.")}</p> : null}
				{active.map((r) => (
					<Link key={r.sessionId} to="/sessions/$sessionId" params={{ sessionId: r.sessionId }} className="flex items-center gap-2.5 rounded-md text-[13px] hover:text-accent">
						<StatusDot status={runtimeDot(r.state)} />
						<span className="min-w-0 flex-1 truncate">{titles.get(r.sessionId) ?? r.sessionId}</span>
						<span className="font-mono text-2xs text-subtle">{tr(RUNTIME_STATE_LABEL[r.state])}</span>
						{r.pid ? <span className="font-mono text-2xs text-subtle">{t("pid {pid}", { pid: r.pid })}</span> : null}
					</Link>
				))}
			</CardContent>
		</Card>
	);
}
