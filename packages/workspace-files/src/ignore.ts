/** Minimal gitignore engine: nested files, negation, anchoring, `**`, character classes, dir-only rules. */

interface Rule {
	/** Folder (relative to the scan root, no trailing slash, "" = root) the rule is relative to. */
	base: string;
	regex: RegExp;
	negate: boolean;
	dirOnly: boolean;
}

function globToRegexSource(glob: string): string {
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i] as string;
		if (c === "\\") {
			i++;
			if (i < glob.length) out += escapeRegex(glob[i] as string);
		} else if (c === "*") {
			if (glob[i + 1] === "*") {
				// `**`: leading `**/`, trailing `/**`, or inner `/**/`.
				const before = i === 0 || glob[i - 1] === "/";
				let j = i + 2;
				if (before && glob[j] === "/") {
					out += "(?:.*/)?";
					i = j; // skip the slash too
				} else if (before && j === glob.length) {
					out += ".*";
					i = j - 1;
				} else {
					out += "[^/]*";
					i = j - 1;
				}
			} else {
				out += "[^/]*";
			}
		} else if (c === "?") {
			out += "[^/]";
		} else if (c === "[") {
			const end = findClassEnd(glob, i);
			if (end === -1) {
				out += "\\[";
			} else {
				let body = glob.slice(i + 1, end);
				let negate = false;
				if (body.startsWith("!") || body.startsWith("^")) {
					negate = true;
					body = body.slice(1);
				}
				body = body.replace(/\\/g, "\\\\").replace(/\]/g, "\\]").replace(/\^/g, "\\^");
				out += `[${negate ? "^/" : ""}${body}]`;
				i = end;
			}
		} else {
			out += escapeRegex(c);
		}
	}
	return out;
}

function findClassEnd(glob: string, start: number): number {
	let i = start + 1;
	if (glob[i] === "!" || glob[i] === "^") i++;
	if (glob[i] === "]") i++; // a leading `]` is literal
	for (; i < glob.length; i++) {
		if (glob[i] === "\\") i++;
		else if (glob[i] === "]") return i;
	}
	return -1;
}

function escapeRegex(c: string): string {
	return /[\\^$.*+?()[\]{}|/]/.test(c) ? `\\${c}` : c;
}

export function parseIgnoreLines(lines: Iterable<string>, base = ""): Rule[] {
	const rules: Rule[] = [];
	for (const raw of lines) {
		let line = raw.replace(/\r$/, "");
		if (line === "" || line.startsWith("#")) continue;
		// Trailing spaces are ignored unless escaped with a backslash.
		line = line.replace(/(?<!\\)\s+$/, "");
		if (line === "") continue;
		let negate = false;
		if (line.startsWith("!")) {
			negate = true;
			line = line.slice(1);
		} else if (line.startsWith("\\!") || line.startsWith("\\#")) {
			line = line.slice(1);
		}
		let dirOnly = false;
		if (line.endsWith("/")) {
			dirOnly = true;
			line = line.replace(/\/+$/, "");
		}
		if (line === "") continue;
		const anchored = line.includes("/");
		if (line.startsWith("/")) line = line.replace(/^\/+/, "");
		if (line === "") continue;
		let source = globToRegexSource(line);
		source = `^${anchored ? "" : "(?:.*/)?"}${source}$`;
		let regex: RegExp;
		try {
			regex = new RegExp(source, "u");
		} catch {
			continue;
		}
		rules.push({ base, regex, negate, dirOnly });
	}
	return rules;
}

export class IgnoreMatcher {
	private readonly rules: Rule[] = [];

	add(rules: Rule[]): void {
		this.rules.push(...rules);
	}

	/** Snapshot with extra rules (used while descending into a folder with its own .gitignore). */
	fork(extra: Rule[]): IgnoreMatcher {
		const next = new IgnoreMatcher();
		next.rules.push(...this.rules, ...extra);
		return next;
	}

	/** Last matching rule wins (gitignore semantics). */
	ignores(relPath: string, isDir: boolean): boolean {
		let ignored = false;
		for (const rule of this.rules) {
			if (rule.dirOnly && !isDir) continue;
			let sub: string;
			if (rule.base === "") sub = relPath;
			else if (relPath.startsWith(`${rule.base}/`)) sub = relPath.slice(rule.base.length + 1);
			else continue;
			if (rule.regex.test(sub)) ignored = !rule.negate;
		}
		return ignored;
	}
}

export type { Rule as IgnoreRule };
