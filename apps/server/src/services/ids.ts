import { randomBytes } from "node:crypto";

/** `<prefix>_<16 random hex chars>`, e.g. `ws_3fa91c0b7d2e4a68`. */
export function newId(prefix: string): string {
	return `${prefix}_${randomBytes(8).toString("hex")}`;
}
