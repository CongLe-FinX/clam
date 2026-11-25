/**
 * OMP's `@path` mention: a message that names a file of the session folder this way gets that file's text (a folder: its listing; a
 * picture: the picture) put into the agent's context when it is sent, so the agent does not have to read it first. OMP matches
 * `@"…"`, `@'…'` or `@` + a run without spaces and `@`, and drops punctuation at either end of the bare form; such paths are quoted.
 * A folder ends with `/` so it reads as one.
 */
export function fileMention(path: string, dir: boolean): string {
	const target = dir ? `${path}/` : path;
	if (!/[\s@]|^[`"'([{<]|[)\]}>.,;:!?"'`]$/.test(target)) return `@${target}`;
	const quote = target.includes('"') ? "'" : '"';
	return `@${quote}${target}${quote}`;
}

export interface MentionedFile {
	path: string;
	/** Lines read into the context (a folder: lines of its listing). */
	lines: number | null;
	/** Why OMP left the file out (too large, unreadable…). */
	skipped: string | null;
}

/** The files of a `fileMention` notice: one `path (N lines)` / `path [skipped: why]` per line (see agent-runtime `omp/messages.ts`). */
export function parseMentionNotice(text: string): MentionedFile[] {
	return text
		.split("\n")
		.map((line) => /^(.+?)(?: \((\d+) lines\))?(?: \[skipped: (.*)\])?$/.exec(line.trim()))
		.flatMap((m) => (m ? [{ path: m[1] as string, lines: m[2] ? Number(m[2]) : null, skipped: m[3] ?? null }] : []));
}
