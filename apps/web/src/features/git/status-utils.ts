import type { GitFileKind, GitFileStatus } from "@clam/contracts";
import { msg, type Msg } from "@/i18n";

export type ChangeGroup = "staged" | "changes" | "untracked" | "conflicted";

export const GROUP_LABEL: Record<ChangeGroup, Msg> = {
	conflicted: msg("Conflicted"),
	staged: msg("Staged"),
	changes: msg("Changes"),
	untracked: msg("Untracked"),
};
export const GROUP_ORDER: ChangeGroup[] = ["conflicted", "staged", "changes", "untracked"];

export function groupFiles(files: readonly GitFileStatus[]): Record<ChangeGroup, GitFileStatus[]> {
	const out: Record<ChangeGroup, GitFileStatus[]> = { staged: [], changes: [], untracked: [], conflicted: [] };
	for (const f of files) {
		if (f.kind === "conflicted") out.conflicted.push(f);
		else if (f.kind === "untracked") out.untracked.push(f);
		else {
			if (f.staged) out.staged.push(f);
			if (f.unstaged) out.changes.push(f);
		}
	}
	for (const g of GROUP_ORDER) out[g].sort((a, b) => a.path.localeCompare(b.path));
	return out;
}

export const KIND_LETTER: Record<GitFileKind, string> = {
	modified: "M",
	added: "A",
	deleted: "D",
	renamed: "R",
	copied: "C",
	typechange: "T",
	untracked: "U",
	conflicted: "!",
};
export const KIND_LABEL: Record<GitFileKind, Msg> = {
	modified: msg("Modified"),
	added: msg("Added"),
	deleted: msg("Deleted"),
	renamed: msg("Renamed"),
	copied: msg("Copied"),
	typechange: msg("Type changed"),
	untracked: msg("Untracked"),
	conflicted: msg("Conflicted"),
};
export const KIND_TONE: Record<GitFileKind, string> = {
	modified: "text-warning",
	added: "text-success",
	deleted: "text-danger",
	renamed: "text-info",
	copied: "text-info",
	typechange: "text-warning",
	untracked: "text-success",
	conflicted: "text-danger",
};

export function splitPath(path: string): { dir: string; name: string } {
	const i = path.lastIndexOf("/");
	return i < 0 ? { dir: "", name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
}

export function normalizeRemoteBranch(name: string, remote = "origin"): string {
	return name.startsWith(`${remote}/`) ? name.slice(remote.length + 1) : name;
}

/** Only the parts of a trailer set worth a badge. */
export function agentTrailer(trailers: Record<string, string>): string | null {
	const key = Object.keys(trailers).find((k) => k.toLowerCase() === "agent");
	return key ? (trailers[key] ?? null) : null;
}
