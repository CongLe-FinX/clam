import type { GitBranch, GitCommit } from "@clam/contracts";

/** Fields separated by US (0x1f), records by NUL (`git log -z`). */
export const LOG_FORMAT = "%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%P%x1f%D%x1f%s%x1f%(trailers:unfold,only)%x1f%b";

export function isoOf(value: string): string {
	const t = new Date(value);
	return Number.isNaN(t.getTime()) ? new Date(0).toISOString() : t.toISOString();
}

export function parseTrailers(block: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of block.split("\n")) {
		const m = /^([A-Za-z][A-Za-z0-9-]*)\s*:\s*(.*)$/.exec(line.trim());
		if (m) out[m[1] as string] = m[2] as string;
	}
	return out;
}

function parseRefs(decoration: string): string[] {
	if (!decoration) return [];
	const refs: string[] = [];
	for (const part of decoration.split(", ")) {
		const arrow = part.indexOf(" -> ");
		if (arrow >= 0) refs.push(part.slice(0, arrow), part.slice(arrow + 4));
		else refs.push(part);
	}
	return refs;
}

export function parseLog(raw: string): GitCommit[] {
	const commits: GitCommit[] = [];
	for (const record of raw.split("\0")) {
		if (!record.trim()) continue;
		const f = record.replace(/^\n+/, "").split("\x1f");
		if (f.length < 10) continue;
		commits.push({
			sha: f[0] as string,
			shortSha: f[1] as string,
			authorName: f[2] as string,
			authorEmail: f[3] as string,
			authoredAt: isoOf(f[4] as string),
			parents: (f[5] as string).split(" ").filter(Boolean),
			refs: parseRefs(f[6] as string),
			subject: f[7] as string,
			trailers: parseTrailers(f[8] as string),
			body: (f.slice(9).join("\x1f")).trim(),
		});
	}
	return commits;
}

export const BRANCH_FORMAT = ["%(HEAD)", "%(refname)", "%(symref)", "%(upstream)", "%(upstream:short)", "%(upstream:track)", "%(objectname)", "%(contents:subject)", "%(committerdate:iso-strict)"].join("%00");

export function parseBranches(raw: string): GitBranch[] {
	const out: GitBranch[] = [];
	for (const line of raw.split("\n")) {
		if (!line) continue;
		const f = line.split("\0");
		const [head, refname, symref, upstreamFull, upstreamShort, track, sha, subject, date] = f;
		if (!refname || symref) continue; // skips refs/remotes/<r>/HEAD
		const remote = refname.startsWith("refs/remotes/");
		const local = refname.startsWith("refs/heads/");
		if (!remote && !local) continue;
		const name = refname.slice(remote ? "refs/remotes/".length : "refs/heads/".length);
		let ahead: number | null = null;
		let behind: number | null = null;
		if (local && upstreamFull && track !== "[gone]") {
			ahead = Number(/ahead (\d+)/.exec(track ?? "")?.[1] ?? 0);
			behind = Number(/behind (\d+)/.exec(track ?? "")?.[1] ?? 0);
		}
		out.push({
			name,
			remote,
			current: head === "*",
			upstream: local && upstreamFull ? (upstreamShort ?? null) : null,
			ahead,
			behind,
			headSha: sha ?? "",
			subject: subject ?? "",
			committedAt: isoOf(date ?? ""),
		});
	}
	return out;
}
