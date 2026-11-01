import { type I18nText, renderI18n } from "@clam/contracts";
import { expect } from "vitest";

/**
 * Drift guard for server-generated text: whatever carries an `i18n` twin must render to exactly its English text
 * (`text`/`summary`/`message`), and a generated line must carry one. `generated` = false lets a caller check only consistency.
 */
export function expectI18nMatches(item: { i18n?: I18nText | undefined }, english: string, label = english): void {
	expect(item.i18n, `no i18n key for: ${label}`).toBeDefined();
	expect(renderI18n(item.i18n!.key, item.i18n!.params), `i18n key drifted from its English text: ${label}`).toBe(english);
}

/** Every `system` line of a group log has an `i18n` twin that renders to its text. */
export function expectSystemLinesLocalised(messages: readonly { kind: string; text: string; i18n?: I18nText | undefined }[]): number {
	const lines = messages.filter((m) => m.kind === "system");
	for (const m of lines) expectI18nMatches(m, m.text);
	return lines.length;
}

/** Every event of a task/handoff timeline that carries an `i18n` twin renders to its summary; `requireAll` also demands one. */
export function expectEventsLocalised(events: readonly { summary: string; i18n?: I18nText | undefined }[], requireAll = true): void {
	for (const e of events) {
		if (e.i18n) expectI18nMatches(e, e.summary);
		else if (requireAll) expectI18nMatches(e, e.summary);
	}
}

/** A task whose `reason` is our own text carries a twin that renders to it; a user's or a peer's reason has none (`reasonI18n` absent). */
export function expectReasonLocalised(task: { reason: string | null; reasonI18n?: I18nText | undefined }): void {
	if (task.reason !== null && task.reasonI18n) expectI18nMatches({ i18n: task.reasonI18n }, task.reason, `task reason: ${task.reason}`);
}

/** Activity entries with a twin: `subject: <twin>` (task entries) or the twin alone render to `summary`. */
export function expectActivityLocalised(items: readonly { summary: string; subject?: string | undefined; i18n?: I18nText | undefined }[]): number {
	let twinned = 0;
	for (const item of items) {
		if (!item.i18n) continue;
		twinned += 1;
		const text = renderI18n(item.i18n.key, item.i18n.params);
		expect(item.subject === undefined ? text : `${item.subject}: ${text}`, `activity twin drifted: ${item.summary}`).toBe(item.summary);
	}
	return twinned;
}

/** Every step detail with a twin renders to its text. */
export function expectStepsLocalised(steps: readonly { detail: string | null; i18n?: I18nText | undefined }[]): number {
	let twinned = 0;
	for (const s of steps) {
		if (!s.i18n || s.detail === null) continue;
		twinned += 1;
		expectI18nMatches(s, s.detail);
	}
	return twinned;
}

/** A shared-session transfer record: its message, and its error message, render from their twins. */
export function expectTransferLocalised(transfer: { message: string; i18n?: I18nText | undefined; error: { message: string; i18n?: I18nText | undefined } | null }): void {
	expectI18nMatches(transfer, transfer.message);
	if (transfer.error?.i18n) expectI18nMatches(transfer.error, transfer.error.message);
}
