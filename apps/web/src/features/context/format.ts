import type { Context, ContextType } from "@clam/contracts";
import { BookMarked, ClipboardList, FileText, Gavel, Lightbulb, type LucideIcon } from "lucide-react";
import { msg, t, type Msg } from "@/i18n";
import { formatList } from "@/lib/utils";

export const CONTEXT_TYPES: ReadonlyArray<{ id: ContextType; label: Msg; plural: Msg; icon: LucideIcon; hint: Msg }> = [
	{ id: "memory", label: msg("Memory"), plural: msg("Memories"), icon: Lightbulb, hint: msg("A durable fact agents and teammates should remember (conventions, gotchas, how things work).") },
	{ id: "plan", label: msg("Plan"), plural: msg("Plans"), icon: ClipboardList, hint: msg("What we intend to do, step by step.") },
	{ id: "decision", label: msg("Decision"), plural: msg("Decisions"), icon: Gavel, hint: msg("A choice that was made and why.") },
	{ id: "summary", label: msg("Summary"), plural: msg("Summaries"), icon: FileText, hint: msg("A condensed recap of work or a discussion.") },
	{ id: "note", label: msg("Note"), plural: msg("Notes"), icon: BookMarked, hint: msg("Anything else worth keeping.") },
];
export const contextTypeInfo = (t: ContextType) => CONTEXT_TYPES.find((x) => x.id === t) ?? CONTEXT_TYPES[4]!;

export type SyncBadge = { label: string; variant: "neutral" | "accent" | "success" | "warning" | "danger" | "outline"; detail: string };

/** One-line sync summary for a context; `nodeNames` maps node ids → display names. */
export function syncBadge(c: Pick<Context, "shareable" | "sync">, nodeNames: Map<string, string>): SyncBadge {
	const s = c.sync;
	switch (s.state) {
		case "private":
			return { label: t("Private"), variant: "neutral", detail: t("Stays on this machine. It is never sent to other machines or written to Git.") };
		case "pending":
			return { label: t("Syncing"), variant: "accent", detail: t("Waiting to be delivered to the other workspace members (queued while they are offline).") };
		case "synced": {
			const names = s.syncedTo.map((id) => nodeNames.get(id) ?? id.slice(0, 8));
			return { label: names.length ? t("Synced · {count}", { count: names.length }) : t("Synced"), variant: "success", detail: names.length ? t("Current version is on: {names}.", { names: formatList(names) }) : t("No other member holds this yet.") };
		}
		case "conflict":
			return { label: t("Conflict"), variant: "danger", detail: t("{name} edited the same version. Nothing was merged — choose what to keep.", { name: s.conflict?.nodeName ?? t("Another machine") }) };
	}
}

/** Highlight markers from `contextSearch` snippets: «hit». Returns alternating plain / hit segments. */
export function splitSnippet(snippet: string): Array<{ text: string; hit: boolean }> {
	const out: Array<{ text: string; hit: boolean }> = [];
	let i = 0;
	while (i < snippet.length) {
		const open = snippet.indexOf("«", i);
		if (open < 0) {
			out.push({ text: snippet.slice(i), hit: false });
			break;
		}
		if (open > i) out.push({ text: snippet.slice(i, open), hit: false });
		const close = snippet.indexOf("»", open + 1);
		if (close < 0) {
			out.push({ text: snippet.slice(open + 1), hit: true });
			break;
		}
		out.push({ text: snippet.slice(open + 1, close), hit: true });
		i = close + 1;
	}
	return out;
}
