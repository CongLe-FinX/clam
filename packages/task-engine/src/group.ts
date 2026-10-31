import { type MentionCandidate, parseMentions } from "@clam/contracts";
import { formatAuthor, type InjectionAuthor } from "./injection.ts";

/**
 * Pure rules of the group chat of a shared session (docs/shared-sessions.md, "Group chat"): the hybrid logical clock that
 * orders the replicated log, the total order itself, @mention parsing, addressing, the wake budget (loop guard) and the
 * "Since your last turn in the group" block. The server decides when to use them.
 */

export const GROUP_MESSAGE_KINDS = ["chat", "reply", "system", "instruction", "question", "answer", "note"] as const;
export type GroupMessageKind = (typeof GROUP_MESSAGE_KINDS)[number];

export interface MessageTarget {
	nodeId: string;
	agentId: string;
}

/** `lead` = the agent that drives (edits code) at the moment the receiving node looks at it. */
export interface MessageTo {
	mode: "all" | "lead" | "agents";
	agents: MessageTarget[];
}

// ------------------------------------------------------------------ hybrid logical clock

/** Physical milliseconds plus a counter that breaks ties and keeps the clock monotonic when the wall clock stalls or steps back. */
export interface Hlc {
	wall: number;
	counter: number;
}

const WALL_DIGITS = 15;
const COUNTER_DIGITS = 5;
const COUNTER_MAX = 10 ** COUNTER_DIGITS - 1;
const HLC_PATTERN = new RegExp(`^(\\d{${WALL_DIGITS}})-(\\d{${COUNTER_DIGITS}})$`);
/** Fixed width, so plain string comparison is the clock order: 15 digits of milliseconds, a dash, 5 digits of counter (`001793427266195-00000`). */
export function formatHlc(hlc: Hlc): string {
	return `${String(hlc.wall).padStart(WALL_DIGITS, "0")}-${String(hlc.counter).padStart(COUNTER_DIGITS, "0")}`;
}

export function parseHlc(text: string): Hlc | null {
	const match = HLC_PATTERN.exec(text);
	return match ? { wall: Number(match[1]), counter: Number(match[2]) } : null;
}

function settle(wall: number, counter: number): Hlc {
	return counter > COUNTER_MAX ? { wall: wall + 1, counter: 0 } : { wall, counter };
}

/** A local event (a message accepted on this node): strictly greater than `last` and never behind the wall clock. */
export function tickHlc(last: Hlc | null, nowMs: number): Hlc {
	if (!last || nowMs > last.wall) return { wall: nowMs, counter: 0 };
	return settle(last.wall, last.counter + 1);
}

/** A message from another node arrived: the result is greater than both `last` and `remote`. */
export function mergeHlc(last: Hlc | null, remote: Hlc, nowMs: number): Hlc {
	const mine = last ?? { wall: 0, counter: 0 };
	const wall = Math.max(nowMs, mine.wall, remote.wall);
	if (wall === mine.wall && wall === remote.wall) return settle(wall, Math.max(mine.counter, remote.counter) + 1);
	if (wall === mine.wall) return settle(wall, mine.counter + 1);
	if (wall === remote.wall) return settle(wall, remote.counter + 1);
	return { wall, counter: 0 };
}

// ------------------------------------------------------------------ order

/** Origin = the node that accepted the message = its author node (`SharedMessage.originNodeId`). */
export interface OrderedMessage {
	hlc: string;
	authorNodeId: string;
	id: string;
}

/** The log order, identical on every node: `(hlc, origin node, id)`. */
export function compareGroupMessages(a: OrderedMessage, b: OrderedMessage): number {
	if (a.hlc !== b.hlc) return a.hlc < b.hlc ? -1 : 1;
	if (a.authorNodeId !== b.authorNodeId) return a.authorNodeId < b.authorNodeId ? -1 : 1;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function orderGroupMessages<T extends OrderedMessage>(messages: readonly T[]): T[] {
	return [...messages].sort(compareGroupMessages);
}

// ------------------------------------------------------------------ mentions
function sameTo(to: MessageTo): MessageTo {
	return { mode: to.mode, agents: to.mode === "agents" ? to.agents.map((a) => ({ nodeId: a.nodeId, agentId: a.agentId })) : [] };
}

/**
 * Who a message is for. An explicit `to` wins. Otherwise the mentions decide: `@all` → everybody, named agents → exactly
 * those, nothing → a human's message goes to the lead, an agent's message to NOBODY (everyone sees it, nobody is woken). An
 * agent never addresses itself.
 */
export function resolveRecipients(i: { author: "human" | "agent"; authorNodeId: string; text: string; candidates: readonly MentionCandidate[]; explicit?: MessageTo | undefined }): MessageTo {
	const strip = (to: MessageTo): MessageTo => (i.author === "agent" && to.mode === "agents" ? { mode: "agents", agents: to.agents.filter((a) => a.nodeId !== i.authorNodeId) } : sameTo(to));
	if (i.explicit) return strip(i.explicit);
	const mentions = parseMentions(i.text, i.candidates);
	if (mentions.all) return { mode: "all", agents: [] };
	if (mentions.agents.length > 0) return strip({ mode: "agents", agents: mentions.agents });
	return i.author === "human" ? { mode: "lead", agents: [] } : { mode: "agents", agents: [] };
}

/** Whether the agent of `local` (this node) is addressed. One agent per node: matched by node. The author's own agent is never woken by its own message (callers check that). */
export function isAddressed(to: MessageTo, local: { nodeId: string; isLead: boolean }): boolean {
	if (to.mode === "all") return true;
	if (to.mode === "lead") return local.isLead;
	return to.agents.some((a) => a.nodeId === local.nodeId);
}

/**
 * The agent a human's unmentioned message goes to when the lead cannot be reached (so it does not reach nobody): the agent of
 * the node the message was posted on, else the first reachable member agent by node name. The lead's own node is never chosen
 * and the chosen agent is NOT made lead (it may answer, plan and review; code edits wait for a hand-over or takeover). Null when
 * no member agent can be woken.
 */
export function pickFallbackAgent(candidates: readonly MentionCandidate[], i: { postedOnNodeId: string; leadNodeId: string; hasLocalAgent: boolean; isReachable: (nodeId: string) => boolean }): (MentionCandidate & { agentId: string }) | null {
	const usable = candidates.filter((c): c is MentionCandidate & { agentId: string } => c.agentId !== null && c.nodeId !== i.leadNodeId);
	const here = usable.find((c) => c.nodeId === i.postedOnNodeId);
	if (here && i.hasLocalAgent) return here;
	return usable.filter((c) => c.nodeId !== i.postedOnNodeId && i.isReachable(c.nodeId)).sort((a, b) => a.nodeName.localeCompare(b.nodeName))[0] ?? null;
}

/** An agent message that can wake another agent: it counts against the loop budget. */
export function wakesAgents(to: MessageTo): boolean {
	return to.mode === "all" || (to.mode === "agents" && to.agents.length > 0);
}

export interface WakeBudgetMessage extends OrderedMessage {
	authorKind: "human" | "agent" | "system";
	to: MessageTo;
}

/** Waking agent messages by `selfNodeId` after the latest human message (any node, in log order); a human writing replenishes. */
export function wakeBudget(messages: readonly WakeBudgetMessage[], selfNodeId: string, limit: number): { limit: number; used: number; remaining: number } {
	let used = 0;
	for (const m of orderGroupMessages(messages)) {
		if (m.authorKind === "human") used = 0;
		else if (m.authorKind === "agent" && m.authorNodeId === selfNodeId && wakesAgents(m.to)) used++;
	}
	return { limit, used, remaining: Math.max(0, limit - used) };
}

// ------------------------------------------------------------------ the unaddressed buffer

export interface BufferedMessage {
	author: InjectionAuthor;
	kind: GroupMessageKind;
	text: string;
}

export const BUFFER_MAX_CHARS = 8000;
const BUFFER_ITEM_CHARS = 2000;

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

/**
 * The block an agent gets in front of its next addressed turn: what the group said that was not for it, oldest first. The
 * most recent messages are kept within `maxChars`; the count of the older ones that were dropped is stated. Null = nothing.
 */
export function buildSinceLastTurnBlock(messages: readonly BufferedMessage[], maxChars: number = BUFFER_MAX_CHARS): string | null {
	if (messages.length === 0) return null;
	const entries = messages.map((m) => `- ${formatAuthor(m.author)} (${m.kind}): ${clip(m.text.trim(), BUFFER_ITEM_CHARS).replace(/\n/g, "\n  ")}`);
	const kept: string[] = [];
	let size = 0;
	for (const entry of entries.toReversed()) {
		if (kept.length > 0 && size + entry.length + 1 > maxChars) break;
		kept.unshift(kept.length === 0 ? clip(entry, maxChars) : entry);
		size += entry.length + 1;
	}
	const omitted = entries.length - kept.length;
	return ["Since your last turn in the group:", ...(omitted > 0 ? [`(${omitted} earlier message${omitted === 1 ? "" : "s"} omitted)`] : []), ...kept].join("\n");
}
