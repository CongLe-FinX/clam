import type { Dirent } from "node:fs";
import { lstat, open, readdir, realpath, stat, access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { DirSuggestion, FileContent, FileEntry } from "@clam/contracts";
import { ApiError } from "../http/errors.ts";

/** Largest file whose content is returned inline. */
export const MAX_FILE_BYTES = 512 * 1024;
const BINARY_SNIFF_BYTES = 8000;
const SKIPPED_DIRS = new Set([".git", "node_modules"]);
const MAX_SUGGESTIONS = 20;

const invalidPath = (message: string) => new ApiError(400, "invalid_path", message);
const outsideProject = () => new ApiError(403, "path_outside_project", "Path resolves outside the project root");

function isInside(root: string, target: string): boolean {
	const rel = path.relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Validate a client-supplied relative path and return its normalized POSIX form ("" = root). */
export function normalizeRelativePath(input: string): string {
	if (input.includes("\0")) throw invalidPath("Path contains a NUL byte");
	if (input.startsWith("/") || input.startsWith("\\") || path.isAbsolute(input) || /^[A-Za-z]:/.test(input)) {
		throw invalidPath("Path must be relative to the project root");
	}
	const segments = input.split(/[\\/]/).filter((s) => s !== "" && s !== ".");
	if (segments.includes("..")) throw invalidPath("Path must not contain '..' segments");
	return segments.join("/");
}

export interface ResolvedPath {
	/** Normalized POSIX path relative to the project root ("" = root). */
	rel: string;
	/** Real absolute path of the target (symlinks resolved). */
	abs: string;
}

/**
 * Resolve a relative path against a project root. The target is canonicalized with `realpath`, so a
 * symlink that leads outside the real root is rejected (403 `path_outside_project`).
 */
export async function resolveInsideRoot(root: string, relInput: string): Promise<ResolvedPath> {
	const rel = normalizeRelativePath(relInput);
	let realRoot: string;
	try {
		realRoot = await realpath(root);
	} catch {
		throw new ApiError(404, "project_path_missing", "Project directory no longer exists on this node");
	}
	let abs: string;
	try {
		abs = await realpath(path.join(realRoot, ...rel.split("/").filter(Boolean)));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ENOTDIR") {
			throw ApiError.notFound(`Path "${rel}"`);
		}
		throw err;
	}
	if (!isInside(realRoot, abs)) throw outsideProject();
	return { rel, abs };
}

/** List ONE directory level, directories first, then case-insensitive by name. */
export async function listDirectory(root: string, relInput: string): Promise<FileEntry[]> {
	const { rel, abs } = await resolveInsideRoot(root, relInput);
	const info = await stat(abs);
	if (!info.isDirectory()) throw ApiError.badRequest(`"${rel}" is not a directory`);
	let dirents: Dirent[];
	try {
		dirents = await readdir(abs, { withFileTypes: true });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EACCES" || (err as NodeJS.ErrnoException).code === "EPERM") {
			throw new ApiError(403, "forbidden", `Cannot read directory "${rel}"`);
		}
		throw err;
	}
	const entries = await Promise.all(
		dirents
			.filter((d) => !SKIPPED_DIRS.has(d.name))
			.map(async (d): Promise<FileEntry | null> => {
				let st;
				try {
					st = await lstat(path.join(abs, d.name));
				} catch {
					return null; // vanished or unreadable between readdir and lstat
				}
				const kind = st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : "file";
				return {
					name: d.name,
					path: rel === "" ? d.name : `${rel}/${d.name}`,
					kind,
					size: kind === "file" ? st.size : null,
					modifiedAt: st.mtime.toISOString(),
				};
			}),
	);
	return entries
		.filter((e): e is FileEntry => e !== null)
		.sort((a, b) => {
			const ad = a.kind === "dir" ? 0 : 1;
			const bd = b.kind === "dir" ? 0 : 1;
			if (ad !== bd) return ad - bd;
			const byName = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
			return byName !== 0 ? byName : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
		});
}

const LANGUAGE_BY_EXT: Record<string, string> = {
	ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
	js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
	json: "json", jsonc: "jsonc", json5: "json",
	md: "markdown", markdown: "markdown", mdx: "mdx",
	py: "python", pyi: "python",
	rs: "rust", go: "go", java: "java", kt: "kotlin", kts: "kotlin", swift: "swift",
	c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp",
	cs: "csharp", rb: "ruby", php: "php",
	sh: "shell", bash: "shell", zsh: "shell", fish: "shell", ps1: "powershell",
	sql: "sql", html: "html", htm: "html", css: "css", scss: "scss", less: "less",
	vue: "vue", svelte: "svelte",
	yml: "yaml", yaml: "yaml", toml: "toml", ini: "ini", xml: "xml", svg: "xml",
	graphql: "graphql", gql: "graphql", proto: "protobuf", lua: "lua", dart: "dart", zig: "zig",
	tf: "hcl", tfvars: "hcl", hcl: "hcl", dockerfile: "dockerfile",
	r: "r", scala: "scala", ex: "elixir", exs: "elixir", clj: "clojure", hs: "haskell", pl: "perl",
	txt: "plaintext",
};

const LANGUAGE_BY_FILENAME: Record<string, string> = {
	dockerfile: "dockerfile",
	makefile: "makefile",
	gnumakefile: "makefile",
	".bashrc": "shell",
	".zshrc": "shell",
	".profile": "shell",
	".gitignore": "ini",
	".gitattributes": "ini",
	".editorconfig": "ini",
	".env": "ini",
	"cmakelists.txt": "cmake",
	"tsconfig.json": "jsonc",
	"jsconfig.json": "jsonc",
	".eslintrc": "json",
	".prettierrc": "json",
};

/** Monaco/Shiki-style language id for a file name, or null when unknown. */
export function languageFor(fileName: string): string | null {
	const base = path.posix.basename(fileName.replaceAll("\\", "/")).toLowerCase();
	const byName = LANGUAGE_BY_FILENAME[base];
	if (byName) return byName;
	if (base.startsWith("dockerfile.")) return "dockerfile";
	const dot = base.lastIndexOf(".");
	return dot < 0 ? null : (LANGUAGE_BY_EXT[base.slice(dot + 1)] ?? null);
}

/**
 * Decode file bytes: `null` when the data looks binary (NUL byte in the first 8000 bytes or invalid
 * UTF-8).
 */
export function decodeText(bytes: Uint8Array): string | null {
	const sniff = bytes.subarray(0, BINARY_SNIFF_BYTES);
	if (sniff.includes(0)) return null;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

export async function readProjectFile(root: string, relInput: string): Promise<FileContent> {
	const { rel, abs } = await resolveInsideRoot(root, relInput);
	if (rel === "") throw ApiError.badRequest("Path must name a file");
	const info = await stat(abs);
	if (info.isDirectory()) throw ApiError.badRequest(`"${rel}" is a directory`);
	if (!info.isFile()) throw ApiError.badRequest(`"${rel}" is not a regular file`);
	const language = languageFor(rel);
	if (info.size > MAX_FILE_BYTES) {
		return { path: rel, size: info.size, content: null, truncated: true, binary: false, language };
	}
	const handle = await open(abs, "r");
	let bytes: Buffer;
	try {
		const buf = Buffer.alloc(Math.min(info.size, MAX_FILE_BYTES));
		let read = 0;
		while (read < buf.length) {
			const { bytesRead } = await handle.read(buf, read, buf.length - read, read);
			if (bytesRead === 0) break;
			read += bytesRead;
		}
		bytes = buf.subarray(0, read);
	} finally {
		await handle.close();
	}
	const text = decodeText(bytes);
	return {
		path: rel,
		size: info.size,
		content: text,
		truncated: false,
		binary: text === null,
		language,
	};
}

async function isDirectoryLike(full: string, dirent: Dirent): Promise<boolean> {
	if (dirent.isDirectory()) return true;
	if (!dirent.isSymbolicLink()) return false;
	try {
		return (await stat(full)).isDirectory();
	} catch {
		return false;
	}
}

async function exists(p: string): Promise<boolean> {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
}

/**
 * Directory completions for the project-path picker. Never throws: unusable input yields `[]`.
 * `home` is injectable for tests.
 */
export async function suggestDirectories(prefix: string, home: string = homedir()): Promise<DirSuggestion[]> {
	try {
		if (prefix.includes("\0")) return [];
		let input = prefix.trim();
		if (input === "~") input = `${home}${path.sep}`;
		else if (input.startsWith("~/") || input.startsWith(`~${path.sep}`)) input = path.join(home, input.slice(2)) + (/[\\/]$/.test(input) ? path.sep : "");
		if (input === "" || !path.isAbsolute(input)) input = `${home}${path.sep}`;

		let dir: string;
		let fragment: string;
		if (/[\\/]$/.test(input)) {
			dir = input;
			fragment = "";
		} else {
			dir = path.dirname(input);
			fragment = path.basename(input);
		}
		const needle = fragment.toLowerCase();
		const showHidden = fragment.startsWith(".");

		let dirents: Dirent[];
		try {
			dirents = await readdir(dir, { withFileTypes: true });
		} catch {
			return [];
		}
		const candidates = dirents.filter(
			(d) => d.name.toLowerCase().startsWith(needle) && (showHidden || !d.name.startsWith(".")),
		);
		const resolved = await Promise.all(
			candidates.map(async (d): Promise<DirSuggestion | null> => {
				const full = path.join(dir, d.name);
				if (!(await isDirectoryLike(full, d))) return null;
				try {
					await access(full, constants.R_OK | constants.X_OK);
				} catch {
					return null;
				}
				return { path: full, isGitRepo: await exists(path.join(full, ".git")) };
			}),
		);
		return resolved
			.filter((s): s is DirSuggestion => s !== null)
			.sort((a, b) => path.basename(a.path).toLowerCase().localeCompare(path.basename(b.path).toLowerCase()))
			.slice(0, MAX_SUGGESTIONS);
	} catch {
		return [];
	}
}

/** Validate and canonicalize a project working directory; throws 400 `invalid_request` when unusable. */
export async function canonicalProjectDir(input: string): Promise<string> {
	if (input.includes("\0")) throw ApiError.badRequest("Project path contains a NUL byte");
	if (!path.isAbsolute(input)) throw ApiError.badRequest("Project path must be absolute");
	let real: string;
	try {
		real = await realpath(input);
	} catch {
		throw ApiError.badRequest(`Project path does not exist: ${input}`);
	}
	if (!(await stat(real)).isDirectory()) throw ApiError.badRequest(`Project path is not a directory: ${input}`);
	return real;
}
