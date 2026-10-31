import type { SharedSession } from "@clam/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Eye, Inbox, RefreshCw, Users } from "lucide-react";
import { useMemo } from "react";
import { errorMessage } from "@/lib/api";
import { isPendingInvite, useNode, useSharedInvites, useSharedSessions } from "@/lib/queries";
import { cn, relativeTime } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty-state";
import { PageContainer, PageHeader, SectionTitle } from "@/ui/page";
import { Skeleton } from "@/ui/skeleton";
import { StatusDot } from "@/ui/status-dot";
import { driverOf, nodeDot, NODE_STATUS_LABEL, participantLabel, ROLE_LABEL, teamOf } from "./format.ts";
import { InviteCard } from "./invite-card.tsx";
import { ModeLabel } from "./mode.tsx";

const ROLE_VARIANT = { driver: "accent", participant: "neutral", former_driver: "warning" } as const satisfies Record<SharedSession["localRole"], string>;

function statusLine(s: SharedSession): { text: string; tone: "warning" | "muted" | "success" } {
	if (s.localRole === "former_driver") return { text: s.rescueBranch ? `Work continues elsewhere · your unpushed changes are on ${s.rescueBranch}` : "Work continues on another machine", tone: "warning" };
	if (s.localRole === "participant") {
		if (s.takeoverAvailable) return { text: "The driver looks offline — you can continue the work on this machine", tone: "warning" };
		return { text: s.takeoverBlockedReason ?? "Following the driver live", tone: "muted" };
	}
	return { text: s.lastCheckpoint ? `Checkpoint ${s.lastCheckpoint.seq} · ${relativeTime(s.lastCheckpoint.at)}${s.vcs === "git" && s.lastCheckpoint.commit && !s.lastCheckpoint.pushed ? " · not pushed" : ""}` : "No checkpoint yet", tone: "success" };
}

function SharedRow({ s }: { s: SharedSession }) {
	const driver = driverOf(s);
	const team = teamOf(s);
	const status = statusLine(s);
	const body = (
		<>
			<div className="flex flex-wrap items-center gap-2">
				<h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{s.title}</h3>
				{s.unreadMessages > 0 ? <span className="tabular grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1.5 text-2xs font-semibold text-accent-foreground" aria-label={`${s.unreadMessages} unread messages`}>{s.unreadMessages}</span> : null}
				<Badge variant={ROLE_VARIANT[s.localRole]}>{ROLE_LABEL[s.localRole]}</Badge>
				{s.localRole === "participant" ? (
					<Badge variant="outline" className="gap-1">
						<Eye aria-hidden /> Live view
					</Badge>
				) : null}
			</div>
			<div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
				{driver ? (
					<span className="inline-flex items-center gap-1.5">
						<StatusDot status={nodeDot(driver.nodeStatus)} label={NODE_STATUS_LABEL[driver.nodeStatus]} />
						<span>
							Driver <span className="font-medium text-foreground">{participantLabel(driver)}</span>
						</span>
					</span>
				) : null}
				<ModeLabel vcs={s.vcs} repo={s.repo} className="text-xs" />
				<span className="tabular font-mono text-2xs text-subtle">epoch {s.epoch}</span>
			</div>
			<div className="flex flex-wrap items-center gap-1.5">
				{team.map((p) => (
					<span key={p.nodeId} className="inline-flex items-center gap-1.5 rounded-md bg-surface-2 px-1.5 py-1 text-2xs text-muted-foreground">
						<StatusDot status={nodeDot(p.nodeStatus)} label={NODE_STATUS_LABEL[p.nodeStatus]} className="size-1.5 [&>span]:size-1.5" />
						{participantLabel(p)}
						{p.state === "invited" ? <span className="text-subtle">· invited</span> : null}
					</span>
				))}
			</div>
			<p className={cn("text-xs", status.tone === "warning" ? "text-warning" : "text-subtle")}>{status.text}</p>
		</>
	);
	return (
		<li className="rounded-xl bg-surface-1 shadow-[inset_0_0_0_1px_var(--border)] transition-colors hover:bg-surface-2">
			{s.localSessionId ? (
				<Link to="/sessions/$sessionId" params={{ sessionId: s.localSessionId }} className="flex min-h-11 flex-col gap-2 rounded-xl p-4 outline-none focus-visible:shadow-[0_0_0_2px_var(--accent)]">
					{body}
					<span className="inline-flex items-center gap-1 text-xs font-medium text-accent">
						Open session <ArrowUpRight className="size-3" aria-hidden />
					</span>
				</Link>
			) : (
				<div className="flex flex-col gap-2 p-4">{body}</div>
			)}
		</li>
	);
}

export default function SharedPage() {
	const sessions = useSharedSessions();
	const invites = useSharedInvites();
	const node = useNode().data;
	const pending = (invites.data ?? []).filter(isPendingInvite);
	const sorted = useMemo(() => [...(sessions.data ?? [])].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)), [sessions.data]);

	return (
		<PageContainer>
			<PageHeader
				eyebrow="Agent Network"
				title="Shared sessions"
				description={`Work that several machines do together${node ? ` — ${node.name} drives some and follows others` : ""}. Add an agent from another machine to a session to share it.`}
			/>

			{pending.length > 0 ? (
				<section aria-label="Invitations" className="flex flex-col gap-3">
					<SectionTitle>
						<span className="inline-flex items-center gap-1.5">
							<Inbox className="size-3.5" aria-hidden /> Invitations <span className="tabular rounded-full bg-accent px-1.5 text-2xs text-accent-foreground">{pending.length}</span>
						</span>
					</SectionTitle>
					{pending.map((i) => (
						<InviteCard key={i.id} invite={i} />
					))}
				</section>
			) : null}

			<section aria-label="Shared sessions" className="flex flex-col gap-3">
				<SectionTitle>
					<span className="inline-flex items-center gap-1.5">
						<Users className="size-3.5" aria-hidden /> Sessions
					</span>
				</SectionTitle>
				{sessions.isPending ? (
					<div className="flex flex-col gap-3" aria-busy="true">
						<Skeleton className="h-28" />
						<Skeleton className="h-28" />
					</div>
				) : sessions.isError ? (
					<EmptyState
						icon={RefreshCw}
						title="Could not load shared sessions"
						description={errorMessage(sessions.error)}
						action={
							<Button variant="outline" onClick={() => void sessions.refetch()}>
								Retry
							</Button>
						}
					/>
				) : sorted.length === 0 ? (
					<EmptyState
						icon={Users}
						title="No shared sessions yet"
						description="Open an agent session and use “Add agent” in its header to bring an agent from another machine into it. Invitations from other machines show up here."
						action={
							<Button asChild variant="outline">
								<Link to="/node/sessions">Go to agent sessions</Link>
							</Button>
						}
					/>
				) : (
					<ul className="flex flex-col gap-3">
						{sorted.map((s) => (
							<SharedRow key={s.id} s={s} />
						))}
					</ul>
				)}
			</section>
		</PageContainer>
	);
}
