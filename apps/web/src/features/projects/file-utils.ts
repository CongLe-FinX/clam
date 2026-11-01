import type { FileEntry } from "@clam/contracts";
import { File, FileArchive, FileCode, FileCog, FileImage, FileJson, FileLock, FileTerminal, FileText } from "lucide-react";

const CODE_EXT = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "java", "c", "h", "cpp", "cc", "hpp", "rb", "php", "swift", "kt", "css", "scss", "html", "htm", "vue", "svelte", "sql", "lua", "zig"]);
const IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "avif", "bmp"]);
const ARCHIVE_EXT = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar"]);
const CONFIG_EXT = new Set(["yml", "yaml", "toml", "ini", "conf", "cfg", "env"]);
const TEXT_EXT = new Set(["md", "mdx", "txt", "rst", "log", "csv"]);

export function fileIcon(name: string): { Icon: typeof File; tone: string } {
	const lower = name.toLowerCase();
	if (lower.endsWith(".lock") || lower === "pnpm-lock.yaml" || lower === "package-lock.json") return { Icon: FileLock, tone: "text-subtle" };
	if (lower.startsWith(".env")) return { Icon: FileCog, tone: "text-warning" };
	const ext = lower.includes(".") ? (lower.split(".").pop() as string) : "";
	if (ext === "json" || ext === "jsonc" || ext === "jsonl") return { Icon: FileJson, tone: "text-warning" };
	if (ext === "sh" || ext === "bash" || ext === "zsh") return { Icon: FileTerminal, tone: "text-success" };
	if (CODE_EXT.has(ext)) return { Icon: FileCode, tone: "text-accent" };
	if (IMG_EXT.has(ext)) return { Icon: FileImage, tone: "text-info" };
	if (ARCHIVE_EXT.has(ext)) return { Icon: FileArchive, tone: "text-subtle" };
	if (CONFIG_EXT.has(ext)) return { Icon: FileCog, tone: "text-muted-foreground" };
	if (TEXT_EXT.has(ext)) return { Icon: FileText, tone: "text-muted-foreground" };
	return { Icon: File, tone: "text-subtle" };
}

export const byKindThenName = (a: FileEntry, b: FileEntry) => {
	const ad = a.kind === "dir" ? 0 : 1;
	const bd = b.kind === "dir" ? 0 : 1;
	return ad - bd || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
};

export const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
export function ancestorsOf(p: string): string[] {
	const parts = p.split("/");
	const out: string[] = [];
	for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
	return out;
}

