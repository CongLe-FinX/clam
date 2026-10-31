import type { AskAnswer, AskQuestion } from "@clam/contracts";

/** What the person has picked for one question so far. */
export interface QuestionDraft {
	/** Exact option labels, in the order they were picked. */
	selected: string[];
	/** Free text of the "Other" choice (kept while "Other" is switched off so toggling does not lose it). */
	custom: string;
	/** "Other" is chosen. */
	otherOn: boolean;
}

export interface AskDraft {
	/** 0..n-1 = a question; n = the summary. */
	step: number;
	answers: QuestionDraft[];
}

/** Single-select questions start on the agent's recommended option, so Enter, Enter accepts its suggestions. */
export function initialDraft(questions: readonly AskQuestion[]): AskDraft {
	return {
		step: 0,
		answers: questions.map((q) => {
			const suggested = !q.multi && q.recommended !== undefined ? q.options[q.recommended] : undefined;
			return { selected: suggested ? [suggested.label] : [], custom: "", otherOn: false };
		}),
	};
}

export function pickOption(q: AskQuestion, d: QuestionDraft, label: string): QuestionDraft {
	if (q.multi) {
		const selected = d.selected.includes(label) ? d.selected.filter((l) => l !== label) : [...d.selected, label];
		return { ...d, selected };
	}
	return { ...d, selected: [label], otherOn: false };
}

export function toggleOther(q: AskQuestion, d: QuestionDraft): QuestionDraft {
	if (q.multi) return { ...d, otherOn: !d.otherOn };
	return d.otherOn ? { ...d, otherOn: false } : { ...d, otherOn: true, selected: [] };
}

export function setCustom(d: QuestionDraft, custom: string): QuestionDraft {
	return { ...d, custom };
}

const trimmedCustom = (d: QuestionDraft): string => (d.otherOn ? d.custom.trim() : "");

/** The question has an answer the agent can use (a multi-select may also be left empty on purpose). */
export function isAnswered(d: QuestionDraft): boolean {
	return d.selected.length > 0 || trimmedCustom(d) !== "";
}

/** Chosen labels followed by the free text, for the summary and the answered card. */
export function describeAnswer(d: QuestionDraft): string[] {
	const custom = trimmedCustom(d);
	return custom ? [...d.selected, custom] : d.selected;
}

/** The wire answer of one question: exact labels plus trimmed free text, a single-select never both. */
export function toAnswer(q: AskQuestion, d: QuestionDraft): AskAnswer {
	const customInput = trimmedCustom(d);
	if (!q.multi && customInput) return { id: q.id, selectedOptions: [], customInput };
	return { id: q.id, selectedOptions: d.selected, ...(customInput ? { customInput } : {}) };
}

export function toAnswers(questions: readonly AskQuestion[], draft: AskDraft): AskAnswer[] {
	return questions.map((q, i) => toAnswer(q, draft.answers[i] as QuestionDraft));
}

/** A single-select needs an answer to go on; a multi-select may be empty. */
export function canAdvance(q: AskQuestion, d: QuestionDraft): boolean {
	return q.multi === true || isAnswered(d);
}

/** What an answer looks like in the answered card: the labels and free text OMP received. */
export function describeWireAnswer(a: AskAnswer): string[] {
	return a.customInput ? [...a.selectedOptions, a.customInput] : a.selectedOptions;
}
