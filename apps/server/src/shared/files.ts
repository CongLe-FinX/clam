import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { BundleManifest, type FilesApplyResult, type FilesPreview } from "@clam/contracts";
import { projects, type SharedRescueFiles } from "@clam/database";
import { applyBundle, createBundle, previewBundle, readBundleManifest } from "@clam/workspace-files";
import { eq } from "drizzle-orm";
import { ApiError } from "../http/errors.ts";
import { KeyedLock, errorText } from "../network/util.ts";
import { applyFiles, guardBundle, previewFiles } from "../services/files-bundles.ts";
import type { FilesModeApi, SharedHub } from "./hub.ts";
import { placeAt, SnapshotFiles } from "./snapshots.ts";
import type { CheckpointRow, SharedRow } from "./store.ts";

const LISTED_PATHS = 200;

/**
 * Files mode of a shared session (no git repository): how the working folder travels. The DRIVER's folder is bundled at
 * every checkpoint (`@clam/workspace-files`: deterministic tar.gz, default excludes, sha256-verified); participants
 * download it with the snapshot. A participant's folder receives the FIRST bundle when it joins; later bundles are applied
 * only when it takes over (preview first; a file edited locally since the last synced state is a conflict that refuses the
 * takeover unless forced, and then the local versions are saved as a rescue bundle before they are replaced). A former
 * driver's work after its last checkpoint is bundled as a rescue bundle. Nothing is ever deleted.
 *
 * `<dataDir>/shared/<id>/synced-manifest.json` is the manifest of the folder as it was when this node last made or applied
 * a checkpoint bundle: the base that tells local edits from shared changes.
 */
export class SharedFilesService implements FilesModeApi {
	private readonly files: SnapshotFiles;
	private readonly lock = new KeyedLock();

	constructor(private readonly hub: SharedHub) {
		this.files = new SnapshotFiles(hub.ctx.config.dataDir);
	}

	private get store() {
		return this.hub.store;
	}

	private get limits() {
		const max = this.hub.options.maxSnapshotBytes;
		return { maxFileBytes: max, maxTotalBytes: max } as const;
	}

	private project(shared: SharedRow): { id: string; name: string; path: string } {
		const row = shared.localProjectId ? this.hub.ctx.db.select().from(projects).where(eq(projects.id, shared.localProjectId)).get() : undefined;
		if (!row) throw new ApiError(409, "no_local_clone", "No local folder is linked to this shared session on this node");
		return row;
	}

	// ------------------------------------------------------------------ synced manifest

	async readSynced(sharedId: string): Promise<BundleManifest | undefined> {
		try {
			return BundleManifest.parse(JSON.parse(await readFile(this.files.absolute(this.files.syncedManifest(sharedId)), "utf8")));
		} catch {
			return undefined;
		}
	}

	private async writeSynced(sharedId: string, manifest: BundleManifest): Promise<void> {
		const target = this.files.absolute(this.files.syncedManifest(sharedId));
		await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
		await writeFile(target, JSON.stringify(manifest), { mode: 0o600 });
	}

	// ------------------------------------------------------------------ driver: the bundle of a checkpoint

	async bundle(shared: SharedRow, seq: number): ReturnType<FilesModeApi["bundle"]> {
		const tmp = await this.files.temporary(shared.id, `bundle-${seq}`, "files");
		try {
			const dir = this.project(shared).path;
			const built = await guardBundle(() => createBundle(dir, tmp, this.limits));
			if (built.size > this.hub.options.maxSnapshotBytes) throw new Error(`the bundle is ${built.size} bytes, over the ${this.hub.options.maxSnapshotBytes} byte limit`);
			const problems: string[] = [];
			const tooLarge = built.manifest.skipped.filter((s) => s.reason === "too_large");
			if (tooLarge.length > 0) problems.push(`${tooLarge.length} file(s) over the size limit were left out of the folder bundle (${tooLarge.slice(0, 3).map((s) => s.path).join(", ")})`);
			const relative = await this.files.place(tmp, shared.id, seq, "files");
			await this.writeSynced(shared.id, built.manifest);
			this.store.patchMeta(shared.id, { appliedFilesSeq: seq });
			return { relative, meta: { sha256: built.sha256, size: built.size, fileCount: built.manifest.files.length }, problems };
		} catch (error) {
			await rm(tmp, { force: true });
			this.hub.log.warn({ err: errorText(error), sharedId: shared.id, seq }, "could not bundle the working folder");
			return { relative: null, meta: null, problems: [`no folder bundle: ${errorText(error, 160)}`] };
		}
	}

	bundleFile(sharedId: string, seq: number): { path: string; size: number; sha256: string } {
		const row = this.store.checkpoint(sharedId, seq);
		if (!row || !row.filesPath || !row.files) throw ApiError.notFound("Folder bundle");
		return { path: this.files.absolute(row.filesPath), size: row.files.size, sha256: row.files.sha256 };
	}

	// ------------------------------------------------------------------ participant: first bundle

	applyInitial(sharedId: string, seq: number): Promise<void> {
		return this.lock.run(sharedId, async () => {
			const shared = this.store.find(sharedId);
			const row = this.store.checkpoint(sharedId, seq);
			if (!shared || !row?.filesPath || shared.vcs !== "files" || shared.state !== "active" || shared.localRole !== "participant" || !shared.localProjectId) return;
			if (shared.meta.appliedFilesSeq !== undefined) return;
			const project = this.project(shared);
			try {
				const archive = this.files.absolute(row.filesPath);
				const manifest = await guardBundle(() => readBundleManifest(archive));
				// No base: a file that already exists here with other content is kept, never replaced.
				const result = await guardBundle(() => applyBundle(archive, project.path));
				await this.writeSynced(sharedId, manifest);
				this.store.patchMeta(sharedId, { appliedFilesSeq: seq });
				const kept = result.skipped.filter((s) => s.reason === "conflict").map((s) => s.path);
				this.hub.discussion.note(
					sharedId,
					`${this.hub.nodeName()} received the working folder from ${shared.driverNodeName}: ${result.written.length} file(s) placed in ${project.name}${kept.length > 0 ? `; ${kept.length} existing file(s) with other content were kept (${kept.slice(0, 5).join(", ")})` : ""}.`,
					{ local: true },
				);
			} catch (error) {
				this.hub.log.warn({ err: errorText(error), sharedId, seq }, "placing the first folder bundle failed");
				this.hub.discussion.note(sharedId, `The working folder from ${shared.driverNodeName} could not be placed in ${project.name}: ${errorText(error, 200)}`, { local: true });
			}
		});
	}

	// ------------------------------------------------------------------ takeover: restore the folder from a checkpoint

	async restore(shared: SharedRow, held: CheckpointRow, options: { force: boolean; reason: "takeover" | "transfer" }): ReturnType<FilesModeApi["restore"]> {
		if (!held.filesPath || !held.files) throw new ApiError(409, "no_files", "No folder bundle has been received for this checkpoint; wait for the driver's next checkpoint.");
		const project = this.project(shared);
		const archive = this.files.absolute(held.filesPath);
		const base = await this.readSynced(shared.id);
		const preview = await guardBundle(() => previewBundle(archive, project.path, base ? { base } : {}));
		const conflicts = preview.filter((f) => f.status === "conflict").map((f) => f.path);
		if (conflicts.length > 0 && options.reason === "takeover" && !options.force) {
			throw new ApiError(
				409,
				"files_conflict",
				`${conflicts.length} file(s) in ${project.name} were changed here since the last checkpoint and differ from it (${conflicts.slice(0, 5).join(", ")}${conflicts.length > 5 ? ", …" : ""}). Continuing replaces them with the checkpoint's version; the local versions are saved as a rescue bundle first. Confirm to continue.`,
				{ paths: conflicts },
			);
		}
		if (conflicts.length > 0) await this.saveRescue(shared, "local-edits", { paths: conflicts });
		const result = await guardBundle(() => applyBundle(archive, project.path, { ...(base && { base }), overwrite: conflicts }));
		const manifest = await guardBundle(() => readBundleManifest(archive));
		await this.writeSynced(shared.id, manifest);
		this.store.patchMeta(shared.id, { appliedFilesSeq: held.seq });
		return { fileCount: manifest.files.length, applied: result.written, kept: result.skipped.filter((s) => s.reason === "conflict").map((s) => s.path), rescued: conflicts.length };
	}

	// ------------------------------------------------------------------ rescue bundles

	/** Bundle `dir` (restricted to `paths`, or to what changed since `base`) as the node's rescue bundle. Null when there is nothing to save. */
	private async saveRescue(shared: SharedRow, label: string, options: { paths?: string[]; base?: BundleManifest | undefined }): Promise<SharedRescueFiles | null> {
		const project = this.project(shared);
		const tmp = await this.files.temporary(shared.id, `rescue-${label}`, "rescue");
		try {
			const built = await guardBundle(() => createBundle(project.path, tmp, { ...this.limits, ...(options.paths && { paths: options.paths }), ...(options.base && { base: options.base }) }));
			if (built.manifest.files.length === 0) {
				await rm(tmp, { force: true });
				return null;
			}
			const relative = await placeAt(this.files, tmp, this.files.rescue(shared.id, shared.epoch, label));
			const saved: SharedRescueFiles = {
				path: relative,
				sha256: built.sha256,
				size: built.size,
				fileCount: built.manifest.files.length,
				paths: built.manifest.files.map((f) => f.path).slice(0, LISTED_PATHS),
				epoch: shared.epoch,
				at: new Date().toISOString(),
			};
			this.store.update(shared.id, { rescueFiles: saved });
			return saved;
		} catch (error) {
			await rm(tmp, { force: true });
			throw error;
		}
	}

	async rescueSinceSync(shared: SharedRow): Promise<SharedRescueFiles | null> {
		try {
			const saved = await this.saveRescue(shared, "after-checkpoint", { base: await this.readSynced(shared.id) });
			if (saved) {
				this.hub.discussion.note(
					shared.id,
					`${this.hub.nodeName()} had ${saved.fileCount} file(s) that are not in the shared folder (new or changed after the last checkpoint); they were saved as a rescue bundle: ${saved.paths.slice(0, 8).join(", ")}${saved.fileCount > 8 ? ", …" : ""}.`,
				);
			}
			return saved;
		} catch (error) {
			this.hub.log.warn({ err: errorText(error), sharedId: shared.id }, "rescuing the files of the former driver failed; nothing was discarded");
			this.hub.discussion.note(shared.id, `Saving the former driver's files as a rescue bundle failed: ${errorText(error, 200)}. The folder was not touched.`);
			return null;
		}
	}

	private rescueArchive(sharedId: string): string {
		const shared = this.store.get(sharedId);
		if (!shared.rescueFiles) throw new ApiError(409, "no_rescue_files", "This node has no rescue bundle for the shared session");
		return this.files.absolute(shared.rescueFiles.path);
	}

	private target(projectId: string): { id: string; path: string } {
		const row = this.hub.ctx.db.select().from(projects).where(eq(projects.id, projectId)).get();
		if (!row) throw ApiError.notFound("Project");
		return row;
	}

	rescuePreview(sharedId: string, projectId: string): Promise<FilesPreview> {
		const archive = this.rescueArchive(sharedId);
		const project = this.target(projectId);
		return previewFiles(project.id, archive, project.path);
	}

	rescueApply(sharedId: string, body: { projectId: string; paths?: string[] | undefined; overwrite: string[] }): Promise<FilesApplyResult> {
		const archive = this.rescueArchive(sharedId);
		return applyFiles(archive, this.target(body.projectId).path, body);
	}
}
