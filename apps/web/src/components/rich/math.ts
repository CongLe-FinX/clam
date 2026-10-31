import type { Options } from "react-markdown";

type PluggableList = NonNullable<Options["remarkPlugins"]>;

/** `$$…$$` or an inline `$…$` that is not currency (`$5 and $10` has a space before the closing `$`). */
const MATH = /\$\$|(?<![\\$\w])\$(?=[^\s$])[^$\n]*?[^\s$\\]\$(?![\w$])|(?<![\\$\w])\$[^\s$\\]\$(?![\w$])/;
export const hasMath = (text: string): boolean => text.includes("$") && MATH.test(text);

const INLINE_PAIR = /(?<![\\$\w])\$(?=[^\s$])[^$\n]*?[^\s$\\]\$(?![\w$])|(?<![\\$\w])\$[^\s$\\]\$(?![\w$])/g;

/** Escape the `$` of a line outside its inline-math pairs and code spans, so currency (`$5 and $10`) stays text when the same message has real math. */
function protectLine(line: string): string {
	return line
		.split(/(`+[^`]*`+)/)
		.map((part, i) => {
			if (i % 2 === 1 || !part.includes("$")) return part;
			let out = "";
			let at = 0;
			for (const m of part.matchAll(INLINE_PAIR)) {
				out += part.slice(at, m.index).replace(/(?<!\\)\$/g, "\\$");
				out += m[0];
				at = m.index + m[0].length;
			}
			return out + part.slice(at).replace(/(?<!\\)\$/g, "\\$");
		})
		.join("");
}

/** `text` with every `$` that does not belong to math escaped. Display math (`$$`) and fenced code are left alone. */
export function protectCurrency(text: string): string {
	if (!text.includes("$")) return text;
	let fence = false;
	return text
		.split("\n")
		.map((line) => {
			if (/^ {0,3}(`{3,}|~{3,})/.test(line)) fence = !fence;
			return fence || line.includes("$$") ? line : protectLine(line);
		})
		.join("\n");
}

export interface MathPlugins {
	remark: PluggableList;
	rehype: PluggableList;
}

let promise: Promise<MathPlugins> | null = null;
let loaded: MathPlugins | null = null;
export const loadedMath = (): MathPlugins | null => loaded;

/** KaTeX + its stylesheet load once, only when some message contains math. */
export function loadMath(): Promise<MathPlugins> {
	promise ??= Promise.all([import("remark-math"), import("rehype-katex"), import("katex/dist/katex.min.css")]).then(([rm, rk]) => {
		loaded = { remark: [rm.default], rehype: [[rk.default, { throwOnError: false, strict: "ignore", errorColor: "var(--danger)" }]] };
		return loaded;
	});
	return promise;
}
