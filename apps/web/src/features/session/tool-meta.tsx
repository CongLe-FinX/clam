import { Bot, Braces, FileText, Globe, ListChecks, type LucideIcon, Network, Pencil, Search, Terminal, Wrench } from "lucide-react";

const rules: Array<[RegExp, LucideIcon]> = [
	[/^mesh_/, Network],
	[/^(bash|shell|exec|run|terminal|python|eval)/i, Terminal],
	[/^(read|cat|open|view)/i, FileText],
	[/^(edit|write|patch|apply|replace|create|ast_edit|notebook)/i, Pencil],
	[/^(grep|find|glob|search|ls|list|lsp|symbols)/i, Search],
	[/(web|fetch|browser|http|url)/i, Globe],
	[/(todo|plan|task_list)/i, ListChecks],
	[/^(task|agent|subagent|delegate)/i, Bot],
	[/^(ast|code|lsp|debug)/i, Braces],
];

export function toolIcon(name: string): LucideIcon {
	for (const [re, icon] of rules) if (re.test(name)) return icon;
	return Wrench;
}

const SUMMARY_KEYS = ["command", "cmd", "path", "file_path", "filePath", "file", "paths", "pattern", "query", "url", "description", "prompt", "name", "title", "id"];

const cache = new WeakMap<object, string>();

function clip(s: string, n = 140): string {
	const one = s.replace(/\s+/g, " ").trim();
	return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** One-line summary of a tool call's arguments (command, path, pattern…). Cached per args object. */
export function summarizeArgs(args: unknown): string {
	if (typeof args === "string") return clip(args);
	if (!args || typeof args !== "object") return "";
	const hit = cache.get(args);
	if (hit !== undefined) return hit;
	const rec = args as Record<string, unknown>;
	let out = "";
	for (const k of SUMMARY_KEYS) {
		const v = rec[k];
		if (typeof v === "string" && v) {
			out = clip(v);
			break;
		}
		if (Array.isArray(v) && v.length && v.every((x) => typeof x === "string")) {
			out = clip(v.join(", "));
			break;
		}
	}
	if (!out) {
		for (const v of Object.values(rec)) {
			if (typeof v === "string" && v) {
				out = clip(v);
				break;
			}
		}
	}
	cache.set(args, out);
	return out;
}

export function prettyJson(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? "";
	} catch {
		return String(value);
	}
}
