import type { Invitation, Peer } from "@clam/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Cloud, Inbox, Loader2, LogIn, Network, RefreshCw, Trash2, UserPlus } from "lucide-react";
import { useMemo } from "react";
import { errorMessage } from "@/lib/api";
import { isAwaitingApproval, useInvitations, useOutgoingPairings, usePairingRequests, usePeers, useTunnel, useWorkspaces } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { cn, relativeTime, shortFingerprint } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card, CardContent } from "@/ui/card";
import { EmptyState } from "@/ui/empty-state";
import { PageContainer, PageHeader, SectionTitle } from "@/ui/page";
import { Skeleton } from "@/ui/skeleton";
import { Table, TBody, Td, Th, THead, Tr } from "@/ui/table";
import { Countdown, CopyIconButton, PeerStatusBadge } from "./components";
import { hostOf } from "./format";
import { useRevokeInvitation } from "./hooks";
import { PairingRequestCard, sortRequests } from "./pairing-requests";

const STATUS_RANK = { online: 0, degraded: 1, offline: 2, revoked: 3 } as const;

export default function ConnectedNodesPage() {
	const peers = usePeers();
	const requests = usePairingRequests();
	const openDialog = useUi((s) => s.openDialog);
	const sorted = useMemo(() => [...(peers.data ?? [])].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.name.localeCompare(b.name)), [peers.data]);
	const awaiting = sortRequests((requests.data ?? []).filter((r) => isAwaitingApproval(r) || r.state === "confirming"));

	return (
		<PageContainer wide>
			<PageHeader
				eyebrow="Agent Network"
				title="Connected nodes"
				description="Nodes you paired with. Each request between you is signed with Ed25519 keys that both sides pinned during pairing."
				actions={
					<>
						<Button variant="outline" onClick={() => openDialog({ kind: "join-node" })}>
							<LogIn /> Join a node
						</Button>
						<Button variant="primary" onClick={() => openDialog({ kind: "invite-node" })}>
							<UserPlus /> Invite a node
						</Button>
					</>
				}
			/>
			<ReachabilityStrip />

			{awaiting.length > 0 ? (
				<section className="flex flex-col gap-2.5" aria-label="Pairing requests">
					<SectionTitle actions={<Badge variant="warning">{awaiting.length} waiting</Badge>}>Pairing requests</SectionTitle>
					{awaiting.map((r) => (
						<PairingRequestCard key={r.id} request={r} />
					))}
				</section>
			) : null}

			<OutgoingPairings />

			<section className="flex flex-col gap-2.5">
				<SectionTitle>Nodes</SectionTitle>
				{peers.isPending ? (
					<div aria-busy className="flex flex-col gap-2">
						{[0, 1, 2].map((i) => (
							<Skeleton key={i} className="h-14 rounded-lg" />
						))}
					</div>
				) : peers.error ? (
					<EmptyState
						icon={Network}
						title="Could not load nodes"
						description={errorMessage(peers.error)}
						action={
							<Button size="sm" variant="outline" onClick={() => void peers.refetch()}>
								<RefreshCw /> Retry
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
		</PageContainer>
	);
}

function ReachabilityStrip() {
	const tunnel = useTunnel();
	const t = tunnel.data;
	if (!t) return null;
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl bg-surface-1 px-3.5 py-2.5 text-[13px] shadow-[inset_0_0_0_1px_var(--border)]">
			<Cloud className={cn("size-4 shrink-0", t.publicUrl ? "text-success" : "text-subtle")} />
			{t.publicUrl ? (
				<>
					<span className="text-muted-foreground">This node is reachable at</span>
					<span className="min-w-0 truncate font-mono text-xs">{t.publicUrl}</span>
					<CopyIconButton value={t.publicUrl} label="Copy this node's address" />
				</>
			) : (
				<span className="text-muted-foreground">
					No public URL — other nodes cannot reach this one yet.{" "}
					<Link to="/settings/tunnel" className="font-medium text-accent hover:underline">
						Start a Cloudflare Tunnel
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
	const steps = [
		{
			n: 1,
			title: "Make this node reachable",
			body: "Start a Cloudflare Tunnel so other nodes can reach this one over HTTPS without opening any ports. Only the signed /api/v1 interface is exposed — never this UI.",
			action: (
				<Button asChild variant={running ? "outline" : "primary"} size="sm" className="self-start">
					<Link to="/settings/tunnel">{running ? "Tunnel is running" : "Open tunnel settings"}</Link>
				</Button>
			),
			done: running,
		},
		{
			n: 2,
			title: "Invite — or join",
			body: "Create an invitation and send the code, the address and the fingerprint to the other person. Or enter a code you received. Both sides compare fingerprints, then the inviter approves.",
			action: (
				<div className="flex flex-wrap gap-2">
					<Button variant="primary" size="sm" onClick={() => openDialog({ kind: "invite-node" })}>
						<UserPlus /> Invite a node
					</Button>
					<Button variant="outline" size="sm" onClick={() => openDialog({ kind: "join-node" })}>
						<LogIn /> Join a node
					</Button>
				</div>
			),
			done: false,
		},
	];
	return (
		<Card>
			<CardContent className="flex flex-col gap-4">
				<div className="flex items-center gap-3">
					<div className="grid size-10 place-items-center rounded-xl bg-surface-2 text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]">
						<Network className="size-5" />
					</div>
					<div>
						<h3 className="text-sm font-semibold">No connected nodes yet</h3>
						<p className="text-[13px] text-muted-foreground">Pairing takes two steps.</p>
					</div>
				</div>
				<div className="grid gap-3 md:grid-cols-2">
					{steps.map((s) => (
						<div key={s.n} className="flex flex-col gap-2 rounded-xl bg-surface-2 p-3.5 shadow-[inset_0_0_0_1px_var(--border)]">
							<div className="flex items-center gap-2 text-[13px] font-medium">
								<span className={cn("grid size-5 place-items-center rounded-md font-mono text-2xs", s.done ? "bg-success/15 text-success" : "bg-accent-soft text-accent")}>{s.n}</span>
								{s.title}
							</div>
							<p className="flex-1 text-xs text-muted-foreground">{s.body}</p>
							{s.action}
						</div>
					))}
				</div>
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

const latency = (p: Peer) => (p.latencyMs === null || p.status === "offline" || p.status === "revoked" ? "—" : `${Math.round(p.latencyMs)} ms`);

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
								<span className="min-w-0 truncate text-[15px] font-semibold">{p.name}</span>
								<span className="flex shrink-0 items-center gap-1">
									<PeerStatusBadge status={p.status} />
									<ChevronRight className="size-4 text-subtle" />
								</span>
							</div>
							<span className="truncate font-mono text-xs text-subtle">{hostOf(p.url)}</span>
							<dl className="grid grid-cols-3 gap-2 text-xs">
								<Meta label="Agents" value={p.agentCount} />
								<Meta label="Latency" value={latency(p)} />
								<Meta label="Last seen" value={relativeTime(p.lastSeenAt)} />
							</dl>
						</Link>
					</li>
				))}
			</ul>
			<div className="hidden overflow-hidden rounded-xl bg-surface-1 shadow-[inset_0_0_0_1px_var(--border)] md:block">
				<Table>
					<THead>
						<tr>
							<Th>Node</Th>
							<Th>Status</Th>
							<Th>Fingerprint</Th>
							<Th>URL</Th>
							<Th>Latency</Th>
							<Th>Last seen</Th>
							<Th>Agents</Th>
							<Th>Workspaces</Th>
							<Th className="w-8" />
						</tr>
					</THead>
					<TBody>
						{peers.map((p) => (
							<Tr key={p.id} className={cn(p.status === "revoked" && "opacity-60")}>
								<Td className="max-w-56">
									<Link to="/network/nodes/$peerId" params={{ peerId: p.id }} preload="intent" className="block truncate font-medium hover:underline">
										{p.name}
									</Link>
								</Td>
								<Td>
									<PeerStatusBadge status={p.status} />
								</Td>
								<Td>
									<span className="inline-flex items-center gap-0.5">
										<span className="font-mono text-xs" title={p.fingerprint}>
											{shortFingerprint(p.fingerprint)}
										</span>
										<CopyIconButton value={p.fingerprint} label="Copy fingerprint" />
									</span>
								</Td>
								<Td className="max-w-56 truncate font-mono text-xs text-muted-foreground" title={p.url}>
									{hostOf(p.url)}
								</Td>
								<Td className="tabular font-mono text-xs">{latency(p)}</Td>
								<Td className="whitespace-nowrap text-xs text-muted-foreground">{relativeTime(p.lastSeenAt)}</Td>
								<Td className="tabular text-xs">{p.agentCount}</Td>
								<Td className="max-w-44 text-xs text-muted-foreground">
									<SharedWorkspaces ids={p.workspaceIds} />
								</Td>
								<Td className="pr-2">
									<Link to="/network/nodes/$peerId" params={{ peerId: p.id }} aria-label={`Open ${p.name}`} className="grid size-7 place-items-center rounded text-subtle hover:text-foreground">
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
		<section className="flex flex-col gap-2.5" aria-label="Pairings in progress">
			<SectionTitle>Joining</SectionTitle>
			{active.map((p) => (
				<div key={p.id} className="flex items-center gap-3 rounded-xl bg-surface-1 px-3.5 py-3 text-[13px] shadow-[inset_0_0_0_1px_var(--border)]">
					<Loader2 className="size-4 shrink-0 animate-spin text-accent" />
					<span className="min-w-0 flex-1">
						<span className="font-medium">{p.remote.name}</span>
						<span className="text-muted-foreground"> — {p.state === "hello_sent" ? "contacting…" : "waiting for the inviter to approve"}</span>
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
		<section className="flex flex-col gap-2.5" aria-label="Pending invitations">
			<SectionTitle>Pending invitations</SectionTitle>
			<ul className="divide-y overflow-hidden rounded-xl bg-surface-1 shadow-[inset_0_0_0_1px_var(--border)]">
				{pending.map((i) => (
					<li key={i.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3.5 py-3 text-[13px]">
						<span className="min-w-0 flex-1">
							<span className="block truncate font-medium">{workspaces.data?.find((w) => w.id === i.workspaceId)?.name ?? i.workspaceId}</span>
							<span className="text-xs text-muted-foreground">
								{i.capabilities.length} capabilities · expires in <Countdown until={i.expiresAt} />
								{i.attempts > 0 ? ` · ${i.attempts} ${i.attempts === 1 ? "attempt" : "attempts"} used` : ""}
							</span>
						</span>
						<Button size="sm" variant="outline" loading={revoke.isPending && revoke.variables === i.id} onClick={() => revoke.mutate(i.id)}>
							<Trash2 /> Revoke
						</Button>
					</li>
				))}
			</ul>
			<p className="flex items-center gap-1.5 text-xs text-subtle">
				<Inbox className="size-3.5" /> The code itself is not stored and cannot be shown again; revoke and create a new invitation if you lost it.
			</p>
		</section>
	);
}
