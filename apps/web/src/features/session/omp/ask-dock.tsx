import { Bell, ChevronUp, MessageCircleQuestion, ShieldQuestion } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { AskCard } from "./ask-card.tsx";
import { CountdownPill, useRemaining } from "./countdown.tsx";
import { type OmpStore, type PendingRequest, useOmpState } from "./omp-store.ts";
import { enablePendingNotifications } from "./pending-watch.ts";
import { RequestCard } from "./request-card.tsx";

const NO_REQUEST: PendingRequest = { requestId: "", method: "", title: "", receivedAt: 0 };

function notificationState(): NotificationPermission | "unsupported" {
	return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

/**
 * Pending questions and approvals, above the composer. Never a modal: the conversation above stays readable and scrollable,
 * and the card can be minimised to a one-line bar. Nothing is ever answered on the person's behalf.
 */
export function AskDock({ store, group, className }: { store: OmpStore; /** Shared session: who asked (`agent@machine`); the card then says anybody in the group can answer. */ group?: string; className?: string }) {
	const { requests, focusTick } = useOmpState(store);
	const first = requests[0];
	const [collapsed, setCollapsed] = useState(false);
	const [notify, setNotify] = useState(notificationState);
	const ref = useRef<HTMLDivElement>(null);
	const firstId = first?.requestId;
	const remaining = useRemaining(first ?? NO_REQUEST);

	// A new head-of-queue request, or "Answer" on its card in the conversation, expands the dock and brings it into view.
	// biome-ignore lint/correctness/useExhaustiveDependencies: firstId and focusTick are the triggers
	useEffect(() => {
		if (!firstId) return;
		setCollapsed(false);
		ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
	}, [firstId, focusTick]);

	if (!first) return null;
	const approval = first.method !== "ask";
	const Icon = approval ? ShieldQuestion : MessageCircleQuestion;
	const label = first.method === "ask" ? (first.questions && first.questions.length > 1 ? `${first.questions.length} questions for you` : "A question for you") : "Approval needed";

	return (
		<div ref={ref} className={cn("animate-slide-up mx-auto flex w-full max-w-[60rem] shrink-0 flex-col px-3 pt-2 pb-1.5 sm:px-4", className)}>
			{collapsed ? (
				<button
					type="button"
					onClick={() => setCollapsed(false)}
					className="flex min-h-12 w-full items-center gap-2.5 rounded-2xl bg-overlay px-3.5 text-left shadow-pop outline-none transition-transform active:scale-[0.99] focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:min-h-14"
				>
					<span aria-hidden className={cn("grid size-6 shrink-0 place-items-center rounded-lg", approval ? "bg-warning/14 text-warning" : "bg-accent-soft text-accent")}>
						<Icon className="size-3.5" />
					</span>
					<span className="min-w-0 flex-1 truncate text-[13px] font-medium">{label}</span>
					{requests.length > 1 ? <span className="tabular rounded bg-surface-3 px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">+{requests.length - 1}</span> : null}
					{remaining !== null ? <CountdownPill remaining={remaining} /> : null}
					<span className="flex items-center gap-1 text-xs font-medium text-accent">
						Answer <ChevronUp className="size-3.5" aria-hidden />
					</span>
				</button>
			) : null}
			{!collapsed && group ? (
				<p className="mb-1.5 px-1 text-2xs text-subtle">
					<span className="font-medium text-muted-foreground">{group}</span> is waiting · anybody in the group can answer
				</p>
			) : null}
			{collapsed ? null : first.method === "ask" ? (
				<AskCard key={first.requestId} store={store} request={first} onCollapse={() => setCollapsed(true)} className="max-h-[min(72dvh,680px)]" />
			) : (
				<RequestCard key={first.requestId} store={store} request={first} onCollapse={() => setCollapsed(true)} className="max-h-[min(72dvh,560px)]" />
			)}
			{!collapsed && requests.length > 1 ? <p className="mt-1.5 px-1 text-center text-2xs text-subtle">{requests.length - 1} more waiting after this one</p> : null}
			{!collapsed && notify === "default" ? (
				<button
					type="button"
					onClick={() => void enablePendingNotifications().then((p) => setNotify(p))}
					className="mx-auto mt-1.5 inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-2xs text-subtle outline-none transition-colors hover:text-foreground focus-visible:text-foreground coarse:min-h-11"
				>
					<Bell className="size-3" aria-hidden /> Notify me when the agent asks something while I am away
				</button>
			) : null}
		</div>
	);
}
