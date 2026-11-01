import type { Handoff, HandoffDetail } from "@clam/contracts";
import { Link, useParams } from "@tanstack/react-router";
import { ChevronLeft, ListChecks, RotateCw, SearchX, SquareTerminal, TriangleAlert } from "lucide-react";
import { t } from "@/i18n";
import { ApiError, errorText } from "@/lib/api";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card, CardContent } from "@/ui/card";
import { EmptyState } from "@/ui/empty-state";
import { Skeleton } from "@/ui/skeleton";
import { ActionButtons, DecisionPanel, FailureCard } from "./action-panel.tsx";
import { useHandoffActions } from "./actions.ts";
import { useHandoff, useHandoffLive } from "./api.ts";
import { ManifestCard } from "./manifest-card.tsx";
import { ownSessionId, progressLine } from "./meta.ts";
import { Countdown, NodeFlow, RoleChip, StateChip, useNow } from "./parts.tsx";
import { SetupPanel } from "./setup-panel.tsx";
import { EventTimeline, StepTimeline } from "./timelines.tsx";

export default function HandoffDetailPage() {
	const { handoffId } = useParams({ strict: false }) as { handoffId?: string };
	if (!handoffId) return null;
	return <Gate key={handoffId} id={handoffId} />;
}

function Gate({ id }: { id: string }) {
	const q = useHandoff(id);
	useHandoffLive(id);
	if (q.data) return <View detail={q.data} />;
	if (q.isPending) {
		return (
			<div className="mx-auto flex max-w-5xl flex-col gap-4 p-6" aria-busy aria-label={t("Loading handoff")}>
				<Skeleton className="h-8 w-2/3" />
				<Skeleton className="h-28" />
				<Skeleton className="h-48" />
			</div>
		);
	}
	const notFound = q.error instanceof ApiError && q.error.status === 404;
	return (
		<EmptyState
			className="h-full"
			icon={notFound ? SearchX : TriangleAlert}
			title={notFound ? t("Handoff not found") : t("Could not load this handoff")}
			description={notFound ? t("It may have been archived, or the link is wrong.") : errorText(q.error)}
			action={
				notFound ? (
					<Button asChild variant="outline">
						<Link to="/handoffs">{t("All handoffs")}</Link>
					</Button>
				) : (
					<Button variant="outline" onClick={() => void q.refetch()}>
						<RotateCw /> {t("Retry")}
					</Button>
				)
			}
		/>
	);
}

function View({ detail }: { detail: HandoffDetail }) {
	const { handoff: h, events } = detail;
	const actions = useHandoffActions(h.id);
	const failed = h.failure !== null || h.state === "ack_timeout";
	return (
		<div className="flex h-full min-h-0 flex-col bg-background">
			<div className="flex h-[calc(3rem+env(safe-area-inset-top))] shrink-0 items-center gap-1 border-b bg-surface-1 px-2 pt-safe coarse:h-[calc(3.5rem+env(safe-area-inset-top))]">
				<Button asChild variant="ghost" size="icon" aria-label={t("Back to handoffs")}>
					<Link to="/handoffs">
						<ChevronLeft />
					</Link>
				</Button>
				<h1 className="flex min-w-0 flex-1 items-baseline gap-2 text-sm font-semibold tracking-tight">
					{t("Handoff")} <span className="truncate font-mono text-2xs font-normal text-subtle">{h.id}</span>
				</h1>
				<StateChip state={h.state} />
			</div>
			<div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-contain">
				<div className="mx-auto grid w-full max-w-6xl gap-4 px-4 py-4 sm:px-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:py-6">
					<div className="flex min-w-0 flex-col gap-4">
						<Header h={h} actions={!failed ? <ActionButtons h={h} actions={actions} /> : null} />
						<DecisionPanel h={h} actions={actions} />
						<FailureCard h={h} actions={actions} />
						<SetupPanel h={h} actions={actions} />
						<ManifestCard h={h} />
					</div>
					<div className="flex min-w-0 flex-col gap-4">
						<StepTimeline steps={h.steps} />
						<EventTimeline events={events} h={h} />
					</div>
				</div>
			</div>
		</div>
	);
}

function Header({ h, actions }: { h: Handoff; actions: React.ReactNode }) {
	const now = useNow();
	const sessionId = ownSessionId(h);
	return (
		<Card>
			<CardContent className="flex flex-col gap-3.5">
				<div className="flex flex-wrap items-center gap-1.5">
					<StateChip state={h.state} />
					<RoleChip role={h.role} />
					<Badge variant="outline">{h.kind === "task" ? t("Task handoff") : t("Shared-session hand-over")}</Badge>
					<Badge variant="outline" title={t("Ownership epoch (fencing token)")}>
						{t("epoch {from} → {to}", { from: h.fromEpoch, to: h.toEpoch })}
					</Badge>
				</div>
				<h2 className="text-lg font-semibold leading-snug tracking-tight">{h.title}</h2>
				<NodeFlow h={h} />
				<div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
					<span>{progressLine(h)}</span>
					<Countdown h={h} now={now} withLabel />
				</div>
				<div className="flex flex-wrap items-center gap-2">
					{sessionId ? (
						<Button asChild size="sm" variant="outline">
							<Link to="/sessions/$sessionId" params={{ sessionId }}>
								<SquareTerminal /> {h.role === "source" ? t("Open the source session") : t("Open the new session")}
							</Link>
						</Button>
					) : null}
					{h.kind === "task" ? (
						<Button asChild size="sm" variant="outline">
							<Link to="/tasks/$taskId" params={{ taskId: h.subjectId }}>
								<ListChecks /> {t("Open the task")}
							</Link>
						</Button>
					) : (
						<Button asChild size="sm" variant="outline">
							<Link to="/shared">
								<ListChecks /> {t("Shared sessions")}
							</Link>
						</Button>
					)}
				</div>
				{actions}
			</CardContent>
		</Card>
	);
}
