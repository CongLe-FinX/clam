import type { Capability, Peer, WorkspaceMember } from "@clam/contracts";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { KeyRound, Link2, TriangleAlert, UserMinus, UserPlus, Users } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { T, msg, t, tr, type Msg } from "@/i18n";
import { PEER_STATUS_LABEL } from "@/features/network/format";
import { useMemberMutations, useMembers } from "@/features/context/hooks.ts";
import { NODE_STATUS_LABEL, nodeDot } from "@/features/shared/format.ts";
import { errorMessage } from "@/lib/api";
import { usePeers, useWorkspace } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { cn, relativeTime } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { EmptyState } from "@/ui/empty-state";
import { PageContainer, PageHeader } from "@/ui/page";
import { Skeleton } from "@/ui/skeleton";
import { StatusDot } from "@/ui/status-dot";
import { Table, TBody, Td, Th, THead, Tr } from "@/ui/table";
import { Tip } from "@/ui/tooltip";

const CAPABILITY_HINT: Partial<Record<Capability, Msg>> = {
	"context.sync": msg("Receive and send shareable contexts for this workspace"),
	"sessions.share": msg("Take part in shared sessions (mirror, checkpoints, hand-over)"),
	"tasks.send": msg("Send tasks to this machine"),
	"tasks.receive": msg("Receive tasks from this machine"),
	"tasks.cancel": msg("Cancel tasks it sent"),
	"agents.read": msg("List this machine's agents"),
	"events.read": msg("Follow this machine's events"),
	"artifacts.read": msg("Read artifacts"),
	"artifacts.write": msg("Write artifacts"),
	"handoff.send": msg("Hand work over to this machine"),
	"handoff.receive": msg("Receive hand-overs from this machine"),
};

// ───────────────────────────── add member ─────────────────────────────

function PeerChoice({ peer, checked, onSelect }: { peer: Peer; checked: boolean; onSelect: () => void }) {
	return (
		<label
			className={cn(
				"flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] transition-colors has-[:focus-visible]:shadow-[0_0_0_2px_var(--accent)]",
				checked ? "bg-accent-soft" : "bg-surface-2/60 hover:bg-surface-2",
			)}
		>
			<input type="radio" name="member-peer" checked={checked} onChange={onSelect} className="size-4 shrink-0 accent-[var(--accent)] coarse:size-5" />
			<StatusDot status={peer.status === "online" ? "online" : peer.status === "degraded" ? "degraded" : "offline"} label={tr(PEER_STATUS_LABEL[peer.status])} />
			<span className="min-w-0 flex-1 truncate font-medium">{peer.name}</span>
			<span className="shrink-0 text-2xs text-subtle">{tr(PEER_STATUS_LABEL[peer.status])}</span>
		</label>
	);
}

function AddMemberDialog({ workspaceId, members, onClose }: { workspaceId: string; members: WorkspaceMember[]; onClose: () => void }) {
	const peers = usePeers();
	const { add } = useMemberMutations(workspaceId);
	const openDialog = useUi((s) => s.openDialog);
	const [peerId, setPeerId] = useState<string | null>(null);
	const [perms, setPerms] = useState<Set<string>>(new Set());

	const candidates = useMemo(() => {
		const taken = new Set(members.filter((m) => m.nodeStatus !== "revoked" && m.revokedAt === null).map((m) => m.nodeId));
		return (peers.data ?? []).filter((p) => p.status !== "revoked" && !taken.has(p.id));
	}, [peers.data, members]);
	const peer = candidates.find((p) => p.id === peerId) ?? null;

	const select = (p: Peer) => {
		setPeerId(p.id);
		setPerms(new Set(p.grantedCapabilities));
	};
	const toggle = (cap: string, on: boolean) =>
		setPerms((prev) => {
			const next = new Set(prev);
			if (on) next.add(cap);
			else next.delete(cap);
			return next;
		});
	const lacksSync = peer ? !peer.grantedCapabilities.includes("context.sync") : false;

	const submit = () => {
		if (!peer) return;
		add.mutate(
			{ nodeId: peer.id, permissions: [...perms] },
			{
				onSuccess: () => {
					toast.success(t("{name} added to the workspace", { name: peer.name }));
					onClose();
				},
				onError: (e) => toast.error(t("Could not add member"), { description: errorMessage(e) }),
			},
		);
	};

	let body: ReactNode;
	if (peers.isPending) {
		body = (
			<div className="flex flex-col gap-2" aria-busy="true">
				<Skeleton className="h-11" />
				<Skeleton className="h-11" />
			</div>
		);
	} else if (peers.isError) {
		body = (
			<EmptyState
				icon={TriangleAlert}
				title={t("Could not load paired machines")}
				description={errorMessage(peers.error)}
				className="py-6"
				action={
					<Button variant="outline" onClick={() => void peers.refetch()}>
						{t("Retry")}
					</Button>
				}
			/>
		);
	} else if (candidates.length === 0) {
		body = (
			<EmptyState
				icon={Link2}
				title={t("No machine to add")}
				description={(peers.data ?? []).some((p) => p.status !== "revoked") ? t("Every paired machine is already a member.") : t("Pair another machine first, then add it here.")}
				className="py-6"
				action={
					<div className="flex flex-wrap justify-center gap-2">
						<Button
							variant="outline"
							onClick={() => {
								onClose();
								openDialog({ kind: "invite-node", workspaceId });
							}}
						>
							{t("Invite a machine")}
						</Button>
						<Button
							variant="outline"
							onClick={() => {
								onClose();
								openDialog({ kind: "join-node" });
							}}
						>
							{t("Join a machine")}
						</Button>
					</div>
				}
			/>
		);
	} else {
		body = (
			<div className="scrollbar-thin flex min-h-0 flex-col gap-3 overflow-y-auto">
				<div role="radiogroup" aria-label={t("Paired machine")} className="flex flex-col gap-1.5">
					{candidates.map((p) => (
						<PeerChoice key={p.id} peer={p} checked={p.id === peerId} onSelect={() => select(p)} />
					))}
				</div>
				{peer ? (
					<fieldset className="flex flex-col gap-1.5">
						<legend className="mb-1 text-xs font-medium text-muted-foreground">{t("Permissions in this workspace")}</legend>
						{peer.grantedCapabilities.length === 0 ? <p className="text-xs text-subtle">{t("You have not granted this machine any capability.")}</p> : null}
						{peer.grantedCapabilities.map((cap) => (
							<label key={cap} className="flex min-h-8 cursor-pointer items-start gap-2.5 py-1 coarse:min-h-11 coarse:items-center">
								<input
									type="checkbox"
									checked={perms.has(cap)}
									onChange={(e) => toggle(cap, e.target.checked)}
									className="mt-0.5 size-4 shrink-0 accent-[var(--accent)] coarse:mt-0 coarse:size-5"
								/>
								<span className="flex min-w-0 flex-col">
									<span className="font-mono text-xs">{cap}</span>
									{CAPABILITY_HINT[cap] ? <span className="text-2xs text-subtle">{tr(CAPABILITY_HINT[cap])}</span> : null}
								</span>
							</label>
						))}
						{lacksSync ? (
							<div role="alert" className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning shadow-[inset_0_0_0_1px_var(--warning)]">
								<TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
								<p>
									<T
										text="This machine can't receive shared context until you grant context.sync on its <link>Machines page</link>."
										tags={{ link: <Link to="/network/nodes/$peerId" params={{ peerId: peer.id }} onClick={onClose} className="font-medium underline" /> }}
									/>
								</p>
							</div>
						) : null}
					</fieldset>
				) : null}
			</div>
		);
	}

	return (
		<Dialog open onOpenChange={(o) => !o && onClose()}>
			<DialogContent sheetOnMobile>
				<DialogHeader>
					<DialogTitle>{t("Add member")}</DialogTitle>
					<DialogDescription>{t("Members receive this workspace's shareable contexts. Private contexts never leave this machine.")}</DialogDescription>
				</DialogHeader>
				{body}
				<DialogFooter>
					<Button variant="ghost" onClick={onClose}>
						{t("Cancel")}
					</Button>
					<Button variant="primary" onClick={submit} loading={add.isPending} disabled={!peer}>
						<UserPlus /> {t("Add member")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

// ───────────────────────────── list ─────────────────────────────

function removeBlocker(m: WorkspaceMember): string | null {
	if (m.nodeStatus === "self") return t("This machine can't be removed from its own workspace.");
	if (m.role === "owner") return t("The owner can't be removed.");
	return null;
}

function RemoveButton({ member, onRemove }: { member: WorkspaceMember; onRemove: (m: WorkspaceMember) => void }) {
	const blocker = removeBlocker(member);
	if (blocker) {
		return (
			<Tip label={blocker}>
				<span tabIndex={0} className="inline-flex rounded-lg outline-none focus-visible:shadow-[0_0_0_2px_var(--accent)]" aria-label={blocker}>
					<Button size="sm" variant="ghost" disabled>
						<UserMinus /> {t("Remove")}
					</Button>
				</span>
			</Tip>
		);
	}
	if (member.nodeStatus === "revoked" && member.revokedAt) return null;
	return (
		<Button size="sm" variant="ghost" className="text-danger hover:text-danger" onClick={() => onRemove(member)} aria-label={t("Remove {name}", { name: member.nodeName })}>
			<UserMinus /> {t("Remove")}
		</Button>
	);
}

function Perms({ perms }: { perms: string[] }) {
	if (perms.length === 0) return <span className="text-2xs text-subtle">{t("none")}</span>;
	return (
		<span className="flex flex-wrap gap-1">
			{perms.map((p) => (
				<Badge key={p} variant={p === "context.sync" ? "accent" : "outline"} className="font-mono">
					{p}
				</Badge>
			))}
		</span>
	);
}

function NodeCell({ m }: { m: WorkspaceMember }) {
	return (
		<span className="flex min-w-0 items-center gap-2">
			<StatusDot status={nodeDot(m.nodeStatus)} label={tr(NODE_STATUS_LABEL[m.nodeStatus])} />
			<span className="min-w-0 truncate font-medium" title={m.nodeName}>
				{m.nodeName}
			</span>
			{m.nodeStatus === "self" ? <Badge variant="outline">{t("This machine")}</Badge> : null}
		</span>
	);
}

const when = (m: WorkspaceMember) =>
	m.revokedAt ? t("removed {time}", { time: relativeTime(m.revokedAt) }) : m.joinedAt ? t("joined {time}", { time: relativeTime(m.joinedAt) }) : "—";

function MembersTable({ members, onRemove }: { members: WorkspaceMember[]; onRemove: (m: WorkspaceMember) => void }) {
	return (
		<Card className="hidden overflow-hidden md:block">
			<Table aria-label={t("Workspace members")}>
				<THead>
					<tr>
						<Th>{t("Machine")}</Th>
						<Th>{t("Role")}</Th>
						<Th>{t("Status")}</Th>
						<Th>{t("Permissions")}</Th>
						<Th>{t("Since")}</Th>
						<Th className="text-right">
							<span className="sr-only">{t("Actions")}</span>
						</Th>
					</tr>
				</THead>
				<TBody>
					{members.map((m) => (
						<Tr key={m.nodeId}>
							<Td className="max-w-56">
								<NodeCell m={m} />
							</Td>
							<Td>
								<Badge variant={m.role === "owner" ? "accent" : "neutral"}>{m.role === "owner" ? t("Owner") : t("Member")}</Badge>
							</Td>
							<Td className="text-muted-foreground">{tr(NODE_STATUS_LABEL[m.nodeStatus])}</Td>
							<Td className="max-w-72">
								<Perms perms={m.permissions} />
							</Td>
							<Td className="whitespace-nowrap text-xs text-subtle">{when(m)}</Td>
							<Td className="text-right">
								<RemoveButton member={m} onRemove={onRemove} />
							</Td>
						</Tr>
					))}
				</TBody>
			</Table>
		</Card>
	);
}

function MembersCards({ members, onRemove }: { members: WorkspaceMember[]; onRemove: (m: WorkspaceMember) => void }) {
	return (
		<ul className="flex flex-col gap-2 md:hidden" aria-label={t("Workspace members")}>
			{members.map((m) => (
				<li key={m.nodeId} className="flex flex-col gap-2 rounded-xl bg-surface-1 p-3 shadow-[inset_0_0_0_1px_var(--border)]">
					<div className="flex min-w-0 items-center gap-2">
						<div className="min-w-0 flex-1">
							<NodeCell m={m} />
						</div>
						<Badge variant={m.role === "owner" ? "accent" : "neutral"}>{m.role === "owner" ? t("Owner") : t("Member")}</Badge>
					</div>
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-subtle">
						<span>{tr(NODE_STATUS_LABEL[m.nodeStatus])}</span>
						<span>{when(m)}</span>
					</div>
					<Perms perms={m.permissions} />
					<div className="flex justify-end">
						<RemoveButton member={m} onRemove={onRemove} />
					</div>
				</li>
			))}
		</ul>
	);
}

export default function MembersPage() {
	const { workspaceId } = useParams({ strict: false }) as { workspaceId: string };
	const { add } = useSearch({ strict: false }) as { add?: "1" };
	const navigate = useNavigate();
	const ws = useWorkspace(workspaceId);
	const q = useMembers(workspaceId);
	const { remove } = useMemberMutations(workspaceId);
	const openDialog = useUi((s) => s.openDialog);
	const [adding, setAdding] = useState(add === "1");
	const [removing, setRemoving] = useState<WorkspaceMember | null>(null);

	// `?add=1` (command palette, links) opens the dialog; closing it clears the param.
	useEffect(() => {
		if (add === "1") setAdding(true);
	}, [add]);
	const closeAdd = () => {
		setAdding(false);
		if (add) void navigate({ to: "/workspaces/$workspaceId/members", params: { workspaceId }, search: {}, replace: true });
	};

	const members = q.data ?? [];
	const alone = q.isSuccess && members.every((m) => m.nodeStatus === "self");

	return (
		<PageContainer>
			<PageHeader
				eyebrow={
					<Link to="/workspaces/$workspaceId" params={{ workspaceId }} className="rounded-sm outline-none hover:text-foreground focus-visible:shadow-[0_0_0_2px_var(--accent)]">
						{ws.data?.name ?? t("Workspace")}
					</Link>
				}
				title={t("Members")}
				description={t("Machines that take part in this workspace. Shareable contexts sync with members machine-to-machine; private contexts never leave their machine.")}
				actions={
					<Button variant="primary" onClick={() => setAdding(true)} disabled={!q.isSuccess}>
						<UserPlus /> {t("Add member")}
					</Button>
				}
			/>

			{q.isPending ? (
				<div className="flex flex-col gap-2" aria-busy="true" aria-label={t("Loading members")}>
					<Skeleton className="h-14 rounded-xl" />
					<Skeleton className="h-14 rounded-xl" />
					<Skeleton className="h-14 rounded-xl" />
				</div>
			) : q.isError ? (
				<EmptyState
					icon={TriangleAlert}
					title={t("Could not load members")}
					description={errorMessage(q.error)}
					action={
						<Button variant="outline" loading={q.isFetching} onClick={() => void q.refetch()}>
							{t("Retry")}
						</Button>
					}
				/>
			) : (
				<>
					<MembersTable members={members} onRemove={setRemoving} />
					<MembersCards members={members} onRemove={setRemoving} />
					{alone ? (
						<EmptyState
							icon={Users}
							title={t("Only this machine is a member")}
							description={t("Pair another machine, then add it here to share contexts and hand off tasks.")}
							className="rounded-xl bg-surface-1 py-10 shadow-[inset_0_0_0_1px_var(--border)]"
							action={
								<div className="flex flex-wrap justify-center gap-2">
									<Button variant="outline" onClick={() => openDialog({ kind: "invite-node", workspaceId })}>
										<KeyRound /> {t("Invite a machine")}
									</Button>
									<Button variant="outline" onClick={() => openDialog({ kind: "join-node" })}>
										<Link2 /> {t("Join a machine")}
									</Button>
									<Button variant="primary" onClick={() => setAdding(true)}>
										<UserPlus /> {t("Add member")}
									</Button>
								</div>
							}
						/>
					) : null}
				</>
			)}

			{adding && q.isSuccess ? <AddMemberDialog workspaceId={workspaceId} members={members} onClose={closeAdd} /> : null}
			<ConfirmDialog
				open={removing !== null}
				onOpenChange={(o) => !o && setRemoving(null)}
				title={t("Remove {name}?", { name: removing?.nodeName ?? t("member") })}
				description={t("This stops syncing shareable contexts with that machine. Copies it already holds stay on that machine.")}
				confirmLabel={t("Remove")}
				danger
				loading={remove.isPending}
				onConfirm={() =>
					removing &&
					remove.mutate(removing.nodeId, {
						onSuccess: () => {
							toast.success(t("{name} removed", { name: removing.nodeName }));
							setRemoving(null);
						},
						onError: (e) => toast.error(t("Could not remove member"), { description: errorMessage(e) }),
					})
				}
			/>
		</PageContainer>
	);
}
