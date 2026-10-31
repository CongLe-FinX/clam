import type { DiffFile, DiffHunk, DiffLine } from "@clam/contracts";

export interface DiffCaps {
	/** A file section larger than this keeps its counts but drops its hunks (`tooLarge`). */
	maxFileBytes: number;
	/** Once retained hunks exceed this, remaining files are omitted (`truncated`). */
	maxTotalBytes: number;
}

export const DEFAULT_DIFF_CAPS: DiffCaps = { maxFileBytes: 512 * 1024, maxTotalBytes: 4 * 1024 * 1024 };

const LANGUAGES: Record<string, string> = {
	ts: "typescript",
	tsx: "tsx",
	mts: "typescript",
	cts: "typescript",
	js: "javascript",
	jsx: "jsx",
	mjs: "javascript",
	cjs: "javascript",
	json: "json",
	jsonc: "json",
	md: "markdown",
	mdx: "markdown",
	css: "css",
	scss: "scss",
	less: "less",
	html: "html",
	htm: "html",
	vue: "vue",
	svelte: "svelte",
	py: "python",
	rb: "ruby",
	go: "go",
	rs: "rust",
	java: "java",
	kt: "kotlin",
	swift: "swift",
	c: "c",
	h: "c",
	cc: "cpp",
	cpp: "cpp",
	hpp: "cpp",
	cs: "csharp",
	php: "php",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	ps1: "powershell",
	yml: "yaml",
	yaml: "yaml",
	toml: "toml",
	ini: "ini",
	xml: "xml",
	svg: "xml",
	sql: "sql",
	graphql: "graphql",
	gql: "graphql",
	lua: "lua",
	dart: "dart",
	scala: "scala",
	r: "r",
	tf: "hcl",
	proto: "protobuf",
	txt: "text",
};

const NAMED_LANGUAGES: Record<string, string> = {
	dockerfile: "dockerfile",
	makefile: "makefile",
	gemfile: "ruby",
	rakefile: "ruby",
	".gitignore": "ini",
	".env": "ini",
};

export function languageOf(path: string): string | null {
	const base = path.slice(path.lastIndexOf("/") + 1);
	const named = NAMED_LANGUAGES[base.toLowerCase()];
	if (named) return named;
	const dot = base.lastIndexOf(".");
	if (dot <= 0) return null;
	return LANGUAGES[base.slice(dot + 1).toLowerCase()] ?? null;
}

/** Decodes a git C-quoted path (`"a\tb\303\251"`). Unquoted input is returned unchanged. */
export function unquoteCPath(s: string): string {
	if (!(s.length >= 2 && s.startsWith('"') && s.endsWith('"'))) return s;
	const bytes: number[] = [];
	const body = s.slice(1, -1);
	const enc = new TextEncoder();
	for (let i = 0; i < body.length; i++) {
		const ch = body[i] as string;
		if (ch !== "\\") {
			bytes.push(...enc.encode(ch));
			continue;
		}
		const next = body[++i] ?? "";
		const oct = /^[0-3][0-7]{2}/.exec(body.slice(i, i + 3));
		if (oct) {
			bytes.push(Number.parseInt(oct[0], 8));
			i += 2;
			continue;
		}
		const simple: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, "\\": 92 };
		bytes.push(simple[next] ?? next.charCodeAt(0));
	}
	return new TextDecoder().decode(Uint8Array.from(bytes));
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const COMBINED_HUNK_RE = /^@@@+ ((?:-\d+(?:,\d+)? )+)\+(\d+)(?:,(\d+))? @@@+/;

interface Section {
	lines: string[];
	bytes: number;
}

function splitSections(text: string): Section[] {
	const sections: Section[] = [];
	let cur: Section | null = null;
	let pos = 0;
	while (pos < text.length) {
		let nl = text.indexOf("\n", pos);
		if (nl < 0) nl = text.length;
		const line = text.slice(pos, nl);
		pos = nl + 1;
		if (line.startsWith("diff --git ") || line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) {
			cur = { lines: [], bytes: 0 };
			sections.push(cur);
		}
		if (cur) {
			cur.lines.push(line);
			cur.bytes += line.length + 1;
		}
	}
	return sections;
}

interface Header {
	path: string;
	oldPath: string | null;
	status: DiffFile["status"];
	binary: boolean;
	bodyStart: number;
}

function stripPrefix(p: string, prefix: "a/" | "b/"): string {
	return p.startsWith(prefix) ? p.slice(2) : p;
}

function parseHeader(lines: string[]): Header {
	const first = lines[0] ?? "";
	let status: DiffFile["status"] = "modified";
	let renameFrom: string | null = null;
	let renameTo: string | null = null;
	let copyFrom: string | null = null;
	let copyTo: string | null = null;
	let minus: string | null = null;
	let plus: string | null = null;
	let oldMode: string | null = null;
	let newMode: string | null = null;
	let binary = false;
	let i = 1;
	for (; i < lines.length; i++) {
		const l = lines[i] as string;
		if (l.startsWith("@@")) break;
		if (l.startsWith("new file mode")) status = "added";
		else if (l.startsWith("deleted file mode")) status = "deleted";
		else if (l.startsWith("old mode ")) oldMode = l.slice(9).trim();
		else if (l.startsWith("new mode ")) newMode = l.slice(9).trim();
		else if (l.startsWith("rename from ")) renameFrom = unquoteCPath(l.slice(12));
		else if (l.startsWith("rename to ")) renameTo = unquoteCPath(l.slice(10));
		else if (l.startsWith("copy from ")) copyFrom = unquoteCPath(l.slice(10));
		else if (l.startsWith("copy to ")) copyTo = unquoteCPath(l.slice(8));
		else if (l.startsWith("--- ")) minus = l.slice(4).replace(/\t$/, "");
		else if (l.startsWith("+++ ")) plus = l.slice(4).replace(/\t$/, "");
		else if (l.startsWith("Binary files ") || l.startsWith("GIT binary patch")) binary = true;
	}
	if (renameTo !== null) status = "renamed";
	else if (copyTo !== null) status = "copied";
	else if (status === "modified" && oldMode && newMode && oldMode.slice(0, 3) !== newMode.slice(0, 3)) status = "typechange";

	let path: string | null = renameTo ?? copyTo;
	let oldPath: string | null = renameFrom ?? copyFrom;
	if (path === null) {
		const p = plus !== null && plus !== "/dev/null" ? stripPrefix(unquoteCPath(plus), "b/") : null;
		const m = minus !== null && minus !== "/dev/null" ? stripPrefix(unquoteCPath(minus), "a/") : null;
		path = p ?? m;
	}
	if (path === null) {
		// Binary add/delete/modify has no ---/+++ lines; both sides carry the same path, so the header splits in half.
		const rest = first.replace(/^diff --(?:git|cc|combined) /, "");
		if (first.startsWith("diff --git ") && !rest.startsWith('"')) {
			const len = (rest.length - 4) >> 1;
			path = rest.slice(2, 2 + len);
		} else if (first.startsWith("diff --git ")) {
			const m = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/.exec(rest);
			path = m ? stripPrefix(unquoteCPath(m[2] as string), "b/") : rest;
		} else {
			path = unquoteCPath(rest);
		}
	}
	if (status !== "renamed" && status !== "copied") oldPath = null;
	return { path, oldPath, status, binary, bodyStart: i };
}

function parseHunks(lines: string[], from: number): { hunks: DiffHunk[]; additions: number; deletions: number } {
	const hunks: DiffHunk[] = [];
	let additions = 0;
	let deletions = 0;
	let i = from;
	while (i < lines.length) {
		const header = lines[i] as string;
		const m = HUNK_RE.exec(header);
		const cm = m ? null : COMBINED_HUNK_RE.exec(header);
		if (!m && !cm) {
			i++;
			continue;
		}
		const cols = cm ? header.indexOf(" ") - 1 : 1; // number of prefix columns per line (parents)
		const oldStart = m ? Number(m[1]) : Number(/-(\d+)/.exec(cm?.[1] ?? "")?.[1] ?? 0);
		const oldLines = m ? (m[2] === undefined ? 1 : Number(m[2])) : Number(/-\d+,?(\d*)/.exec(cm?.[1] ?? "")?.[1] || 1);
		const newStart = Number((m ? m[3] : cm?.[2]) ?? 0);
		const newLines = m ? (m[4] === undefined ? 1 : Number(m[4])) : cm?.[3] === undefined ? 1 : Number(cm[3]);
		const hunk: DiffHunk = { header, oldStart, oldLines, newStart, newLines, lines: [] };
		let oldNo = oldStart;
		let newNo = newStart;
		let remOld = oldLines;
		let remNew = newLines;
		i++;
		for (; i < lines.length; i++) {
			const l = lines[i] as string;
			if (l.startsWith("\\")) {
				hunk.lines.push({ type: "meta", content: l, oldNo: null, newNo: null });
				continue;
			}
			if (!cm && remOld <= 0 && remNew <= 0) break;
			const prefix = l.slice(0, cols);
			if (l === "" && i === lines.length - 1) break; // trailing newline artefact
			if (cm) {
				if (!/^[ +-]+$/.test(prefix) || prefix.length < cols) break;
				const type: DiffLine["type"] = prefix.includes("+") ? "add" : prefix.includes("-") ? "del" : "context";
				if (type === "add") {
					hunk.lines.push({ type, content: l.slice(cols), oldNo: null, newNo: newNo++ });
					additions++;
				} else if (type === "del") {
					hunk.lines.push({ type, content: l.slice(cols), oldNo: oldNo++, newNo: null });
					deletions++;
				} else hunk.lines.push({ type, content: l.slice(cols), oldNo: oldNo++, newNo: newNo++ });
				continue;
			}
			const c = l[0];
			if (c === "+") {
				hunk.lines.push({ type: "add", content: l.slice(1), oldNo: null, newNo: newNo++ });
				remNew--;
				additions++;
			} else if (c === "-") {
				hunk.lines.push({ type: "del", content: l.slice(1), oldNo: oldNo++, newNo: null });
				remOld--;
				deletions++;
			} else if (c === " " || l === "") {
				hunk.lines.push({ type: "context", content: l.slice(1), oldNo: oldNo++, newNo: newNo++ });
				remOld--;
				remNew--;
			} else break;
		}
		hunks.push(hunk);
	}
	return { hunks, additions, deletions };
}

function countOnly(lines: string[], from: number): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;
	let inHunk = false;
	for (let i = from; i < lines.length; i++) {
		const l = lines[i] as string;
		if (l.startsWith("@@")) {
			inHunk = true;
			continue;
		}
		if (!inHunk) continue;
		if (l.startsWith("+")) additions++;
		else if (l.startsWith("-")) deletions++;
	}
	return { additions, deletions };
}

export interface ParsedDiff {
	files: DiffFile[];
	truncated: boolean;
}

export function parsePatch(text: string, caps: DiffCaps = DEFAULT_DIFF_CAPS, alreadyTruncated = false): ParsedDiff {
	let sections = splitSections(text);
	let truncated = false;
	if (alreadyTruncated && sections.length > 0) {
		sections = sections.slice(0, -1); // the last section may be cut mid-file
		truncated = true;
	}
	const files: DiffFile[] = [];
	let retained = 0;
	for (const section of sections) {
		const header = parseHeader(section.lines);
		let file: DiffFile;
		if (header.binary) {
			file = { path: header.path, oldPath: header.oldPath, status: header.status, binary: true, additions: 0, deletions: 0, hunks: [], tooLarge: false, language: languageOf(header.path) };
		} else if (section.bytes > caps.maxFileBytes) {
			const counts = countOnly(section.lines, header.bodyStart);
			file = { path: header.path, oldPath: header.oldPath, status: header.status, binary: false, ...counts, hunks: [], tooLarge: true, language: languageOf(header.path) };
		} else {
			const parsed = parseHunks(section.lines, header.bodyStart);
			file = {
				path: header.path,
				oldPath: header.oldPath,
				status: header.status,
				binary: false,
				additions: parsed.additions,
				deletions: parsed.deletions,
				hunks: parsed.hunks,
				tooLarge: false,
				language: languageOf(header.path),
			};
			retained += section.bytes;
		}
		if (retained > caps.maxTotalBytes && files.length > 0) {
			truncated = true;
			break;
		}
		files.push(file);
	}
	return { files, truncated };
}
