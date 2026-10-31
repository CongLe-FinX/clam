import { BundleError } from "./errors.ts";

/**
 * Validate a folder-relative POSIX path coming from a manifest, a tar entry or a caller. Throws `unsafe_path` for
 * anything that could escape the target folder or touch git internals.
 */
export function assertSafeRelPath(path: string, what = "path"): string {
	if (path.length === 0) throw new BundleError("unsafe_path", `empty ${what}`);
	if (path.includes("\0")) throw new BundleError("unsafe_path", `${what} contains NUL: ${JSON.stringify(path)}`);
	if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.startsWith("\\")) {
		throw new BundleError("unsafe_path", `absolute ${what}: ${path}`);
	}
	const segments = path.split("/");
	for (const segment of segments) {
		if (segment === "" || segment === "." || segment === "..") {
			throw new BundleError("unsafe_path", `unsafe ${what}: ${path}`);
		}
		if (segment.toLowerCase() === ".git") throw new BundleError("unsafe_path", `${what} touches .git: ${path}`);
		if (segment.includes("\\")) throw new BundleError("unsafe_path", `backslash in ${what}: ${path}`);
	}
	return path;
}

/** Normalize a caller-supplied path (`./a//b/`, backslashes not allowed) to the canonical relative form. */
export function normalizeRelPath(path: string): string {
	const trimmed = path.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "").replace(/\/{2,}/g, "/");
	return assertSafeRelPath(trimmed);
}

export function comparePaths(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
