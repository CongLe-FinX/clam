import { randomBytes } from "node:crypto";
import { lstat, stat } from "node:fs/promises";
import path from "node:path";
import { ATTACHMENT_MAX_BYTES, routes, type FileEntry, i18nMsg } from "@clam/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RoutePluginOptions } from "../context.ts";
import { ApiError } from "../http/errors.ts";
import { sendFile } from "../http/file-response.ts";
import { rawBodyScope } from "../http/raw-body.ts";
import { resolveInsideRoot } from "../services/files.ts";
import { commitNew, receiveToFile, refuseGitDir, resolveWritableTarget } from "../services/file-writes.ts";
import { requireProject } from "./projects.ts";

const RawQuery = z.object({
	path: z.string().min(1, "path is required"),
	download: z.enum(["1", "0", "true", "false"]).optional(),
});
const UploadQuery = z.object({
	path: z.string().min(1, "path is required"),
	overwrite: z.enum(["1", "0", "true", "false"]).optional(),
});

/** Raw file bytes of a project folder (preview/download) and raw uploads into it. */
export default async function projectFileRoutes(app: FastifyInstance, { ctx }: RoutePluginOptions): Promise<void> {
	app.get<{ Params: { id: string } }>(routes.projectRaw(":id"), { config: { compress: false } }, async (req, reply) => {
		const row = requireProject(ctx, req.params.id);
		const query = RawQuery.parse(req.query);
		const { rel, abs } = await resolveInsideRoot(row.path, query.path);
		if (rel === "") throw ApiError.badRequest(i18nMsg("path must name a file"));
		refuseGitDir(rel);
		const info = await stat(abs);
		if (!info.isFile()) throw ApiError.badRequest(i18nMsg('"{rel}" is not a regular file', { rel }));
		return sendFile(req, reply, { abs, size: info.size, name: path.posix.basename(rel), download: query.download === "1" || query.download === "true" });
	});

	// Raw uploads live in their own scope: that scope hands the request stream over untouched (no JSON parsing, no buffering).
	await app.register(async (upload) => {
		rawBodyScope(upload);
		upload.post<{ Params: { id: string } }>(routes.projectUpload(":id"), { bodyLimit: ATTACHMENT_MAX_BYTES }, async (req, reply): Promise<FileEntry> => {
			const row = requireProject(ctx, req.params.id);
			const query = UploadQuery.parse(req.query);
			const overwrite = query.overwrite === "1" || query.overwrite === "true";
			const { rel, abs } = await resolveWritableTarget(row.path, query.path);
			const existing = await lstat(abs).catch(() => null);
			if (existing?.isDirectory()) throw ApiError.conflict(i18nMsg('"{rel}" is a folder', { rel }));
			if (existing && !overwrite) throw ApiError.conflict(i18nMsg('"{rel}" already exists; send overwrite=1 to replace it', { rel }));
			const tmp = path.join(path.dirname(abs), `.clam-upload-${randomBytes(6).toString("hex")}.tmp`);
			const size = await receiveToFile(req.body, tmp, ATTACHMENT_MAX_BYTES, req.headers["content-length"]);
			await commitNew(tmp, abs, rel, overwrite);
			const written = await stat(abs);
			return reply.status(201).send({ name: path.posix.basename(rel), path: rel, kind: "file", size, modifiedAt: written.mtime.toISOString() } satisfies FileEntry);
		});
	});
}
