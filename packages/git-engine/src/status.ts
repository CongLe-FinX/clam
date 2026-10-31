import type { GitFileStatus } from "@clam/contracts";

export type FileKind = GitFileStatus["kind"];

export interface ParsedStatus {
	branch: string | null;
	headSha: string | null;
	detached: boolean;
	upstream: string | null;
	ahead: number;
	behind: number;
	files: GitFileStatus[];
}

const LETTER_KIND: Record<string, FileKind> = {
	M: "modified",
	A: "added",
	D: "deleted",
	R: "renamed",
	C: "copied",
	T: "typechange",
};

function kindOf(x: string, y: string): FileKind {
	if (y === "D") return "deleted";
	const letter = x !== "." ? x : y;
	return LETTER_KIND[letter] ?? "modified";
}

/** Parses `git status --porcelain=v2 --branch -z` output. Paths are verbatim (no C-quoting with -z). */
export function parseStatusV2(raw: string): ParsedStatus {
	const out: ParsedStatus = { branch: null, headSha: null, detached: false, upstream: null, ahead: 0, behind: 0, files: [] };
	const parts = raw.split("\0");
	for (let i = 0; i < parts.length; i++) {
		const rec = parts[i];
		if (!rec) continue;
		const tag = rec[0];
		if (tag === "#") {
			const m = /^# (\S+) ?(.*)$/.exec(rec);
			if (!m) continue;
			const value = m[2] ?? "";
			switch (m[1]) {
				case "branch.oid":
					out.headSha = value === "(initial)" ? null : value;
					break;
				case "branch.head":
					if (value === "(detached)") out.detached = true;
					else out.branch = value;
					break;
				case "branch.upstream":
					out.upstream = value;
					break;
				case "branch.ab": {
					const ab = /^\+(\d+) -(\d+)$/.exec(value);
					if (ab) {
						out.ahead = Number(ab[1]);
						out.behind = Number(ab[2]);
					}
					break;
				}
			}
		} else if (tag === "1") {
			// 1 XY sub mH mI mW hH hI path
			const f = splitFields(rec, 7);
			const xy = f[0] ?? "..";
			const path = f[7];
			if (path === undefined) continue;
			out.files.push({ path, origPath: null, kind: kindOf(xy[0] ?? ".", xy[1] ?? "."), staged: xy[0] !== ".", unstaged: xy[1] !== "." });
		} else if (tag === "2") {
			// 2 XY sub mH mI mW hH hI Xscore path \0 origPath
			const f = splitFields(rec, 8);
			const xy = f[0] ?? "..";
			const path = f[8];
			const origPath = parts[++i];
			if (path === undefined) continue;
			out.files.push({
				path,
				origPath: origPath ?? null,
				kind: kindOf(xy[0] ?? ".", xy[1] ?? "."),
				staged: xy[0] !== ".",
				unstaged: xy[1] !== ".",
			});
		} else if (tag === "u") {
			// u XY sub m1 m2 m3 mW h1 h2 h3 path
			const f = splitFields(rec, 9);
			const path = f[9];
			if (path === undefined) continue;
			out.files.push({ path, origPath: null, kind: "conflicted", staged: false, unstaged: true });
		} else if (tag === "?") {
			out.files.push({ path: rec.slice(2), origPath: null, kind: "untracked", staged: false, unstaged: true });
		}
		// "!" (ignored) records are not requested.
	}
	return out;
}

/** Splits `rec` (after its leading type char) into `n` space-separated fields plus the remainder (the path). */
function splitFields(rec: string, n: number): string[] {
	const fields: string[] = [];
	let pos = 2; // skip "<tag> "
	for (let k = 0; k < n; k++) {
		const sp = rec.indexOf(" ", pos);
		if (sp < 0) return fields;
		fields.push(rec.slice(pos, sp));
		pos = sp + 1;
	}
	fields.push(rec.slice(pos));
	return fields;
}
