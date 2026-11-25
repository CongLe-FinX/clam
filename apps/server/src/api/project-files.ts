import { randomBytes } from "node:crypto";
import { lstat, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { ATTACHMENT_MAX_BYTES, CreateFolderBody, MoveEntryBody, routes, type FileEntry, i18nMsg } from "@clam/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RoutePluginOptions } from "../context.ts";
import { ApiError } from "../http/errors.ts";
import { sendFile } from "../http/file-response.ts";
import { rawBodyScope } from "../http/raw-body.ts";
import { normalizeRelativePath, resolveInsideRoot } from "../services/files.ts";
import { commitNew, receiveToFile, refuseGitDir, resolveWritableTarget } from "../services/file-writes.ts";
import { checkoutFolder } from "../services/checkouts.ts";

const RawQuery = z.object({
	path: z.string().min(1, "path is required"),
	download: z.enum(["1", "0", "true", "false"]).optional(),
	/** `1`: an HTML file is served as a runnable page in a script sandbox (the viewer's preview); otherwise scripts never run. */
	page: z.enum(["1", "0", "true", "false"]).optional(),
});
const UploadQuery = z.object({
	path: z.string().min(1, "path is required"),
	overwrite: z.enum(["1", "0", "true", "false"]).optional(),
	/**
	 * Save from an editor: the file's `modifiedAt` when it was read. Replacing is refused (409 `file_changed`) when the file has changed
	 * or gone since, so an edit made meanwhile (by an agent, a teammate) is never overwritten unseen. Implies `overwrite`.
	 */
	expectedModifiedAt: z.string().optional(),
});

/** The listing entry of what is at `abs` now (lstat: a symlink is reported as one). */
async function entryAt(abs: string, rel: string): Promise<FileEntry> {
	const info = await lstat(abs);
	const kind = info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "dir" : "file";
	return { name: path.posix.basename(rel), path: rel, kind, size: kind === "file" ? info.size : null, modifiedAt: info.mtime.toISOString() };
}

/** Raw file bytes of a project folder or shared-session worktree (`:id` is a checkout id; preview/download), raw uploads into it, new folders and moves. */
export default async function projectFileRoutes(app: FastifyInstance, { ctx }: RoutePluginOptions): Promise<void> {
	app.post<{ Params: { id: string } }>(routes.projectFolder(":id"), async (req, reply): Promise<FileEntry> => {
		const root = await checkoutFolder(ctx, req.params.id);
		const { rel, abs } = await resolveWritableTarget(root, CreateFolderBody.parse(req.body).path);
		try {
			await mkdir(abs);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") throw ApiError.conflict(i18nMsg('"{rel}" already exists', { rel }));
			throw error;
		}
		return reply.status(201).send(await entryAt(abs, rel));
	});

	/**
	 * Move or rename one entry inside the project. The entry itself moves (a symlink stays a link); the target's parent folders are created,
	 * both ends stay inside the project and outside `.git`, an existing target is never replaced, and a folder never moves into itself.
	 */
	app.post<{ Params: { id: string } }>(routes.projectMove(":id"), async (req): Promise<FileEntry> => {
		const root = await checkoutFolder(ctx, req.params.id);
		const body = MoveEntryBody.parse(req.body);
		const from = normalizeRelativePath(body.from);
		const to = normalizeRelativePath(body.to);
		if (from === "" || to === "") throw ApiError.badRequest(i18nMsg("path must name a file"));
		refuseGitDir(from);
		refuseGitDir(to);
		const slash = from.lastIndexOf("/");
		const parent = await resolveInsideRoot(root, slash < 0 ? "" : from.slice(0, slash));
		const source = path.join(parent.abs, from.slice(slash + 1));
		const info = await lstat(source).catch(() => null);
		if (!info) throw ApiError.notFound(`Path "${from}"`);
		if (to === from) return entryAt(source, from);
		if (info.isDirectory() && to.startsWith(`${from}/`)) throw ApiError.badRequest(i18nMsg("A folder cannot be moved into itself"));
		const target = await resolveWritableTarget(root, to);
		const inside = path.relative(source, target.abs);
		if (info.isDirectory() && !inside.startsWith("..") && !path.isAbsolute(inside)) throw ApiError.badRequest(i18nMsg("A folder cannot be moved into itself"));
		// On a case-insensitive disk `Readme.md` → `README.md` finds the entry itself at the target: a rename, not a clash.
		const existing = await lstat(target.abs).catch(() => null);
		if (existing && !(existing.ino === info.ino && existing.dev === info.dev)) throw ApiError.conflict(i18nMsg('"{rel}" already exists', { rel: target.rel }));
		await rename(source, target.abs);
		return entryAt(target.abs, target.rel);
	});

	app.get<{ Params: { id: string } }>(routes.projectRaw(":id"), { config: { compress: false } }, async (req, reply) => {
		const root = await checkoutFolder(ctx, req.params.id);
		const query = RawQuery.parse(req.query);
		const { rel, abs } = await resolveInsideRoot(root, query.path);
		if (rel === "") throw ApiError.badRequest(i18nMsg("path must name a file"));
		refuseGitDir(rel);
		const info = await stat(abs);
		if (!info.isFile()) throw ApiError.badRequest(i18nMsg('"{rel}" is not a regular file', { rel }));
		return sendFile(req, reply, { abs, size: info.size, name: path.posix.basename(rel), download: query.download === "1" || query.download === "true", page: query.page === "1" || query.page === "true" });
	});

	// Raw uploads live in their own scope: that scope hands the request stream over untouched (no JSON parsing, no buffering).
	await app.register(async (upload) => {
		rawBodyScope(upload);
		upload.post<{ Params: { id: string } }>(routes.projectUpload(":id"), { bodyLimit: ATTACHMENT_MAX_BYTES }, async (req, reply): Promise<FileEntry> => {
			const root = await checkoutFolder(ctx, req.params.id);
			const query = UploadQuery.parse(req.query);
			const overwrite = query.overwrite === "1" || query.overwrite === "true" || query.expectedModifiedAt !== undefined;
			const { rel, abs } = await resolveWritableTarget(root, query.path);
			const existing = await lstat(abs).catch(() => null);
			if (existing?.isDirectory()) throw ApiError.conflict(i18nMsg('"{rel}" is a folder', { rel }));
			if (query.expectedModifiedAt !== undefined && existing?.mtime.toISOString() !== query.expectedModifiedAt) {
				const changed = existing
					? i18nMsg('"{rel}" was changed since you opened it', { rel })
					: i18nMsg('"{rel}" was deleted since you opened it', { rel });
				throw new ApiError(409, "file_changed", changed, { modifiedAt: existing?.mtime.toISOString() ?? null });
			}
			if (existing && !overwrite) throw ApiError.conflict(i18nMsg('"{rel}" already exists; send overwrite=1 to replace it', { rel }));
			const tmp = path.join(path.dirname(abs), `.clam-upload-${randomBytes(6).toString("hex")}.tmp`);
			const size = await receiveToFile(req.body, tmp, ATTACHMENT_MAX_BYTES, req.headers["content-length"]);
			await commitNew(tmp, abs, rel, overwrite);
			const written = await stat(abs);
			return reply.status(201).send({ name: path.posix.basename(rel), path: rel, kind: "file", size, modifiedAt: written.mtime.toISOString() } satisfies FileEntry);
		});
	});
}
