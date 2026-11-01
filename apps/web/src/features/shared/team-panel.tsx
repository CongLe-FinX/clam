import type { AgentSession, Checkpoint, Participant, SharedSession, SharedSessionDetail } from "@clam/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowRightLeft, Camera, Check, Clock, ExternalLink, FolderSync, GitBranch, LogOut, TriangleAlert, UserMinus, UserPlus, Users } from "lucide-react";
import { type ReactNode, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { t, tr } from "@/i18n";
import { errorText } from "@/lib/api";
import { useUi } from "@/lib/store";
import { cn, formatBytes, formatDateTime, formatList, relativeTime } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty-state";
import { Skeleton } from "@/ui/skeleton";
import { StatusDot } from "@/ui/status-dot";
import { branchUrl, NODE_STATUS_LABEL, nodeDot, PARTICIPANT_STATE_LABEL, participantLabel, remoteSessionUrl, ROLE_LABEL, teamOf } from "./format.ts";
import { useCheckpointNow, useLeaveShared, useNodeUiUrl, useRemoveParticipant, useSharedDetail } from "./hooks.ts";
import { CheckpointFacts, FilesInfoButton } from "./mode.tsx";

type TeamTab = "members" | "checkpoints";

function SubTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
	return (
		<button
			type="button"
			role="tab"
			aria-selected={active}
			onClick={onClick}
			className={cn(
				"inline-flex h-7 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium outline-none transition-colors focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:h-11 [&_svg]:size-3.5",
				active ? "bg-surface-3 text-foreground" : "text-muted-foreground hover:bg-surface-2 hover:text-foreground",
			)}
		>
			{children}
		</button>
	);
}

function selfOf(s: SharedSession): Participant | undefined {
	return s.participants.find((p) => p.nodeStatus === "self");
}

// ───────────────────────────── members ─────────────────────────────

function MemberRow({ shared, p, onTransfer, onRemove }: { shared: SharedSession; p: Participant; onTransfer: (p: Participant) => void; onRemove: (p: Participant) => void }) {
	const isDriver = p.nodeId === shared.driverNodeId;
	const self = p.nodeStatus === "self";
	const iAmDriver = shared.localRole === "driver";
	const active = p.state === "active";
	const canTransfer = iAmDriver && !self && active && p.nodeStatus === "online";
	const canRemove = iAmDriver && !self && (p.state === "active" || p.state === "invited");
	const ui = useNodeUiUrl(p.nodeId, p.uiUrl);
	return (
		<li className="flex flex-col gap-2 rounded-xl bg-surface-2/60 p-3 shadow-[inset_0_0_0_1px_var(--border)]">
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
				<StatusDot status={nodeDot(p.nodeStatus)} label={tr(NODE_STATUS_LABEL[p.nodeStatus])} />
				<span className="min-w-0 flex-1 basis-28 truncate text-[13px] font-medium" title={participantLabel(p)}>
					{participantLabel(p)}
				</span>
				{self ? <Badge variant="outline">{t("this machine")}</Badge> : null}
				{isDriver ? <Badge variant="accent">{tr(ROLE_LABEL.driver)}</Badge> : <Badge variant="neutral">{tr(ROLE_LABEL.participant)}</Badge>}
			</div>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-subtle">
				<span>{tr(NODE_STATUS_LABEL[p.nodeStatus])}</span>
				{p.state !== "active" ? <span className={cn(p.state === "invited" ? "text-warning" : "")}>{tr(PARTICIPANT_STATE_LABEL[p.state])}</span> : null}
				{p.joinedAt ? <span>{t("joined {time}", { time: relativeTime(p.joinedAt) })}</span> : null}
			</div>
			<div className="flex flex-wrap items-center gap-1.5">
				{self && p.agentSessionId ? (
					<Button asChild size="sm" variant="outline">
						<Link to="/sessions/$sessionId" params={{ sessionId: p.agentSessionId }}>
							{t("Agent session")}
						</Link>
					</Button>
				) : null}
				{self && isDriver && shared.localSessionId ? (
					<span className="text-2xs text-subtle">{t("This session is driven here.")}</span>
				) : null}
				{!self && ui ? (
					<Button asChild size="sm" variant="outline">
						<a href={remoteSessionUrl(ui, isDriver ? null : p.agentSessionId)} target="_blank" rel="noreferrer noopener">
							<ExternalLink /> {t("Open on {name}", { name: p.nodeName })}
						</a>
					</Button>
				) : null}
				{canTransfer ? (
					<Button size="sm" variant="outline" onClick={() => onTransfer(p)}>
						<ArrowRightLeft /> {t("Make driver")}
					</Button>
				) : null}
				{canRemove ? (
					<Button size="sm" variant="ghost" className="text-danger hover:text-danger" onClick={() => onRemove(p)} aria-label={t("Remove {name}", { name: participantLabel(p) })}>
						<UserMinus /> {t("Remove")}
					</Button>
				) : null}
			</div>
		</li>
	);
}

function Members({ shared, onAddAgent }: { shared: SharedSession; onAddAgent: () => void }) {
	const openDialog = useUi((s) => s.openDialog);
	const remove = useRemoveParticipant(shared.id);
	const leave = useLeaveShared(shared.id);
	const [removing, setRemoving] = useState<Participant | null>(null);
	const [leaving, setLeaving] = useState(false);
	const members = teamOf(shared);
	const gone = shared.participants.filter((p) => p.state !== "invited" && p.state !== "active");
	const iAmDriver = shared.localRole === "driver";
	const me = selfOf(shared);
	const branch = shared.repo ? branchUrl(shared.repo.url, shared.repo.branch) : null;

	return (
		<div className="flex flex-col gap-3 p-3">
			<ul className="flex flex-col gap-2" aria-label={t("Team members")}>
				{members.map((p) => (
					<MemberRow key={p.nodeId} shared={shared} p={p} onTransfer={(m) => shared.localSessionId && openDialog({ kind: "handover", sessionId: shared.localSessionId, toNodeId: m.nodeId })} onRemove={setRemoving} />
				))}
			</ul>
			{iAmDriver ? (
				<Button variant="outline" onClick={onAddAgent} className="self-start">
					<UserPlus /> {t("Add agent")}
				</Button>
			) : null}
			{gone.length > 0 ? (
				<p className="text-2xs text-subtle">
					{t("Not in the team: {list}", { list: formatList(gone.map((p) => `${participantLabel(p)} (${tr(PARTICIPANT_STATE_LABEL[p.state]).toLowerCase()})`)) })}
				</p>
			) : null}
			<dl className="flex flex-col gap-1.5 rounded-lg bg-surface-2/60 p-3 text-2xs text-subtle">
				<div className="flex items-center gap-2">
					<dt className="w-16 shrink-0">{shared.vcs === "git" ? t("Branch") : t("Sync")}</dt>
					{shared.vcs === "git" && shared.repo ? (
						<dd className="flex min-w-0 items-center gap-1 font-mono text-muted-foreground">
							<GitBranch className="size-3 shrink-0" aria-hidden />
							{branch ? (
								<a href={branch} target="_blank" rel="noreferrer noopener" className="truncate hover:text-foreground hover:underline">
									{shared.repo.branch}
								</a>
							) : (
								<span className="truncate">{shared.repo.branch}</span>
							)}
						</dd>
					) : (
						<dd className="flex min-w-0 items-center gap-1 text-muted-foreground">
							<FolderSync className="size-3 shrink-0" aria-hidden />
							<span className="truncate">{t("Folder sync · no repository")}</span>
							<FilesInfoButton />
						</dd>
					)}
				</div>
				<div className="flex items-center gap-2">
					<dt className="w-16 shrink-0">{t("Epoch")}</dt>
					<dd className="tabular font-mono text-muted-foreground" title={t("Increases every time the driver changes; actions from an older epoch are refused.")}>
						{shared.epoch}
					</dd>
				</div>
			</dl>
			{shared.localRole === "participant" && me && me.state === "active" ? (
				<Button variant="ghost" size="sm" className="self-start text-danger hover:text-danger" onClick={() => setLeaving(true)}>
					<LogOut /> {t("Leave shared session")}
				</Button>
			) : null}

			<ConfirmDialog
				open={removing !== null}
				onOpenChange={(o) => !o && setRemoving(null)}
				title={t("Remove {name}?", { name: removing ? participantLabel(removing) : "" })}
				description={t("Its live view and agent session on that machine are torn down. Its work stays in its clone and on any branch it already pushed.")}
				confirmLabel={t("Remove")}
				danger
				loading={remove.isPending}
				onConfirm={() => removing && remove.mutate(removing.nodeId, { onSuccess: () => setRemoving(null) })}
			/>
			<ConfirmDialog
				open={leaving}
				onOpenChange={setLeaving}
				title={t("Leave this shared session?")}
				description={t("Your live view and your agent's session for it are torn down on this machine. You can be invited again later.")}
				confirmLabel={t("Leave")}
				danger
				loading={leave.isPending}
				onConfirm={() => leave.mutate(undefined, { onSuccess: () => setLeaving(false) })}
			/>
		</div>
	);
}

// ───────────────────────────── checkpoints ─────────────────────────────

function CheckpointItem({ shared, c }: { shared: SharedSession; c: Checkpoint }) {
	const git = shared.vcs === "git";
	const holders = shared.participants.filter((p) => p.nodeId !== c.nodeId && p.state === "active");
	const names = new Map(shared.participants.map((p) => [p.nodeId, participantLabel(p)]));
	return (
		<li className="relative flex flex-col gap-1.5 pb-4 pl-5 last:pb-0">
			<span aria-hidden className="absolute left-0 top-1.5 size-2 rounded-full bg-accent" />
			<span aria-hidden className="absolute bottom-0 left-[3px] top-4 w-px bg-border last:hidden" />
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
				<span className="text-[13px] font-medium">{t("Checkpoint {seq}", { seq: c.seq })}</span>
				<span className="text-2xs text-subtle" title={formatDateTime(c.at)}>
					{relativeTime(c.at)}
				</span>
				<span className="tabular font-mono text-2xs text-subtle">{t("epoch {epoch}", { epoch: c.epoch })}</span>
				{git && c.commit && c.pushed ? (
					<Badge variant="success">
						<Check aria-hidden /> {t("Pushed")}
					</Badge>
				) : git && c.commit ? (
					<Badge variant="warning" title={t("The push was refused or has not happened yet; the commit exists on the driver node.")}>
						<TriangleAlert aria-hidden /> {t("Not pushed")}
					</Badge>
				) : null}
			</div>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
				<CheckpointFacts shared={shared} c={c} />
				{c.snapshot ? (
					<span title={`sha256 ${c.snapshot.sha256}`}>
						{t("Snapshot · {count, plural, one {# message} other {# messages}} · {size}", { count: c.snapshot.messageCount, size: formatBytes(c.snapshot.size) })}
					</span>
				) : (
					<span className="text-warning">{t("No snapshot")}</span>
				)}
			</div>
			{c.snapshot && holders.length > 0 ? (
				<div className="flex flex-wrap items-center gap-1">
					{holders.map((p) => {
						const has = c.deliveredTo.includes(p.nodeId);
						return (
							<span key={p.nodeId} className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs", has ? "bg-success/12 text-success" : "bg-surface-3 text-subtle")}>
								{has ? <Check className="size-3" aria-hidden /> : <Clock className="size-3" aria-hidden />}
								{names.get(p.nodeId) ?? p.nodeName}
								<span className="sr-only">{has ? t("has the snapshot") : t("has not received the snapshot yet")}</span>
							</span>
						);
					})}
				</div>
			) : null}
			{c.note ? <p className="text-xs text-muted-foreground">“{c.note}”</p> : null}
		</li>
	);
}

function Checkpoints({ shared, checkpoints }: { shared: SharedSession; checkpoints: Checkpoint[] }) {
	const now = useCheckpointNow(shared.id);
	const ordered = [...checkpoints].sort((a, b) => b.seq - a.seq);
	const driver = shared.localRole === "driver";
	return (
		<div className="flex flex-col gap-3 p-3">
			<div className="flex items-center gap-2">
				<p className="min-w-0 flex-1 text-xs text-muted-foreground">
					{shared.vcs === "git"
						? t("A checkpoint commits the work to the shared branch and ships a snapshot of the conversation to the team. Another machine can continue from the latest one.")
						: t("A checkpoint bundles the working folder (no Git needed) and ships it with a snapshot of the conversation to the team. Another machine can continue from the latest one — work done after it is lost.")}
				</p>
			</div>
			{driver ? (
				<Button variant="outline" onClick={() => now.mutate(undefined)} loading={now.isPending} className="self-start">
					<Camera /> {t("Checkpoint now")}
				</Button>
			) : null}
			{ordered.length === 0 ? (
				<EmptyState icon={Camera} title={t("No checkpoints yet")} description={driver ? t("One is taken automatically after a turn that changed files; or take one now.") : t("The driver takes them automatically.")} className="py-8" />
			) : (
				<ol className="flex flex-col" aria-label={t("Checkpoints, newest first")}>
					{ordered.map((c) => (
						<CheckpointItem key={c.seq} shared={shared} c={c} />
					))}
				</ol>
			)}
		</div>
	);
}

// ───────────────────────────── panel ─────────────────────────────

/** Right-panel tab of a session that belongs to a shared session: the members and the checkpoints (the conversation is the group chat). */
export function TeamPanel({ session, onAddAgent }: { session: AgentSession; onAddAgent: () => void }) {
	const q = useSharedDetail(session.sharedSessionId);
	const [tab, setTab] = useState<TeamTab>("members");

	if (!session.sharedSessionId) {
		const canShare = session.kind === "local" && !session.movedTo;
		return (
			<EmptyState
				icon={Users}
				title={t("Not shared yet")}
				description={t("Add an agent from another machine to work on this session together: it follows live, discusses with you, and can take over if this machine goes offline.")}
				action={
					canShare ? (
						<Button variant="primary" onClick={onAddAgent}>
							<UserPlus /> {t("Add agent")}
						</Button>
					) : undefined
				}
				className="h-full"
			/>
		);
	}
	if (q.isPending) {
		return (
			<div className="flex flex-col gap-2 p-3" aria-busy="true">
				<Skeleton className="h-8" />
				<Skeleton className="h-20" />
				<Skeleton className="h-20" />
			</div>
		);
	}
	if (q.isError) {
		return (
			<EmptyState
				icon={TriangleAlert}
				title={t("Could not load the team")}
				description={errorText(q.error)}
				action={
					<Button variant="outline" onClick={() => void q.refetch()}>
						{t("Retry")}
					</Button>
				}
			/>
		);
	}
	const detail = q.data;
	const { shared } = detail;
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex shrink-0 flex-col gap-2 border-b px-3 py-2.5">
				<div className="flex items-center gap-2">
					<Users className="size-4 shrink-0 text-accent" aria-hidden />
					<h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold" title={shared.title}>
						{shared.title}
					</h2>
					<Badge variant={shared.localRole === "driver" ? "accent" : shared.localRole === "former_driver" ? "warning" : "neutral"}>{tr(ROLE_LABEL[shared.localRole])}</Badge>
				</div>
				<ul className="flex flex-wrap gap-1.5" aria-label={t("Team status")}>
					{teamOf(shared).map((p) => (
						<li key={p.nodeId} className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-surface-2 px-1.5 py-1 text-2xs text-muted-foreground" title={`${participantLabel(p)} · ${tr(NODE_STATUS_LABEL[p.nodeStatus])}`}>
							<StatusDot status={nodeDot(p.nodeStatus)} label={tr(NODE_STATUS_LABEL[p.nodeStatus])} className="size-1.5 [&>span]:size-1.5" />
							<span className="truncate">{participantLabel(p)}</span>
							{p.nodeId === shared.driverNodeId ? <span className="text-accent">{t("lead")}</span> : null}
							{p.state === "invited" ? <span className="text-warning">{t("invited")}</span> : null}
						</li>
					))}
				</ul>
				<div role="tablist" aria-label={t("Team")} className="flex gap-0.5">
					<SubTab active={tab === "members"} onClick={() => setTab("members")}>
						<Users /> {t("Members")}
					</SubTab>
					<SubTab active={tab === "checkpoints"} onClick={() => setTab("checkpoints")}>
						<Camera /> {t("Checkpoints")}
						<span className="tabular font-mono text-2xs text-subtle">{detail.checkpoints.length}</span>
					</SubTab>
				</div>
			</div>
			<div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-contain">
				{tab === "members" ? <Members shared={shared} onAddAgent={onAddAgent} /> : <Checkpoints shared={shared} checkpoints={detail.checkpoints} />}
			</div>
		</div>
	);
}
