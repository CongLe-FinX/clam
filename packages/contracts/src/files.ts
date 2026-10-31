import { z } from "zod";

/**
 * Folder bundles: how working files travel between nodes when there is no git repository (task inputs/results,
 * files-mode shared sessions, handoffs). Built by `@clam/workspace-files`.
 */

export const BundleFile = z.object({
	/** Folder-relative, POSIX separators. */
	path: z.string(),
	size: z.number().int(),
	sha256: z.string(),
	executable: z.boolean(),
});
export type BundleFile = z.infer<typeof BundleFile>;

export const BundleManifest = z.object({
	version: z.literal(1),
	files: z.array(BundleFile),
	/** Paths left out by the default excludes / size caps, so the receiver knows the bundle is partial. */
	skipped: z.array(z.object({ path: z.string(), reason: z.enum(["excluded", "too_large", "symlink", "special"]) })),
	totalSize: z.number().int(),
});
export type BundleManifest = z.infer<typeof BundleManifest>;

export const FilePreviewStatus = z.enum([
	"new", // not in the local folder
	"unchanged", // identical locally
	"update", // local copy unchanged since the base → safe to replace
	"conflict", // local copy changed too → only replaced when listed in `overwrite`
]);
export const FilesPreview = z.object({
	projectId: z.string(),
	files: z.array(z.object({ path: z.string(), status: FilePreviewStatus, size: z.number().int() })),
	/** Unified diffs for text files (capped); binary files have none. */
	diffs: z.record(z.string(), z.string()),
});
export type FilesPreview = z.infer<typeof FilesPreview>;

export const ApplyFilesBody = z.object({
	projectId: z.string().min(1),
	/** Apply only these paths (default: every new/update file). */
	paths: z.array(z.string()).max(5000).optional(),
	/** Conflicting paths the user explicitly chose to overwrite. */
	overwrite: z.array(z.string()).max(5000).default([]),
});
export const FilesApplyResult = z.object({
	written: z.array(z.string()),
	skipped: z.array(z.object({ path: z.string(), reason: z.enum(["unchanged", "conflict", "not_selected"]) })),
});
export type FilesApplyResult = z.infer<typeof FilesApplyResult>;
