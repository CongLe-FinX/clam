import type { Handoff } from "@clam/contracts";
import { Check, Clock, OctagonAlert, RotateCw, TriangleAlert, Undo2, X, XCircle } from "lucide-react";
import { useState } from "react";
import { ApiError, errorMessage } from "@/lib/api";
import { useAgents, usePeers, useProjects } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { Field } from "@/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { Textarea } from "@/ui/textarea";
import type { HandoffActions } from "./actions.ts";
import { FAILURE_TEXT, RECLAIM_RISK } from "./meta.ts";

const DEFAULT = "__default__";
const EXTEND_OPTIONS = [15, 30, 60, 120] as const;

/** Accept (with an optional project and agent) or reject an incoming handoff. */
export function DecisionPanel({ h, actions }: { h: Handoff; actions: HandoffActions }) {
	const [rejectOpen, setRejectOpen] = useState(false);
	const projects = useProjects();
	const agents = useAgents();
	const [projectId, setProjectId] = useState(DEFAULT);
	const [agentId, setAgentId] = useState(DEFAULT);
	const canAccept = h.actions.includes("accept");
	const canReject = h.actions.includes("reject");
	if (!canAccept && !canReject) return null;
	const noGit = h.vcs !== "git";

	return (
		<Card className="shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--accent)_45%,transparent)]">
			<CardHeader>
				<CardTitle>{h.source.nodeName} wants to hand this work to this machine</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-4 pt-3">
				<p className="text-[13px] text-muted-foreground">
					Accepting restores the {noGit ? "folder bundle" : "branch"} into a separate working folder on this machine, then asks you to approve any setup commands. Your own files are never overwritten, and the source keeps the task
					until this machine confirms it is ready.
				</p>
				{canAccept ? (
					<div className="grid gap-3 sm:grid-cols-2">
						<Field label="Project" hint={noGit ? "Optional. By default a fresh folder is created." : "Optional. By default the matching local project is used, or the repository is cloned."}>
							{(id) => (
								<Select value={projectId} onValueChange={setProjectId}>
									<SelectTrigger id={id}>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value={DEFAULT}>Choose automatically</SelectItem>
										{[...(projects.data ?? [])]
											.sort((a, b) => a.name.localeCompare(b.name))
											.map((p) => (
												<SelectItem key={p.id} value={p.id}>
													{p.name}
												</SelectItem>
											))}
									</SelectContent>
								</Select>
							)}
						</Field>
						<Field label="Agent" hint="Optional. Runs the new session.">
							{(id) => (
								<Select value={agentId} onValueChange={setAgentId}>
									<SelectTrigger id={id}>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value={DEFAULT}>Default agent</SelectItem>
										{(agents.data ?? []).map((a) => (
											<SelectItem key={a.id} value={a.id}>
												{a.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							)}
						</Field>
					</div>
				) : null}
				<div className="flex flex-wrap gap-2">
					{canAccept ? (
						<Button
							variant="primary"
							loading={actions.decide.isPending}
							onClick={() => actions.decide.mutate({ decision: "accept", projectId: projectId === DEFAULT ? undefined : projectId, agentId: agentId === DEFAULT ? undefined : agentId })}
						>
							<Check /> Accept handoff
						</Button>
					) : null}
					{canReject ? (
						<Button variant="outline" className="text-danger" disabled={actions.decide.isPending} onClick={() => setRejectOpen(true)}>
							<X /> Reject
						</Button>
					) : null}
				</div>
			</CardContent>
			{rejectOpen ? <RejectDialog actions={actions} onClose={() => setRejectOpen(false)} /> : null}
		</Card>
	);
}

function RejectDialog({ actions, onClose }: { actions: HandoffActions; onClose: () => void }) {
	const [reason, setReason] = useState("");
	return (
		<Dialog open onOpenChange={(o) => !o && !actions.decide.isPending && onClose()}>
			<DialogContent sheetOnMobile className="max-w-md">
				<DialogHeader>
					<DialogTitle>Reject this handoff?</DialogTitle>
					<DialogDescription>The source keeps the task and sees your reason.</DialogDescription>
				</DialogHeader>
				<Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={2000} aria-label="Reason" placeholder="Why not? (required)" className="resize-none" />
				<DialogFooter>
					<Button variant="ghost" onClick={onClose} disabled={actions.decide.isPending}>
						Back
					</Button>
					<Button variant="danger" disabled={reason.trim() === ""} loading={actions.decide.isPending} onClick={() => actions.decide.mutate({ decision: "reject", reason: reason.trim() }, { onSuccess: onClose })}>
						Reject handoff
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

type Dlg = "cancel" | "extend" | "reclaim" | null;

/** Retry / extend / reclaim / cancel, exactly the ones the server says are possible right now. */
export function ActionButtons({ h, actions }: { h: Handoff; actions: HandoffActions }) {
	const [dlg, setDlg] = useState<Dlg>(null);
	const can = (a: Handoff["actions"][number]) => h.actions.includes(a);
	if (!can("retry") && !can("extend") && !can("reclaim") && !can("cancel")) return null;
	return (
		<div className="flex flex-wrap gap-2">
			{can("retry") ? (
				<Button variant="primary" size="sm" loading={actions.retry.isPending} onClick={() => actions.retry.mutate()}>
					<RotateCw /> {h.role === "target" ? "Retry this step" : "Retry"}
				</Button>
			) : null}
			{can("extend") ? (
				<Button variant="outline" size="sm" onClick={() => setDlg("extend")}>
					<Clock /> Extend deadline
				</Button>
			) : null}
			{can("reclaim") ? (
				<Button variant="outline" size="sm" onClick={() => setDlg("reclaim")}>
					<Undo2 /> Reclaim task
				</Button>
			) : null}
			{can("cancel") ? (
				<Button variant="outline" size="sm" className="text-danger" onClick={() => setDlg("cancel")}>
					<XCircle /> Cancel handoff
				</Button>
			) : null}
			{dlg === "cancel" ? <CancelDialog h={h} actions={actions} onClose={() => setDlg(null)} /> : null}
			{dlg === "extend" ? <ExtendDialog actions={actions} onClose={() => setDlg(null)} /> : null}
			{dlg === "reclaim" ? <ReclaimDialog h={h} actions={actions} onClose={() => setDlg(null)} /> : null}
		</div>
	);
}

function CancelDialog({ h, actions, onClose }: { h: Handoff; actions: HandoffActions; onClose: () => void }) {
	return (
		<Dialog open onOpenChange={(o) => !o && !actions.cancel.isPending && onClose()}>
			<DialogContent sheetOnMobile className="max-w-md">
				<DialogHeader>
					<DialogTitle>Cancel this handoff?</DialogTitle>
					<DialogDescription>
						{h.role === "source"
							? `${h.target.nodeName} stops restoring and discards its copy. The task stays here and keeps running.`
							: `The restore on this machine stops and its working copy is cleaned up. ${h.source.nodeName} keeps the task.`}
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button variant="ghost" onClick={onClose} disabled={actions.cancel.isPending}>
						Keep going
					</Button>
					<Button variant="danger" loading={actions.cancel.isPending} onClick={() => actions.cancel.mutate(undefined, { onSuccess: onClose })}>
						Cancel handoff
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function ExtendDialog({ actions, onClose }: { actions: HandoffActions; onClose: () => void }) {
	const [minutes, setMinutes] = useState<number>(30);
	return (
		<Dialog open onOpenChange={(o) => !o && !actions.extend.isPending && onClose()}>
			<DialogContent sheetOnMobile className="max-w-sm">
				<DialogHeader>
					<DialogTitle>Extend the restore deadline</DialogTitle>
					<DialogDescription>Gives the target more time to finish restoring and acknowledge. The task stays with this machine until it does.</DialogDescription>
				</DialogHeader>
				<Field label="Add">
					{(id) => (
						<Select value={String(minutes)} onValueChange={(v) => setMinutes(Number(v))}>
							<SelectTrigger id={id}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{EXTEND_OPTIONS.map((m) => (
									<SelectItem key={m} value={String(m)}>
										{m < 60 ? `${m} minutes` : `${m / 60} ${m === 60 ? "hour" : "hours"}`}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					)}
				</Field>
				<DialogFooter>
					<Button variant="ghost" onClick={onClose} disabled={actions.extend.isPending}>
						Back
					</Button>
					<Button variant="primary" loading={actions.extend.isPending} onClick={() => actions.extend.mutate(minutes, { onSuccess: onClose })}>
						Extend
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function ReclaimDialog({ h, actions, onClose }: { h: Handoff; actions: HandoffActions; onClose: () => void }) {
	const peers = usePeers();
	const peer = peers.data?.find((p) => p.id === h.target.nodeId);
	// The target can only be asked whether it acknowledged while it is reachable; otherwise (or when the server says so) an explicit override is required.
	const [serverAskedOverride, setServerAskedOverride] = useState(false);
	const [override, setOverride] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const unreachable = peer?.status !== "online";
	const mustOverride = unreachable || serverAskedOverride;

	const reclaim = () =>
		actions.reclaim.mutate(mustOverride && override, {
			onSuccess: onClose,
			onError: (e) => {
				setError(errorMessage(e));
				if (e instanceof ApiError && (e.status === 409 || e.status === 412 || e.status === 422)) setServerAskedOverride(true);
			},
		});

	return (
		<Dialog open onOpenChange={(o) => !o && !actions.reclaim.isPending && onClose()}>
			<DialogContent sheetOnMobile className="max-w-md">
				<DialogHeader>
					<DialogTitle>Reclaim “{h.title}” on this machine?</DialogTitle>
					<DialogDescription>
						This machine takes the task back and {h.target.nodeName} is told the handoff is void. Ownership moves to a new epoch so the old one can never write again.
					</DialogDescription>
				</DialogHeader>
				<div className="scrollbar-thin -mx-1 flex min-h-0 flex-col gap-3 overflow-y-auto px-1">
					<div role="alert" className="flex items-start gap-2.5 rounded-xl bg-warning/10 p-3 text-[13px] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--warning)_35%,transparent)]">
						<TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
						<div className="min-w-0">
							<strong>Risk of duplicate execution.</strong> {RECLAIM_RISK}
						</div>
					</div>
					{mustOverride ? (
						<label className="flex cursor-pointer items-start gap-2.5 text-[13px]">
							<input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]" />
							<span>
								{unreachable ? `${h.target.nodeName} is not reachable, so I cannot check whether it acknowledged. ` : "The server could not prove the target did not acknowledge. "}
								<strong>I understand the risk and want to reclaim anyway.</strong>
							</span>
						</label>
					) : (
						<p className="text-xs text-subtle">{h.target.nodeName} is reachable, so this machine first asks it whether it acknowledged. If it did, nothing is reclaimed.</p>
					)}
					{error ? (
						<p role="alert" className="break-words text-xs text-danger">
							{error}
						</p>
					) : null}
				</div>
				<DialogFooter>
					<Button variant="ghost" onClick={onClose} disabled={actions.reclaim.isPending}>
						Keep waiting
					</Button>
					<Button variant="danger" disabled={mustOverride && !override} loading={actions.reclaim.isPending} onClick={reclaim}>
						Reclaim task
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** Plain-English failure explanation with the recommended next actions. Also covers an ack timeout that carries no failure record. */
export function FailureCard({ h, actions }: { h: Handoff; actions: HandoffActions }) {
	const failure = h.failure ?? (h.state === "ack_timeout" ? { code: "timeout" as const, detail: `${h.target.nodeName} has not acknowledged before the deadline.`, step: null } : null);
	if (!failure) return null;
	const text = FAILURE_TEXT[failure.code];
	return (
		<Card className="shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--danger)_40%,transparent)]">
			<CardContent className="flex flex-col gap-3">
				<div className="flex items-start gap-2.5">
					<OctagonAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
					<div className="min-w-0">
						<h3 className="text-sm font-semibold text-danger">{text.title}</h3>
						<p className="mt-1 text-[13px]">{text.body}</p>
						<p className="mt-1.5 text-[13px] text-muted-foreground">
							<span className="font-medium text-foreground">Recommended: </span>
							{text.advice}
						</p>
					</div>
				</div>
				{failure.detail ? (
					<pre className={cn("scrollbar-thin max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-2 p-2.5 font-mono text-xs text-muted-foreground")}>{failure.detail}</pre>
				) : null}
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
					<ActionButtons h={h} actions={actions} />
					<span className="font-mono text-2xs text-subtle">
						code {failure.code}
						{failure.step !== null ? ` · step ${failure.step}` : ""}
					</span>
				</div>
			</CardContent>
		</Card>
	);
}
