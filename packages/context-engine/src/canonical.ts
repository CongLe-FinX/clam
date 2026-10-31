import { createHash } from "node:crypto";

/** `ctx_` + 8–32 alphanumerics: what this node generates (`ctx_<16 hex>`) and what it accepts from peers and `.clmesh/` files. */
export const CONTEXT_ID = /^ctx_[A-Za-z0-9]{8,32}$/;

export const MAX_TITLE_CHARS = 200;
export const MAX_BODY_CHARS = 200_000;

/** One line, single spaces. */
export function canonicalTitle(title: string): string {
	return title.replace(/\s+/g, " ").trim();
}

/**
 * The body as stored and hashed: LF line endings, no leading blank lines, no trailing whitespace at the end, and (when not
 * empty) exactly one final newline — so an editor that adds or drops the final newline, or a Windows checkout, never
 * changes a version.
 */
export function canonicalBody(body: string): string {
	const text = body.replace(/\r\n?/g, "\n").replace(/^\n+/, "").trimEnd();
	return text === "" ? "" : `${text}\n`;
}

/**
 * sha-256 (hex) over the canonical content of a version. The title is part of the content (renaming is an edit); a
 * tombstone hashes differently from a live version with the same title. `title` and `body` must already be canonical.
 */
export function contextSha(content: { title: string; body: string; deleted?: boolean }): string {
	return createHash("sha256")
		.update(`clam-context-v1\n${content.deleted ? "deleted" : "live"}\n${content.title}\n\n${content.body}`, "utf8")
		.digest("hex");
}

export const SHA256 = /^[0-9a-f]{64}$/;

/** `<version>:<sha256>`: the identity of a version (the same text written as the same version number is the same version). */
export function versionId(v: { version: number; sha256: string }): string {
	return `${v.version}:${v.sha256}`;
}
