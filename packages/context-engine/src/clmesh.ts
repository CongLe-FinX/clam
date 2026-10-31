import type { ContextAuthor, ContextType } from "@clam/contracts";
import { CONTEXT_ID, MAX_BODY_CHARS, SHA256, canonicalBody, canonicalTitle, contextSha, versionId } from "./canonical.ts";
import type { VersionRecord, VersionRef } from "./versions.ts";

/**
 * Mapping of contexts to the `.clmesh/` directory of a git project (docs/github-integration.md §9). Pure: rendering,
 * parsing and path rules only; the server writes the files (through the secret scanner) and never commits.
 *
 *   .clmesh/memory/<slug>.md · decisions/<yyyy-mm-dd>-<slug>.md · plans/<slug>.md · notes/<slug>.md · summaries/<slug>.md
 *   .clmesh/context/index.json   { contexts: [{ id, path, sha256, version }], schema: 1 }   (sorted keys, one entry per line)
 */

export const CLMESH_DIR = ".clmesh";
export const CLMESH_INDEX = "context/index.json";
export const CLMESH_SCHEMA = 1;
/** Largest `.clmesh/` context file the importer reads. */
export const MAX_FILE_BYTES = 1024 * 1024;

export const TYPE_DIRS: Readonly<Record<ContextType, string>> = {
	memory: "memory",
	decision: "decisions",
	plan: "plans",
	note: "notes",
	summary: "summaries",
};
const DIR_TYPES = new Map<string, ContextType>(Object.entries(TYPE_DIRS).map(([type, dir]) => [dir, type as ContextType]));

/** Lowercase ASCII words joined by `-` (diacritics folded, at most 60 characters); `context` when nothing is left. */
export function slugify(title: string): string {
	const slug = title
		.normalize("NFD")
		.replace(/\p{M}+/gu, "")
		.replace(/đ/g, "d")
		.replace(/Đ/g, "D")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/g, "");
	return slug === "" ? "context" : slug;
}

export interface PathInput {
	id: string;
	type: ContextType;
	title: string;
	/** ISO date of the context's creation (decisions are named by it). */
	createdAt: string;
}

/**
 * Path of a context under `.clmesh/`. `taken` holds the paths already used by other contexts: a clash appends the id's
 * last six characters, so two contexts with one title never share a file.
 */
export function contextPath(c: PathInput, taken: ReadonlySet<string>): string {
	const dir = TYPE_DIRS[c.type];
	const slug = slugify(c.title);
	const stem = c.type === "decision" ? `${c.createdAt.slice(0, 10)}-${slug}` : slug;
	const plain = `${dir}/${stem}.md`;
	if (!taken.has(plain)) return plain;
	return `${dir}/${stem}-${c.id.slice(-6).toLowerCase()}.md`;
}

/** `memory/x.md` and friends; false for anything else (the importer ignores every other path). */
export function isContextFilePath(rel: string): boolean {
	const parts = rel.split("/");
	return parts.length === 2 && DIR_TYPES.has(parts[0] as string) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.md$/.test(parts[1] as string);
}

export function typeOfPath(rel: string): ContextType | null {
	return DIR_TYPES.get(rel.split("/")[0] as string) ?? null;
}

export interface FrontMatter {
	id: string;
	type: ContextType;
	title: string;
	version: number;
	sha256: string;
	/** Id (`<version>:<sha256>`) of the version this one was edited from; null for version 1. */
	base: string | null;
	scope: "workspace" | "project";
	shareable: boolean;
	author: string;
	updated: string;
}

export interface ExportableContext {
	id: string;
	type: ContextType;
	title: string;
	body: string;
	version: number;
	sha256: string;
	base: VersionRef | null;
	scope: "workspace" | "project";
	author: ContextAuthor;
	updatedAt: string;
}

export function describeAuthor(a: ContextAuthor): string {
	return a.kind === "agent" ? `${a.agentName ?? "agent"}@${a.nodeName}` : `${a.kind}@${a.nodeName}`;
}

/** The file content: front matter (JSON-quoted strings, so a title cannot break it) and the canonical body. */
export function renderContextFile(c: ExportableContext): string {
	const front = [
		"---",
		`id: ${c.id}`,
		`type: ${c.type}`,
		`title: ${JSON.stringify(c.title)}`,
		`version: ${c.version}`,
		`sha256: ${c.sha256}`,
		...(c.base ? [`base: ${versionId(c.base)}`] : []),
		`scope: ${c.scope}`,
		"shareable: true",
		`author: ${JSON.stringify(describeAuthor(c.author))}`,
		`updated: ${c.updatedAt}`,
		"---",
	];
	return `${front.join("\n")}\n\n${c.body}`;
}

export type ParsedFile = { ok: true; front: FrontMatter; title: string; body: string } | { ok: false; reason: string };

function scalar(raw: string): unknown {
	const v = raw.trim();
	if (v.startsWith('"')) {
		try {
			return JSON.parse(v);
		} catch {
			return undefined;
		}
	}
	if (v === "true") return true;
	if (v === "false") return false;
	if (/^-?\d+$/.test(v)) return Number(v);
	return v;
}

/** Parse a `.clmesh/` context file. Strict: anything unexpected is a reason to skip the file, never a guess. */
export function parseContextFile(text: string, rel: string): ParsedFile {
	if (text.length > MAX_FILE_BYTES) return { ok: false, reason: "file is larger than 1 MiB" };
	const normal = text.replace(/\r\n?/g, "\n");
	if (!normal.startsWith("---\n")) return { ok: false, reason: "no front matter" };
	const end = normal.indexOf("\n---\n", 3);
	const closing = end !== -1 ? end : normal.endsWith("\n---") ? normal.length - 4 : -1;
	if (closing === -1) return { ok: false, reason: "front matter is not closed" };
	const fields = new Map<string, unknown>();
	for (const line of normal.slice(4, closing).split("\n")) {
		if (line.trim() === "") continue;
		const at = line.indexOf(":");
		if (at <= 0) return { ok: false, reason: `unreadable front matter line: ${line.slice(0, 40)}` };
		const value = scalar(line.slice(at + 1));
		if (value === undefined) return { ok: false, reason: `unreadable value of ${line.slice(0, at)}` };
		fields.set(line.slice(0, at).trim(), value);
	}
	const str = (key: string): string | null => (typeof fields.get(key) === "string" ? (fields.get(key) as string) : null);
	const id = str("id");
	if (id === null || !CONTEXT_ID.test(id)) return { ok: false, reason: "missing or invalid id" };
	const type = str("type") as ContextType | null;
	const dirType = typeOfPath(rel);
	if (type === null || !(Object.keys(TYPE_DIRS) as string[]).includes(type)) return { ok: false, reason: "missing or invalid type" };
	if (dirType !== type) return { ok: false, reason: `type ${type} does not belong in ${rel.split("/")[0]}/` };
	const title = str("title");
	if (title === null || canonicalTitle(title) === "" || title.length > 200) return { ok: false, reason: "missing or invalid title" };
	const version = fields.get("version");
	if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return { ok: false, reason: "missing or invalid version" };
	const sha = str("sha256");
	if (sha === null || !SHA256.test(sha)) return { ok: false, reason: "missing or invalid sha256" };
	const base = str("base");
	if (base !== null && !/^[1-9][0-9]{0,8}:[0-9a-f]{64}$/.test(base)) return { ok: false, reason: "invalid base" };
	const scope = str("scope") === "project" ? "project" : str("scope") === "workspace" ? "workspace" : null;
	if (scope === null) return { ok: false, reason: "missing or invalid scope" };
	if (fields.get("shareable") !== true) return { ok: false, reason: "not marked shareable" };
	const body = canonicalBody(normal.slice(closing + 5));
	if (body.length > MAX_BODY_CHARS) return { ok: false, reason: "body is too long" };
	return {
		ok: true,
		title: canonicalTitle(title),
		body,
		front: { id, type, title, version, sha256: sha, base, scope, shareable: true, author: str("author") ?? "", updated: str("updated") ?? "" },
	};
}

const baseRef = (id: string | null): VersionRef | null => {
	if (id === null) return null;
	const at = id.indexOf(":");
	return { version: Number(id.slice(0, at)), sha256: id.slice(at + 1) };
};

/**
 * What the file means as an incoming version. A file whose content still hashes to its `sha256` is that version
 * (exported earlier, possibly by another node); a file edited by hand is a NEW version based on the one named in its front
 * matter. Either way `classify`/`applyIncoming` decide fast-forward, stale or conflict against the local head.
 */
export function fileToVersion(file: Extract<ParsedFile, { ok: true }>, edit: { author: ContextAuthor; originNodeId: string; at: string }): { version: VersionRecord; edited: boolean } {
	const sha256 = contextSha({ title: file.title, body: file.body });
	const edited = sha256 !== file.front.sha256;
	if (!edited) {
		return {
			edited,
			version: { version: file.front.version, sha256, title: file.title, body: file.body, deleted: false, base: baseRef(file.front.base), merged: [], ancestors: [], author: edit.author, originNodeId: edit.originNodeId, createdAt: edit.at },
		};
	}
	const basis: VersionRef = { version: file.front.version, sha256: file.front.sha256 };
	return {
		edited,
		version: { version: file.front.version + 1, sha256, title: file.title, body: file.body, deleted: false, base: basis, merged: [], ancestors: [versionId(basis)], author: edit.author, originNodeId: edit.originNodeId, createdAt: edit.at },
	};
}

export interface IndexEntry {
	id: string;
	path: string;
	sha256: string;
	version: number;
}

/** `context/index.json`: sorted keys, one entry per line (so two branches adding contexts merge as plain text). */
export function renderIndex(entries: readonly IndexEntry[]): string {
	const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const lines = sorted.map((e) => `    ${JSON.stringify({ id: e.id, path: e.path, sha256: e.sha256, version: e.version })}`);
	return `{\n  "contexts": [${lines.length > 0 ? `\n${lines.join(",\n")}\n  ` : ""}],\n  "schema": ${CLMESH_SCHEMA}\n}\n`;
}

export function parseIndex(text: string): IndexEntry[] | null {
	try {
		const parsed = JSON.parse(text) as { contexts?: unknown };
		if (!Array.isArray(parsed.contexts)) return null;
		const out: IndexEntry[] = [];
		for (const item of parsed.contexts as Array<Record<string, unknown>>) {
			if (typeof item.id === "string" && typeof item.path === "string" && typeof item.sha256 === "string" && typeof item.version === "number") {
				out.push({ id: item.id, path: item.path, sha256: item.sha256, version: item.version });
			}
		}
		return out;
	} catch {
		return null;
	}
}
