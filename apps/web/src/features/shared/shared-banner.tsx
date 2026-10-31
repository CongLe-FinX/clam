import type { AgentSession, SharedSession, SharedSessionDetail, SharedTransfer } from "@clam/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowRightFromLine, Camera, ExternalLink, Eye, GitBranch, Loader2, Play, ShieldAlert, TriangleAlert, Users } from "lucide-react";
import { useState } from "react";
import { errorMessage } from "@/lib/api";
import { useProject } from "@/lib/queries";
import { cn, relativeTime } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { StatusDot } from "@/ui/status-dot";
import { branchUrl, commitUrl, driverOf, NODE_STATUS_LABEL, nodeDot, participantLabel, shortCommit, teamOf } from "./format.ts";
import { useCheckpointNow, useNodeUiUrl, useTakeover } from "./hooks.ts";

const bar = "animate-fade-in flex shrink-0 flex-col gap-2 border-b px-3 py-2.5 text-[13px]";

/** Where the work continues: the new driver's UI (movedTo.url may be the node's base URL or already the session URL). */
export function movedHref(m: NonNullable<AgentSession["movedTo"]>): string | null {
	if (!m.url) return null;
	if (!m.sessionId || m.url.includes("/sessions/")) return m.url;
	return `${m.url.replace(/\/+$/, "")}/sessions/${m.sessionId}`;
}

// ───────────────────────────── takeover ─────────────────────────────

function TakeoverDialog({ shared, force, onClose }: { shared: SharedSession; force: boolean; onClose: () => void }) {
	const takeover = useTakeover(shared.id);
	const project = useProject(shared.localProjectId ?? "").data;
	const driver = driverOf(shared);
	const cp = shared.lastCheckpoint;
	const [understood, setUnderstood] = useState(false);
	const driverName = driver?.nodeName ?? "the driver";
	const url = cp?.commit ? commitUrl(shared.repo.url, cp.commit) : null;
	const ready = Boolean(cp?.snapshot) && (!force || understood);

	return (
		<Dialog open onOpenChange={(o) => !o && !takeover.isPending && onClose()}>
			<DialogContent sheetOnMobile className="max-w-lg">
				<DialogHeader>
					<DialogTitle>{force ? "Take over while the driver is reachable?" : "Continue this work on this node?"}</DialogTitle>
					<DialogDescription>
						A new session on this node picks up “{shared.title}” from the last checkpoint. It opens here, in this node's own web UI.
					</DialogDescription>
				</DialogHeader>
				<div className="scrollbar-thin -mx-1 flex min-h-0 flex-col gap-3.5 overflow-y-auto px-1 text-[13px]">
					{force ? (
						<div role="alert" className="flex items-start gap-2 rounded-lg bg-danger/10 px-3 py-2.5 text-xs text-danger">
							<ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
							<span>
								<strong>{driverName} is still reachable and may be working right now.</strong> Taking over splits the work: when it notices the higher epoch its own session is stopped and becomes read-only, and anything it does before that is only saved on a rescue branch. Prefer asking its owner to hand the work over from the Team tab instead.
							</span>
						</div>
					) : null}
					<dl className="flex flex-col gap-2.5 rounded-xl bg-surface-2/60 p-3 shadow-[inset_0_0_0_1px_var(--border)]">
						<div className="flex flex-col gap-0.5">
							<dt className="text-2xs font-medium uppercase tracking-wider text-subtle">Starting from checkpoint</dt>
							<dd>
								{cp ? (
									<span className="flex flex-wrap items-center gap-x-2 gap-y-1">
										<span className="font-medium">#{cp.seq}</span>
										<span className="text-muted-foreground" title={new Date(cp.at).toLocaleString()}>
											{relativeTime(cp.at)}
										</span>
										{cp.commit ? (
											<span className="font-mono text-xs">
												{url ? (
													<a href={url} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">
														{shortCommit(cp.commit)}
													</a>
												) : (
													shortCommit(cp.commit)
												)}
											</span>
										) : (
											<span className="text-xs text-subtle">no file changes</span>
										)}
										{cp.snapshot ? <span className="text-xs text-muted-foreground">{cp.snapshot.messageCount} messages</span> : null}
									</span>
								) : (
									<span className="text-warning">No checkpoint has been received yet.</span>
								)}
							</dd>
							{cp && !cp.pushed && cp.commit ? (
								<dd className="flex items-start gap-1.5 text-xs text-warning">
									<TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden /> That commit was never pushed to GitHub, so the code may be behind the conversation.
								</dd>
							) : null}
						</div>
						<div className="flex flex-col gap-0.5">
							<dt className="text-2xs font-medium uppercase tracking-wider text-subtle">What may be lost</dt>
							<dd className="text-muted-foreground">
								Everything {driverName} did after that checkpoint{cp ? ` (${relativeTime(cp.at)})` : ""} — messages, file changes, commands — is not on this node.
							</dd>
						</div>
						<div className="flex flex-col gap-0.5">
							<dt className="text-2xs font-medium uppercase tracking-wider text-subtle">Where it runs</dt>
							<dd className="flex flex-col gap-1 text-muted-foreground">
								<span>
									Local clone: <span className="font-medium text-foreground">{project?.name ?? (shared.localProjectId ? "…" : "none linked")}</span>
									{project ? <span className="ml-1 font-mono text-2xs text-subtle">{project.path}</span> : null}
								</span>
								<span className="inline-flex items-center gap-1">
									<GitBranch className="size-3.5 text-subtle" aria-hidden />
									Branch <code className="font-mono text-foreground">{shared.repo.branch}</code>
									{cp?.commit ? <> at <code className="font-mono">{shortCommit(cp.commit)}</code></> : null}
								</span>
								<span className="text-xs text-subtle">Uncommitted changes in that clone are never discarded: if they overlap, the takeover stops and tells you.</span>
							</dd>
						</div>
						<div className="flex flex-col gap-0.5">
							<dt className="text-2xs font-medium uppercase tracking-wider text-subtle">Afterwards</dt>
							<dd className="text-muted-foreground">
								This node drives (epoch {shared.epoch + 1}); {driverName} stays in the team. If it comes back, its copy becomes read-only with a link here and its unsaved work is kept on a rescue branch.
							</dd>
						</div>
					</dl>
					{force ? (
						<label className="flex min-h-11 cursor-pointer items-start gap-2.5 text-xs">
							<input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--danger)] coarse:size-5" />
							<span>I understand that {driverName} may lose work it is doing right now.</span>
						</label>
					) : null}
					{takeover.error ? (
						<p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
							{errorMessage(takeover.error)}
						</p>
					) : null}
				</div>
				<DialogFooter>
					<Button variant="ghost" onClick={onClose} disabled={takeover.isPending}>
						Cancel
					</Button>
					<Button variant={force ? "danger" : "primary"} loading={takeover.isPending} disabled={!ready} onClick={() => takeover.mutate(force, { onSuccess: onClose })}>
						<Play /> {force ? "Take over anyway" : "Continue on this node"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

// ───────────────────────────── banners ─────────────────────────────

function DriverChip({ shared }: { shared: SharedSession }) {
	const driver = driverOf(shared);
	if (!driver) return null;
	return (
		<Badge variant={driver.nodeStatus === "online" ? "success" : driver.nodeStatus === "offline" ? "danger" : "warning"} className="gap-1.5">
			<StatusDot status={nodeDot(driver.nodeStatus)} label={NODE_STATUS_LABEL[driver.nodeStatus]} className="size-1.5 [&>span]:size-1.5" />
			Driver {NODE_STATUS_LABEL[driver.nodeStatus].toLowerCase()}
		</Badge>
	);
}

function MirrorBanner({ session, shared, onOpenTeam }: { session: AgentSession; shared: SharedSession | null; onOpenTeam: () => void }) {
	const [dialog, setDialog] = useState<null | "continue" | "force">(null);
	const driver = shared ? driverOf(shared) : undefined;
	const driverNode = driver?.nodeName ?? "the driver node";
	const title = shared?.title ?? session.title;
	const reachable = driver ? driver.nodeStatus === "online" || driver.nodeStatus === "degraded" : true;
	return (
		<div role="region" aria-label="Live view" className={cn(bar, "bg-accent-soft/60")}>
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
				<Eye className="size-4 shrink-0 text-accent" aria-hidden />
				<p className="min-w-0 flex-1 basis-60">
					Live view of <span className="font-semibold">“{title}”</span> running on <span className="font-semibold">{driverNode}</span>
					<span className="text-muted-foreground"> · read-only</span>
				</p>
				{shared ? <DriverChip shared={shared} /> : null}
				<Button size="sm" variant="ghost" onClick={onOpenTeam} className="max-sm:hidden">
					<Users /> Team
				</Button>
			</div>
			{shared ? (
				shared.takeoverAvailable ? (
					<div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-warning/10 px-3 py-2.5 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--warning)_40%,transparent)]">
						<p className="min-w-0 flex-1 basis-56 text-xs text-warning">
							<strong>{driverNode} looks offline.</strong> {shared.lastCheckpoint ? `This node holds checkpoint ${shared.lastCheckpoint.seq} from ${relativeTime(shared.lastCheckpoint.at)}.` : null} You can continue the work here.
						</p>
						<Button variant="primary" size="lg" onClick={() => setDialog("continue")} className="max-sm:w-full">
							<Play /> Continue on this node
						</Button>
					</div>
				) : (
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
						<p className="min-w-0 flex-1 basis-56">{reachable ? "Following the driver live. You can still continue here if it stops responding." : (shared.takeoverBlockedReason ?? "The driver is offline, but this node cannot continue yet.")}</p>
						{reachable && shared.lastCheckpoint?.snapshot ? (
							<Button size="sm" variant="ghost" className="text-danger hover:text-danger" onClick={() => setDialog("force")}>
								Take over anyway…
							</Button>
						) : null}
					</div>
				)
			) : null}
			{shared && dialog ? <TakeoverDialog shared={shared} force={dialog === "force"} onClose={() => setDialog(null)} /> : null}
		</div>
	);
}

function MovedBanner({ session, shared }: { session: AgentSession; shared: SharedSession | null }) {
	const moved = session.movedTo;
	const ui = useNodeUiUrl(moved?.nodeId ?? "", moved?.url ?? null);
	if (!moved) return null;
	const href = movedHref({ ...moved, url: ui });
	const mirrorId = shared?.mirrorSessionId ?? null;
	const rescue = shared?.rescueBranch ?? null;
	const rescueUrl = rescue && shared ? branchUrl(shared.repo.url, rescue) : null;
	const me = shared?.participants.find((p) => p.nodeStatus === "self");
	return (
		<div role="region" aria-label="Moved" className={cn(bar, "bg-warning/10")}>
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
				<ArrowRightFromLine className="size-4 shrink-0 text-warning" aria-hidden />
				<p className="min-w-0 flex-1 basis-60">
					<span className="font-semibold">This work continues on {moved.nodeName}.</span> <span className="text-muted-foreground">This copy is read-only — moved {relativeTime(moved.at)}.</span>
				</p>
				{href ? (
					<Button asChild size="sm" variant="primary">
						<a href={href} target="_blank" rel="noreferrer noopener">
							<ExternalLink /> Open on {moved.nodeName}
						</a>
					</Button>
				) : (
					<Button asChild size="sm" variant="outline">
						<Link to="/network/nodes/$peerId" params={{ peerId: moved.nodeId }}>
							Find {moved.nodeName}
						</Link>
					</Button>
				)}
			</div>
			{rescue ? (
				<p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
					<GitBranch className="size-3.5 text-subtle" aria-hidden />
					Your unsaved changes were kept on branch{" "}
					{rescueUrl ? (
						<a href={rescueUrl} target="_blank" rel="noreferrer noopener" className="font-mono text-accent hover:underline">
							{rescue}
						</a>
					) : (
						<code className="font-mono text-foreground">{rescue}</code>
					)}
					.
				</p>
			) : null}
			{!href ? <p className="text-xs text-subtle">The address of {moved.nodeName}'s web UI is not known on this node.</p> : null}
			<div className="flex flex-wrap items-center gap-2">
				{mirrorId ? (
					<Button asChild size="sm" variant="outline">
						<Link to="/sessions/$sessionId" params={{ sessionId: mirrorId }}>
							<Eye /> Watch live here
						</Link>
					</Button>
				) : null}
				<span className="text-xs text-subtle">
					{me?.state === "active" ? `This node's agent stays in the team as a participant${mirrorId ? "" : "; its live view is being set up"}.` : "This node is no longer part of the team."}
				</span>
			</div>
		</div>
	);
}

/** This node's agent working as a participant: its own session in its own clone, next to the live view of the driver. */
function ParticipantStrip({ shared, onOpenTeam }: { shared: SharedSession; onOpenTeam: () => void }) {
	const driver = driverOf(shared);
	const viewId = shared.mirrorSessionId ?? shared.localSessionId;
	return (
		<div role="region" aria-label="Shared session" className="animate-fade-in flex shrink-0 items-center gap-x-3 border-b bg-accent-soft/40 px-3 py-1.5 text-xs">
			<Users className="size-4 shrink-0 text-accent" aria-hidden />
			<button type="button" onClick={onOpenTeam} className="min-w-0 flex-1 truncate rounded text-left text-muted-foreground outline-none hover:text-foreground focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:py-3" title="Open the team">
				Participant session in “{shared.title}”{driver ? <> — driven by <span className="font-medium text-foreground">{participantLabel(driver)}</span></> : null}
			</button>
			{viewId ? (
				<Button asChild size="sm" variant="ghost" className="shrink-0">
					<Link to="/sessions/$sessionId" params={{ sessionId: viewId }}>
						<Eye /> <span className="max-sm:sr-only">Live view</span>
					</Link>
				</Button>
			) : null}
		</div>
	);
}

/** Progress of a hand-over this node started, kept visible after the dialog is hidden. */
function TransferStrip({ transfer, onOpen }: { transfer: SharedTransfer; onOpen: () => void }) {
	const failed = transfer.phase === "failed" || transfer.phase === "cancelled";
	return (
		<div role="status" className={cn("animate-fade-in flex shrink-0 items-center gap-x-3 border-b px-3 py-1.5 text-xs", failed ? "bg-danger/10 text-danger" : "bg-warning/10")}>
			{failed ? <TriangleAlert className="size-4 shrink-0" aria-hidden /> : <Loader2 className="size-4 shrink-0 animate-spin text-warning" aria-hidden />}
			<span className="min-w-0 flex-1 truncate" title={transfer.message}>
				<span className="font-medium">{failed ? `Hand-over to ${transfer.toNodeName} ${transfer.phase === "cancelled" ? "cancelled" : "failed"}` : `Handing over to ${transfer.toNodeName}`}</span> · {failed ? (transfer.error?.message ?? transfer.message) : transfer.message}
			</span>
			<Button size="sm" variant="ghost" className="shrink-0" onClick={onOpen}>
				Details
			</Button>
		</div>
	);
}

/** The banner of a shared / mirror / moved session, or nothing for an ordinary one. */
export function SharedBanner({ session, detail, onOpenTeam, onOpenHandover }: { session: AgentSession; detail: SharedSessionDetail | undefined; onOpenTeam: () => void; onOpenHandover: () => void }) {
	const shared = detail?.shared ?? null;
	if (session.movedTo) return <MovedBanner session={session} shared={shared} />;
	if (session.kind === "mirror") return <MirrorBanner session={session} shared={shared} onOpenTeam={onOpenTeam} />;
	if (shared && shared.localRole === "driver") return shared.transfer ? <TransferStrip transfer={shared.transfer} onOpen={onOpenHandover} /> : null;
	if (shared) return <ParticipantStrip shared={shared} onOpenTeam={onOpenTeam} />;
	return null;
}
