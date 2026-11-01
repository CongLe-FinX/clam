import { cloneElement, isValidElement, use, type ReactElement, type ReactNode } from "react";
import type { I18nText } from "@clam/contracts";
import { active, getLocale, isNamespaceReady, loadNamespace, useLocale } from "./core";
import { formatMessage, type Params } from "./icu";

export { LOCALES, getLocale, intlTag, isNamespaceReady, loadNamespace, setLocale, useLocale, type Catalog, type Locale } from "./core";
export type { Params } from "./icu";

/**
 * Translate. The English source text IS the key and must be a string literal (checked by `scripts/check-i18n.mjs`):
 * `t("Hand over")`, `t("Hello {name}", { name })`, `t("{count, plural, one {# agent} other {# agents}}", { count })`.
 */
export function t(text: string, params?: Params): string {
	return formatMessage(active[text] ?? text, params);
}

/** Marks a literal for extraction where it cannot be translated yet (module-level tables); render it with `tr()`. */
declare const MSG: unique symbol;
/**
 * Opaque (not a string): a `msg()` value cannot be rendered, interpolated or assigned to `string`/`ReactNode` without `tr()`,
 * so forgetting `tr()` is a type error instead of silent English.
 */
export type Msg = { readonly [MSG]: true };
export const msg = (text: string): Msg => text as unknown as Msg;
/** Translates a `msg()` value (or any string key; non-literal argument allowed). */
export const tr = (text: Msg | string, params?: Params): string => t(text as string, params);

/** Subscribes the caller to locale changes; with `ns`, suspends until that namespace's catalog is loaded. */
export function useT(ns?: string): typeof t {
	useLocale();
	if (ns && !isNamespaceReady(ns)) use(loadNamespace(ns));
	return t;
}

/** Param names whose string values are enum words of the server (`running`, `awaiting_ack`, …); declared in `lib/server-words.ts`. */
const WORD_PARAMS = ["state", "status", "fromStatus", "toStatus", "reported", "side", "role", "step"] as const;

function translateWords(params: Params | undefined): Params | undefined {
	if (!params) return params;
	const out: Record<string, string | number> = { ...params };
	for (const name of WORD_PARAMS) {
		const v = out[name];
		if (typeof v === "string" && Object.hasOwn(active, v)) out[name] = active[v] as string;
	}
	return out;
}

/** Server-generated sentence: the structured `i18n` form when it has a catalog entry, otherwise the English `text`. Enum-word params (see `WORD_PARAMS`) are translated too. */
export function renderServerText(text: string, i18n?: I18nText | null): string {
	if (!i18n || getLocale() === "en" || !(i18n.key in active)) return text;
	return t(i18n.key, translateWords(i18n.params));
}

type Tag = ReactElement<{ children?: ReactNode }> | ((children: ReactNode) => ReactNode);
const TAG = /<(\/?)([a-z][a-z0-9]*)\s*(\/?)>/g;

function mount(tag: Tag | undefined, children: ReactNode, key: number): ReactNode {
	if (tag === undefined) return children;
	if (typeof tag === "function") return <span key={key}>{tag(children)}</span>;
	return isValidElement(tag) ? cloneElement(tag, { key }, children) : children;
}

/**
 * Rich text: tags in the (translatable) source become components. Params are inserted as text and can never inject tags.
 * `<T text="Open <b>{name}</b> in <code>git</code>" params={{ name }} tags={{ b: <strong />, code: <code className="…" /> }} />`
 * A tag value is an element (cloned around its content) or a function `(children) => node`. Tags may be self-closing (`<br/>`).
 */
export function T({ text, params, tags = {} }: { text: string; params?: Params; tags?: Record<string, Tag> }): ReactNode {
	useLocale();
	const src = formatMessage(active[text] ?? text, params, true);
	const root: ReactNode[] = [];
	const stack: { name: string; kids: ReactNode[] }[] = [];
	const top = () => (stack.length ? stack[stack.length - 1]!.kids : root);
	const push = (s: string) => s && top().push(s.replaceAll("\u0001", "<"));
	let last = 0;
	let n = 0;
	for (const m of src.matchAll(TAG)) {
		const [raw, close, name, self] = m as unknown as [string, string, string, string];
		if (!(name in tags)) continue;
		push(src.slice(last, m.index));
		last = m.index + raw.length;
		if (self) top().push(mount(tags[name], null, n++));
		else if (!close) stack.push({ name, kids: [] });
		else if (stack.length && stack[stack.length - 1]!.name === name) {
			const done = stack.pop()!;
			top().push(mount(tags[name], done.kids, n++));
		}
		else push(raw);
	}
	push(src.slice(last));
	while (stack.length) root.push(...stack.pop()!.kids);
	return root;
}
