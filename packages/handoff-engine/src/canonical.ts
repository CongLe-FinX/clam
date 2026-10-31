import { createHash } from "node:crypto";

/**
 * Canonical JSON (docs/handoff-protocol.md §2): object keys sorted by UTF-16 code unit at every depth,
 * no insignificant whitespace, `undefined` properties omitted (like `JSON.stringify`). The same value
 * always produces the same bytes regardless of key insertion order.
 */
export function canonicalJson(value: unknown): string {
	const out = serialize(value, "$");
	if (out === undefined) throw new TypeError("canonicalJson: value is not JSON-serialisable (undefined/function/symbol)");
	return out;
}

function serialize(value: unknown, path: string): string | undefined {
	if (value === null) return "null";
	switch (typeof value) {
		case "string":
			return JSON.stringify(value);
		case "boolean":
			return value ? "true" : "false";
		case "number":
			if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number at ${path}`);
			return JSON.stringify(value);
		case "undefined":
		case "function":
		case "symbol":
			return undefined;
		case "bigint":
			throw new TypeError(`canonicalJson: bigint at ${path}`);
		default:
			break;
	}
	if (Array.isArray(value)) {
		return `[${value.map((item, i) => serialize(item, `${path}[${i}]`) ?? "null").join(",")}]`;
	}
	const obj = value as Record<string, unknown>;
	if ("toJSON" in obj && typeof obj.toJSON === "function") return serialize(obj.toJSON(), path);
	const parts: string[] = [];
	for (const key of Object.keys(obj).sort()) {
		const encoded = serialize(obj[key], `${path}.${key}`);
		if (encoded !== undefined) parts.push(`${JSON.stringify(key)}:${encoded}`);
	}
	return `{${parts.join(",")}}`;
}

/** SHA-256 (hex) of the canonical UTF-8 bytes of `value`. */
export function sha256OfCanonical(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
