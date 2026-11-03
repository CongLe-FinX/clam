import type { Options } from "react-markdown";

type PluggableList = NonNullable<Options["rehypePlugins"]>;

export interface HtmlPlugins {
	/** Parse raw HTML into the tree, then sanitize it with GitHub's rules: what renders is what github.com would render. */
	rehype: PluggableList;
}

let promise: Promise<HtmlPlugins> | null = null;
let loaded: HtmlPlugins | null = null;
export const loadedHtml = (): HtmlPlugins | null => loaded;

/** rehype-raw (an HTML parser) + rehype-sanitize load once, only for a document that is rendered with its HTML. */
export function loadHtml(): Promise<HtmlPlugins> {
	promise ??= Promise.all([import("rehype-raw"), import("rehype-sanitize")]).then(([raw, sanitize]) => {
		const base = sanitize.defaultSchema;
		const schema = {
			...base,
			attributes: {
				...base.attributes,
				// remark-math marks math as `code.language-math.math-inline|math-display`; KaTeX runs after sanitizing and needs both classes.
				code: [["className", /^language-./, "math-inline", "math-display"]],
			},
		};
		loaded = { rehype: [raw.default, [sanitize.default, schema]] };
		return loaded;
	});
	return promise;
}
