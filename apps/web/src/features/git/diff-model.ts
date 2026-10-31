import type { DiffFile, DiffLine } from "@clam/contracts";

/**
 * Flattens a GitDiff into the rows of one virtualized list (file headers, hunk headers, lines, notes) so a diff with tens of
 * thousands of lines costs the same DOM as a small one. Row heights are fixed, which keeps scroll math exact.
 */

export const ROW_H = { file: 40, hunk: 26, line: 20, note: 48 } as const;
export const CHAR_W = 7.2; // 12px JetBrains Mono advance
export const GUTTER_W = 48;

/** Index of a line in the per-side source used for highlighting (-1: no source line, e.g. "\ No newline"). */
export interface LineRef {
	line: DiffLine;
	oi: number;
	ni: number;
}

export type NoteKind = "binary" | "too-large" | "empty" | "rename" | "no-hunks";

export type DiffRow =
	| { kind: "file"; key: string; fi: number; file: DiffFile; collapsed: boolean }
	| { kind: "hunk"; key: string; fi: number; header: string }
	| { kind: "line"; key: string; fi: number; ref: LineRef }
	| { kind: "pair"; key: string; fi: number; left: LineRef | null; right: LineRef | null }
	| { kind: "note"; key: string; fi: number; note: NoteKind; file: DiffFile };

export function rowHeight(r: DiffRow): number {
	return ROW_H[r.kind === "pair" ? "line" : r.kind];
}

function noteFor(file: DiffFile): NoteKind | null {
	if (file.binary) return "binary";
	if (file.tooLarge) return "too-large";
	if (file.hunks.length === 0) {
		if (file.status === "renamed" || file.status === "copied") return "rename";
		return file.status === "added" || file.status === "untracked" ? "empty" : "no-hunks";
	}
	return null;
}

function refsOf(file: DiffFile): LineRef[][] {
	let oi = 0;
	let ni = 0;
	return file.hunks.map((h) =>
		h.lines.map((line): LineRef => {
			switch (line.type) {
				case "context":
					return { line, oi: oi++, ni: ni++ };
				case "add":
					return { line, oi: -1, ni: ni++ };
				case "del":
					return { line, oi: oi++, ni: -1 };
				default:
					return { line, oi: -1, ni: -1 };
			}
		}),
	);
}

/** Source text of each side, one entry per line, for syntax highlighting. */
export function fileSources(file: DiffFile): { old: string; new: string; oldLines: number; newLines: number } {
	const o: string[] = [];
	const n: string[] = [];
	for (const h of file.hunks) {
		for (const l of h.lines) {
			if (l.type === "context") {
				o.push(l.content);
				n.push(l.content);
			} else if (l.type === "add") n.push(l.content);
			else if (l.type === "del") o.push(l.content);
		}
	}
	return { old: o.join("\n"), new: n.join("\n"), oldLines: o.length, newLines: n.length };
}

export function buildRows(files: readonly DiffFile[], mode: "unified" | "split", collapsed: ReadonlySet<string>): DiffRow[] {
	const rows: DiffRow[] = [];
	files.forEach((file, fi) => {
		const isCollapsed = collapsed.has(file.path);
		rows.push({ kind: "file", key: `f:${file.path}`, fi, file, collapsed: isCollapsed });
		if (isCollapsed) return;
		const note = noteFor(file);
		if (note) {
			rows.push({ kind: "note", key: `n:${file.path}`, fi, note, file });
			return;
		}
		const refs = refsOf(file);
		file.hunks.forEach((hunk, hi) => {
			rows.push({ kind: "hunk", key: `h:${file.path}:${hi}`, fi, header: hunk.header });
			const lines = refs[hi] ?? [];
			if (mode === "unified") {
				lines.forEach((ref, li) => rows.push({ kind: "line", key: `l:${file.path}:${hi}:${li}`, fi, ref }));
				return;
			}
			let dels: LineRef[] = [];
			let adds: LineRef[] = [];
			let seq = 0;
			const flush = () => {
				const n = Math.max(dels.length, adds.length);
				for (let i = 0; i < n; i++) rows.push({ kind: "pair", key: `p:${file.path}:${hi}:${seq++}`, fi, left: dels[i] ?? null, right: adds[i] ?? null });
				dels = [];
				adds = [];
			};
			for (const ref of lines) {
				if (ref.line.type === "del") dels.push(ref);
				else if (ref.line.type === "add") adds.push(ref);
				else {
					flush();
					rows.push({ kind: "pair", key: `p:${file.path}:${hi}:${seq++}`, fi, left: ref, right: ref });
				}
			}
			flush();
		});
	});
	return rows;
}

/** Cheap content hash so highlight caches survive refetches that returned identical file diffs. */
const hashCache = new WeakMap<DiffFile, string>();
export function fileHash(file: DiffFile): string {
	let h = hashCache.get(file);
	if (h) return h;
	let a = 5381;
	for (const hunk of file.hunks) {
		for (const l of hunk.lines) {
			a = (a * 33) ^ l.type.charCodeAt(0);
			for (let i = 0; i < l.content.length; i++) a = (a * 33) ^ l.content.charCodeAt(i);
		}
	}
	h = `${file.path}\u0000${file.hunks.length}\u0000${(a >>> 0).toString(36)}`;
	hashCache.set(file, h);
	return h;
}

export function maxLineChars(files: readonly DiffFile[]): number {
	let m = 0;
	for (const f of files) for (const h of f.hunks) for (const l of h.lines) if (l.content.length > m) m = l.content.length;
	return Math.min(m, 600);
}

export function totalChanges(files: readonly DiffFile[]): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;
	for (const f of files) {
		additions += f.additions;
		deletions += f.deletions;
	}
	return { additions, deletions };
}
