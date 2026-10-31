/** The part of a SQLite handle the engine uses (better-sqlite3's `Database` satisfies it); the engine does no other I/O. */
export interface SqliteHandle {
	prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

const MAX_TERMS = 12;
const MAX_TERM_CHARS = 64;
const WORD = /[\p{L}\p{N}]+/gu;

/**
 * An FTS5 MATCH expression from what a person typed. Bare words match as prefixes (`styl` finds "style"; typing a query
 * is a search-as-you-type), a "quoted phrase" matches exactly in order, and every term must match (implicit AND).
 * Every term is emitted as a double-quoted FTS5 string containing only letters and digits, so operators, column filters,
 * `NEAR`, parentheses, `*` and quotes typed by the user can never be interpreted as FTS5 syntax. `null` when nothing
 * searchable is left (the caller then returns no hits instead of running a query).
 */
export function buildFtsQuery(input: string): string | null {
	const terms: string[] = [];
	const pieces = input.matchAll(/"([^"]*)"|(\S+)/g);
	for (const piece of pieces) {
		if (terms.length >= MAX_TERMS) break;
		const phrase = piece[1];
		const words = (phrase ?? piece[2] ?? "").match(WORD)?.map((w) => w.slice(0, MAX_TERM_CHARS)) ?? [];
		if (words.length === 0) continue;
		if (phrase !== undefined) terms.push(`"${words.join(" ")}"`);
		else for (const word of words) if (terms.length < MAX_TERMS) terms.push(`"${word}"*`);
	}
	return terms.length === 0 ? null : terms.join(" ");
}

export const SNIPPET_OPEN = "«";
export const SNIPPET_CLOSE = "»";

export interface SearchFilters {
	workspaceId?: string;
	/** Contexts bound to this local project, plus synced ones whose `projectKey` matches. */
	project?: { id: string; key: string };
	/** Also return the workspace-wide contexts (no project) next to the project's own. */
	includeWorkspaceWide?: boolean;
	type?: string;
	limit: number;
}

export interface RawHit {
	id: string;
	snippet: string;
	/** Higher is better (negated bm25, the title weighs eight times the body). */
	rank: number;
}

interface Row {
	id: string;
	score: number;
	title_snippet: string;
	body_snippet: string;
}

/**
 * Ranked search over the head title/body of live contexts (`context_fts`, bm25). `snippet` is the matched excerpt with
 * `«` `»` around hits: the body's excerpt, or the title when only the title matched.
 */
export function searchContexts(db: SqliteHandle, query: string, filters: SearchFilters): RawHit[] {
	const match = buildFtsQuery(query);
	if (match === null) return [];
	const where = ["context_fts MATCH ?", "c.deleted_at IS NULL"];
	const params: unknown[] = [match];
	if (filters.workspaceId) {
		where.push("c.workspace_id = ?");
		params.push(filters.workspaceId);
	}
	if (filters.project) {
		const scope = "(c.project_id = ? OR (c.project_id IS NULL AND c.project_key = ?))";
		where.push(filters.includeWorkspaceWide ? `(${scope} OR (c.project_id IS NULL AND c.project_key IS NULL))` : scope);
		params.push(filters.project.id, filters.project.key);
	}
	if (filters.type) {
		where.push("c.type = ?");
		params.push(filters.type);
	}
	params.push(Math.max(1, Math.min(100, filters.limit)));
	const rows = db
		.prepare(
			`SELECT c.id AS id, -bm25(context_fts, 8.0, 1.0) AS score,
				snippet(context_fts, 0, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', '…', 10) AS title_snippet,
				snippet(context_fts, 1, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', '…', 16) AS body_snippet
			 FROM context_fts JOIN contexts c ON c.seq = context_fts.rowid
			 WHERE ${where.join(" AND ")}
			 ORDER BY score DESC, c.updated_at DESC
			 LIMIT ?`,
		)
		.all(...params) as Row[];
	return rows.map((r) => ({
		id: r.id,
		rank: r.score,
		snippet: !r.body_snippet.includes(SNIPPET_OPEN) && r.title_snippet.includes(SNIPPET_OPEN) ? r.title_snippet : r.body_snippet.replace(/\s+/g, " ").trim(),
	}));
}
