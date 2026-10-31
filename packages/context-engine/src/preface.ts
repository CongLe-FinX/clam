import type { ContextType } from "@clam/contracts";

/** What an agent's first prompt of a session in a project that has contexts starts with (docs/security.md: local text only). */
export const PREFACE_MAX_CHARS = 2000;
export const PREFACE_END = "[end of project memory]";
const HEADER = "[CL Agent Mesh] project memory";

export interface PrefaceItem {
	type: ContextType;
	title: string;
	body: string;
	updatedAt: string;
}

/** Memory first (it is what a project's people pinned as lasting facts), then decisions, plans, summaries, notes; newest first within a type. */
const TYPE_ORDER: Readonly<Record<ContextType, number>> = { memory: 0, decision: 1, plan: 2, summary: 3, note: 4 };

const flat = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The first meaningful line of a markdown body: no heading marks, list bullets or front-matter dashes. */
export function firstLine(body: string, max = 140): string {
	for (const raw of body.split("\n")) {
		const line = flat(raw.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*)/, ""));
		if (line === "" || /^[-=_*]{3,}$/.test(line)) continue;
		return line.length > max ? `${line.slice(0, max - 1)}…` : line;
	}
	return "";
}

/**
 * The compact "Project memory" section: titles and first lines, at most `maxChars` characters, ordered `TYPE_ORDER` then newest first.
 * Null when there is nothing to say. The caller prepends it to the first prompt of a session
 * (`${preface}\n\n${prompt}`); a UI can fold everything up to and including the `PREFACE_END` line.
 */
export function buildPreface(project: string, items: readonly PrefaceItem[], maxChars = PREFACE_MAX_CHARS): string | null {
	if (items.length === 0) return null;
	const sorted = [...items].sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
	const head = `${HEADER} · "${flat(project).replace(/"/g, "'")}" · ${items.length} ${items.length === 1 ? "item" : "items"}`;
	const guide = "Notes this project's people and agents kept. Search or read any of them in full with the mesh_memory tool; save a durable fact or decision with mesh_remember (it stays private to this node until a person shares it).";
	const tail = (hidden: number): string => `${hidden > 0 ? `(+${hidden} more: use mesh_memory to search them)\n` : ""}${PREFACE_END}`;
	const lines: string[] = [];
	let used = head.length + guide.length + tail(items.length).length + 6;
	let shown = 0;
	for (const item of sorted) {
		const first = firstLine(item.body);
		const text = `- [${item.type}] ${flat(item.title)}${first && first !== flat(item.title) ? ` — ${first}` : ""}`;
		const line = text.length > 260 ? `${text.slice(0, 259)}…` : text;
		if (used + line.length + 1 > maxChars && shown > 0) break;
		if (used + line.length + 1 > maxChars) {
			// Even one item does not fit: shorten it rather than say nothing.
			lines.push(line.slice(0, Math.max(40, maxChars - used - 2)) + "…");
			shown++;
			break;
		}
		lines.push(line);
		used += line.length + 1;
		shown++;
	}
	return `${head}\n${guide}\n${lines.join("\n")}\n${tail(items.length - shown)}`;
}

/** The first prompt with the preface in front of it. */
export const withPreface = (preface: string, message: string): string => `${preface}\n\n${message}`;
