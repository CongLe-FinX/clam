import type { Peer } from "@clam/contracts";
import { Link, useParams } from "@tanstack/react-router";
import { Check, ChevronLeft, ExternalLink, Globe, Network, Pencil, Send, ShieldOff, Terminal, X } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { KeyValue } from "@/features/settings/components/section";
import { errorMessage } from "@/lib/api";
import { useDirectory, usePeers, useWorkspaces } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { relativeTime } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/card";
import { EmptyState } from "@/ui/empty-state";
import { Input } from "@/ui/input";
import { PageContainer } from "@/ui/page";
import { Skeleton } from "@/ui/skeleton";
import { StatusDot } from "@/ui/status-dot";
import { Switch } from "@/ui/switch";
import { Tip } from "@/ui/tooltip";
import { CapabilityChecklist, CapabilityChips } from "./capabilities";
import { CopyIconButton, PeerStatusBadge } from "./components";
import { FingerprintCompare, FingerprintIcon } from "./fingerprint";
import { useRevokePeer, useUpdatePeer } from "./hooks";

export default function PeerPage() {
	const { peerId } = useParams({ from: "/network/nodes/$peerId" });
	const peers = usePeers();
	const peer = peers.data?.find((p) => p.id === peerId);

	return (
		<PageContainer>
			<Link to="/network/nodes" className="-mb-2 inline-flex min-h-9 items-center gap-1 self-start text-[13px] text-muted-foreground outline-none hover:text-foreground coarse:min-h-11">
				<ChevronLeft className="size-4" /> Connected machines
			</Link>
			{peers.isPending ? (
				<div aria-busy className="flex flex-col gap-3">
					<Skeleton className="h-10 w-64" />
					<Skeleton className="h-48" />
				</div>
			) : peers.error ? (
				<EmptyState icon={Network} title="Could not load this machine" description={errorMessage(peers.error)} />
			) : !peer ? (
				<EmptyState
					icon={Network}
					title="Machine not found"
					description="This machine is not paired with you (any more)."
					action={
						<Button asChild variant="outline" size="sm">
							<Link to="/network/nodes">Back to connected machines</Link>
						</Button>
					}
				/>
			) : (
				<PeerDetail peer={peer} />
			)}
		</PageContainer>
	);
}

/** The peer's own web UI at `/browser`; nothing is proxied through this machine. */
function peerBrowserUrl(apiBaseUrl: string): string | null {
	try {
		const { origin } = new URL(apiBaseUrl);
		return origin === "null" ? null : `${origin}/browser`;
	} catch {
		return null;
	}
}

/** The peer's own web UI at `/terminal`: its own shell, its own sign-in; nothing is relayed through this machine. */
function peerTerminalUrl(apiBaseUrl: string): string | null {
	try {
		const { origin } = new URL(apiBaseUrl);
		return origin === "null" ? null : `${origin}/terminal`;
	} catch {
		return null;
	}
}

function PeerDetail({ peer }: { peer: Peer }) {
	const [confirmRevoke, setConfirmRevoke] = useState(false);
	const openDialog = useUi((s) => s.openDialog);
	const revoke = useRevokePeer();
	const update = useUpdatePeer();
	const revoked = peer.status === "revoked";
	const browserUrl = peerBrowserUrl(peer.url);
	const terminalUrl = peerTerminalUrl(peer.url);

	return (
		<>
			<header className="flex flex-wrap items-start justify-between gap-3">
				<div className="flex min-w-0 items-center gap-3.5">
					<FingerprintIcon fingerprint={peer.fingerprint} size={56} className="hidden sm:block" />
					<div className="flex min-w-0 flex-col gap-1.5">
						<NameEditor peer={peer} disabled={revoked} />
						<div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
							<PeerStatusBadge status={peer.status} />
							<span>paired {relativeTime(peer.pairedAt)}</span>
							<span aria-hidden>·</span>
							<span>last seen {peer.lastSeenAt ? relativeTime(peer.lastSeenAt) : "never"}</span>
						</div>
					</div>
				</div>
				{revoked ? null : (
					<div className="flex flex-wrap items-center gap-2">
						<Button variant="primary" onClick={() => openDialog({ kind: "delegate-task", peerId: peer.id })}>
							<Send /> Delegate a task
						</Button>
						{terminalUrl ? (
							<Button asChild variant="outline">
								<a href={terminalUrl} target="_blank" rel="noopener noreferrer">
									<Terminal /> Open {peer.name}&apos;s Terminal <ExternalLink className="opacity-60" />
								</a>
							</Button>
						) : (
							<Tip label="This machine has no public address">
								<span tabIndex={0} className="inline-flex">
									<Button variant="outline" disabled>
										<Terminal /> Open {peer.name}&apos;s Terminal
									</Button>
								</span>
							</Tip>
						)}
						{browserUrl ? (
							<Button asChild variant="outline">
								<a href={browserUrl} target="_blank" rel="noopener noreferrer">
									<Globe /> Open {peer.name}&apos;s Browser <ExternalLink className="opacity-60" />
								</a>
							</Button>
						) : (
							<Tip label="This machine has no public address">
								<span tabIndex={0} className="inline-flex">
									<Button variant="outline" disabled>
										<Globe /> Open {peer.name}&apos;s Browser
									</Button>
								</span>
							</Tip>
						)}
						<Button variant="outline" className="text-danger" onClick={() => setConfirmRevoke(true)}>
							<ShieldOff /> Revoke
						</Button>
					</div>
				)}
			</header>
			{revoked ? null : <p className="-mt-2 text-xs text-subtle">Opens that machine&apos;s own UI — you sign in there. Its Terminal and Browser must be switched on by its owner.</p>}

			{revoked ? (
				<div role="status" className="rounded-xl bg-danger/10 p-3.5 text-[13px] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--danger)_30%,transparent)]">
					<strong className="text-danger">{peer.revokedBy === "remote" ? "This machine revoked you." : "You revoked this machine."}</strong>{" "}
					<span className="text-muted-foreground">
						{peer.revokedAt ? `${relativeTime(peer.revokedAt)}. ` : ""}It cannot reach this machine and no tasks flow either way. To connect again, pair with a fresh invitation.
					</span>
				</div>
			) : null}

			<div className="grid gap-4 lg:grid-cols-2">
				<div className="flex min-w-0 flex-col gap-4">
					<Card>
						<CardHeader>
							<CardTitle>Identity</CardTitle>
						</CardHeader>
						<CardContent className="flex flex-col gap-3 pt-3">
							<FingerprintCompare label="Fingerprint" fingerprint={peer.fingerprint} />
							<dl className="divide-y">
								<KeyValue label="Machine ID" mono>
									<span className="inline-flex items-center gap-1">
										{peer.id}
										<CopyIconButton value={peer.id} label="Copy machine ID" />
									</span>
								</KeyValue>
								<KeyValue label="URL" mono>
									<span className="inline-flex items-center gap-1">
										{peer.url}
										<CopyIconButton value={peer.url} label="Copy URL" />
									</span>
								</KeyValue>
								<KeyValue label="Protocol version" mono>
									v{peer.protocolVersion}
								</KeyValue>
							</dl>
						</CardContent>
					</Card>

					<Card>
						<CardHeader>
							<CardTitle>Status</CardTitle>
						</CardHeader>
						<CardContent className="pt-1">
							<dl className="divide-y">
								<KeyValue label="Connection">
									<span className="inline-flex items-center gap-2">
										<StatusDot status={peer.status === "revoked" ? "crashed" : peer.status} label={peer.status} />
										<span className="capitalize">{peer.status}</span>
									</span>
								</KeyValue>
								<KeyValue label="Last seen">{peer.lastSeenAt ? `${relativeTime(peer.lastSeenAt)} · ${new Date(peer.lastSeenAt).toLocaleString()}` : "Never"}</KeyValue>
								<KeyValue label="Latency" mono>
									{peer.latencyMs === null || revoked ? "—" : `${Math.round(peer.latencyMs)} ms`}
								</KeyValue>
								<KeyValue label="Last error">{peer.lastError ? <span className="break-words text-danger">{peer.lastError}</span> : <span className="text-subtle">None</span>}</KeyValue>
							</dl>
						</CardContent>
					</Card>

					<SharedWorkspaces peer={peer} />
				</div>

				<div className="flex min-w-0 flex-col gap-4">
					<Card>
						<CardHeader className="flex-col gap-1">
							<CardTitle>Tasks from this machine</CardTitle>
							<CardDescription>What happens when {peer.name} delegates work to one of your agents.</CardDescription>
						</CardHeader>
						<CardContent className="pt-3">
							<label className="flex cursor-pointer items-start gap-3 text-[13px] coarse:min-h-11">
								<Switch checked={peer.autoAcceptTasks} disabled={revoked} onCheckedChange={(v) => update.mutate({ id: peer.id, autoAcceptTasks: v })} aria-label="Auto-accept tasks from this machine" className="mt-0.5" />
								<span className="flex flex-col gap-0.5">
									<span className="font-medium">Auto-accept tasks from this machine</span>
									<span className="text-xs text-muted-foreground">
										A task starts right away when exactly one of your projects is linked to its GitHub repository. Otherwise — or when this is off — it waits for you to accept it. The agent then works on your machine under your approval settings.
									</span>
								</span>
							</label>
						</CardContent>
					</Card>
					<Card>
						<CardHeader className="flex-col gap-1">
							<CardTitle>What this machine may do on yours</CardTitle>
							<CardDescription>Changes apply immediately, on the next request this machine sends.</CardDescription>
						</CardHeader>
						<CardContent className="pt-3">
							<CapabilityChecklist value={peer.grantedCapabilities} peerName={peer.name} disabled={revoked} onChange={(next) => update.mutate({ id: peer.id, grantedCapabilities: next })} />
						</CardContent>
					</Card>
					<Card>
						<CardHeader className="flex-col gap-1">
							<CardTitle>What it allows you to do on its machine</CardTitle>
							<CardDescription>Set by {peer.name}; read-only here.</CardDescription>
						</CardHeader>
						<CardContent className="pt-3">
							<CapabilityChips value={peer.receivedCapabilities} />
						</CardContent>
					</Card>
					<PeerAgents peer={peer} />
				</div>
			</div>

			<ConfirmDialog
				open={confirmRevoke}
				onOpenChange={setConfirmRevoke}
				title={`Revoke ${peer.name}?`}
				danger
				confirmLabel="Revoke now"
				loading={revoke.isPending}
				description={
					<>
						This takes effect <strong>immediately</strong>: {peer.name} can no longer call this machine, its capabilities are removed and its agents disappear from your directory. It is notified on a best-effort basis. You cannot undo it — to connect again you must pair with a new invitation.
					</>
				}
				onConfirm={() => revoke.mutate(peer.id, { onSettled: () => setConfirmRevoke(false) })}
			/>
		</>
	);
}

function NameEditor({ peer, disabled }: { peer: Peer; disabled: boolean }) {
	const update = useUpdatePeer();
	const [editing, setEditing] = useState(false);
	const [name, setName] = useState(peer.name);
	if (!editing)
		return (
			<div className="flex min-w-0 items-center gap-1">
				<h1 className="truncate text-xl font-semibold tracking-tight">{peer.name}</h1>
				{disabled ? null : (
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="Rename machine"
						onClick={() => {
							setName(peer.name);
							setEditing(true);
						}}
					>
						<Pencil />
					</Button>
				)}
			</div>
		);
	const save = () => {
		const next = name.trim();
		if (next && next !== peer.name) update.mutate({ id: peer.id, name: next });
		setEditing(false);
	};
	return (
		<form
			className="flex items-center gap-1"
			onSubmit={(e) => {
				e.preventDefault();
				save();
			}}
		>
			<Input autoFocus value={name} maxLength={64} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setEditing(false)} className="w-64 max-w-full" aria-label="Machine name" />
			<Button type="submit" variant="ghost" size="icon-sm" aria-label="Save name">
				<Check />
			</Button>
			<Button variant="ghost" size="icon-sm" aria-label="Cancel" onClick={() => setEditing(false)}>
				<X />
			</Button>
		</form>
	);
}

function SharedWorkspaces({ peer }: { peer: Peer }) {
	const workspaces = useWorkspaces();
	return (
		<Card>
			<CardHeader>
				<CardTitle>Shared workspaces</CardTitle>
			</CardHeader>
			<CardContent className="pt-3">
				{peer.workspaceIds.length === 0 ? (
					<p className="text-[13px] text-subtle">No workspace is shared with this machine.</p>
				) : (
					<ul className="flex flex-col gap-1">
						{peer.workspaceIds.map((id) => {
							const ws = workspaces.data?.find((w) => w.id === id);
							return (
								<li key={id}>
									<Link to="/workspaces/$workspaceId" params={{ workspaceId: id }} className="flex min-h-9 items-center justify-between rounded-lg px-2 text-[13px] hover:bg-surface-2 coarse:min-h-11">
										<span className="truncate font-medium">{ws?.name ?? id}</span>
										{ws ? <span className="font-mono text-2xs text-subtle">{ws.projectCount} projects</span> : null}
									</Link>
								</li>
							);
						})}
					</ul>
				)}
			</CardContent>
		</Card>
	);
}

function PeerAgents({ peer }: { peer: Peer }) {
	const directory = useDirectory();
	const agents = (directory.data ?? []).filter((a) => a.nodeId === peer.id);
	return (
		<Card>
			<CardHeader>
				<CardTitle>Agents ({peer.status === "revoked" ? 0 : peer.agentCount})</CardTitle>
				<Link to="/network/agents" className="text-xs text-muted-foreground hover:text-foreground">
					Agent Directory
				</Link>
			</CardHeader>
			<CardContent className="flex flex-col gap-2 pt-3">
				{directory.isPending ? <Skeleton className="h-10" /> : null}
				{directory.isSuccess && agents.length === 0 ? <p className="text-[13px] text-subtle">{peer.status === "revoked" ? "Agents of revoked machines are not listed." : "No agents reported yet."}</p> : null}
				{agents.map((a) => (
					<div key={a.agentId} className="flex items-center gap-2.5 text-[13px]">
						<StatusDot status={a.status} />
						<span className="font-medium">{a.name}</span>
						<span className="min-w-0 flex-1 truncate text-xs text-subtle">{a.role}</span>
						<span className="font-mono text-2xs text-subtle">{a.runtime}</span>
					</div>
				))}
			</CardContent>
		</Card>
	);
}
