import type { AskQuestion } from "@clam/contracts";
import { ArrowLeft, ArrowRight, Check, ChevronDown, CornerDownLeft, MessageCircleQuestion, PencilLine, Send, X } from "lucide-react";
import { memo, type RefObject, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { LazyMarkdown } from "@/components/lazy-markdown";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Tip } from "@/ui/tooltip";
import {
	type AskDraft,
	type QuestionDraft,
	canAdvance,
	describeAnswer,
	initialDraft,
	isAnswered,
	pickOption,
	setCustom,
	toAnswers,
	toggleOther,
} from "./ask-model.ts";
import { CountdownBar, CountdownPill, useRemaining } from "./countdown.tsx";
import type { OmpStore, PendingRequest } from "./omp-store.ts";

function isTyping(t: EventTarget | null): boolean {
	return t instanceof HTMLElement && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
}

/** Short chip label of a question: the agent's `header`, else a numbered fallback. */
export const questionLabel = (q: AskQuestion, index: number): string => q.header ?? `Question ${index + 1}`;

// ───────────────────────────── option card ─────────────────────────────

const OptionCard = memo(function OptionCard({
	label,
	description,
	hint,
	selected,
	multi,
	recommended,
	onPick,
	onPreview,
}: {
	label: string;
	description?: string;
	hint: string;
	selected: boolean;
	multi: boolean;
	recommended: boolean;
	onPick: () => void;
	onPreview: () => void;
}) {
	return (
		<button
			type="button"
			role={multi ? "checkbox" : "radio"}
			aria-checked={selected}
			onClick={onPick}
			onMouseEnter={onPreview}
			onFocus={onPreview}
			className={cn(
				"group/opt relative flex min-h-12 w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left outline-none transition-[background-color,box-shadow,transform] duration-150 ease-out active:scale-[0.99] focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:min-h-14",
				selected ? "bg-accent-soft shadow-[inset_0_0_0_1.5px_var(--accent)]" : "bg-surface-2 shadow-[inset_0_0_0_1px_var(--border)] hover:bg-surface-3 hover:shadow-[inset_0_0_0_1px_var(--border-strong)]",
			)}
		>
			<span
				aria-hidden
				className={cn(
					"mt-0.5 grid size-5 shrink-0 place-items-center border transition-colors duration-150",
					multi ? "rounded-md" : "rounded-full",
					selected ? "border-accent bg-accent text-accent-foreground" : "border-border-strong bg-background text-transparent group-hover/opt:border-subtle",
				)}
			>
				{selected ? <Check className="animate-pop-in size-3" strokeWidth={3} /> : null}
			</span>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="flex min-w-0 items-center gap-2">
					<span className="min-w-0 break-words text-[13.5px] font-medium leading-snug">{label}</span>
					{recommended ? <span className="shrink-0 rounded bg-accent-soft px-1.5 py-0.5 text-2xs font-medium text-accent">Recommended</span> : null}
				</span>
				{description ? <span className="break-words text-xs leading-snug text-muted-foreground">{description}</span> : null}
			</span>
			<kbd aria-hidden className="mt-0.5 hidden h-5 min-w-5 shrink-0 place-items-center rounded bg-background px-1 font-mono text-2xs text-subtle shadow-[inset_0_0_0_1px_var(--border)] fine:grid">
				{hint}
			</kbd>
		</button>
	);
});

// ───────────────────────────── one question ─────────────────────────────

function QuestionStep({
	question,
	draft,
	onChange,
	onEnter,
	customRef,
}: {
	question: AskQuestion;
	draft: QuestionDraft;
	onChange: (d: QuestionDraft) => void;
	/** Enter inside the free-text field. */
	onEnter: () => void;
	customRef: RefObject<HTMLTextAreaElement | null>;
}) {
	const multi = question.multi === true;
	const firstPreview = question.options.findIndex((o) => o.preview);
	const [previewIndex, setPreviewIndex] = useState<number | null>(null);
	// Preview follows what was hovered/focused, then the picked option, then the first one that has a preview.
	const pickedWithPreview = question.options.findIndex((o) => o.preview && draft.selected.includes(o.label));
	const shown = previewIndex !== null && question.options[previewIndex]?.preview ? previewIndex : pickedWithPreview >= 0 ? pickedWithPreview : firstPreview;
	const preview = shown >= 0 ? question.options[shown] : undefined;
	const groupId = useId();
	return (
		<div className={cn("grid gap-3", preview && "md:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] md:gap-4")}>
			<div role={multi ? "group" : "radiogroup"} aria-labelledby={`${groupId}-q`} className="flex min-w-0 flex-col gap-2">
				<p id={`${groupId}-q`} className="text-[15px] font-medium leading-snug">
					{question.question}
					{multi ? <span className="ml-2 align-middle text-2xs font-normal text-subtle">Select all that apply</span> : null}
				</p>
				<div className="flex flex-col gap-1.5">
					{question.options.map((option, i) => (
						<OptionCard
							key={option.label}
							label={option.label}
							description={option.description}
							hint={i < 9 ? String(i + 1) : ""}
							selected={draft.selected.includes(option.label)}
							multi={multi}
							recommended={question.recommended === i}
							onPick={() => onChange(pickOption(question, draft, option.label))}
							onPreview={() => setPreviewIndex(i)}
						/>
					))}
					<div
						className={cn(
							"flex flex-col gap-2 rounded-xl px-3 py-2.5 transition-[background-color,box-shadow] duration-150",
							draft.otherOn ? "bg-accent-soft shadow-[inset_0_0_0_1.5px_var(--accent)]" : "bg-surface-2 shadow-[inset_0_0_0_1px_var(--border)] hover:bg-surface-3",
						)}
					>
						<button
							type="button"
							role={multi ? "checkbox" : "radio"}
							aria-checked={draft.otherOn}
							onClick={() => {
								onChange(toggleOther(question, draft));
								requestAnimationFrame(() => customRef.current?.focus());
							}}
							className="group/opt flex min-h-8 w-full items-center gap-3 rounded-lg text-left outline-none focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:min-h-11"
						>
							<span
								aria-hidden
								className={cn(
									"grid size-5 shrink-0 place-items-center border transition-colors duration-150",
									multi ? "rounded-md" : "rounded-full",
									draft.otherOn ? "border-accent bg-accent text-accent-foreground" : "border-border-strong bg-background text-transparent group-hover/opt:border-subtle",
								)}
							>
								{draft.otherOn ? <Check className="animate-pop-in size-3" strokeWidth={3} /> : <PencilLine className="size-3 text-subtle" />}
							</span>
							<span className="flex-1 text-[13.5px] font-medium">Other</span>
							<kbd aria-hidden className="hidden h-5 min-w-5 shrink-0 place-items-center rounded bg-background px-1 font-mono text-2xs text-subtle shadow-[inset_0_0_0_1px_var(--border)] fine:grid">
								o
							</kbd>
						</button>
						{draft.otherOn ? (
							<textarea
								ref={customRef}
								value={draft.custom}
								onChange={(e) => onChange(setCustom(draft, e.target.value))}
								onKeyDown={(e) => {
									if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
										e.preventDefault();
										onEnter();
									}
								}}
								rows={2}
								placeholder="Type your own answer"
								aria-label={`Your own answer to: ${question.question}`}
								className="animate-fade-in w-full resize-none rounded-lg bg-background px-2.5 py-2 text-[13.5px] leading-snug shadow-[inset_0_0_0_1px_var(--border-strong)] outline-none placeholder:text-subtle focus-visible:shadow-[inset_0_0_0_1.5px_var(--accent)]"
							/>
						) : null}
					</div>
				</div>
			</div>
			{preview?.preview ? (
				<div className="flex min-h-0 min-w-0 flex-col gap-1.5">
					<span className="text-2xs font-medium uppercase tracking-wider text-subtle">Preview · {preview.label}</span>
					<div key={shown} className="animate-fade-in scrollbar-thin max-h-56 min-h-16 overflow-auto rounded-xl bg-surface-2 p-3 text-[13px] shadow-[inset_0_0_0_1px_var(--border)] md:max-h-72">
						<LazyMarkdown text={preview.preview} />
					</div>
				</div>
			) : null}
		</div>
	);
}

// ───────────────────────────── summary ─────────────────────────────

function Summary({ questions, draft, onEdit }: { questions: readonly AskQuestion[]; draft: AskDraft; onEdit: (i: number) => void }) {
	return (
		<div className="flex flex-col gap-2.5">
			<p className="text-[15px] font-medium leading-snug">Review your answers</p>
			<ul className="flex flex-col gap-1.5">
				{questions.map((q, i) => {
					const d = draft.answers[i] as QuestionDraft;
					const chosen = describeAnswer(d);
					return (
						<li key={q.id} className="flex items-start gap-3 rounded-xl bg-surface-2 px-3 py-2.5 shadow-[inset_0_0_0_1px_var(--border)]">
							<div className="flex min-w-0 flex-1 flex-col gap-1">
								<span className="text-2xs font-medium uppercase tracking-wider text-subtle">{questionLabel(q, i)}</span>
								<span className="break-words text-xs text-muted-foreground">{q.question}</span>
								{chosen.length > 0 ? (
									<span className="mt-0.5 flex flex-wrap gap-1.5">
										{chosen.map((c) => (
											<span key={c} className="max-w-full break-words rounded-md bg-accent-soft px-2 py-0.5 text-[13px] font-medium text-accent">
												{c}
											</span>
										))}
									</span>
								) : (
									<span className="text-[13px] italic text-subtle">No selection</span>
								)}
							</div>
							<Tip label="Change this answer">
								<Button variant="ghost" size="icon-sm" aria-label={`Change answer to ${questionLabel(q, i)}`} onClick={() => onEdit(i)}>
									<PencilLine />
								</Button>
							</Tip>
						</li>
					);
				})}
			</ul>
		</div>
	);
}

// ───────────────────────────── the card ─────────────────────────────

/**
 * One step per question, then a summary with Submit. Keys (while no text field has focus): 1–9 pick, `o` Other, Enter next/submit.
 * Questions with a single answer skip the summary: its last step sends.
 */
export function AskCard({ store, request, onCollapse, className }: { store: OmpStore; request: PendingRequest; onCollapse?: () => void; className?: string }) {
	const questions = request.questions ?? [];
	const [draft, setDraft] = useState<AskDraft>(() => initialDraft(questions));
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const customRef = useRef<HTMLTextAreaElement | null>(null);
	const cardRef = useRef<HTMLElement | null>(null);
	// The composer usually has focus when a question arrives (the person just sent a message): take it, so 1-9 and Enter
	// reach the card. A draft that is being typed is never taken away.
	useEffect(() => {
		const active = document.activeElement;
		if (!active || active === document.body || (active instanceof HTMLTextAreaElement && active.value === "")) cardRef.current?.focus({ preventScroll: true });
	}, []);
	const remaining = useRemaining(request);
	const single = questions.length === 1;
	const summaryStep = questions.length;
	const lastQuestion = questions.length - 1;
	const onSummary = draft.step === summaryStep && !single;
	const question = questions[Math.min(draft.step, lastQuestion)];
	const current = draft.answers[Math.min(draft.step, lastQuestion)];
	const sendLabel = "Send answers";

	const update = useCallback((i: number, d: QuestionDraft) => setDraft((prev) => ({ ...prev, answers: prev.answers.map((a, j) => (j === i ? d : a)) })), []);

	const submit = useCallback(async () => {
		setSending(true);
		setError(null);
		try {
			await store.answerAsk(request.requestId, toAnswers(questions, draft));
		} catch (e) {
			setError(errorMessage(e));
			setSending(false);
		}
	}, [store, request.requestId, questions, draft]);

	const decline = useCallback(async () => {
		setSending(true);
		setError(null);
		try {
			await store.respond(request.requestId, null);
		} catch (e) {
			setError(errorMessage(e));
			setSending(false);
		}
	}, [store, request.requestId]);

	const next = useCallback(() => {
		if (sending || !question || !current) return;
		if (onSummary) {
			void submit();
			return;
		}
		if (!canAdvance(question, current)) return;
		if (single) void submit();
		else setDraft((prev) => ({ ...prev, step: prev.step + 1 }));
	}, [sending, question, current, onSummary, single, submit]);

	const back = useCallback(() => setDraft((prev) => ({ ...prev, step: Math.max(0, prev.step - 1) })), []);

	// Keyboard: digits pick, `o` Other, Enter goes on. Ignored while typing elsewhere (composer, the Other field).
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
			if (isTyping(e.target)) return;
			if (e.key === "Enter") {
				// A focused button handles Enter itself.
				if (e.target instanceof HTMLElement && e.target.tagName === "BUTTON") return;
				e.preventDefault();
				next();
				return;
			}
			if (onSummary || !question || !current) return;
			if (/^[1-9]$/.test(e.key)) {
				const option = question.options[Number(e.key) - 1];
				if (!option) return;
				e.preventDefault();
				update(Math.min(draft.step, lastQuestion), pickOption(question, current, option.label));
			} else if (e.key === "o" || e.key === "O") {
				e.preventDefault();
				update(Math.min(draft.step, lastQuestion), toggleOther(question, current));
				requestAnimationFrame(() => customRef.current?.focus());
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [next, onSummary, question, current, draft.step, lastQuestion, update]);

	const stepIndex = Math.min(draft.step, questions.length);
	const segments = single ? 1 : questions.length + 1;
	const answeredCount = useMemo(() => draft.answers.filter((a) => isAnswered(a)).length, [draft.answers]);

	if (!question || !current) return null;
	const header = onSummary ? "Review" : questionLabel(question, draft.step);

	return (
		<section ref={cardRef} tabIndex={-1} aria-label="Question from the agent" className={cn("flex min-h-0 flex-col overflow-hidden rounded-2xl bg-overlay shadow-pop outline-none", className)}>
			{remaining !== null && request.timeoutMs !== undefined ? <CountdownBar remaining={remaining} total={request.timeoutMs} /> : null}
			<div className="flex shrink-0 items-center gap-2 px-3.5 pt-3 pb-1.5">
				<span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
					<MessageCircleQuestion className="size-3.5" />
				</span>
				<span className="min-w-0 truncate rounded-md bg-surface-3 px-2 py-0.5 text-2xs font-medium text-muted-foreground">{header}</span>
				{!single ? (
					<div role="progressbar" aria-label="Progress" aria-valuemin={1} aria-valuemax={segments} aria-valuenow={stepIndex + 1} className="flex flex-1 items-center gap-1 px-1">
						{Array.from({ length: segments }, (_, i) => (
							<span key={i} className={cn("h-1 min-w-3 flex-1 rounded-full transition-colors duration-200", i < stepIndex ? "bg-accent" : i === stepIndex ? "bg-accent/55" : "bg-surface-3")} />
						))}
					</div>
				) : (
					<span className="flex-1" />
				)}
				{remaining !== null ? <CountdownPill remaining={remaining} /> : null}
				<Tip label="Cancel — this stops the agent's current turn">
					<Button variant="ghost" size="icon-sm" aria-label="Cancel question and stop the agent's turn" disabled={sending} onClick={() => void decline()}>
						<X />
					</Button>
				</Tip>
				{onCollapse ? (
					<Tip label="Minimise">
						<Button variant="ghost" size="icon-sm" aria-label="Minimise question" onClick={onCollapse}>
							<ChevronDown />
						</Button>
					</Tip>
				) : null}
			</div>

			<div aria-live="polite" className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-contain px-3.5 pt-1.5 pb-3">
				<div key={onSummary ? "summary" : draft.step} className="animate-fade-in">
					{onSummary ? (
						<Summary questions={questions} draft={draft} onEdit={(i) => setDraft((prev) => ({ ...prev, step: i }))} />
					) : (
						<QuestionStep question={question} draft={current} onChange={(d) => update(draft.step, d)} onEnter={next} customRef={customRef} />
					)}
				</div>
				{error ? (
					<p role="alert" className="mt-3 rounded-lg bg-danger/8 px-3 py-2 text-xs text-danger">
						{error}
					</p>
				) : null}
			</div>

			<div className="flex shrink-0 items-center gap-2 border-t bg-surface-1 px-3.5 py-2.5">
				{!single && draft.step > 0 ? (
					<Button variant="ghost" onClick={back} disabled={sending}>
						<ArrowLeft /> Back
					</Button>
				) : (
					<span className="hidden text-2xs text-subtle fine:inline">
						<kbd className="rounded bg-surface-3 px-1 font-mono">1</kbd>–<kbd className="rounded bg-surface-3 px-1 font-mono">{Math.min(9, question.options.length || 1)}</kbd> pick · <kbd className="rounded bg-surface-3 px-1 font-mono">o</kbd> other
					</span>
				)}
				<span className="flex-1" />
				{!single && !onSummary ? <span className="tabular text-2xs text-subtle">{answeredCount}/{questions.length} answered</span> : null}
				{onSummary || single ? (
					<Button variant="primary" loading={sending} disabled={single && !canAdvance(question, current)} onClick={next}>
						<Send /> {sendLabel}
						<CornerDownLeft className="opacity-60" />
					</Button>
				) : (
					<Button variant="primary" disabled={!canAdvance(question, current)} onClick={next}>
						{draft.step === lastQuestion ? "Review" : "Next"} <ArrowRight />
					</Button>
				)}
			</div>
		</section>
	);
}
