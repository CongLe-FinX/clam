import type { Context, ContextType } from "@clam/contracts";
import { BookMarked, ClipboardList, FileText, Gavel, Lightbulb, type LucideIcon } from "lucide-react";

export const CONTEXT_TYPES: ReadonlyArray<{ id: ContextType; label: string; plural: string; icon: LucideIcon; hint: string }> = [
	{ id: "memory", label: "Memory", plural: "Memories", icon: Lightbulb, hint: "A durable fact agents and teammates should remember (conventions, gotchas, how things work)." },
	{ id: "plan", label: "Plan", plural: "Plans", icon: ClipboardList, hint: "What we intend to do, step by step." },
	{ id: "decision", label: "Decision", plural: "Decisions", icon: Gavel, hint: "A choice that was made and why." },
	{ id: "summary", label: "Summary", plural: "Summaries", icon: FileText, hint: "A condensed recap of work or a discussion." },
	{ id: "note", label: "Note", plural: "Notes", icon: BookMarked, hint: "Anything else worth keeping." },
];
export const contextTypeInfo = (t: ContextType) => CONTEXT_TYPES.find((x) => x.id === t) ?? CONTEXT_TYPES[4]!;

export type SyncBadge = { label: string; variant: "neutral" | "accent" | "success" | "warning" | "danger" | "outline"; detail: string };

/** One-line sync summary for a context; `nodeNames` maps node ids → display names. */
export function syncBadge(c: Pick<Context, "shareable" | "sync">, nodeNames: Map<string, string>): SyncBadge {
	const s = c.sync;
	switch (s.state) {
		case "private":
			return { label: "Private", variant: "neutral", detail: "Stays on this machine. It is never sent to other machines or written to Git." };
		case "pending":
			return { label: "Syncing", variant: "accent", detail: "Waiting to be delivered to the other workspace members (queued while they are offline)." };
		case "synced": {
			const names = s.syncedTo.map((id) => nodeNames.get(id) ?? id.slice(0, 8));
			return { label: names.length ? `Synced · ${names.length}` : "Synced", variant: "success", detail: names.length ? `Current version is on: ${names.join(", ")}.` : "No other member holds this yet." };
		}
		case "conflict":
			return { label: "Conflict", variant: "danger", detail: `${s.conflict?.nodeName ?? "Another machine"} edited the same version. Nothing was merged — choose what to keep.` };
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
