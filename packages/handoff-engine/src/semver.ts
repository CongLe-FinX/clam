/**
 * Small semver-ish range checker for runtime requirements (`>=22.12`, `^20`, `~3.11`, `22`, `1.x`,
 * `>=18 <21`, `18 || 20`, `1.2 - 1.8`). Pre-release/build tags are ignored; missing parts count as 0.
 * Unparseable ranges are treated as "no constraint" by {@link satisfiesRange} (never block on a typo).
 */

export type Version = readonly [number, number, number];

const VERSION_IN_TEXT = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/;

/** First version-looking token in `text` (e.g. `v22.12.0`, `Python 3.11.4`, `go version go1.22.3 …`). */
export function parseVersion(text: string): Version | null {
	const m = VERSION_IN_TEXT.exec(text);
	if (!m) return null;
	return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

function compare(a: Version, b: Version): number {
	for (let i = 0; i < 3; i++) {
		const d = (a[i] as number) - (b[i] as number);
		if (d !== 0) return d;
	}
	return 0;
}

/** A partial version: how many numeric parts were written and their values (`x`/`*` stop the count). */
function partial(text: string): { v: Version; parts: number } | null {
	const t = text.trim().replace(/^[v=]+/i, "");
	if (t === "" || /^[x*]$/i.test(t)) return { v: [0, 0, 0], parts: 0 };
	const m = /^(\d+)(?:\.(\d+|[x*]))?(?:\.(\d+|[x*]))?(?:[-+].*)?$/i.exec(t);
	if (!m) return null;
	const nums: number[] = [];
	for (const g of [m[1], m[2], m[3]]) {
		if (g === undefined || /^[x*]$/i.test(g)) break;
		nums.push(Number(g));
	}
	return { v: [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0], parts: nums.length };
}

function bump(v: Version, parts: number): Version {
	// Exclusive upper bound of a partial version: `1.2` → `1.3.0`, `1` → `2.0.0`, `1.2.3` → `1.2.4`.
	if (parts <= 0) return [Number.POSITIVE_INFINITY, 0, 0];
	if (parts === 1) return [v[0] + 1, 0, 0];
	if (parts === 2) return [v[0], v[1] + 1, 0];
	return [v[0], v[1], v[2] + 1];
}

type Predicate = (v: Version) => boolean;

function comparator(token: string): Predicate | null {
	const m = /^(>=|<=|>|<|=|\^|~>?)?\s*(.*)$/.exec(token);
	if (!m) return null;
	const op = m[1] ?? "";
	const p = partial(m[2] ?? "");
	if (!p) return null;
	const { v, parts } = p;
	switch (op) {
		case ">=":
			return (x) => compare(x, v) >= 0;
		case "<=":
			return (x) => compare(x, bump(v, parts)) < 0;
		case ">":
			return (x) => compare(x, bump(v, parts)) >= 0;
		case "<":
			return (x) => compare(x, v) < 0;
		case "^": {
			// ^1.2.3 := >=1.2.3 <2.0.0; ^0.2.3 := <0.3.0; ^0.0.3 := <0.0.4
			const upper: Version = v[0] > 0 || parts <= 1 ? [v[0] + 1, 0, 0] : v[1] > 0 || parts === 2 ? [0, v[1] + 1, 0] : [0, 0, v[2] + 1];
			return (x) => compare(x, v) >= 0 && compare(x, upper) < 0;
		}
		case "~":
		case "~>": {
			const upper: Version = parts <= 1 ? [v[0] + 1, 0, 0] : [v[0], v[1] + 1, 0];
			return (x) => compare(x, v) >= 0 && compare(x, upper) < 0;
		}
		default: {
			const upper = bump(v, parts);
			return (x) => compare(x, v) >= 0 && compare(x, upper) < 0;
		}
	}
}

function conjunction(set: string): Predicate | null {
	const hyphen = /^\s*(\S+)\s+-\s+(\S+)\s*$/.exec(set);
	if (hyphen) {
		const lo = partial(hyphen[1] as string);
		const hi = partial(hyphen[2] as string);
		if (!lo || !hi) return null;
		const upper = bump(hi.v, hi.parts);
		return (x) => compare(x, lo.v) >= 0 && compare(x, upper) < 0;
	}
	// Re-join `>= 1.2` style (operator separated from its version by a space).
	const tokens = set.replace(/(>=|<=|>|<|=|\^|~>?)\s+/g, "$1").trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return () => true;
	const preds: Predicate[] = [];
	for (const t of tokens) {
		const p = comparator(t);
		if (!p) return null;
		preds.push(p);
	}
	return (x) => preds.every((p) => p(x));
}

/** True when `version` satisfies `range`; unparseable ranges are permissive. */
export function satisfiesRange(version: Version, range: string): boolean {
	const alternatives = range.split("||").map((s) => s.trim());
	let anyParsed = false;
	for (const alt of alternatives) {
		const pred = conjunction(alt);
		if (!pred) continue;
		anyParsed = true;
		if (pred(version)) return true;
	}
	return !anyParsed;
}
