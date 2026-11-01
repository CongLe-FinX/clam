import type { AskAnswer, AskQuestion, TodoPhase } from "@clam/contracts";
import { Check, ChevronRight, ListChecks, MessageCircleQuestion, Minus, Plus, Play, X } from "lucide-react";
import { type ComponentType, useMemo, useState } from "react";
import { msg, t, tr, type Msg } from "@/i18n";
import { useNode } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import type { SessionStream, ToolRec } from "../stream-store.ts";
import type { ToolBlock } from "../tool-card.tsx";
import { describeWireAnswer } from "./ask-model.ts";
import { questionLabel } from "./ask-card.tsx";
import { answererLabel, type OmpStore, useOmpState, useOptionalOmpStore } from "./omp-store.ts";
import { type ChangeKind, planStats, todoChange } from "./plan-model.ts";
import { PlanBar, PlanList } from "./plan-ui.tsx";
import { TeamCard } from "./team-card.tsx";

export interface OmpToolSurfaceProps {
	stream: SessionStream;
	block: ToolBlock;
	rec: ToolRec | undefined;
	/** The ToolCard's display status. */
	status: "preparing" | "queued" | "running" | "ok" | "error" | "interrupted" | "none";
	args: unknown;
}

// ───────────────────────────── ask ─────────────────────────────

function questionsOf(args: unknown): AskQuestion[] {
	if (!args || typeof args !== "object" || !("questions" in args) || !Array.isArray(args.questions)) return [];
	const out: AskQuestion[] = [];
	for (const q of args.questions) {
		if (!q || typeof q !== "object" || !("question" in q) || typeof q.question !== "string") continue;
		const options = "options" in q && Array.isArray(q.options) ? q.options.flatMap((o: unknown) => (typeof o === "string" ? [{ label: o }] : o && typeof o === "object" && "label" in o && typeof o.label === "string" ? [{ label: o.label }] : [])) : [];
		out.push({
			id: "id" in q && typeof q.id === "string" ? q.id : `q${out.length + 1}`,
			question: q.question,
			header: "header" in q && typeof q.header === "string" ? q.header : undefined,
			options,
			multi: "multi" in q && q.multi === true ? true : undefined,
			recommended: "recommended" in q && typeof q.recommended === "number" ? q.recommended : undefined,
		});
	}
	return out;
}

/** What the agent got back for each question, in question order (`details.results`; `timedOut` marks defaults used on a timeout). */
function answersOf(details: unknown): { list: AskAnswer[]; timedOut: boolean } | null {
	if (!details || typeof details !== "object" || !("results" in details) || !Array.isArray(details.results)) return null;
	const list: AskAnswer[] = [];
	let timedOut = false;
	for (const r of details.results) {
		if (!r || typeof r !== "object") continue;
		const selected = "selectedOptions" in r && Array.isArray(r.selectedOptions) ? r.selectedOptions.filter((s: unknown): s is string => typeof s === "string") : [];
		if ("timedOut" in r && r.timedOut === true) timedOut = true;
		list.push({ id: "id" in r && typeof r.id === "string" ? r.id : "", selectedOptions: selected, ...("customInput" in r && typeof r.customInput === "string" ? { customInput: r.customInput } : {}) });
	}
	return list.length > 0 ? { list, timedOut } : null;
}

function Chips({ values, tone }: { values: string[]; tone: "accent" | "muted" }) {
	return (
		<span className="flex flex-wrap gap-1.5">
			{values.map((v) => (
				<span key={v} className={cn("max-w-full break-words rounded-md px-2 py-0.5 text-[13px]", tone === "accent" ? "bg-accent-soft font-medium text-accent" : "bg-surface-3 text-muted-foreground")}>
					{v}
				</span>
			))}
		</span>
	);
}

/** The agent's `ask` call, anchored in the conversation: the questions, then waiting / answered / timed out / skipped. */
function AskToolCard({ store, rec, status, args }: OmpToolSurfaceProps & { store: OmpStore }) {
	const questions = useMemo(() => questionsOf(args), [args]);
	const { requests, resolved } = useOmpState(store);
	const selfNodeId = useNode().data?.id;
	const answers = useMemo(() => answersOf(rec?.details), [rec?.details]);
	const ids = questions.map((q) => q.id).join("\u0000");
	const pending = status === "running" && requests.some((r) => r.method === "ask");
	// How the matching request ended (an early cancel is also known from the live event).
	const ended = useMemo(() => [...resolved.values()].reverse().find((r) => r.request.method === "ask" && (r.request.questions ?? []).map((q) => q.id).join("\u0000") === ids), [resolved, ids]);
	const cancelled = !answers && (status === "error" || status === "interrupted" || ended?.outcome === "cancelled");
	const state = pending ? "pending" : answers ? (answers.timedOut || ended?.outcome === "timed_out" ? "timed_out" : "answered") : cancelled ? "skipped" : status === "running" || status === "preparing" || status === "queued" ? "pending" : "none";

	return (
		<div data-ask-state={state} className="max-w-3xl overflow-hidden rounded-xl bg-surface-1 shadow-[inset_0_0_0_1px_var(--border)]">
			<div className="flex min-h-11 items-center gap-2.5 px-3 py-2">
				<span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
					<MessageCircleQuestion className="size-3.5" />
				</span>
				<span className="text-[13px] font-semibold">{questions.length > 1 ? t("{count} questions", { count: questions.length }) : t("Question")}</span>
				<span className="flex-1" />
				{state === "pending" ? (
					<>
						<span className="inline-flex items-center gap-1.5 rounded-md bg-warning/14 px-1.5 py-0.5 text-2xs font-medium text-warning">
							<span aria-hidden className="size-1.5 animate-pulse rounded-full bg-warning" /> {t("Waiting for you")}
						</span>
						{pending ? (
							<Button size="sm" variant="primary" onClick={store.focusQuestion}>
								{t("Answer")}
							</Button>
						) : null}
					</>
				) : state === "answered" ? (
					<span className="inline-flex items-center gap-1 rounded-md bg-success/12 px-1.5 py-0.5 text-2xs font-medium text-success">
						<Check className="size-3" aria-hidden /> {ended?.answeredBy ? t("Answered {who}", { who: answererLabel(ended.answeredBy, selfNodeId) }) : t("Answered")}
					</span>
				) : state === "timed_out" ? (
					<span className="inline-flex items-center gap-1 rounded-md bg-warning/14 px-1.5 py-0.5 text-2xs font-medium text-warning">{t("Timed out · used defaults")}</span>
				) : state === "skipped" ? (
					<span className="inline-flex items-center gap-1 rounded-md bg-surface-3 px-1.5 py-0.5 text-2xs font-medium text-muted-foreground">
						<X className="size-3" aria-hidden /> {t("Cancelled")}
					</span>
				) : null}
			</div>
			<ul className="divide-y border-t">
				{questions.map((q, i) => {
					const a = answers?.list[i];
					return (
						<li key={q.id} className="flex flex-col gap-1 px-3 py-2.5">
							<span className="text-2xs font-medium uppercase tracking-wider text-subtle">{questionLabel(q, i)}</span>
							<span className="break-words text-[13px]">{q.question}</span>
							{a ? (
								<Chips values={describeWireAnswer(a)} tone="accent" />
							) : state === "pending" && q.options.length > 0 ? (
								<Chips values={q.options.map((o) => o.label)} tone="muted" />
							) : null}
						</li>
					);
				})}
			</ul>
		</div>
	);
}

// ───────────────────────────── todo ─────────────────────────────

const CHANGE_STYLE: Record<ChangeKind, { Icon: typeof Plus; tone: string; label: Msg }> = {
	added: { Icon: Plus, tone: "bg-accent-soft text-accent", label: msg("Added") },
	started: { Icon: Play, tone: "bg-accent-soft text-accent", label: msg("Started") },
	completed: { Icon: Check, tone: "bg-success/14 text-success", label: msg("Completed") },
	dropped: { Icon: Minus, tone: "bg-surface-3 text-subtle", label: msg("Dropped") },
	blocked: { Icon: Minus, tone: "bg-warning/14 text-warning", label: msg("Blocked") },
	unblocked: { Icon: Play, tone: "bg-accent-soft text-accent", label: msg("Unblocked") },
};

function phasesOf(details: unknown): TodoPhase[] | null {
	if (!details || typeof details !== "object" || !("phases" in details) || !Array.isArray(details.phases)) return null;
	return details.phases as TodoPhase[];
}

/** A `todo` call as what it changed (added / started / completed) with progress, instead of raw JSON. */
function TodoToolCard({ rec, status, args }: OmpToolSurfaceProps) {
	const [open, setOpen] = useState(false);
	const phases = useMemo(() => phasesOf(rec?.details), [rec?.details]);
	const change = useMemo(() => todoChange(args, rec?.details), [args, rec?.details]);
	const stats = planStats(phases ?? []);
	const running = status === "running" || status === "preparing" || status === "queued";
	return (
		<div className="max-w-3xl overflow-hidden rounded-xl bg-surface-1 shadow-[inset_0_0_0_1px_var(--border)]">
			<button type="button" aria-expanded={open} disabled={!phases} onClick={() => setOpen((v) => !v)} className="flex min-h-11 w-full items-center gap-2.5 px-3 py-2 text-left outline-none transition-colors enabled:hover:bg-surface-2 enabled:focus-visible:bg-surface-2">
				<span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
					<ListChecks className="size-3.5" />
				</span>
				<span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{running ? t("Updating the plan…") : change.title}</span>
				{phases ? (
					<>
						<span className="tabular shrink-0 font-mono text-2xs text-muted-foreground">
							{stats.done}/{stats.total}
						</span>
						<ChevronRight className={cn("size-3.5 shrink-0 text-subtle transition-transform duration-150", open && "rotate-90")} aria-hidden />
					</>
				) : null}
			</button>
			{phases && stats.total > 0 ? <PlanBar done={stats.done} total={stats.total} className="h-0.5 rounded-none" /> : null}
			{change.items.length > 0 ? (
				<ul className="flex flex-col gap-1 border-t px-3 py-2">
					{change.items.slice(0, 12).map((item, i) => {
						const { Icon, tone, label } = CHANGE_STYLE[item.kind];
						return (
							// biome-ignore lint/suspicious/noArrayIndexKey: a call can name the same task twice
							<li key={`${i}:${item.content}`} className="flex items-start gap-2 text-[13px] leading-snug">
								<span aria-label={tr(label)} className={cn("mt-px grid size-4 shrink-0 place-items-center rounded-full", tone)}>
									<Icon className="size-2.5" strokeWidth={3} />
								</span>
								<span className={cn("min-w-0 flex-1 break-words", item.kind === "dropped" && "text-subtle line-through", item.kind === "completed" && "text-muted-foreground")}>{item.content}</span>
							</li>
						);
					})}
					{change.items.length > 12 ? <li className="pl-6 text-2xs text-subtle">{t("+{count} more", { count: change.items.length - 12 })}</li> : null}
				</ul>
			) : null}
			{open && phases ? (
				<div className="animate-fade-in border-t p-3">
					<PlanList phases={phases} />
				</div>
			) : null}
		</div>
	);
}

// ───────────────────────────── dispatcher ─────────────────────────────

function AskSurface(props: OmpToolSurfaceProps) {
	const store = useOptionalOmpStore();
	return store ? <AskToolCard {...props} store={store} /> : null;
}

function TaskSurface({ block, status, args }: OmpToolSurfaceProps) {
	const store = useOptionalOmpStore();
	return store ? <TeamCard store={store} toolCallId={block.id} args={args} toolRunning={status === "running" || status === "queued"} /> : null;
}

const SURFACES: Record<string, ComponentType<OmpToolSurfaceProps>> = { ask: AskSurface, task: TaskSurface, todo: TodoToolCard };

/** The dedicated card of an OMP tool call (`task` → team, `ask` → question, `todo` → plan changes); null = use the generic tool card. */
export function ompToolSurface(name: string): ComponentType<OmpToolSurfaceProps> | null {
	return Object.hasOwn(SURFACES, name) ? (SURFACES[name] as ComponentType<OmpToolSurfaceProps>) : null;
}


