import type { Invitation, Peer } from "@clam/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Cloud, Inbox, Loader2, Network, Plug, RefreshCw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { T, t } from "@/i18n";
import { errorText } from "@/lib/api";
import { isAwaitingApproval, useInvitations, useOutgoingPairings, usePairingRequests, usePeers, useTunnel, useWorkspaces } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { cn, formatNumber, relativeTime, shortFingerprint } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card, CardContent } from "@/ui/card";
import { EmptyState } from "@/ui/empty-state";
import { PageContainer, PageHeader, SectionTitle } from "@/ui/page";
import { Skeleton } from "@/ui/skeleton";
import { Table, TBody, Td, Th, THead, Tr } from "@/ui/table";
import { summarizeCapabilities } from "./capabilities";
import { Countdown, CopyIconButton, PeerStatusBadge } from "./components";
import { ConnectDialog, ConnectPaths, PairingDiagram } from "./connect";
import { FingerprintIcon } from "./fingerprint";
import { hostOf } from "./format";
import { useRevokeInvitation } from "./hooks";
import { PairingRequestCard, sortRequests } from "./pairing-requests";

const STATUS_RANK = { online: 0, degraded: 1, offline: 2, revoked: 3 } as const;

export default function ConnectedNodesPage() {
	const peers = usePeers();
	const requests = usePairingRequests();
	const openDialog = useUi((s) => s.openDialog);
	const [chooser, setChooser] = useState(false);
	const sorted = useMemo(() => [...(peers.data ?? [])].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.name.localeCompare(b.name)), [peers.data]);
	const awaiting = sortRequests((requests.data ?? []).filter((r) => isAwaitingApproval(r) || r.state === "confirming"));

	return (
		<PageContainer wide>
			<PageHeader
				eyebrow={t("Agent Network")}
				title={t("Connected machines")}
				description={t("Machines you paired with. Each request between you is signed with Ed25519 keys that both sides pinned during pairing.")}
				actions={
					<Button variant="primary" onClick={() => setChooser(true)} data-testid="connect-machine">
						<Plug /> {t("Connect a machine")}
					</Button>
				}
			/>
			<ReachabilityStrip />
			{sorted.length > 0 ? <SummaryStrip peers={sorted} waiting={awaiting.filter(isAwaitingApproval).length} /> : null}

			{awaiting.length > 0 ? (
				<section className="flex flex-col gap-2.5" aria-label={t("Pairing requests")}>
					<SectionTitle actions={<Badge variant="warning">{t("{count} waiting", { count: formatNumber(awaiting.length) })}</Badge>}>{t("Pairing requests")}</SectionTitle>
					{awaiting.map((r) => (
						<PairingRequestCard key={r.id} request={r} />
					))}
				</section>
			) : null}

			<OutgoingPairings />

			<section className="flex flex-col gap-2.5">
				<SectionTitle>{t("Machines")}</SectionTitle>
				{peers.isPending ? (
					<div aria-busy className="flex flex-col gap-2">
						{[0, 1, 2].map((i) => (
							<Skeleton key={i} className="h-16 rounded-xl" />
						))}
					</div>
				) : peers.error ? (
					<EmptyState
						icon={Network}
						title={t("Could not load machines")}
						description={errorText(peers.error)}
						action={
							<Button size="sm" variant="outline" onClick={() => void peers.refetch()}>
								<RefreshCw /> {t("Retry")}
							</Button>
						}
					/>
				) : sorted.length === 0 ? (
					<NoPeers />
				) : (
					<PeerList peers={sorted} />
				)}
			</section>

			<PendingInvitations />
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
		</PageContainer>
	);
}

function SummaryStrip({ peers, waiting }: { peers: Peer[]; waiting: number }) {
	const live = peers.filter((p) => p.status !== "revoked");
	const online = live.filter((p) => p.status === "online" || p.status === "degraded");
	const agents = online.reduce((n, p) => n + p.agentCount, 0);
	const stats = [
		{ label: t("Online"), value: formatNumber(online.length), hint: t("{count, plural, one {of # machine} other {of # machines}}", { count: live.length }), tone: online.length > 0 ? "text-success" : "text-muted-foreground" },
		{ label: t("Agents"), value: formatNumber(agents), hint: t("reachable"), tone: "text-foreground" },
		{ label: t("Waiting"), value: formatNumber(waiting), hint: t("{count, plural, one {request} other {requests}}", { count: waiting }), tone: waiting > 0 ? "text-warning" : "text-muted-foreground" },
	];
	return (
		<dl className="grid grid-cols-3 gap-2 sm:gap-3">
			{stats.map((s) => (
				<div key={s.label} className="flex min-w-0 flex-col gap-0.5 rounded-xl bg-surface-1 px-3 py-2.5 shadow-[inset_0_0_0_1px_var(--border)] sm:px-4 sm:py-3">
					<dt className="truncate text-2xs font-medium uppercase tracking-wider text-subtle">{s.label}</dt>
					<dd className={cn("tabular text-2xl font-semibold leading-tight", s.tone)}>{s.value}</dd>
					<dd className="truncate text-xs text-muted-foreground">{s.hint}</dd>
				</div>
			))}
		</dl>
	);
}

function ReachabilityStrip() {
	const tunnel = useTunnel().data;
	if (!tunnel) return null;
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl bg-surface-1 px-3.5 py-2.5 text-[13px] shadow-[inset_0_0_0_1px_var(--border)]">
			<Cloud className={cn("size-4 shrink-0", tunnel.publicUrl ? "text-success" : "text-subtle")} />
			{tunnel.publicUrl ? (
				<>
					<span className="text-muted-foreground">{t("This machine is reachable at")}</span>
					<span className="min-w-0 truncate font-mono text-xs">{tunnel.publicUrl}</span>
					<CopyIconButton value={tunnel.publicUrl} label={t("Copy this machine's address")} />
				</>
			) : (
				<span className="text-muted-foreground">
					{t("No public URL — other machines cannot reach this one yet.")}{" "}
					<Link to="/settings/tunnel" className="font-medium text-accent hover:underline">
						{t("Start a Cloudflare Tunnel")}
					</Link>
				</span>
			)}
		</div>
	);
}

function NoPeers() {
	const tunnel = useTunnel();
	const openDialog = useUi((s) => s.openDialog);
	const running = Boolean(tunnel.data?.publicUrl);
	return (
		<Card>
			<CardContent className="flex flex-col gap-5">
				<div className="flex flex-col gap-1">
					<h3 className="text-base font-semibold">{t("Connect your first machine")}</h3>
					<p className="max-w-2xl text-[13px] text-muted-foreground">{t("Pair this machine with another one to share agents, delegate tasks and hand sessions over. Pick the side you are on.")}</p>
				</div>
				<ConnectPaths onInvite={() => openDialog({ kind: "invite-node" })} onJoin={() => openDialog({ kind: "join-node" })} />
				<PairingDiagram />
				{running ? null : (
					<div className="flex flex-wrap items-center gap-3 rounded-xl bg-surface-2 p-3.5 text-[13px] shadow-[inset_0_0_0_1px_var(--border)]">
						<Cloud className="size-4 shrink-0 text-subtle" />
						<span className="min-w-0 flex-1 text-muted-foreground">{t("Inviting from another network needs a public address. Start a quick tunnel first — no ports to open.")}</span>
						<Button asChild variant="outline" size="sm">
							<Link to="/settings/tunnel">{t("Open tunnel settings")}</Link>
						</Button>
					</div>
				)}
			</CardContent>
		</Card>
	);
}

function SharedWorkspaces({ ids }: { ids: string[] }) {
	const workspaces = useWorkspaces();
	if (ids.length === 0) return <span className="text-subtle">—</span>;
	const names = ids.map((id) => workspaces.data?.find((w) => w.id === id)?.name ?? id);
	return (
		<span className="truncate" title={names.join(", ")}>
			{names.slice(0, 2).join(", ")}
			{names.length > 2 ? ` +${names.length - 2}` : ""}
		</span>
	);
}

const latency = (p: Peer) => (p.latencyMs === null || p.status === "offline" || p.status === "revoked" ? "—" : `${formatNumber(Math.round(p.latencyMs))} ms`);

function PeerList({ peers }: { peers: Peer[] }) {
	return (
		<>
			{/* Phones: cards that navigate to the detail route. */}
			<ul className="flex flex-col gap-2 md:hidden">
				{peers.map((p) => (
					<li key={p.id}>
						<Link
							to="/network/nodes/$peerId"
							params={{ peerId: p.id }}
							preload="intent"
							className={cn("flex min-h-14 flex-col gap-2 rounded-xl bg-surface-1 p-3.5 outline-none shadow-[inset_0_0_0_1px_var(--border)] active:bg-surface-2 focus-visible:shadow-[inset_0_0_0_2px_var(--accent)]", p.status === "revoked" && "opacity-60")}
						>
							<div className="flex items-center justify-between gap-2">
								<span className="flex min-w-0 items-center gap-2.5">
									<FingerprintIcon fingerprint={p.fingerprint} size={32} className="rounded-lg" />
									<span className="min-w-0 truncate text-[15px] font-semibold">{p.name}</span>
								</span>
								<span className="flex shrink-0 items-center gap-1">
									<PeerStatusBadge status={p.status} />
									<ChevronRight className="size-4 text-subtle" />
								</span>
							</div>
							<span className="truncate font-mono text-xs text-subtle">{hostOf(p.url)}</span>
							<span className="truncate text-xs text-muted-foreground">{t("Access: {access}", { access: summarizeCapabilities(p.grantedCapabilities) })}</span>
							<dl className="grid grid-cols-3 gap-2 text-xs">
								<Meta label={t("Agents")} value={p.agentCount} />
								<Meta label={t("Latency")} value={latency(p)} />
								<Meta label={t("Last seen")} value={relativeTime(p.lastSeenAt)} />
							</dl>
						</Link>
					</li>
				))}
			</ul>
			<div className="hidden overflow-x-auto rounded-xl bg-surface-1 shadow-[inset_0_0_0_1px_var(--border)] md:block">
				<Table>
					<THead>
						<tr>
							<Th>{t("Machine")}</Th>
							<Th>{t("Status")}</Th>
							<Th className="hidden xl:table-cell">{t("Fingerprint")}</Th>
							<Th>{t("URL")}</Th>
							<Th className="hidden lg:table-cell">{t("Latency")}</Th>
							<Th>{t("Last seen")}</Th>
							<Th>{t("Agents")}</Th>
							<Th>{t("Access granted")}</Th>
							<Th className="hidden xl:table-cell">{t("Workspaces")}</Th>
							<Th className="w-8" />
						</tr>
					</THead>
					<TBody>
						{peers.map((p) => (
							<Tr key={p.id} className={cn(p.status === "revoked" && "opacity-60")}>
								<Td className="max-w-56">
									<Link to="/network/nodes/$peerId" params={{ peerId: p.id }} preload="intent" className="flex items-center gap-2.5 rounded-md font-medium outline-none hover:underline focus-visible:shadow-[0_0_0_2px_var(--ring)]">
										<FingerprintIcon fingerprint={p.fingerprint} size={28} className="rounded-lg" />
										<span className="truncate">{p.name}</span>
									</Link>
								</Td>
								<Td>
									<PeerStatusBadge status={p.status} />
								</Td>
								<Td className="hidden xl:table-cell">
									<span className="inline-flex items-center gap-0.5">
										<span className="font-mono text-xs" title={p.fingerprint}>
											{shortFingerprint(p.fingerprint)}
										</span>
										<CopyIconButton value={p.fingerprint} label={t("Copy fingerprint")} />
									</span>
								</Td>
								<Td className="max-w-56 truncate font-mono text-xs text-muted-foreground" title={p.url}>
									{hostOf(p.url)}
								</Td>
								<Td className="tabular hidden font-mono text-xs lg:table-cell">{latency(p)}</Td>
								<Td className="whitespace-nowrap text-xs text-muted-foreground">{relativeTime(p.lastSeenAt)}</Td>
								<Td className="tabular text-xs">{p.agentCount}</Td>
								<Td className="max-w-52 truncate text-xs text-muted-foreground" title={p.grantedCapabilities.join(", ")}>
									{summarizeCapabilities(p.grantedCapabilities)}
								</Td>
								<Td className="hidden max-w-44 text-xs text-muted-foreground xl:table-cell">
									<SharedWorkspaces ids={p.workspaceIds} />
								</Td>
								<Td className="pr-2">
									<Link to="/network/nodes/$peerId" params={{ peerId: p.id }} aria-label={t("Open {name}", { name: p.name })} className="grid size-7 place-items-center rounded text-subtle hover:text-foreground">
										<ChevronRight className="size-4" />
									</Link>
								</Td>
							</Tr>
						))}
					</TBody>
				</Table>
			</div>
		</>
	);
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
	return (
		<div className="flex min-w-0 flex-col gap-0.5">
			<dt className="text-2xs uppercase tracking-wider text-subtle">{label}</dt>
			<dd className="truncate tabular">{value}</dd>
		</div>
	);
}

function OutgoingPairings() {
	const outgoing = useOutgoingPairings();
	const active = (outgoing.data ?? []).filter((p) => p.state === "hello_sent" || p.state === "awaiting_remote_approval");
	if (active.length === 0) return null;
	return (
		<section className="flex flex-col gap-2.5" aria-label={t("Pairings in progress")}>
			<SectionTitle>{t("Joining")}</SectionTitle>
			{active.map((p) => (
				<div key={p.id} className="flex items-center gap-3 rounded-xl bg-surface-1 px-3.5 py-3 text-[13px] shadow-[inset_0_0_0_1px_var(--border)]">
					<Loader2 className="size-4 shrink-0 animate-spin text-accent" />
					<span className="min-w-0 flex-1">
						<span className="font-medium">{p.remote.name}</span>
						<span className="text-muted-foreground"> — {p.state === "hello_sent" ? t("contacting…") : t("waiting for the inviter to approve")}</span>
					</span>
				</div>
			))}
		</section>
	);
}

function PendingInvitations() {
	const invitations = useInvitations();
	const workspaces = useWorkspaces();
	const revoke = useRevokeInvitation();
	const pending = (invitations.data ?? []).filter((i: Invitation) => i.state === "pending" && Date.parse(i.expiresAt) > Date.now());
	if (pending.length === 0) return null;
	return (
		<section className="flex flex-col gap-2.5" aria-label={t("Pending invitations")}>
			<SectionTitle>{t("Pending invitations")}</SectionTitle>
			<ul className="divide-y overflow-hidden rounded-xl bg-surface-1 shadow-[inset_0_0_0_1px_var(--border)]">
				{pending.map((i) => (
					<li key={i.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3.5 py-3 text-[13px]">
						<span className="min-w-0 flex-1">
							<span className="block truncate font-medium">{workspaces.data?.find((w) => w.id === i.workspaceId)?.name ?? i.workspaceId}</span>
							<span className="text-xs text-muted-foreground">
								<T
									text="{count, plural, one {# capability} other {# capabilities}} · expires in <c/>"
									params={{ count: i.capabilities.length }}
									tags={{ c: <Countdown until={i.expiresAt} /> }}
								/>
								{i.attempts > 0 ? ` · ${t("{count, plural, one {# attempt used} other {# attempts used}}", { count: i.attempts })}` : ""}
							</span>
						</span>
						<Button size="sm" variant="outline" loading={revoke.isPending && revoke.variables === i.id} onClick={() => revoke.mutate(i.id)}>
							<Trash2 /> {t("Revoke")}
						</Button>
					</li>
				))}
			</ul>
			<p className="flex items-center gap-1.5 text-xs text-subtle">
				<Inbox className="size-3.5" /> {t("The code itself is not stored and cannot be shown again; revoke and create a new invitation if you lost it.")}
			</p>
		</section>
	);
}
