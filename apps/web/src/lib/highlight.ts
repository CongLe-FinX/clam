import type { HighlighterCore, ThemedToken } from "shiki/core";

/** Lazy syntax highlighting. Nothing here is imported by the initial bundle. */
export interface HlToken {
	content: string;
	/** CSS custom properties `--shiki-dark` / `--shiki-light` (dual-theme). */
	style?: Record<string, string>;
}
export type HlLine = HlToken[];

const langLoaders: Record<string, () => Promise<unknown>> = {
	typescript: () => import("shiki/langs/typescript.mjs"),
	tsx: () => import("shiki/langs/tsx.mjs"),
	javascript: () => import("shiki/langs/javascript.mjs"),
	jsx: () => import("shiki/langs/jsx.mjs"),
	json: () => import("shiki/langs/json.mjs"),
	jsonc: () => import("shiki/langs/jsonc.mjs"),
	bash: () => import("shiki/langs/bash.mjs"),
	python: () => import("shiki/langs/python.mjs"),
	rust: () => import("shiki/langs/rust.mjs"),
	go: () => import("shiki/langs/go.mjs"),
	css: () => import("shiki/langs/css.mjs"),
	html: () => import("shiki/langs/html.mjs"),
	markdown: () => import("shiki/langs/markdown.mjs"),
	yaml: () => import("shiki/langs/yaml.mjs"),
	toml: () => import("shiki/langs/toml.mjs"),
	sql: () => import("shiki/langs/sql.mjs"),
	diff: () => import("shiki/langs/diff.mjs"),
	java: () => import("shiki/langs/java.mjs"),
	c: () => import("shiki/langs/c.mjs"),
	cpp: () => import("shiki/langs/cpp.mjs"),
	ruby: () => import("shiki/langs/ruby.mjs"),
	php: () => import("shiki/langs/php.mjs"),
	swift: () => import("shiki/langs/swift.mjs"),
	kotlin: () => import("shiki/langs/kotlin.mjs"),
	dockerfile: () => import("shiki/langs/dockerfile.mjs"),
	xml: () => import("shiki/langs/xml.mjs"),
	scss: () => import("shiki/langs/scss.mjs"),
};

const aliases: Record<string, string> = {
	ts: "typescript",
	mts: "typescript",
	cts: "typescript",
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	sh: "bash",
	shell: "bash",
	zsh: "bash",
	console: "bash",
	py: "python",
	rs: "rust",
	yml: "yaml",
	md: "markdown",
	mdx: "markdown",
	rb: "ruby",
	kt: "kotlin",
	"c++": "cpp",
	cc: "cpp",
	h: "c",
	hpp: "cpp",
	docker: "dockerfile",
	svg: "xml",
	vue: "html",
	jsonl: "json",
	patch: "diff",
};

/** Normalize a fence label or server-provided language to a loadable grammar, else null (plain text). */
export function resolveLang(lang: string | null | undefined): string | null {
	if (!lang) return null;
	const l = lang.toLowerCase().trim();
	const name = aliases[l] ?? l;
	return name in langLoaders ? name : null;
}

let hlPromise: Promise<HighlighterCore> | null = null;
const loadedLangs = new Set<string>();

function getHighlighter(): Promise<HighlighterCore> {
	hlPromise ??= (async () => {
		const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, dark, light] = await Promise.all([
			import("shiki/core"),
			import("shiki/engine/javascript"),
			import("shiki/themes/github-dark-default.mjs"),
			import("shiki/themes/github-light-default.mjs"),
		]);
		// github-light's comment and function colours fall just under 4.5:1 on our code surface; darken those two.
		const lightTheme = JSON.parse(JSON.stringify(light.default).replaceAll("#6e7781", "#57606a").replaceAll("#8250df", "#6639ba")) as typeof light.default;
		return createHighlighterCore({ themes: [dark.default, lightTheme], langs: [], engine: createJavaScriptRegexEngine() });
	})();
	return hlPromise;
}

const MAX_CHARS = 400_000;

/** Highlight to per-line tokens. Resolves null when the language is unknown or the input is too large. */
export async function highlightLines(code: string, lang: string | null | undefined): Promise<HlLine[] | null> {
	const name = resolveLang(lang);
	if (!name || code.length > MAX_CHARS) return null;
	const hl = await getHighlighter();
	if (!loadedLangs.has(name)) {
		const mod = (await langLoaders[name]?.()) as { default: Parameters<HighlighterCore["loadLanguage"]>[0] };
		await hl.loadLanguage(mod.default);
		loadedLangs.add(name);
	}
	const { tokens } = hl.codeToTokens(code, { lang: name, themes: { dark: "github-dark-default", light: "github-light-default" }, defaultColor: false });
	return tokens.map((line: ThemedToken[]) => line.map((t) => ({ content: t.content, style: t.htmlStyle as Record<string, string> | undefined })));
}

const extLang: Record<string, string> = {
	ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript", json: "json", jsonc: "jsonc",
	sh: "bash", bash: "bash", zsh: "bash", py: "python", rs: "rust", go: "go", css: "css", scss: "scss", html: "html", htm: "html",
	md: "markdown", mdx: "markdown", yml: "yaml", yaml: "yaml", toml: "toml", sql: "sql", diff: "diff", patch: "diff", java: "java",
	c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", rb: "ruby", php: "php", swift: "swift", kt: "kotlin", xml: "xml", svg: "xml",
};
export function langFromPath(path: string): string | null {
	const base = path.split("/").pop() ?? path;
	if (/^dockerfile/i.test(base)) return "dockerfile";
	const ext = base.includes(".") ? base.split(".").pop()?.toLowerCase() : undefined;
	return ext ? (extLang[ext] ?? null) : null;
}
