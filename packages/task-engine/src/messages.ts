import { type I18nMessage, i18nMsg } from "@clam/contracts";

export const AGENT_MESSAGE_LIMIT = 12;

export type MessageKind = "instruction" | "question" | "answer" | "note";

export interface BudgetMessage {
	id: string;
	authorKind: "human" | "agent" | "system";
	authorNodeId: string;
	createdAt: string;
}

export function orderMessages<T extends { createdAt: string; id: string }>(m: readonly T[]): T[] {
	return [...m].sort((a, b) =>
		a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
	);
}

/** Agent messages by `selfNodeId` after the latest human message (either node); a human stepping in replenishes. */
export function agentMessageBudget(
	messages: readonly BudgetMessage[],
	selfNodeId: string,
	limit: number = AGENT_MESSAGE_LIMIT,
): { limit: number; used: number; remaining: number } {
	const ordered = orderMessages(messages);
	let used = 0;
	for (const m of ordered) {
		if (m.authorKind === "human") used = 0;
		else if (m.authorKind === "agent" && m.authorNodeId === selfNodeId) used++;
	}
	return { limit, used, remaining: Math.max(0, limit - used) };
}

export function canSendKind(
	role: "sender" | "executor",
	author: "human" | "agent",
	kind: MessageKind,
): { ok: true } | { ok: false; message: I18nMessage } {
	if (kind === "instruction" && role !== "sender") {
		return { ok: false, message: i18nMsg("only the task's sender may send an instruction; use question, answer or note") };
	}
	return { ok: true };
}

export function hasPendingQuestion(
	messages: readonly { id: string; kind: MessageKind; authorNodeId: string; createdAt: string }[],
	askerNodeId: string,
): boolean {
	const ordered = orderMessages(messages);
	let lastQ = -1;
	for (let i = 0; i < ordered.length; i++) {
		const m = ordered[i]!;
		if (m.kind === "question" && m.authorNodeId === askerNodeId) lastQ = i;
	}
	if (lastQ < 0) return false;
	return !ordered.slice(lastQ + 1).some((m) => m.authorNodeId !== askerNodeId);
}
