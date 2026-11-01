import { z } from "zod";

/** ISO-8601 timestamp string. */
export const IsoDate = z.string();
export type IsoDate = z.infer<typeof IsoDate>;

export const Id = z.string().min(1);
export type Id = z.infer<typeof Id>;

/**
 * Structured, translatable form of a server-generated sentence. `key` is the English template itself (ICU-lite: `{name}`
 * params and `{count, plural, one {…} other {…}}`), so the web's gettext-style `t(key, params)` finds its catalog entry;
 * `params` are values only (names, counts, paths), never translated. The English text next to it (`text`, `summary`,
 * `message`) is always `renderI18n(key, params)`; old clients, older nodes and agents read that and ignore `i18n`.
 */
export const I18nText = z.object({
	key: z.string(),
	params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});
export type I18nText = z.infer<typeof I18nText>;

/** English rendering of an `I18nText` template. Unknown params are left as `{name}`. */
export function renderI18n(key: string, params?: Readonly<Record<string, string | number>>): string {
	const out: string[] = [];
	let i = 0;
	while (i < key.length) {
		const open = key.indexOf("{", i);
		if (open < 0) {
			out.push(key.slice(i));
			break;
		}
		out.push(key.slice(i, open));
		let depth = 0;
		let close = open;
		for (; close < key.length; close++) {
			if (key[close] === "{") depth++;
			else if (key[close] === "}" && --depth === 0) break;
		}
		const inner = key.slice(open + 1, close);
		const comma = inner.indexOf(",");
		if (comma < 0) {
			const v = params?.[inner.trim()];
			out.push(v === undefined ? `{${inner}}` : String(v));
		} else {
			const name = inner.slice(0, comma).trim();
			const rest = inner.slice(comma + 1).trim();
			const count = Number(params?.[name] ?? 0);
			const branches = new Map<string, string>();
			const re = /([\w=]+)\s*\{/g;
			let m: RegExpExecArray | null;
			const body = rest.replace(/^plural\s*,/, "");
			while ((m = re.exec(body))) {
				let d = 1;
				let j = re.lastIndex;
				for (; j < body.length && d > 0; j++) d += body[j] === "{" ? 1 : body[j] === "}" ? -1 : 0;
				branches.set(m[1]!, body.slice(re.lastIndex, j - 1));
				re.lastIndex = j;
			}
			const chosen = branches.get(`=${count}`) ?? branches.get(new Intl.PluralRules("en").select(count)) ?? branches.get("other") ?? "";
			out.push(renderI18n(chosen.replaceAll("#", String(count)), params));
		}
		i = close + 1;
	}
	return out.join("");
}

/** A server-generated sentence in both forms: `text` (English, as stored/read today) and `i18n` (its structured twin; absent for text that is not ours to translate, e.g. an error from git or a peer without `i18n`). */
export interface I18nMessage {
	readonly text: string;
	readonly i18n?: I18nText | undefined;
}

/** Plain text with no structured twin (shown as-is in every language). */
export function plainMsg(text: string): I18nMessage {
	return { text };
}

/** Build an `I18nMessage`: `i18nMsg("{name} joined the shared session.", { name })` → `{ text: "Bob joined…", i18n: { key, params } }`. */
export function i18nMsg(key: string, params?: Record<string, string | number>): I18nMessage & { readonly i18n: I18nText } {
	return { text: renderI18n(key, params), i18n: params && Object.keys(params).length > 0 ? { key, params } : { key } };
}

/** Every non-2xx JSON response from the local API has this shape. */
export const ApiErrorBody = z.object({
	error: z.object({
		code: z.string(),
		message: z.string(),
		details: z.unknown().optional(),
		/** Structured form of `message` for localisation; `message` stays the English text. Absent = show `message`. */
		i18n: I18nText.optional(),
	}),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

/** Cursor-paginated list. */
export const page = <T extends z.ZodType>(item: T) =>
	z.object({
		items: z.array(item),
		nextCursor: z.string().nullable(),
	});

/**
 * Provenance of a number shown in the UI. Usage figures MUST carry one so the UI
 * can distinguish OMP-recorded actuals from provider-reported quota and from
 * CL Agent Mesh's own estimates.
 */
export const DataSource = z.enum(["omp-recorded", "provider-reported", "clam-estimated"]);
export type DataSource = z.infer<typeof DataSource>;
