import { type Capability, DEFAULT_PEER_CAPABILITIES, type PairingRequest } from "@clam/contracts";
import { Link } from "@tanstack/react-router";
import { CheckCircle2, ChevronDown, Inbox, Loader2, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { isAwaitingApproval, useInvitations, usePairingRequests, useWorkspaces } from "@/lib/queries";
import { relativeTime } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/ui/dialog";
import { EmptyState } from "@/ui/empty-state";
import { CapabilityChecklist, summarizeCapabilities } from "./capabilities";
import { FingerprintCompare } from "./fingerprint";
import { formatFingerprint, hostOf } from "./format";
import { useApprovePairing, useRejectPairing } from "./hooks";
import { type Msg, T, msg, t, tr } from "@/i18n";

const STATE_COPY: Record<PairingRequest["state"], { label: Msg; variant: "accent" | "warning" | "success" | "neutral" | "danger" }> = {
	awaiting_approval: { label: msg("Needs your approval"), variant: "warning" },
	confirming: { label: msg("Finishing pairing…"), variant: "accent" },
	paired: { label: msg("Paired"), variant: "success" },
	rejected: { label: msg("Rejected"), variant: "neutral" },
	expired: { label: msg("Expired"), variant: "neutral" },
	failed: { label: msg("Failed"), variant: "danger" },
};

export function PairingRequestCard({ request }: { request: PairingRequest }) {
	const invitations = useInvitations();
	const workspaces = useWorkspaces();
	const approve = useApprovePairing();
	const reject = useRejectPairing();
	const [picked, setPicked] = useState<Capability[] | null>(null);
	const caps = picked ?? invitations.data?.find((i) => i.id === request.invitationId)?.capabilities ?? DEFAULT_PEER_CAPABILITIES;
	const workspace = workspaces.data?.find((w) => w.id === request.workspaceId);
	const awaiting = isAwaitingApproval(request);
	const s = STATE_COPY[request.state];
	const busy = approve.isPending || reject.isPending;

	return (
		<article className="flex flex-col gap-3 rounded-xl bg-surface-1 p-4 shadow-[inset_0_0_0_1px_var(--border-strong)]" aria-label={t("Pairing request from {name}", { name: request.remote.name })}>
			<header className="flex flex-wrap items-start justify-between gap-2">
				<div className="min-w-0">
					<h3 className="truncate text-[15px] font-semibold">{request.remote.name}</h3>
					<p className="truncate font-mono text-xs text-subtle">{hostOf(request.remote.url)}</p>
				</div>
				<Badge variant={s.variant} className="gap-1">
					{request.state === "confirming" ? <Loader2 className="animate-spin" /> : request.state === "paired" ? <CheckCircle2 /> : null}
					{tr(s.label)}
				</Badge>
			</header>
			<p className="text-xs text-muted-foreground">
				<T
					text="Wants to join workspace <b>{workspace}</b> · requested {time}"
					params={{ workspace: workspace?.name ?? request.workspaceId, time: relativeTime(request.requestedAt) }}
					tags={{ b: <strong className="text-foreground" /> }}
				/>
			</p>

			{awaiting ? (
				<>
					<FingerprintCompare label={t("Fingerprint presented by the other machine")} fingerprint={request.remote.fingerprint}>
						<p className="flex items-start gap-1.5 text-xs text-muted-foreground">
							<ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
							{t("Ask the other person to read the words and fingerprint on their Waiting screen. Approve only if it matches exactly.")}
						</p>
					</FingerprintCompare>
					<details className="group rounded-xl shadow-[inset_0_0_0_1px_var(--border)]">
						<summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center justify-between gap-x-2 py-1.5 rounded-xl px-3 text-[13px] font-medium outline-none focus-visible:shadow-[0_0_0_2px_var(--ring)]">
							{t("Access to grant")}
							<span className="flex min-w-0 items-center gap-1 text-2xs text-subtle">
								{summarizeCapabilities(caps)} · <span className="text-accent group-open:hidden">{t("review & edit")}</span>
								<ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
							</span>
						</summary>
						<div className="border-t">
							<CapabilityChecklist value={caps} onChange={setPicked} disabled={busy} peerName={request.remote.name} className="p-3" />
						</div>
					</details>
					<div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
						<Button variant="ghost" disabled={busy} loading={reject.isPending} onClick={() => reject.mutate(request.id)}>
							{t("Reject")}
						</Button>
						<Button variant="primary" disabled={reject.isPending} loading={approve.isPending} onClick={() => approve.mutate({ id: request.id, capabilities: caps })}>
							{t("Approve and pair")}
						</Button>
					</div>
				</>
			) : (
				<>
					<p className="select-all break-all font-mono text-xs text-subtle">{formatFingerprint(request.remote.fingerprint)}</p>
					{request.error ? <p className="text-xs text-danger">{request.error}</p> : null}
					{request.state === "paired" ? (
						<Link to="/network/nodes/$peerId" params={{ peerId: request.remote.nodeId }} className="text-xs font-medium text-accent hover:underline">
							{t("Open machine")}
						</Link>
					) : null}
				</>
			)}
		</article>
	);
}

export const sortRequests = (list: PairingRequest[]): PairingRequest[] =>
	[...list].sort((a, b) => Number(isAwaitingApproval(b)) - Number(isAwaitingApproval(a)) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

export function PairingRequestsDialog({ onClose }: { onClose: () => void }) {
	const requests = usePairingRequests();
	const list = sortRequests(requests.data ?? []).slice(0, 12);
	return (
		<Dialog open onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="max-w-xl" sheetOnMobile>
				<DialogHeader>
					<DialogTitle>{t("Pairing requests")}</DialogTitle>
					<DialogDescription>{t("Machines that entered one of your invitation codes. Nothing is shared until you approve.")}</DialogDescription>
				</DialogHeader>
				<div className="-mx-1 flex min-h-0 flex-col gap-3 overflow-y-auto px-1">
					{requests.isSuccess && list.length === 0 ? <EmptyState icon={Inbox} title={t("No pairing requests")} description={t("Create an invitation and share the code; requests show up here as soon as someone uses it.")} /> : null}
					{list.map((r) => (
						<PairingRequestCard key={r.id} request={r} />
					))}
				</div>
			</DialogContent>
		</Dialog>
	);
}
