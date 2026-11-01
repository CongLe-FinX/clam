import type { Capability, SharedTransfer, TransferPhase } from "@clam/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRightLeft, Check, Circle, ExternalLink, Eye, Info, Loader2, ShieldAlert, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { PeerStatusBadge } from "@/features/network/components";
import { PEER_STATUS_LABEL } from "@/features/network/format";
import { useUpdatePeer } from "@/features/network/hooks";
import { T, msg, renderServerText, t, tr } from "@/i18n";
import { ApiError, errorText } from "@/lib/api";
import { useDirectory, usePeers, useProject, useSession } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { Field } from "@/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { StatusDot } from "@/ui/status-dot";
import { remoteSessionUrl } from "./format.ts";
import { HANDOVER_INTRO, HANDOVER_SEMANTICS, ModeNote, projectShareMode, type ShareMode } from "./mode.tsx";
import { useCancelTransfer, useHandover, useNodeUiUrl, useSharedDetail, useSharedLive } from "./hooks.ts";

const ANY = "__any__";
const SHARE: Capability = "sessions.share";

const AGENT_STATUS = { online: msg("Online"), busy: msg("Busy"), offline: msg("Offline") } as const;

const CANCELLABLE: Partial<Record<TransferPhase, true>> = { inviting: true, waiting_accept: true, stopping: true, checkpointing: true, delivering: true };

interface Step {
	phase: TransferPhase;
	label: (node: string) => string;
}
const STEPS: Step[] = [
	{ phase: "inviting", label: (n) => t("Invite {name}", { name: n }) },
	{ phase: "waiting_accept", label: (n) => t("{name} accepts the invitation", { name: n }) },
	{ phase: "stopping", label: () => t("Stop the current turn") },
	{ phase: "checkpointing", label: () => t("Commit, push and snapshot all changes") },
	{ phase: "delivering", label: (n) => t("Snapshot delivered to {name}", { name: n }) },
	{ phase: "handing_over", label: (n) => t("{name} takes over", { name: n }) },
	{ phase: "continuing", label: (n) => t("{name} is continuing", { name: n }) },
];

function Progress({ transfer, onWhich, files }: { transfer: SharedTransfer; onWhich: number; files: boolean }) {
	const steps = STEPS.filter((s) => s.phase !== "stopping" || transfer.stopRunning);
	const node = transfer.toNodeName;
	const failed = transfer.phase === "failed" || transfer.phase === "cancelled";
	return (
		<ol className="flex flex-col gap-2.5" aria-label={t("Hand-over progress")}>
			{steps.map((s) => {
				const idx = STEPS.findIndex((x) => x.phase === s.phase);
				const done = !failed && (idx < onWhich || transfer.phase === "continuing");
				const active = !failed && !done && idx === onWhich;
				const broke = failed && idx === onWhich;
				return (
					<li key={s.phase} className={cn("flex items-center gap-2.5 text-[13px]", done ? "text-foreground" : active ? "font-medium text-foreground" : "text-subtle")} aria-current={active ? "step" : undefined}>
						<span className="grid size-5 shrink-0 place-items-center">
							{done ? <Check className="size-4 text-success" aria-hidden /> : active ? <Loader2 className="size-4 animate-spin text-accent" aria-hidden /> : broke ? <X className="size-4 text-danger" aria-hidden /> : <Circle className="size-3" aria-hidden />}
						</span>
						<span>{s.phase === "checkpointing" && files ? t("Bundle the folder and snapshot all changes") : s.label(node)}</span>
					</li>
				);
			})}
		</ol>
	);
}

/**
 * "Hand over…": pick an agent on another machine and move the work to it — the session is shared first when needed, all changes are
 * committed and pushed, the machine takes over and this session becomes a read-only copy. The same dialog shows the hand-over progress.
 */
export default function HandoverDialog({ sessionId, presetNodeId, onClose }: { sessionId: string; presetNodeId?: string; onClose: () => void }) {
	const navigate = useNavigate();
	const openDialog = useUi((s) => s.openDialog);
	const session = useSession(sessionId).data;
	const project = useProject(session?.projectId ?? "").data;
	const peers = usePeers();
	const directory = useDirectory();
	const handover = useHandover(sessionId);
	const updatePeer = useUpdatePeer();

	const [started, setStarted] = useState<string | null>(null);
	const sharedId = session?.sharedSessionId ?? started;
	const detail = useSharedDetail(sharedId).data;
	useSharedLive(sharedId);
	const shared = detail?.shared ?? handover.data ?? null;
	const mode: ShareMode | null = shared ? shared.vcs : project ? projectShareMode(project) : null;
	const transfer = shared?.transfer ?? null;
	const cancel = useCancelTransfer(sharedId ?? "");
	const [again, setAgain] = useState(false);

	const running = session?.status === "running";
	const usable = useMemo(() => (peers.data ?? []).filter((p) => p.status !== "revoked"), [peers.data]);
	const [peerId, setPeerId] = useState(presetNodeId ?? "");
	const [agentKey, setAgentKey] = useState(ANY);
	const [stopRunning, setStopRunning] = useState(true);
	const [busyNotice, setBusyNotice] = useState(false);
	useEffect(() => {
		if (!peerId && usable.length === 1 && usable[0]) setPeerId(usable[0].id);
	}, [peerId, usable]);
	const peer = usable.find((p) => p.id === peerId);
	const agents = useMemo(() => (directory.data ?? []).filter((a) => a.nodeId === peerId).sort((a, b) => a.name.localeCompare(b.name)), [directory.data, peerId]);
	useEffect(() => {
		if (agentKey !== ANY && directory.isSuccess && !agents.some((a) => a.agentId === agentKey)) setAgentKey(ANY);
	}, [agentKey, agents, directory.isSuccess]);

	// Remember the phase a failure happened in (the record itself only says "failed").
	const lastLive = useRef<TransferPhase>("inviting");
	if (transfer && transfer.phase !== "failed" && transfer.phase !== "cancelled") lastLive.current = transfer.phase;
	const ui = useNodeUiUrl(transfer?.toNodeId ?? peerId, shared?.participants.find((p) => p.nodeId === (transfer?.toNodeId ?? peerId))?.uiUrl ?? null);

	const theyAllow = peer ? peer.receivedCapabilities.includes(SHARE) : true;
	const weAllow = peer ? peer.grantedCapabilities.includes(SHARE) : true;
	const offline = peer !== undefined && peer.status !== "online";
	const ready = Boolean(peer && !offline && session?.kind === "local" && !session.movedTo);
	const noNodes = peers.isSuccess && usable.length === 0;

	const submit = (stop: boolean) => {
		if (!ready || !peer) return;
		setBusyNotice(false);
		handover.mutate(
			{ toNodeId: peer.id, agentId: agentKey === ANY ? undefined : agentKey, stopRunning: stop || undefined },
			{
				onSuccess: (s) => {
					setStarted(s.id);
					setAgain(false);
				},
				onError: (e) => {
					if (e instanceof ApiError && e.code === "session_busy") {
						setStopRunning(true);
						setBusyNotice(true);
					}
				},
			},
		);
	};

	const showProgress = transfer !== null && !again;
	const phaseIdx = (p: TransferPhase): number => Math.max(0, STEPS.findIndex((s) => s.phase === p));
	const done = transfer?.phase === "continuing";
	const failed = transfer?.phase === "failed" || transfer?.phase === "cancelled";
	const watchId = shared?.mirrorSessionId ?? shared?.localSessionId ?? null;
	const openHref = transfer ? (transfer.newSessionUrl ?? (ui ? remoteSessionUrl(ui, transfer.newSessionId) : null)) : null;
	const acceptHref = ui ? `${ui.replace(/\/+$/, "")}/shared` : null;
	const target = transfer?.toNodeName ?? peer?.name ?? t("the machine");

	return (
		<Dialog open onOpenChange={(o) => !o && !handover.isPending && onClose()}>
			<DialogContent sheetOnMobile className="max-w-lg">
				<DialogHeader>
					<DialogTitle>{showProgress ? (done ? t("{name} is continuing", { name: target }) : failed ? t("Hand-over did not complete") : t("Handing over to {name}…", { name: target })) : t("Hand over this session")}</DialogTitle>
					<DialogDescription>
						{showProgress
							? (transfer ? renderServerText(transfer.message, transfer.i18n) : "")
							: tr(HANDOVER_INTRO[mode ?? "unknown"])}
					</DialogDescription>
				</DialogHeader>

				{showProgress && transfer ? (
					<div className="scrollbar-thin -mx-1 flex min-h-0 flex-col gap-4 overflow-y-auto px-1">
						<Progress transfer={transfer} files={mode === "files"} onWhich={phaseIdx(failed ? lastLive.current : transfer.phase)} />
						{transfer.phase === "waiting_accept" ? (
							<div role="status" className="flex flex-col gap-2 rounded-lg bg-surface-2 px-3 py-2.5 text-xs text-muted-foreground">
								<span className="flex items-start gap-2">
									<Info className="mt-0.5 size-4 shrink-0" aria-hidden />
									<span>
										<T text="{name} has to accept the invitation — a person there under <b>Shared sessions</b>, or automatically if its owner allowed it. Nothing is stopped or moved until it accepts." params={{ name: target }} tags={{ b: <strong /> }} />
									</span>
								</span>
								{acceptHref ? (
									<Button asChild size="sm" variant="outline" className="self-start">
										<a href={acceptHref} target="_blank" rel="noreferrer noopener">
											<ExternalLink /> {t("Open {name} to accept", { name: target })}
										</a>
									</Button>
								) : null}
							</div>
						) : null}
						{failed && transfer.error ? (
							<p role="alert" className="flex items-start gap-2 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
								<TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
								<span>
									{renderServerText(transfer.error.message, transfer.error.i18n)} <span className="font-mono text-2xs opacity-70">{transfer.error.code}</span>
								</span>
							</p>
						) : null}
						{failed && !transfer.error ? <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted-foreground">{t("The hand-over was cancelled. This session keeps running here.")}</p> : null}
						{done ? (
							<p className="rounded-lg bg-success/10 px-3 py-2 text-xs text-success">
								{t("{name} now drives this work. This session is a read-only copy; keep talking to the team from it, or watch {name} live.", { name: target })}
							</p>
						) : null}
					</div>
				) : (
					<form
						className="scrollbar-thin -mx-1 flex min-h-0 flex-col gap-4 overflow-y-auto px-1"
						onSubmit={(e) => {
							e.preventDefault();
							submit(running && stopRunning);
						}}
					>
						{noNodes ? (
							<div role="status" className="flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2.5 text-[13px] text-muted-foreground">
								<Info className="mt-0.5 size-4 shrink-0" aria-hidden />
								<span>
									<T
										text="No machine is paired with this one yet. <invite>Invite a machine</invite> or <join>join one</join>."
										tags={{
											invite: (c) => (
												<button type="button" className="text-accent hover:underline" onClick={() => openDialog({ kind: "invite-node" })}>
													{c}
												</button>
											),
											join: (c) => (
												<button type="button" className="text-accent hover:underline" onClick={() => openDialog({ kind: "join-node" })}>
													{c}
												</button>
											),
										}}
									/>
								</span>
							</div>
						) : null}
						<div className="grid gap-3 sm:grid-cols-2">
							<Field label={t("Hand over to")}>
								{() => (
									<Select value={peerId} onValueChange={setPeerId} disabled={noNodes}>
										<SelectTrigger>
											<SelectValue placeholder={t("Choose a machine")} />
										</SelectTrigger>
										<SelectContent>
											{usable.map((p) => (
												<SelectItem key={p.id} value={p.id}>
													<span className="inline-flex items-center gap-2">
														<StatusDot status={p.status === "online" ? "online" : p.status === "degraded" ? "degraded" : "offline"} label={tr(PEER_STATUS_LABEL[p.status])} />
														{p.name}
													</span>
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								)}
							</Field>
							<Field label={t("Agent")} hint={t("Leave on “any” to let that machine choose.")}>
								{() => (
									<Select value={agentKey} onValueChange={setAgentKey} disabled={!peer}>
										<SelectTrigger>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value={ANY}>{t("Any available agent")}</SelectItem>
											{agents.map((a) => (
												<SelectItem key={a.agentId} value={a.agentId}>
													<span className="inline-flex items-center gap-2">
														<StatusDot status={a.status} />
														{a.name}
														<span className="text-2xs text-subtle">{tr(AGENT_STATUS[a.status])}</span>
													</span>
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								)}
							</Field>
						</div>

						{mode ? <ModeNote mode={mode} copy={HANDOVER_SEMANTICS} /> : null}
						{running ? (
							<label className="flex min-h-11 cursor-pointer items-start gap-2.5 rounded-lg bg-warning/10 px-3 py-2.5 text-[13px]">
								<input type="checkbox" checked={stopRunning} onChange={(e) => setStopRunning(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--accent)] coarse:size-5" />
								<span className="flex flex-col gap-0.5">
									<span className="font-medium">{t("Stop the current turn and hand over")}</span>
									<span className="text-xs text-muted-foreground">
										{mode === "files"
											? t("The agent is working right now. It is stopped at a safe point, then the working folder is bundled before {name} continues. Untick to wait instead — the hand-over is refused while a turn runs.", { name: peer?.name ?? t("the machine") })
											: t("The agent is working right now. It is stopped at a safe point, then all its changes are committed and pushed before {name} continues. Untick to wait instead — the hand-over is refused while a turn runs.", { name: peer?.name ?? t("the machine") })}
									</span>
								</span>
							</label>
						) : null}
						{busyNotice ? (
							<p role="status" className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
								{t("A turn started while you were choosing. “Stop the current turn and hand over” is now selected — press Hand over again.")}
							</p>
						) : null}

						{offline && peer ? (
							<p role="status" className="flex items-center gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
								<PeerStatusBadge status={peer.status} />
								{t("{name} is not reachable right now; a hand-over needs it online.", { name: peer.name })}
							</p>
						) : null}
						{peer && !theyAllow ? (
							<div role="alert" className="flex items-start gap-2 rounded-lg bg-danger/10 px-3 py-2.5 text-xs text-danger">
								<ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
								<span>
									<T text="{name} has not allowed this machine to share sessions with it (<code>sessions.share</code>). Ask its owner to grant it; the hand-over will be refused until then." params={{ name: peer.name }} tags={{ code: <code className="font-mono" /> }} />
								</span>
							</div>
						) : null}
						{peer && !weAllow ? (
							<div role="alert" className="flex flex-col gap-2 rounded-lg bg-warning/10 px-3 py-2.5 text-xs text-warning">
								<span className="flex items-start gap-2">
									<ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
									<span>
										<T text="{name} is not allowed to share sessions with this machine yet (<code>sessions.share</code>). It needs that to take over and to send its updates." params={{ name: peer.name }} tags={{ code: <code className="font-mono" /> }} />
									</span>
								</span>
								<Button
									type="button"
									size="sm"
									variant="outline"
									className="self-start"
									loading={updatePeer.isPending}
									onClick={() => updatePeer.mutate({ id: peer.id, grantedCapabilities: [...peer.grantedCapabilities, SHARE] }, { onSuccess: () => toast.success(t("{name} may now share sessions with this machine", { name: peer.name })) })}
								>
									{t("Grant sessions.share to {name}", { name: peer.name })}
								</Button>
							</div>
						) : null}
						{handover.error && !(handover.error instanceof ApiError && handover.error.code === "session_busy") ? (
							<p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
								{errorText(handover.error)}
							</p>
						) : null}
						<DialogFooter className="sticky bottom-0 -mx-1 bg-overlay px-1 pt-1">
							<Button type="button" variant="ghost" onClick={onClose} disabled={handover.isPending}>
								{t("Cancel")}
							</Button>
							<Button type="submit" variant="primary" loading={handover.isPending} disabled={!ready}>
								<ArrowRightLeft /> {t("Hand over")}
							</Button>
						</DialogFooter>
					</form>
				)}

				{showProgress && transfer ? (
					<DialogFooter className="flex-wrap">
						{CANCELLABLE[transfer.phase] ? (
							<Button variant="ghost" loading={cancel.isPending} onClick={() => cancel.mutate()}>
								{t("Cancel hand-over")}
							</Button>
						) : null}
						{failed ? (
							<>
								<Button
									variant="ghost"
									loading={cancel.isPending}
									onClick={() => cancel.mutate(undefined, { onSuccess: onClose })}
								>
									{t("Dismiss")}
								</Button>
								<Button variant="primary" onClick={() => setAgain(true)}>
									{t("Try again")}
								</Button>
							</>
						) : null}
						{done ? (
							<>
								{openHref ? (
									<Button asChild variant="outline">
										<a href={openHref} target="_blank" rel="noreferrer noopener">
											<ExternalLink /> {t("Open on {name}", { name: target })}
										</a>
									</Button>
								) : null}
								{watchId ? (
									<Button
										variant="primary"
										onClick={() => {
											onClose();
											void navigate({ to: "/sessions/$sessionId", params: { sessionId: watchId } });
										}}
									>
										<Eye /> {t("Watch live here")}
									</Button>
								) : null}
							</>
						) : null}
						{!CANCELLABLE[transfer.phase] && !failed && !done ? <span className="text-xs text-subtle">{t("Finishing the hand-over…")}</span> : null}
						{!failed ? (
							<Button variant="ghost" onClick={onClose}>
								{done ? t("Close") : t("Hide")}
							</Button>
						) : null}
					</DialogFooter>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
