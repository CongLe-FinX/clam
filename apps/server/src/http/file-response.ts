import { createReadStream } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";

/** Content types of the files agents and people produce (media, documents, images, text). Unknown extensions are served as opaque bytes. */
const TYPES: Record<string, string> = {
	// text
	txt: "text/plain; charset=utf-8",
	log: "text/plain; charset=utf-8",
	md: "text/markdown; charset=utf-8",
	markdown: "text/markdown; charset=utf-8",
	csv: "text/csv; charset=utf-8",
	tsv: "text/tab-separated-values; charset=utf-8",
	json: "application/json; charset=utf-8",
	yml: "text/plain; charset=utf-8",
	yaml: "text/plain; charset=utf-8",
	toml: "text/plain; charset=utf-8",
	ini: "text/plain; charset=utf-8",
	xml: "application/xml; charset=utf-8",
	html: "text/html; charset=utf-8",
	htm: "text/html; charset=utf-8",
	css: "text/css; charset=utf-8",
	js: "text/javascript; charset=utf-8",
	mjs: "text/javascript; charset=utf-8",
	ts: "text/plain; charset=utf-8",
	tsx: "text/plain; charset=utf-8",
	py: "text/plain; charset=utf-8",
	sh: "text/plain; charset=utf-8",
	srt: "text/plain; charset=utf-8",
	vtt: "text/vtt; charset=utf-8",
	tex: "text/plain; charset=utf-8",
	// documents
	pdf: "application/pdf",
	doc: "application/msword",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xls: "application/vnd.ms-excel",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	ppt: "application/vnd.ms-powerpoint",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	zip: "application/zip",
	gz: "application/gzip",
	tar: "application/x-tar",
	// images
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	bmp: "image/bmp",
	ico: "image/x-icon",
	svg: "image/svg+xml",
	// video
	mp4: "video/mp4",
	m4v: "video/mp4",
	webm: "video/webm",
	mov: "video/quicktime",
	mkv: "video/x-matroska",
	ogv: "video/ogg",
	// audio
	mp3: "audio/mpeg",
	wav: "audio/wav",
	ogg: "audio/ogg",
	oga: "audio/ogg",
	opus: "audio/ogg",
	m4a: "audio/mp4",
	aac: "audio/aac",
	flac: "audio/flac",
};

/** Types a browser would execute (or style) when it opens the file as a page: served inside a script-less sandbox. */
const ACTIVE = /^(text\/html|image\/svg\+xml|application\/xml)\b/;
/** A file response carries its own policy (the app's page-level one would forbid framing): the app's pages may frame it (PDF/HTML preview), nobody else. */
const FILE_CSP = "frame-ancestors 'self'";
/** Pages a browser would open as documents: no scripts, no network, opaque origin. */
const ACTIVE_CSP = `sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; ${FILE_CSP}`;
/**
 * An HTML file the person asked to *run* (the viewer's page preview): its scripts, inline styles and https resources (CDN scripts,
 * web fonts, pictures) work, but it stays in an opaque-origin sandbox with no network calls (`connect-src 'none'`), no forms and
 * no top navigation, so it can neither read nor drive this node's API.
 */
const PAGE_CSP = [
	"sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals",
	"default-src 'none'",
	"script-src 'unsafe-inline' 'unsafe-eval' https:",
	"style-src 'unsafe-inline' https:",
	"font-src https: data:",
	"img-src https: data: blob:",
	"media-src https: data: blob:",
	"connect-src 'none'",
	"form-action 'none'",
	"base-uri 'none'",
	FILE_CSP,
].join("; ");

export function contentTypeFor(fileName: string): string {
	const dot = fileName.lastIndexOf(".");
	return (dot < 0 ? undefined : TYPES[fileName.slice(dot + 1).toLowerCase()]) ?? "application/octet-stream";
}

/** `inline; filename="…"; filename*=UTF-8''…` (RFC 6266), safe for any name. */
export function contentDisposition(fileName: string, mode: "inline" | "attachment"): string {
	const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/g, "_");
	return `${mode}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

export type ByteRange = { start: number; end: number } | "unsatisfiable" | null;

/** One `bytes=` range of a request against a file of `size` bytes. Several ranges (or a malformed header) are ignored: the whole file is served, as HTTP allows. */
export function parseRange(header: string | undefined, size: number): ByteRange {
	if (header === undefined) return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match) return null;
	const [, from = "", to = ""] = match;
	if (from === "" && to === "") return null;
	if (from === "") {
		const suffix = Number(to);
		if (suffix === 0) return "unsatisfiable";
		return size === 0 ? "unsatisfiable" : { start: Math.max(0, size - suffix), end: size - 1 };
	}
	const start = Number(from);
	if (start >= size) return "unsatisfiable";
	const end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
	return end < start ? null : { start, end };
}

export interface FileResponse {
	/** Real absolute path of the file. */
	abs: string;
	size: number;
	/** Name shown to the person (download name, type detection when `mimeType` is absent). */
	name: string;
	mimeType?: string | undefined;
	download: boolean;
	/** The bytes are not on disk yet but arrive as this stream (a lazily fetched file served while it is being stored): sent whole as a 200, `Range` is ignored. */
	live?: Readable | undefined;
	/** Serve HTML as a runnable page (`PAGE_CSP`) instead of the script-less sandbox. Other types are unaffected. */
	page?: boolean | undefined;
}

/**
 * Stream a file with HTTP range support (206 for video/audio seeking and PDF viewers), the right content type and an
 * `attachment` disposition on request. Never compressed (ranges and compression do not mix); pages a browser would run are
 * sandboxed without scripts, and the file carries its own policy so it can be framed by the app.
 */
export function sendFile(request: FastifyRequest, reply: FastifyReply, file: FileResponse): FastifyReply {
	const given = file.mimeType && file.mimeType !== "application/octet-stream" ? file.mimeType : contentTypeFor(file.name);
	const type = given.startsWith("text/") && !given.includes("charset") ? `${given}; charset=utf-8` : given;
	reply
		.header("Accept-Ranges", "bytes")
		.header("Content-Type", type)
		.header("Content-Disposition", contentDisposition(file.name, file.download ? "attachment" : "inline"))
		.header("X-Content-Type-Options", "nosniff")
		.header("Content-Security-Policy", ACTIVE.test(type) ? (file.page && type.startsWith("text/html") ? PAGE_CSP : ACTIVE_CSP) : FILE_CSP);
	if (file.live) return reply.status(200).header("Content-Length", file.size).send(file.live);
	const range = parseRange(request.headers.range, file.size);
	if (range === "unsatisfiable") return reply.status(416).header("Content-Range", `bytes */${file.size}`).send();
	if (range === null) return reply.status(200).header("Content-Length", file.size).send(createReadStream(file.abs));
	return reply
		.status(206)
		.header("Content-Range", `bytes ${range.start}-${range.end}/${file.size}`)
		.header("Content-Length", range.end - range.start + 1)
		.send(createReadStream(file.abs, { start: range.start, end: range.end }));
}

/** Extension-less, separator-free file name that is safe to create inside a folder: no control characters, no path parts, bounded length. */
export function safeFileName(input: string): string {
	let name = path.posix.basename(input.replaceAll("\\", "/")).replace(/[\u0000-\u001f\u007f]/g, "").trim();
	if (name === "" || name === "." || name === "..") name = "file";
	if (name.length > 200) {
		const ext = path.extname(name).slice(0, 20);
		name = `${name.slice(0, 200 - ext.length)}${ext}`;
	}
	return name;
}
