import { type Capability, DEFAULT_PEER_CAPABILITIES, type Invitation } from "@clam/contracts";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ClipboardCopy, Clock, Inbox, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { errorMessage } from "@/lib/api";
import { useInvitations, usePairingRequests, useTunnel, useWorkspaces } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { Field } from "@/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { CapabilityChecklist } from "./capabilities";
import { Countdown, CopyBlock, useCopy } from "./components";
import { formatFingerprint, formatInvitationCode, invitationMessage } from "./format";
import { useCreateInvitation, useRevokeInvitation } from "./hooks";

const TTL_OPTIONS = [1, 2, 5, 10] as const;

export default function InviteDialog({ workspaceId: initialWorkspace, onClose }: { workspaceId?: string; onClose: () => void }) {
	const [created, setCreated] = useState<Invitation | null>(null);
	return (
		<Dialog open onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="max-w-xl" sheetOnMobile>
				{created?.code ? <Created invitation={created} onClose={onClose} onAnother={() => setCreated(null)} /> : <Form initialWorkspace={initialWorkspace} onClose={onClose} onCreated={setCreated} />}
			</DialogContent>
		</Dialog>
	);
}

function Form({ initialWorkspace, onClose, onCreated }: { initialWorkspace?: string; onClose: () => void; onCreated: (i: Invitation) => void }) {
	const workspaces = useWorkspaces();
	const tunnel = useTunnel();
	const create = useCreateInvitation();
	const [workspaceId, setWorkspaceId] = useState(initialWorkspace ?? "");
	const [capabilities, setCapabilities] = useState<Capability[]>(DEFAULT_PEER_CAPABILITIES);
	const [ttl, setTtl] = useState<number>(10);
	useEffect(() => {
		if (!workspaceId && workspaces.data?.[0]) setWorkspaceId(workspaces.data[0].id);
	}, [workspaceId, workspaces.data]);
	const noWorkspace = workspaces.isSuccess && workspaces.data.length === 0;
	const openDialog = useUi((s) => s.openDialog);
	const noUrl = tunnel.isSuccess && !tunnel.data.publicUrl;

	return (
		<>
			<DialogHeader>
				<DialogTitle>Invite a node</DialogTitle>
				<DialogDescription>Creates a one-time code. Share it, together with this node's address and fingerprint, with the person who runs the other node.</DialogDescription>
			</DialogHeader>
			<form
				className="-mx-1 flex min-h-0 flex-col gap-4 overflow-y-auto px-1"
				onSubmit={(e) => {
					e.preventDefault();
					if (workspaceId) create.mutate({ workspaceId, capabilities, ttlMinutes: ttl }, { onSuccess: onCreated });
				}}
			>
				{noUrl ? <NoUrlWarning onNavigate={onClose} /> : null}
				{noWorkspace ? (
					<div className="rounded-xl bg-surface-2 p-3 text-[13px] text-muted-foreground">
						An invitation shares one workspace with the other node, so you need a workspace first.
						<Button size="sm" variant="outline" className="mt-2 block" onClick={() => openDialog({ kind: "create-workspace" })}>
							<Plus /> New workspace
						</Button>
					</div>
				) : (
					<Field label="Workspace to share" hint="The other node gets a workspace with the same name and id. Projects and files are never shared automatically.">
						{() => (
							<Select value={workspaceId} onValueChange={setWorkspaceId}>
								<SelectTrigger>
									<SelectValue placeholder="Select workspace" />
								</SelectTrigger>
								<SelectContent>
									{workspaces.data?.map((w) => (
										<SelectItem key={w.id} value={w.id}>
											{w.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						)}
					</Field>
				)}
				<div className="flex flex-col gap-1.5">
					<span className="text-xs font-medium text-muted-foreground">What the other node may do on this node</span>
					<CapabilityChecklist value={capabilities} onChange={setCapabilities} />
					<p className="text-xs text-subtle">You can review and change this again when you approve the request, and later on the node's page.</p>
				</div>
				<Field label="Code lifetime">
					{() => (
						<Select value={String(ttl)} onValueChange={(v) => setTtl(Number(v))}>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{TTL_OPTIONS.map((m) => (
									<SelectItem key={m} value={String(m)}>
										{m} {m === 1 ? "minute" : "minutes"}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					)}
				</Field>
				{create.error ? (
					<p role="alert" className="text-xs text-danger">
						{errorMessage(create.error)}
					</p>
				) : null}
				<DialogFooter className="sticky bottom-0 bg-overlay pt-1">
					<Button variant="ghost" onClick={onClose}>
						Cancel
					</Button>
					<Button type="submit" variant="primary" loading={create.isPending} disabled={!workspaceId}>
						Create invitation
					</Button>
				</DialogFooter>
			</form>
		</>
	);
}

function NoUrlWarning({ onNavigate }: { onNavigate: () => void }) {
	return (
		<div role="alert" className="flex items-start gap-2.5 rounded-xl bg-warning/12 p-3 text-[13px] text-warning shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--warning)_30%,transparent)]">
			<AlertTriangle className="mt-0.5 size-4 shrink-0" />
			<p className="text-foreground/90">
				This node has no public tunnel URL, so nodes on other machines cannot reach it. Start a tunnel first in{" "}
				<Link to="/settings/tunnel" onClick={onNavigate} className="font-medium text-accent underline underline-offset-2">
					Settings → Cloudflare Tunnel
				</Link>
				.
			</p>
		</div>
	);
}

function Created({ invitation, onClose, onAnother }: { invitation: Invitation; onClose: () => void; onAnother: () => void }) {
	const code = invitation.code ?? "";
	const tunnel = useTunnel();
	const invitations = useInvitations();
	const requests = usePairingRequests();
	const revoke = useRevokeInvitation();
	const openDialog = useUi((s) => s.openDialog);
	const { copied, copy } = useCopy();
	const [expired, setExpired] = useState(Date.parse(invitation.expiresAt) <= Date.now());

	const live = invitations.data?.find((i) => i.id === invitation.id) ?? invitation;
	const url = live.url ?? invitation.url ?? tunnel.data?.publicUrl ?? null;
	const request = requests.data?.find((r) => r.invitationId === invitation.id && r.state === "awaiting_approval");
	const state = expired && live.state === "pending" ? "expired" : live.state;
	const usable = state === "pending";
	const message = invitationMessage({ url, fingerprint: invitation.fingerprint, code, expiresAt: invitation.expiresAt });

	return (
		<>
			<DialogHeader>
				<DialogTitle>Share this code</DialogTitle>
				<DialogDescription>
					The code works once and is shown only here. Send it with the address and fingerprint below; the other person compares the fingerprint before entering the code.
				</DialogDescription>
			</DialogHeader>
			<div className="-mx-1 flex min-h-0 flex-col gap-3 overflow-y-auto px-1">
				{request ? (
					<div className="flex flex-wrap items-center gap-2 rounded-xl bg-accent-soft p-3 text-[13px]">
						<Inbox className="size-4 text-accent" />
						<span className="flex-1">
							<strong>{request.remote.name}</strong> entered the code and waits for your approval.
						</span>
						<Button size="sm" variant="primary" onClick={() => openDialog({ kind: "pairing-requests" })}>
							Review request
						</Button>
					</div>
				) : null}
				{!usable && !request ? (
					<p role="status" className="rounded-xl bg-surface-2 p-3 text-[13px] text-muted-foreground">
						{state === "consumed" ? "This code was used and cannot be used again." : state === "locked" ? "Too many wrong attempts — this code is locked. Create a new invitation." : state === "revoked" ? "This invitation was revoked." : "This code expired. Create a new invitation."}
					</p>
				) : null}
				{url ? null : <NoUrlWarning onNavigate={onClose} />}

				<CopyBlock label="One-time code" variant="code" value={formatInvitationCode(code)} display={formatInvitationCode(code)} className={usable ? undefined : "opacity-50"}>
					<div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
						<Clock className="size-3.5" />
						{usable ? (
							<>
								Expires in <Countdown until={invitation.expiresAt} onExpire={() => setExpired(true)} />
							</>
						) : (
							<span>{state}</span>
						)}
						{live.attempts > 0 ? <span>· {live.attempts} {live.attempts === 1 ? "attempt" : "attempts"} used</span> : null}
					</div>
				</CopyBlock>
				{url ? (
					<CopyBlock label="This node's address" value={url} display={url} variant="fingerprint" />
				) : null}
				<CopyBlock label="This node's fingerprint" value={invitation.fingerprint} display={formatFingerprint(invitation.fingerprint)} />

				<Button variant="secondary" size="lg" onClick={() => void copy(message, "Invitation message")}>
					<ClipboardCopy /> {copied ? "Copied" : "Copy everything as a message"}
				</Button>
			</div>
			<DialogFooter>
				{usable ? (
					<Button variant="ghost" loading={revoke.isPending} onClick={() => revoke.mutate(invitation.id)}>
						<Trash2 /> Revoke code
					</Button>
				) : (
					<Button variant="outline" onClick={onAnother}>
						<Plus /> New invitation
					</Button>
				)}
				<Button variant="primary" onClick={onClose}>
					Done
				</Button>
			</DialogFooter>
		</>
	);
}
