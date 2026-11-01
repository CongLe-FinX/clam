import { intlTag } from "./core";

export type Params = Record<string, string | number>;
type Node = string | { name: string; kind: "arg" | "plural" | "select"; options?: Record<string, Node[]> } | "#";

const cache = new Map<string, Node[]>();

/** ICU-lite: `{name}`, `{n, plural, =0 {…} one {# …} other {# …}}`, `{k, select, a {…} other {…}}`, `{{` = literal `{`. */
function parse(src: string, i: { v: number }, nested: boolean): Node[] {
	const out: Node[] = [];
	let text = "";
	const flush = () => {
		if (text) out.push(text);
		text = "";
	};
	while (i.v < src.length) {
		const c = src[i.v]!;
		if (c === "}" && nested) break;
		if (c === "{" && src[i.v + 1] === "{") {
			text += "{";
			i.v += 2;
		} else if (c === "{") {
			flush();
			i.v++;
			const end = src.slice(i.v).search(/[,}]/);
			const name = src.slice(i.v, i.v + end).trim();
			i.v += end;
			if (src[i.v] === "}") {
				out.push({ name, kind: "arg" });
			} else {
				i.v++;
				const kindEnd = src.indexOf(",", i.v);
				const kind = src.slice(i.v, kindEnd).trim() === "select" ? "select" : "plural";
				i.v = kindEnd + 1;
				const options: Record<string, Node[]> = {};
				for (;;) {
					while (/\s/.test(src[i.v] ?? "")) i.v++;
					if (src[i.v] === "}") break;
					const open = src.indexOf("{", i.v);
					const sel = src.slice(i.v, open).trim();
					i.v = open + 1;
					options[sel] = parse(src, i, true);
					i.v++; // closing }
				}
				out.push({ name, kind, options });
			}
			i.v++;
		} else if (c === "#" && nested) {
			flush();
			out.push("#");
			i.v++;
		} else {
			text += c;
			i.v++;
		}
	}
	flush();
	return out;
}

const plurals = new Map<string, Intl.PluralRules>();
const numbers = new Map<string, Intl.NumberFormat>();
function cached<T>(m: Map<string, T>, make: (tag: string) => T): T {
	const tag = intlTag();
	let v = m.get(tag);
	if (!v) m.set(tag, (v = make(tag)));
	return v;
}

function render(nodes: Node[], params: Params, count: number | null, escape: boolean): string {
	let s = "";
	for (const n of nodes) {
		if (typeof n === "string") {
			s += n === "#" && count != null ? cached(numbers, (t) => new Intl.NumberFormat(t)).format(count) : n;
		} else {
			const v = params[n.name];
			if (n.kind === "arg") {
				s += v === undefined ? `{${n.name}}` : escape ? String(v).replaceAll("<", "\u0001") : String(v);
				continue;
			}
			const o = n.options!;
			let pick: Node[] | undefined;
			if (n.kind === "select") pick = o[String(v)] ?? o.other;
			else {
				const num = Number(v);
				pick = o[`=${num}`] ?? o[cached(plurals, (t) => new Intl.PluralRules(t)).select(num)] ?? o.other;
				s += render(pick ?? [], params, num, escape);
				continue;
			}
			s += render(pick ?? [], params, count, escape);
		}
	}
	return s;
}

/** Formats an ICU-lite template. `escape` hides `<` inside param values so rich-text tags can be parsed safely afterwards. */
export function formatMessage(template: string, params?: Params, escape = false): string {
	if (!params && !template.includes("{")) return template;
	let nodes = cache.get(template);
	if (!nodes) cache.set(template, (nodes = parse(template, { v: 0 }, false)));
	return render(nodes, params ?? {}, null, escape);
}
