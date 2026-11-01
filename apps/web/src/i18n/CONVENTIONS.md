# i18n conventions (en source · vi translation)

English source text **is the key** (gettext style). English needs no catalog. Vietnamese catalogs are lazy chunks, loaded
only when the locale is `vi`. The quality gate `node scripts/check-i18n.mjs` runs in `pnpm --filter @clam/web build`.
Locale: `clam.locale` in localStorage (default: browser language, `vi*` → vi); switching re-keys the tree (no reload).

## API (`import … from "@/i18n"`)

| API | Use |
| --- | --- |
| `t("Hand over")` · `t("Hello {name}", { name })` | translate a **string literal** (first argument MUST be a literal; checked) |
| `t("{count, plural, one {# agent} other {# agents}}", { count })` | plurals via `Intl.PluralRules` (`#` = formatted count; `=0 {…}` exact match works). `{k, select, a {…} other {…}}` too |
| `<T text="Open <b>{name}</b> in <code>git</code>" params={{ name }} tags={{ b: <strong />, code: <code className="…" /> }} />` | rich text with components. `tags` value = element (cloned around its content) or `(children) => node`; `<br/>` self-closing OK. Param values are text only and cannot inject tags |
| `msg("Label")` + `tr(x)` | for module-level tables / `as const` arrays: wrap the literal in `msg()` (extracted), render with `tr(item.label)` inside a component. NEVER call `t()` at module scope (locale changes). `msg()` returns the opaque type `Msg` (not a string): type table fields as `Msg`, and forgetting `tr()` is a **type error** (`Msg` is not assignable to `string`/`ReactNode`; the one hole is a template literal `${x}`) |
| `renderServerText(text, i18n)` | server-generated sentences: `i18n ? t(i18n.key, i18n.params) : text` guarded by catalog presence; English keeps `text` |
| `useT(ns?)` | optional hook: subscribes to locale; `useT("ns")` suspends until a namespace outside the module graph is ready. Normally NOT needed — plain `t` is fine |
| `getLocale()`, `setLocale("vi")`, `useLocale()`, `LOCALES` | locale state |

Literal braces: `{{` renders `{`. A lone `}` is literal. Apostrophes are literal (`Don't` is fine).

## Writing keys
- One sentence = one key. Never concatenate translated fragments (`t("Delete") + " " + name`) — use a param. Word order differs in Vietnamese.
- Don't put markup/classNames in keys except via `<T>`. Don't translate: CL Agent Mesh, code, ids, routes, API values, paths, model names.
- Same English text must carry the same meaning everywhere (one global dictionary; the check rejects conflicting translations). If an English word needs two Vietnamese meanings, make the English more specific (`"Open file"` vs `"Open"`).
- Never put numbers into text by `+`: use params; format with the helpers below *before* passing (`{ size: formatBytes(n) }`).
- `aria-label`, `title`, `placeholder`, `alt`, toast messages, `confirm` text, empty states, error strings shown to users — all wrapped.
- Errors thrown for display: `throw new Error(t("…"))` is fine inside functions (not module scope). API errors from the server: show `renderServerText(err.message, err.i18n)` where the error body exposes `i18n`.
- Sorting/plural/date text must never be hand-built (`n + " items"`).

## Formatting (all locale-aware, in `@/lib/utils`)
`formatNumber`, `formatCompact`, `formatPercent`, `formatCost` (USD currency), `formatBytes`, `formatDuration` (`6 phút 5 giây` / `6m 5s`),
`formatUnit` (one value + narrow unit), `formatSpan` (`7 ngày` / `7 days`), `relativeTime` (`just now` / "3 phút trước"), `formatDate`,
`formatTime`, `formatDateTime`, `formatList`. Never call `toLocale*String`, `new Intl.*`, or `"en"` directly, and never build `${m}m ${s}s` by hand. Charts/axes: use these helpers too.

## Namespaces and where catalogs live
| Source files | Namespace | Catalog (default export `Record<string,string>`) |
| --- | --- | --- |
| `src/features/<f>/**` | `<f>` | `src/features/<f>/i18n/vi.ts` |
| `src/app/**` | shell/app | `src/i18n/shell/vi/app.ts` |
| `src/components/**` | shell/components | `src/i18n/shell/vi/components.ts` |
| everything else in `src/` (lib, hooks, ui, main) | shell/lib | `src/i18n/shell/vi/lib.ts` |
| server text | server | `src/i18n/server/vi.ts` (keys = `i18nMsg("…")` literals in the server) |

`src/i18n/shell/vi.ts` merges the three shards (already written; do not edit). The shell catalog is loaded before the first render
when vi is active; feature catalogs load with the feature chunk.

**Loading is automatic**: the Vite plugin `clam:i18n-namespace` (vite.config.ts) wraps every dynamic `import("…")` of a src module in
`withNamespaces(import(…), [namespaces])`, where the namespaces are the feature folders of every module statically reachable from the
target that imports `@/i18n`. The lazy chunk and its vi catalogs download in parallel and the chunk resolves only when both are in →
no flash of English, nothing to wire (do NOT use top-level await for this: it fragments the entry chunk, +1.6 KB gzip). `main.tsx`
awaits the shell catalog (plus anything statically reachable) before the first render. Just `import { t } from "@/i18n"` in the file
(always that exact specifier, named imports `t`, `T`, `msg`, `tr`). Namespaces only load for features that have an `i18n/vi.ts`
(a missing file is a silent no-op, so create it as soon as the feature has any `t()` call — the check enforces that).
A feature that has `t()` calls MUST have its `i18n/vi.ts`; files in a feature that import from `@/i18n` are all namespace `<f>`.
Switching language at runtime loads every namespace used so far in the session, then re-keys the router tree.

## Server text
Server-generated sentences carry `i18n: { key, params }` next to the English text (`key` = English ICU template, produced by
`i18nMsg("…", params)` in apps/server). Render with `renderServerText(text, i18n)` (or `errorText(err)` for API errors). The vi
catalog is `src/i18n/server/vi.ts` (merges `server/vi/part-*.ts`); the check scans `i18nMsg("literal")` calls in apps/server and
`packages/*` and requires one entry per literal (placeholder names must match). Add a server key → add its vi entry in the same change.
Server params that carry an enum word (`state`, `status`, `fromStatus`, `toStatus`, `reported`, `side`, `role`, `step`) are translated by
`renderServerText` through the lowercase word catalog declared in `src/lib/server-words.ts`; a new word the server interpolates is added there.
Never render an enum value raw (`{x.state}`): use the feature's label map (`msg()` + `tr()`), one map per enum.

## vi.ts shape
```ts
import type { Catalog } from "@/i18n";
const vi: Catalog = {
	"Hand over": "Bàn giao",
	"{count, plural, one {# agent} other {# agents}}": "{count, plural, other {# agent}}",
};
export default vi;
```
Use `import type` only (the check loads catalogs with plain Node type-stripping). Keys are the exact English literal.
Follow `GLOSSARY.md`. Keep Vietnamese about as long as the English where possible; labels in buttons/tabs/sidebar must stay short.

## Converting a file (checklist)
1. `import { t } from "@/i18n"` (+ `T`, `msg`, `tr`), wrap every user-visible literal.
2. Add the entries to the namespace's `vi.ts` (the check prints ready-to-paste lines for missing keys).
3. Replace ad-hoc date/number formatting with the helpers.
4. Add the directory to `scripts/i18n-scope.json` → unwrapped text is then a build error (a source file outside the scope is itself a build error). Legit non-translatable literals → `scripts/i18n-allowlist.json` (`"*"` global, or per file path).
5. Run `node scripts/check-i18n.mjs --only features/<f>` until clean. Layout: Vietnamese is ~15–30% longer; avoid fixed widths on labels, prefer `min-w-0 truncate` only where the full text is also available (title/tooltip).
