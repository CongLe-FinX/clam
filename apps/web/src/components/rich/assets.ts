import { routes, type SharedAttachment, type TurnOutputFile } from "@clam/contracts";
import { localUrl } from "@/lib/api";
import { type PreviewKind, previewKind } from "@/lib/file-kind";

/** A file the chat can show: where its bytes are, how to download it, what it is. */
export interface RichFile {
	/** Stable key (path or attachment id). */
	key: string;
	name: string;
	/** Inline bytes URL (Range-capable). */
	url: string;
	downloadUrl: string;
	mimeType?: string;
	size?: number;
	kind: PreviewKind;
	/** Project-relative path when the file lives in the session's project folder (enables "Open in Files"). */
	path?: string;
	/** Group-chat attachment whose bytes have not reached this machine yet (it is fetched from a member when opened). */
	pending?: boolean;
}

/** Turns the relative paths an agent writes in markdown (`![chart](out/chart.png)`) into files the UI can load. */
export interface AssetResolver {
	/** Null when the path names nothing this chat can show. */
	resolve(href: string): RichFile | null;
}

/**
 * Strip `./`, a leading `/`, query/hash and percent-encoding: `./out/My%20chart.png?x#y` → `out/My chart.png`. With `base` (a folder of
 * the project), the path is taken relative to it and may climb out of it with `..`, never above the project root.
 */
export function normalizeRelative(href: string, base = ""): string | null {
	if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//") || href.startsWith("#")) return null;
	let p = href.split(/[?#]/, 1)[0] ?? "";
	try {
		p = decodeURIComponent(p);
	} catch {
		/* keep as is */
	}
	p = p.replace(/\\/g, "/");
	// A leading `/` means the project root, not the base folder.
	const parts: string[] = p.startsWith("/") ? [] : base.split("/").filter((s) => s !== "" && s !== ".");
	for (const seg of p.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") {
			if (parts.length === 0) return null;
			parts.pop();
			continue;
		}
		parts.push(seg);
	}
	return parts.length ? parts.join("/") : null;
}

const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/** A file in the session's project folder, served by `projectRaw`. */
export function projectFile(projectId: string, file: Pick<TurnOutputFile, "path" | "name" | "size" | "mimeType">): RichFile {
	return {
		key: file.path,
		name: file.name,
		url: localUrl(routes.projectRaw(projectId), { path: file.path }),
		downloadUrl: localUrl(routes.projectRaw(projectId), { path: file.path, download: 1 }),
		mimeType: file.mimeType,
		size: file.size,
		kind: previewKind(file.name, file.mimeType),
		path: file.path,
	};
}

/**
 * Markdown paths resolve against the session's project folder, or against `baseDir` (the folder of the markdown file being shown, so
 * `images/x.png` next to a document works). Unknown files render as broken-image cards, never as a request storm.
 */
export function projectAssets(projectId: string, baseDir = ""): AssetResolver {
	return {
		resolve(href) {
			const rel = normalizeRelative(href, baseDir);
			if (!rel) return null;
			return projectFile(projectId, { path: rel, name: baseName(rel), size: 0, mimeType: "" });
		},
	};
}

/** A group-chat attachment, served by `sharedAttachment`. */
export function attachmentFile(sharedId: string, a: SharedAttachment): RichFile {
	return {
		key: a.id,
		name: a.name,
		url: localUrl(routes.sharedAttachment(sharedId, a.id)),
		downloadUrl: localUrl(routes.sharedAttachment(sharedId, a.id), { download: 1 }),
		mimeType: a.mimeType,
		size: a.size,
		kind: previewKind(a.name, a.mimeType),
		pending: !a.available,
	};
}

/** Markdown paths in a group message resolve to the attachments of that message whose names match the path's base name (or full path). */
export function attachmentAssets(sharedId: string, attachments: readonly SharedAttachment[]): AssetResolver | undefined {
	if (attachments.length === 0) return undefined;
	return {
		resolve(href) {
			const rel = normalizeRelative(href);
			if (!rel) return null;
			const base = baseName(rel);
			const hit = attachments.find((a) => a.name === rel) ?? attachments.find((a) => a.name === base);
			return hit ? attachmentFile(sharedId, hit) : null;
		},
	};
}
