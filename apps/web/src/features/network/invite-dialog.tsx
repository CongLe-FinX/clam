import { type Capability, DEFAULT_PEER_CAPABILITIES, type Invitation } from "@clam/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, ClipboardCopy, Clock, Cloud, Globe, MessagesSquare, Plus, Radio, Trash2, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { errorMessage } from "@/lib/api";
import { useInvitations, usePairingRequests, useTunnel, useWorkspaces } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { Field } from "@/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { CapabilityChecklist } from "./capabilities";
import { CopyBlock, Countdown, useCopy } from "./components";
import { FingerprintCompare } from "./fingerprint";
import { formatInvitationCode, invitationMessage } from "./format";
import { useCreateInvitation, useRevokeInvitation } from "./hooks";
import { PairingRequestCard } from "./pairing-requests";
import { Stepper } from "./stepper";

const TTL_OPTIONS = [1, 2, 5, 10] as const;
const STEPS = ["Choose access", "Share", "Waiting", "Approve"] as const;

export default function InviteDialog({ workspaceId: initialWorkspace, onClose }: { workspaceId?: string; onClose: () => void }) {
	const [created, setCreated] = useState<Invitation | null>(null);
	return (
		<Dialog open onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="max-w-xl" sheetOnMobile>
				{created?.code ? <Created key={created.id} invitation={created} onClose={onClose} onAnother={() => setCreated(null)} /> : <Form initialWorkspace={initialWorkspace} onClose={onClose} onCreated={setCreated} />}
			</DialogContent>
		</Dialog>
	);
}

function Header({ title, description, current }: { title: string; description: string; current: number }) {
	return (
		<DialogHeader>
			<DialogTitle>{title}</DialogTitle>
			<DialogDescription>{description}</DialogDescription>
			<Stepper steps={STEPS} current={current} className="pt-2" />
		</DialogHeader>
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
			<Header title="Invite another machine" description="Creates a one-time code. Share it with this machine's address and fingerprint with the person who runs the other machine." current={0} />
			<form
				className="-mx-1 flex min-h-0 flex-col gap-4 overflow-y-auto px-1"
				onSubmit={(e) => {
					e.preventDefault();
					if (workspaceId) create.mutate({ workspaceId, capabilities, ttlMinutes: ttl }, { onSuccess: onCreated });
				}}
			>
				{tunnel.isPending ? <div aria-hidden className="h-20 animate-pulse rounded-xl bg-surface-2" /> : null}
				{noUrl ? <NoUrlWarning onNavigate={onClose} /> : null}
				{noWorkspace ? (
					<div className="rounded-xl bg-surface-2 p-3 text-[13px] text-muted-foreground">
						An invitation shares one workspace with the other machine, so you need a workspace first.
						<Button size="sm" variant="outline" className="mt-2 block" onClick={() => openDialog({ kind: "create-workspace" })}>
							<Plus /> New workspace
						</Button>
					</div>
				) : (
					<Field label="Workspace to share" hint="The other machine gets a workspace with the same name and id. Projects and files are never shared automatically.">
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
					<span className="text-xs font-medium text-muted-foreground">Access for the other machine</span>
					<CapabilityChecklist value={capabilities} onChange={setCapabilities} />
					<p className="text-xs text-subtle">You can review and change this again when you approve the request, and later on the machine's page.</p>
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
						{noUrl ? "Create anyway" : "Create invitation"}
					</Button>
				</DialogFooter>
			</form>
		</>
	);
}

/** Pre-flight: without a public address nobody else can reach this machine. */
function NoUrlWarning({ onNavigate }: { onNavigate: () => void }) {
	return (
		<div role="alert" className="flex flex-col gap-3 rounded-xl bg-warning/12 p-3.5 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--warning)_35%,transparent)]">
			<div className="flex items-start gap-2.5">
				<AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
				<div className="flex flex-col gap-0.5 text-[13px]">
					<strong className="font-semibold text-foreground">This machine has no public address yet</strong>
					<span className="text-foreground/80">Other machines cannot reach it, so the code would not work from another network. Give it an address first (takes about a minute).</span>
				</div>
			</div>
			<div className="flex flex-wrap gap-2 pl-6.5">
				<Button asChild size="sm" variant="primary">
					<Link to="/settings/tunnel" onClick={onNavigate}>
						<Cloud /> Start a quick tunnel
					</Link>
				</Button>
				<Button asChild size="sm" variant="outline">
					<Link to="/settings/tunnel" onClick={onNavigate}>
						<Globe /> Use your domain
					</Link>
				</Button>
			</div>
			<p className="pl-6.5 text-2xs text-subtle">Both options live in Settings → Tunnel. On the same computer or a LAN you can continue anyway.</p>
		</div>
	);
}

function Created({ invitation, onClose, onAnother }: { invitation: Invitation; onClose: () => void; onAnother: () => void }) {
	const code = invitation.code ?? "";
	const tunnel = useTunnel();
	const invitations = useInvitations();
	const requests = usePairingRequests();
	const revoke = useRevokeInvitation();
	const { copied, copy } = useCopy();
	const [expired, setExpired] = useState(Date.parse(invitation.expiresAt) <= Date.now());
	const [sent, setSent] = useState(false);

	const live = invitations.data?.find((i) => i.id === invitation.id) ?? invitation;
	const url = live.url ?? invitation.url ?? tunnel.data?.publicUrl ?? null;
	const request = requests.data?.filter((r) => r.invitationId === invitation.id).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
	const state = expired && live.state === "pending" ? "expired" : live.state;
	const usable = state === "pending";
	const message = invitationMessage({ url, fingerprint: invitation.fingerprint, code, expiresAt: invitation.expiresAt });

	if (request && request.state !== "rejected" && request.state !== "expired" && request.state !== "failed") {
		return request.state === "paired" ? <Success request={request} onClose={onClose} /> : <ApproveStage invitation={invitation} requestId={request.id} onClose={onClose} />;
	}

	const waiting = sent && usable;
	return (
		<>
			<Header
				title={waiting ? "Waiting for the other machine" : "Share this code"}
				description={waiting ? "Keep this open or close it — the request shows up anywhere in the app as soon as the code is used." : "The code works once and is shown only here. Send it with the address; the other person compares the fingerprint before entering it."}
				current={waiting ? 2 : 1}
			/>
			<div className="-mx-1 flex min-h-0 flex-col gap-3 overflow-y-auto px-1">
				{request ? (
					<p role="status" className="rounded-xl bg-surface-2 p-3 text-[13px] text-muted-foreground">
						The last request from <strong className="text-foreground">{request.remote.name}</strong> was {request.state === "rejected" ? "rejected" : request.state === "expired" ? "not approved in time" : `not completed${request.error ? ` (${request.error})` : ""}`}.
					</p>
				) : null}
				{!usable ? (
					<p role="status" className="rounded-xl bg-surface-2 p-3 text-[13px] text-muted-foreground">
						{state === "consumed" ? "This code was used and cannot be used again." : state === "locked" ? "Too many wrong attempts — this code is locked. Create a new invitation." : state === "revoked" ? "This invitation was revoked." : "This code expired. Create a new invitation."}
					</p>
				) : null}

				{waiting ? (
					<div key="waiting" className="flex animate-slide-up flex-col items-center gap-3 rounded-xl bg-surface-2 px-4 py-7 text-center" role="status" aria-live="polite">
						<span className="relative grid size-14 place-items-center">
							<span className="absolute inset-0 rounded-full bg-accent/30 [animation:clam-pulse-ring_1.8s_ease-out_infinite]" />
							<span className="relative grid size-11 place-items-center rounded-full bg-accent-soft text-accent shadow-[inset_0_0_0_1.5px_var(--accent)]">
								<Radio className="size-5" />
							</span>
						</span>
						<h3 className="text-[15px] font-semibold">Listening for the code</h3>
						<p className="max-w-sm text-[13px] text-muted-foreground">
							When the other machine enters <span className="font-mono font-semibold text-foreground">{formatInvitationCode(code)}</span>, you will see its fingerprint here to approve.
						</p>
						<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
							<Clock className="size-3.5" /> Expires in <Countdown until={invitation.expiresAt} onExpire={() => setExpired(true)} />
							{live.attempts > 0 ? <span>· {live.attempts} {live.attempts === 1 ? "attempt" : "attempts"} used</span> : null}
						</div>
						<Button variant="ghost" size="sm" onClick={() => setSent(false)}>
							Show code again
						</Button>
					</div>
				) : (
					<div key="share" className="flex animate-fade-in flex-col gap-3">
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
						{url ? <CopyBlock label="This machine's address" value={url} display={url} variant="fingerprint" /> : null}
						<FingerprintCompare label="This machine's fingerprint" fingerprint={invitation.fingerprint} />
						<Button variant="secondary" size="lg" onClick={() => void copy(message, "Invitation message")}>
							<ClipboardCopy /> {copied ? "Copied" : "Copy everything as a message"}
						</Button>
					</div>
				)}
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
				{usable && !waiting ? (
					<Button variant="primary" onClick={() => setSent(true)} data-testid="invite-shared">
						I've shared it — wait for the request
					</Button>
				) : (
					<Button variant="primary" onClick={onClose}>
						Done
					</Button>
				)}
			</DialogFooter>
		</>
	);
}

function ApproveStage({ invitation, requestId, onClose }: { invitation: Invitation; requestId: string; onClose: () => void }) {
	const requests = usePairingRequests();
	const request = requests.data?.find((r) => r.id === requestId);
	if (!request) return null;
	return (
		<>
			<Header
				title={request.state === "confirming" ? "Finishing pairing…" : "A machine wants to connect"}
				description="Compare the picture, words and fingerprint with what the other person sees on their screen. Approve only if they match."
				current={3}
			/>
			<div className="-mx-1 flex min-h-0 animate-slide-up flex-col gap-3 overflow-y-auto px-1">
				<PairingRequestCard key={invitation.id} request={request} />
			</div>
			<DialogFooter>
				<Button variant="ghost" onClick={onClose}>
					Decide later
				</Button>
			</DialogFooter>
		</>
	);
}

function Success({ request, onClose }: { request: { remote: { nodeId: string; name: string } }; onClose: () => void }) {
	const navigate = useNavigate();
	const openDialog = useUi((s) => s.openDialog);
	return (
		<>
			<Header title="Connected" description="Both machines pinned each other's keys. Every request between you is now signed." current={STEPS.length} />
			<div className="flex animate-slide-up flex-col items-center gap-3 rounded-xl bg-surface-2 px-4 py-8 text-center" role="status">
				<span className="grid size-14 place-items-center rounded-full bg-success/15 text-success">
					<CheckCircle2 className="size-7" />
				</span>
				<h3 className="text-[15px] font-semibold">Paired with {request.remote.name}</h3>
				<p className="max-w-sm text-[13px] text-muted-foreground">Its agents now appear in your directory. You can change what it may do at any time on its page.</p>
			</div>
			<DialogFooter className="sm:flex-wrap">
				<Button variant="ghost" onClick={onClose}>
					Done
				</Button>
				<Button
					variant="outline"
					onClick={() => {
						onClose();
						openDialog({ kind: "new-chat" });
					}}
				>
					<MessagesSquare /> Start a group chat with its agents
				</Button>
				<Button
					variant="primary"
					onClick={() => {
						onClose();
						void navigate({ to: "/network/agents" });
					}}
				>
					<Users /> Open Agent Directory
				</Button>
			</DialogFooter>
		</>
	);
}
