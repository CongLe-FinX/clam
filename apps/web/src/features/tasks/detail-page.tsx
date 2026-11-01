import type { Task, TaskDetail } from "@clam/contracts";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowRight, ChevronLeft, ExternalLink, ListChecks, MessagesSquare, OctagonAlert, RotateCw, SearchX, SquareTerminal, TriangleAlert, Waypoints, XCircle } from "lucide-react";
import { lazy, type ReactNode, Suspense, useState } from "react";
import { LazyMarkdown } from "@/components/lazy-markdown";
import { useKeyboardInset } from "@/features/session/use-keyboard-inset";
import { KeyValue } from "@/features/settings/components/section";
import { useBreakpoint } from "@/hooks/use-breakpoint";
import { msg, renderServerText, T, t, tr } from "@/i18n";
import { ApiError, errorText } from "@/lib/api";
import { useProjects } from "@/lib/queries";
import { cn, formatBytes, formatCost, formatDateTime, formatDuration, formatNumber, relativeTime } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { EmptyState } from "@/ui/empty-state";
import { Skeleton } from "@/ui/skeleton";
import { Textarea } from "@/ui/textarea";
import { AcceptPanel } from "./accept-panel.tsx";
import { DeliveryMark, DirectionChip, PartyChip, TaskStatusPill } from "./components.tsx";
import { Discussion } from "./discussion.tsx";
import { APPROVAL_MODES, STATUS_META, isTerminal, ownParty, repoSlug } from "./format.ts";
import { useCancelTask, useRetryTask, useTask, useTaskLive } from "./hooks.ts";
import { ResultCard } from "./result-card.tsx";
import { Timeline } from "./timeline.tsx";

const HandOffDialog = lazy(() => import("@/features/handoff/hand-off-dialog.tsx"));

export default function TaskDetailPage() {
	const { taskId } = useParams({ strict: false }) as { taskId?: string };
	if (!taskId) return null;
	return <TaskGate key={taskId} id={taskId} />;
}

function TaskGate({ id }: { id: string }) {
	const q = useTask(id);
	useTaskLive(id);
	if (q.data) return <TaskView detail={q.data} />;
	if (q.isPending) {
		return (
			<div className="mx-auto flex max-w-5xl flex-col gap-4 p-6" aria-busy aria-label={t("Loading task")}>
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
			title={notFound ? t("Task not found") : t("Could not load this task")}
			description={notFound ? t("It may have been removed, or the link is wrong.") : errorText(q.error)}
			action={
				notFound ? (
					<Button asChild variant="outline">
						<Link to="/tasks">{t("All tasks")}</Link>
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

function Notice({ tone, icon: Icon, children }: { tone: "danger" | "warning" | "neutral"; icon: typeof TriangleAlert; children: ReactNode }) {
	return (
		<div
			role="status"
			className={cn(
				"flex items-start gap-2.5 rounded-xl p-3 text-[13px]",
				tone === "danger" && "bg-danger/10 text-danger shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--danger)_30%,transparent)]",
				tone === "warning" && "bg-warning/10 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--warning)_35%,transparent)]",
				tone === "neutral" && "bg-surface-2 text-muted-foreground",
			)}
		>
			<Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
			<div className="min-w-0 flex-1 break-words">{children}</div>
		</div>
	);
}

function TaskView({ detail }: { detail: TaskDetail }) {
	const { task, events, messages } = detail;
	const bp = useBreakpoint();
	const wide = bp === "desktop";
	const kbInset = useKeyboardInset(!wide);
	const [tab, setTab] = useState<"details" | "discussion">("details");
	const unread = task.unreadMessages;

	const details = (
		<div className="scrollbar-thin h-full overflow-y-auto overscroll-contain">
			<div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-4 sm:px-6 lg:py-6">
				<Header task={task} />
				<Notices task={task} />
				{task.direction === "incoming" && task.status === "offered" ? <AcceptPanel task={task} /> : null}
				{task.direction === "incoming" && task.status === "blocked" && task.executor.sessionId === null && task.reason ? <AcceptPanel task={task} reaccept /> : null}
				<ResultCard task={task} />
				<Card>
					<CardHeader>
						<CardTitle>{t("Instructions")}</CardTitle>
					</CardHeader>
					<CardContent className="pt-3">
						<LazyMarkdown text={task.description} />
					</CardContent>
				</Card>
				<MetaCard task={task} />
				<Timeline events={events} />
			</div>
		</div>
	);

	return (
		<div className="flex h-full min-h-0 flex-col bg-background" style={kbInset > 0 ? { paddingBottom: kbInset } : undefined}>
			<div className="flex h-[calc(3rem+env(safe-area-inset-top))] shrink-0 items-center gap-1 border-b bg-surface-1 px-2 pt-safe coarse:h-[calc(3.5rem+env(safe-area-inset-top))]">
				<Button asChild variant="ghost" size="icon" aria-label={t("Back to tasks")}>
					<Link to="/tasks">
						<ChevronLeft />
					</Link>
				</Button>
				<h1 className="flex min-w-0 flex-1 items-baseline gap-2 text-sm font-semibold tracking-tight">
					{t("Task")} <span className="truncate font-mono text-2xs font-normal text-subtle">{task.id}</span>
				</h1>
				<TaskStatusPill status={task.status} />
			</div>
			{wide ? (
				<div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_26rem]">
					{details}
					<Discussion task={task} messages={messages} visible className="border-l bg-surface-1" />
				</div>
			) : (
				<>
					<div role="tablist" aria-label={t("Task sections")} className="mx-3 my-2 flex shrink-0 rounded-lg bg-surface-2 p-0.5">
						<TabButton active={tab === "details"} onClick={() => setTab("details")}>
							<ListChecks className="size-3.5" aria-hidden /> {t("Details")}
						</TabButton>
						<TabButton active={tab === "discussion"} onClick={() => setTab("discussion")}>
							<MessagesSquare className="size-3.5" aria-hidden /> {t("Discussion")}
							<span className="tabular font-mono text-2xs text-subtle">{messages.length}</span>
							{unread > 0 ? (
								<Badge variant="accent" aria-label={t("{count} unread", { count: formatNumber(unread) })}>
									{unread}
								</Badge>
							) : null}
						</TabButton>
					</div>
					<div className={cn("min-h-0 flex-1", tab !== "details" && "hidden")}>{details}</div>
					<Discussion task={task} messages={messages} visible={tab === "discussion"} hideTitle className={cn("flex-1", tab !== "discussion" && "hidden")} />
				</>
			)}
		</div>
	);
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
	return (
		<button
			type="button"
			role="tab"
			aria-selected={active}
			onClick={onClick}
			className={cn(
				"inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md text-xs font-medium outline-none transition-colors coarse:h-11",
				active ? "bg-surface-3 text-foreground" : "text-muted-foreground hover:text-foreground",
			)}
		>
			{children}
		</button>
	);
}

// ───────────────────────── header + actions ─────────────────────────

function Header({ task }: { task: Task }) {
	const [cancelOpen, setCancelOpen] = useState(false);
	const [handOffOpen, setHandOffOpen] = useState(false);
	const retry = useRetryTask(task.id);
	const own = ownParty(task);
	const offeredHere = task.direction === "incoming" && task.status === "offered";
	const canCancel = !isTerminal(task.status) && !offeredHere;
	const canRetry = task.direction === "outgoing" && (task.status === "failed" || task.status === "rejected" || task.status === "cancelled");
	// Executor side only: the machine running the task can hand it over while it is in flight.
	const canHandOff = task.direction === "incoming" && (task.status === "running" || task.status === "blocked");

	return (
		<Card>
			<CardContent className="flex flex-col gap-3.5">
				<div className="flex flex-wrap items-center gap-1.5">
					<TaskStatusPill status={task.status} />
					<DirectionChip direction={task.direction} />
					<Badge variant="outline" title={t("Ownership epoch (fencing token)")}>
						{t("epoch {epoch}", { epoch: task.epoch })}
					</Badge>
					<Badge variant="outline">{task.deliverAs === "branch" ? t("delivers a branch") : task.deliverAs === "files" ? t("delivers files") : t("delivers a summary")}</Badge>
					{task.direction === "outgoing" ? <DeliveryMark state={task.delivery.state} /> : null}
				</div>
				<h2 className="text-lg font-semibold leading-snug tracking-tight">{task.title}</h2>
				<div className="flex flex-col gap-1.5 text-[13px] sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3">
					<span className="flex min-w-0 items-center gap-2">
						<span className="w-8 shrink-0 text-2xs uppercase tracking-wider text-subtle sm:hidden">{t("from")}</span>
						<PartyChip party={task.sender} role="sender" mine={task.direction === "outgoing"} />
					</span>
					<ArrowRight className="hidden size-3.5 shrink-0 text-subtle sm:block" aria-label={t("delegated to")} />
					<span className="flex min-w-0 items-center gap-2">
						<span className="w-8 shrink-0 text-2xs uppercase tracking-wider text-subtle sm:hidden">{t("to")}</span>
						<PartyChip party={task.executor} mine={task.direction === "incoming"} />
					</span>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					{own.sessionId ? (
						<Button asChild size="sm" variant="outline">
							<Link to="/sessions/$sessionId" params={{ sessionId: own.sessionId }}>
								<SquareTerminal /> {task.direction === "incoming" ? t("Open the executing session") : t("Open the delegating session")}
							</Link>
						</Button>
					) : null}
					{canRetry ? (
						<Button size="sm" variant="primary" loading={retry.isPending} onClick={() => retry.mutate()}>
							<RotateCw /> {t("Retry")}
						</Button>
					) : null}
					{canCancel ? (
						<Button size="sm" variant="outline" className="text-danger" onClick={() => setCancelOpen(true)}>
							<XCircle /> {t("Cancel task")}
						</Button>
					) : null}
					{canHandOff ? (
						<Button size="sm" variant="outline" onClick={() => setHandOffOpen(true)}>
							<Waypoints /> {t("Hand off…")}
						</Button>
					) : null}
				</div>
			</CardContent>
			{cancelOpen ? <CancelDialog task={task} onClose={() => setCancelOpen(false)} /> : null}
			{handOffOpen ? (
				<Suspense fallback={null}>
					<HandOffDialog task={task} onClose={() => setHandOffOpen(false)} />
				</Suspense>
			) : null}
		</Card>
	);
}

function CancelDialog({ task, onClose }: { task: Task; onClose: () => void }) {
	const cancel = useCancelTask(task.id);
	const [reason, setReason] = useState("");
	return (
		<Dialog open onOpenChange={(o) => !o && !cancel.isPending && onClose()}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{t("Cancel “{title}”?", { title: task.title })}</DialogTitle>
					<DialogDescription>
						{task.direction === "outgoing"
							? t("{name} stops the run. Work already committed on a task branch is kept there.", { name: task.executor.nodeName })
							: t("The run on this machine is stopped. Work already done stays in the project; nothing is deleted.")}
					</DialogDescription>
				</DialogHeader>
				<Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={2000} aria-label={t("Reason (optional)")} placeholder={t("Reason (optional)")} className="resize-none" />
				<DialogFooter>
					<Button variant="ghost" onClick={onClose} disabled={cancel.isPending}>
						{t("Keep running")}
					</Button>
					<Button variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate(reason.trim() || undefined, { onSuccess: onClose })}>
						{t("Cancel task")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function Notices({ task }: { task: Task }) {
	const items: ReactNode[] = [];
	if (task.direction === "outgoing" && task.delivery.state === "pending") {
		items.push(
			<Notice key="pending" tone="warning" icon={TriangleAlert}>
				<T
					text="<b>Not delivered yet.</b> {name} has not received this task. It stays queued on this machine and is sent when the machine is reachable{attempt}."
					params={{
						name: task.executor.nodeName,
						attempt: task.delivery.attempts > 0 ? ` (${task.delivery.lastError ? t("attempt {attempts}: {error}", { attempts: task.delivery.attempts, error: renderServerText(task.delivery.lastError, task.delivery.lastErrorI18n) }) : t("attempt {attempts}", { attempts: task.delivery.attempts })})` : "",
					}}
					tags={{ b: <strong /> }}
				/>
			</Notice>,
		);
	}
	if (task.direction === "outgoing" && task.delivery.state === "failed") {
		items.push(
			<Notice key="failed-delivery" tone="danger" icon={TriangleAlert}>
				<strong>{t("Delivery failed.")}</strong> {task.delivery.lastError ? renderServerText(task.delivery.lastError, task.delivery.lastErrorI18n) : t("The machine did not accept the task.")}
			</Notice>,
		);
	}
	if (task.reason && (task.status === "blocked" || task.status === "failed" || task.status === "rejected" || task.status === "cancelled")) {
		const label = tr(STATUS_META[task.status].label);
		items.push(
			<Notice key="reason" tone={task.status === "blocked" ? "warning" : task.status === "cancelled" ? "neutral" : "danger"} icon={task.status === "blocked" ? OctagonAlert : TriangleAlert}>
				<strong>{label}.</strong> {renderServerText(task.reason, task.reasonI18n)}
			</Notice>,
		);
	}
	if (task.status === "offered" && task.direction === "outgoing") {
		items.push(
			<Notice key="offered" tone="neutral" icon={ListChecks}>
				{t("Waiting for {name} to accept. You can still discuss the task below once it is delivered.", { name: task.executor.nodeName })}
			</Notice>,
		);
	}
	return items.length > 0 ? <div className="flex flex-col gap-2.5">{items}</div> : null;
}

const DELIVER_DESCRIPTION = {
	branch: msg("A task branch pushed to GitHub (patch attached if the push is refused)"),
	files: msg("The changed files, returned as a bundle to preview and apply"),
	summary: msg("A written summary only"),
} as const;

// ───────────────────────── details ─────────────────────────

function MetaCard({ task }: { task: Task }) {
	const projects = useProjects();
	const project = projects.data?.find((p) => p.id === task.projectId);
	const slug = task.repo ? repoSlug(task.repo.url) : null;
	const c = task.constraints;
	const approvalLabel = c.approvalMode ? APPROVAL_MODES.find((m) => m.value === c.approvalMode)?.label : undefined;
	const approval = approvalLabel ? tr(approvalLabel) : undefined;
	const duration = task.startedAt ? Date.parse(task.finishedAt ?? new Date().toISOString()) - Date.parse(task.startedAt) : null;
	return (
		<Card>
			<CardHeader>
				<CardTitle>{t("Details")}</CardTitle>
			</CardHeader>
			<CardContent className="pt-1">
				<dl className="divide-y">
					<KeyValue label={t("Project (this machine)")}>
						{project ? (
							<Link to="/projects/$projectId" params={{ projectId: project.id }} className="text-accent hover:underline">
								{project.name}
							</Link>
						) : (
							<span className="text-subtle">{task.projectId ? t("Unknown project") : t("Not chosen yet")}</span>
						)}
					</KeyValue>
					{task.repo ? (
						<>
							<KeyValue label={t("Repository")}>
								<a href={task.repo.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-accent hover:underline">
									{slug ?? task.repo.url} <ExternalLink className="size-3" aria-hidden />
								</a>
							</KeyValue>
							<KeyValue label={t("Base branch")} mono>
								{task.repo.branch ?? <span className="font-sans text-subtle">{t("repository default")}</span>}
								{task.repo.commit ? <span className="ml-2 text-subtle">@ {task.repo.commit.slice(0, 8)}</span> : null}
							</KeyValue>
						</>
					) : (
						<KeyValue label={t("Repository")}>
							<span className="text-subtle">{t("No repository — folder task")}</span>
						</KeyValue>
					)}
					{task.inputFiles ? (
						<KeyValue label={t("Input files")}>
							{t("{count, plural, one {# file} other {# files}} · {size}", { count: task.inputFiles.fileCount, size: formatBytes(task.inputFiles.size) })}
						</KeyValue>
					) : null}
					<KeyValue label={t("Deliver as")}>{tr(DELIVER_DESCRIPTION[task.deliverAs])}</KeyValue>
					<KeyValue label={t("Constraints")}>
						{c.maxCostUsd === undefined && !approval && !c.deadline ? (
							<span className="text-subtle">{t("None")}</span>
						) : (
							<span className="flex flex-wrap gap-1.5">
								{c.maxCostUsd !== undefined ? <Badge variant="outline">{t("max {cost}", { cost: formatCost(c.maxCostUsd) })}</Badge> : null}
								{approval ? <Badge variant="outline">{t("approval: {mode}", { mode: approval })}</Badge> : null}
								{c.deadline ? <Badge variant="outline">{t("due {when}", { when: relativeTime(c.deadline) })}</Badge> : null}
							</span>
						)}
					</KeyValue>
					<KeyValue label={t("Cost so far")} mono>
						{formatCost(task.cost)}
					</KeyValue>
					<KeyValue label={t("Created")}>{`${relativeTime(task.createdAt)} · ${formatDateTime(task.createdAt)}`}</KeyValue>
					{task.startedAt ? <KeyValue label={t("Started")}>{formatDateTime(task.startedAt)}</KeyValue> : null}
					{task.finishedAt ? <KeyValue label={t("Finished")}>{duration !== null ? t("{when} · took {duration}", { when: formatDateTime(task.finishedAt), duration: formatDuration(duration) }) : formatDateTime(task.finishedAt)}</KeyValue> : null}
					<KeyValue label={t("Task ID")} mono>
						{task.id}
					</KeyValue>
					{task.retryOf ? (
						<KeyValue label={t("Retry of")}>
							<Link to="/tasks/$taskId" params={{ taskId: task.retryOf }} className="font-mono text-xs text-accent hover:underline">
								{task.retryOf}
							</Link>
						</KeyValue>
					) : null}
				</dl>
			</CardContent>
		</Card>
	);
}
