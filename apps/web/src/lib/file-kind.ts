export type PreviewKind = "image" | "video" | "audio" | "pdf" | "text" | "other";

const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico"]);
const VIDEO = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);
const AUDIO = new Set(["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus"]);

const extOf = (name: string): string => (name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "");

/** What the UI can render inline for a file, from its MIME type when known, else its extension. */
export function previewKind(name: string, mime?: string | null): PreviewKind {
	const m = (mime ?? "").toLowerCase();
	if (m.startsWith("image/")) return "image";
	if (m.startsWith("video/")) return "video";
	if (m.startsWith("audio/")) return "audio";
	if (m === "application/pdf") return "pdf";
	const ext = extOf(name);
	if (IMAGE.has(ext)) return "image";
	if (VIDEO.has(ext)) return "video";
	if (AUDIO.has(ext)) return "audio";
	if (ext === "pdf") return "pdf";
	if (m.startsWith("text/") || m === "application/json") return "text";
	return "other";
}

/** Kinds the browser plays/draws from the raw bytes endpoint instead of the text-content endpoint. */
export const isMediaKind = (k: PreviewKind): boolean => k === "image" || k === "video" || k === "audio" || k === "pdf";

export type FileCategory = "image" | "video" | "audio" | "pdf" | "spreadsheet" | "document" | "presentation" | "archive" | "code" | "data" | "text" | "other";

const SPREADSHEET = new Set(["xls", "xlsx", "xlsm", "ods", "csv", "tsv", "numbers"]);
const DOCUMENT = new Set(["doc", "docx", "odt", "rtf", "pages", "epub"]);
const PRESENTATION = new Set(["ppt", "pptx", "odp", "key"]);
const ARCHIVE = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "zst"]);
const DATA = new Set(["json", "jsonl", "ndjson", "yaml", "yml", "toml", "xml", "parquet", "db", "sqlite", "sqlite3", "ipynb"]);
const CODE = new Set([
	"ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "java", "kt", "swift", "rb", "php", "c", "h", "cpp", "cc", "hpp", "cs",
	"sh", "bash", "zsh", "sql", "html", "htm", "css", "scss", "vue", "svelte", "diff", "patch", "lua", "r", "dart",
]);
const TEXT = new Set(["txt", "md", "mdx", "log", "rst", "ini", "env", "conf"]);

/** Coarse file family for icons and labels (what kind of file this is, not whether the browser can render it). */
export function fileCategory(name: string, mime?: string | null): FileCategory {
	const k = previewKind(name, mime);
	if (k === "image" || k === "video" || k === "audio" || k === "pdf") return k;
	const m = (mime ?? "").toLowerCase();
	const ext = extOf(name);
	if (SPREADSHEET.has(ext) || m.includes("spreadsheet") || m.includes("ms-excel") || m === "text/csv") return "spreadsheet";
	if (PRESENTATION.has(ext) || m.includes("presentation") || m.includes("powerpoint")) return "presentation";
	if (DOCUMENT.has(ext) || m.includes("wordprocessing") || m === "application/msword") return "document";
	if (ARCHIVE.has(ext) || m.includes("zip") || m.includes("tar") || m.includes("compressed")) return "archive";
	if (DATA.has(ext) || m === "application/json" || m.endsWith("+json") || m.endsWith("/xml") || m.endsWith("yaml")) return "data";
	if (CODE.has(ext) || m.includes("javascript") || m.includes("typescript")) return "code";
	if (TEXT.has(ext) || m.startsWith("text/")) return "text";
	return "other";
}

/** Upper-case extension for badges (`report.xlsx` → `XLSX`); empty when there is none. */
export const fileExt = (name: string): string => extOf(name).toUpperCase();
