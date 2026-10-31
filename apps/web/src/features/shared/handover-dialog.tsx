import type { Capability, SharedTransfer, TransferPhase } from "@clam/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRightLeft, Check, Circle, ExternalLink, Eye, Info, Loader2, ShieldAlert, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { PeerStatusBadge } from "@/features/network/components";
import { useUpdatePeer } from "@/features/network/hooks";
import { ApiError, errorMessage } from "@/lib/api";
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

const CANCELLABLE: Partial<Record<TransferPhase, true>> = { inviting: true, waiting_accept: true, stopping: true, checkpointing: true, delivering: true };

interface Step {
	phase: TransferPhase;
	label: (node: string) => string;
}
const STEPS: Step[] = [
	{ phase: "inviting", label: (n) => `Invite ${n}` },
	{ phase: "waiting_accept", label: (n) => `${n} accepts the invitation` },
	{ phase: "stopping", label: () => "Stop the current turn" },
	{ phase: "checkpointing", label: () => "Commit, push and snapshot all changes" },
	{ phase: "delivering", label: (n) => `Snapshot delivered to ${n}` },
	{ phase: "handing_over", label: (n) => `${n} takes over` },
	{ phase: "continuing", label: (n) => `${n} is continuing` },
];

function Progress({ transfer, onWhich, files }: { transfer: SharedTransfer; onWhich: number; files: boolean }) {
	const steps = STEPS.filter((s) => s.phase !== "stopping" || transfer.stopRunning);
	const node = transfer.toNodeName;
	const failed = transfer.phase === "failed" || transfer.phase === "cancelled";
	return (
		<ol className="flex flex-col gap-2.5" aria-label="Hand-over progress">
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
						<span>{s.phase === "checkpointing" && files ? "Bundle the folder and snapshot all changes" : s.label(node)}</span>
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
	const target = transfer?.toNodeName ?? peer?.name ?? "the machine";

	return (
		<Dialog open onOpenChange={(o) => !o && !handover.isPending && onClose()}>
			<DialogContent sheetOnMobile className="max-w-lg">
				<DialogHeader>
					<DialogTitle>{showProgress ? (done ? `${target} is continuing` : failed ? "Hand-over did not complete" : `Handing over to ${target}…`) : "Hand over this session"}</DialogTitle>
					<DialogDescription>
						{showProgress
							? (transfer?.message ?? "")
							: HANDOVER_INTRO[mode ?? "unknown"]}
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
										{target} has to accept the invitation — a person there under <strong>Shared sessions</strong>, or automatically if its owner allowed it. Nothing is stopped or moved until it accepts.
									</span>
								</span>
								{acceptHref ? (
									<Button asChild size="sm" variant="outline" className="self-start">
										<a href={acceptHref} target="_blank" rel="noreferrer noopener">
											<ExternalLink /> Open {target} to accept
										</a>
									</Button>
								) : null}
							</div>
						) : null}
						{failed && transfer.error ? (
							<p role="alert" className="flex items-start gap-2 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
								<TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
								<span>
									{transfer.error.message} <span className="font-mono text-2xs opacity-70">{transfer.error.code}</span>
								</span>
							</p>
						) : null}
						{failed && !transfer.error ? <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted-foreground">The hand-over was cancelled. This session keeps running here.</p> : null}
						{done ? (
							<p className="rounded-lg bg-success/10 px-3 py-2 text-xs text-success">
								{target} now drives this work. This session is a read-only copy; keep talking to the team from it, or watch {target} live.
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
									No machine is paired with this one yet.{" "}
									<button type="button" className="text-accent hover:underline" onClick={() => openDialog({ kind: "invite-node" })}>
										Invite a machine
									</button>{" "}
									or{" "}
									<button type="button" className="text-accent hover:underline" onClick={() => openDialog({ kind: "join-node" })}>
										join one
									</button>
									.
								</span>
							</div>
						) : null}
						<div className="grid gap-3 sm:grid-cols-2">
							<Field label="Hand over to">
								{() => (
									<Select value={peerId} onValueChange={setPeerId} disabled={noNodes}>
										<SelectTrigger>
											<SelectValue placeholder="Choose a machine" />
										</SelectTrigger>
										<SelectContent>
											{usable.map((p) => (
												<SelectItem key={p.id} value={p.id}>
													<span className="inline-flex items-center gap-2">
														<StatusDot status={p.status === "online" ? "online" : p.status === "degraded" ? "degraded" : "offline"} label={p.status} />
														{p.name}
													</span>
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								)}
							</Field>
							<Field label="Agent" hint="Leave on “any” to let that machine choose.">
								{() => (
									<Select value={agentKey} onValueChange={setAgentKey} disabled={!peer}>
										<SelectTrigger>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value={ANY}>Any available agent</SelectItem>
											{agents.map((a) => (
												<SelectItem key={a.agentId} value={a.agentId}>
													<span className="inline-flex items-center gap-2">
														<StatusDot status={a.status} label={a.status} />
														{a.name}
														<span className="text-2xs text-subtle">{a.status}</span>
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
									<span className="font-medium">Stop the current turn and hand over</span>
									<span className="text-xs text-muted-foreground">The agent is working right now. It is stopped at a safe point, then {mode === "files" ? "the working folder is bundled" : "all its changes are committed and pushed"} before {peer?.name ?? "the machine"} continues. Untick to wait instead — the hand-over is refused while a turn runs.</span>
								</span>
							</label>
						) : null}
						{busyNotice ? (
							<p role="status" className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
								A turn started while you were choosing. “Stop the current turn and hand over” is now selected — press Hand over again.
							</p>
						) : null}

						{offline && peer ? (
							<p role="status" className="flex items-center gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
								<PeerStatusBadge status={peer.status} />
								{peer.name} is not reachable right now; a hand-over needs it online.
							</p>
						) : null}
						{peer && !theyAllow ? (
							<div role="alert" className="flex items-start gap-2 rounded-lg bg-danger/10 px-3 py-2.5 text-xs text-danger">
								<ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
								<span>
									{peer.name} has not allowed this machine to share sessions with it (<code className="font-mono">sessions.share</code>). Ask its owner to grant it; the hand-over will be refused until then.
								</span>
							</div>
						) : null}
						{peer && !weAllow ? (
							<div role="alert" className="flex flex-col gap-2 rounded-lg bg-warning/10 px-3 py-2.5 text-xs text-warning">
								<span className="flex items-start gap-2">
									<ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
									<span>
										{peer.name} is not allowed to share sessions with this machine yet (<code className="font-mono">sessions.share</code>). It needs that to take over and to send its updates.
									</span>
								</span>
								<Button
									type="button"
									size="sm"
									variant="outline"
									className="self-start"
									loading={updatePeer.isPending}
									onClick={() => updatePeer.mutate({ id: peer.id, grantedCapabilities: [...peer.grantedCapabilities, SHARE] }, { onSuccess: () => toast.success(`${peer.name} may now share sessions with this machine`) })}
								>
									Grant sessions.share to {peer.name}
								</Button>
							</div>
						) : null}
						{handover.error && !(handover.error instanceof ApiError && handover.error.code === "session_busy") ? (
							<p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
								{errorMessage(handover.error)}
							</p>
						) : null}
						<DialogFooter className="sticky bottom-0 -mx-1 bg-overlay px-1 pt-1">
							<Button type="button" variant="ghost" onClick={onClose} disabled={handover.isPending}>
								Cancel
							</Button>
							<Button type="submit" variant="primary" loading={handover.isPending} disabled={!ready}>
								<ArrowRightLeft /> Hand over
							</Button>
						</DialogFooter>
					</form>
				)}

				{showProgress && transfer ? (
					<DialogFooter className="flex-wrap">
						{CANCELLABLE[transfer.phase] ? (
							<Button variant="ghost" loading={cancel.isPending} onClick={() => cancel.mutate()}>
								Cancel hand-over
							</Button>
						) : null}
						{failed ? (
							<>
								<Button
									variant="ghost"
									loading={cancel.isPending}
									onClick={() => cancel.mutate(undefined, { onSuccess: onClose })}
								>
									Dismiss
								</Button>
								<Button variant="primary" onClick={() => setAgain(true)}>
									Try again
								</Button>
							</>
						) : null}
						{done ? (
							<>
								{openHref ? (
									<Button asChild variant="outline">
										<a href={openHref} target="_blank" rel="noreferrer noopener">
											<ExternalLink /> Open on {target}
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
										<Eye /> Watch live here
									</Button>
								) : null}
							</>
						) : null}
						{!CANCELLABLE[transfer.phase] && !failed && !done ? <span className="text-xs text-subtle">Finishing the hand-over…</span> : null}
						{!failed ? (
							<Button variant="ghost" onClick={onClose}>
								{done ? "Close" : "Hide"}
							</Button>
						) : null}
					</DialogFooter>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
