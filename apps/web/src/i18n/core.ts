import { useSyncExternalStore } from "react";

/** Supported UI languages. `en` is the source language (the English text is the key, so it needs no catalog). */
export type Locale = "en" | "vi";
export type Catalog = Record<string, string>;

/** Native names; never translated. */
export const LOCALES: readonly { id: Locale; label: string }[] = [
	{ id: "en", label: "English" },
	{ id: "vi", label: "Tiếng Việt" },
];

const KEY = "clam.locale";
const isLocale = (v: unknown): v is Locale => v === "en" || v === "vi";
const listeners = new Set<() => void>();

function detect(): Locale {
	try {
		const saved = localStorage.getItem(KEY);
		if (isLocale(saved)) return saved;
	} catch {}
	return /^vi\b/i.test(navigator.language) ? "vi" : "en";
}

let locale: Locale = detect();
document.documentElement.lang = locale;

export const getLocale = (): Locale => locale;
/** BCP-47 tag handed to Intl (`vi-VN` formats numbers as 1.234,5). */
export const intlTag = (): string => (locale === "vi" ? "vi-VN" : "en-US");

const subscribe = (cb: () => void) => {
	listeners.add(cb);
	return () => listeners.delete(cb);
};
export const useLocale = (): Locale => useSyncExternalStore(subscribe, getLocale, getLocale);

// ── catalogs ──────────────────────────────────────────────────────────────────
// Catalog files live at `features/<ns>/i18n/<locale>.ts`, `i18n/shell/<locale>.ts`, `i18n/server/<locale>.ts` and are lazy chunks.
const loaders = import.meta.glob<{ default: Catalog }>(["../features/*/i18n/*.ts", "./shell/*.ts", "./server/*.ts"]);
const loaderFor = (ns: string, l: Locale) =>
	loaders[ns === "shell" || ns === "server" ? `./${ns}/${l}.ts` : `../features/${ns}/i18n/${l}.ts`];

const seen = new Set<string>(["shell"]);
const pending = new Map<string, Promise<void>>();
const loaded = new Map<string, Catalog>();
/** Merged catalogs of the active locale. Read by `t()`. */
export let active: Catalog = {};

function rebuild(): void {
	active = {};
	for (const [k, c] of loaded) if (k.startsWith(`${locale}:`)) Object.assign(active, c);
}

function load(ns: string, l: Locale): Promise<void> {
	const id = `${l}:${ns}`;
	let p = pending.get(id);
	if (!p) {
		const loader = l === "en" ? undefined : loaderFor(ns, l);
		p = loader
			? loader().then((m) => {
					loaded.set(id, m.default);
					if (l === locale) Object.assign(active, m.default);
				})
			: Promise.resolve();
		pending.set(id, p);
	}
	return p;
}

/** Makes sure the catalog of namespace `ns` is ready for the active locale (resolved no-op for English). */
export function loadNamespace(ns: string): Promise<void> {
	seen.add(ns);
	return load(ns, locale);
}

/**
 * Wraps a dynamic `import()` so the promise resolves only once the vi catalogs of `ns` are in. Inserted by the Vite plugin
 * `clam:i18n-namespace` around every `import("…")` whose target (transitively, statically) uses `@/i18n`; never written by hand.
 */
export const withNamespaces = <T>(chunk: Promise<T>, ns: string[]): Promise<T> => Promise.all([chunk, ...ns.map(loadNamespace)]).then((r) => r[0] as T);

/** True once `ns` is available for the active locale (always true for English). */
export const isNamespaceReady = (ns: string): boolean => locale === "en" || loaded.has(`${locale}:${ns}`) || !loaderFor(ns, locale);

/**
 * Switches language instantly: first loads the catalogs of every namespace already used in this session, then commits
 * and notifies (the app tree is re-keyed by locale in `main.tsx`, so every `t()` call is re-evaluated).
 */
export async function setLocale(next: Locale): Promise<void> {
	if (next === locale) return;
	await Promise.all([...seen].map((ns) => load(ns, next)));
	locale = next;
	try {
		localStorage.setItem(KEY, next);
	} catch {}
	document.documentElement.lang = next;
	rebuild();
	for (const l of listeners) l();
}
