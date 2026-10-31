import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { BundleManifest, type FilesApplyResult, type FilesPreview, type TaskResult } from "@clam/contracts";
import type { artifacts, projects } from "@clam/database";
import { applyBundle, createBundle, readBundleManifest, scanFolder } from "@clam/workspace-files";
import { eq } from "drizzle-orm";
import { projects as projectsTable } from "@clam/database";
import { ApiError } from "../http/errors.ts";
import { KeyedLock, errorText } from "../network/util.ts";
import { applyFiles, findSecrets, guardBundle, previewFiles } from "../services/files-bundles.ts";
import { fetchExecutorArtifact, fetchSenderInput } from "./artifact-proxy.ts";
import { MAX_ARTIFACT_BYTES } from "./artifacts.ts";
import type { TaskHub } from "./hub.ts";
import type { TaskRow } from "./store.ts";

type ProjectRow = typeof projects.$inferSelect;

export type InputFiles = NonNullable<TaskRow["inputFiles"]>;
export type ResultFiles = NonNullable<TaskResult["files"]>;

const BUNDLE_MEDIA_TYPE = "application/gzip";
const FETCH_ATTEMPTS = 3;
const FETCH_PAUSE_MS = 1000;
const BUNDLE_OPTIONS = { maxFileBytes: MAX_ARTIFACT_BYTES, maxTotalBytes: MAX_ARTIFACT_BYTES } as const;

/** What the executor-side folder preparation did, for the brief. */
export interface PreparedFolder {
	paths: string[];
	notReplaced: string[];
}

/** Files the executor kept out of a result bundle, and why. */
export interface Withheld {
	path: string;
	reason: string;
}

/**
 * Task files without git (`deliverAs: files`, input files): everything that moves a folder's files between the two
 * nodes of a task. SENDER: bundle the chosen input paths (credential-scanned, size-capped) into an artifact the executor
 * downloads, and later preview/apply the executor's result bundle against a local project. EXECUTOR: download and apply
 * the inputs into the task folder before the agent starts, remember the folder's state, and bundle only what the agent
 * created or changed when it is done. Bundles are built and applied by `@clam/workspace-files` (atomic writes, no symlinks,
 * sha256-verified, never deleting).
 */
export class TaskFiles {
	private readonly lock = new KeyedLock();

	constructor(private readonly hub: TaskHub) {}

	private get artifacts() {
		return this.hub.artifacts;
	}

	// ------------------------------------------------------------------ sender: input bundle

	/**
	 * Build the input bundle of a new task from `inputPaths` of `project`. Returns the artifact values (not inserted: the
	 * sender inserts them with the task row) and the announcement for the wire. The file is already in the artifact store.
	 */
	async bundleInputs(taskId: string, project: Pick<ProjectRow, "path">, inputPaths: readonly string[]): Promise<{ artifact: typeof artifacts.$inferInsert; announced: InputFiles }> {
		const scratch = await this.artifacts.scratch(taskId, "input");
		try {
			const built = await guardBundle(() => createBundle(project.path, scratch, { ...BUNDLE_OPTIONS, paths: [...inputPaths] }));
			const { manifest } = built;
			const tooLarge = manifest.skipped.filter((s) => s.reason === "too_large");
			if (tooLarge.length > 0) {
				throw new ApiError(413, "input_too_large", `Input files are over the ${Math.round(MAX_ARTIFACT_BYTES / 1024 / 1024)} MiB limit (${tooLarge.slice(0, 5).map((s) => s.path).join(", ")}); send fewer or smaller files`);
			}
			if (manifest.files.length === 0) {
				throw ApiError.badRequest("None of the input paths holds a file that can be sent (missing, empty or excluded by default, such as .git, node_modules or .env files)");
			}
			const secrets = await findSecrets(project.path, manifest.files);
			if (secrets.length > 0) {
				throw new ApiError(422, "input_contains_secrets", `Input files look like they contain credentials (${secrets.slice(0, 5).map((s) => `${s.path}: ${s.rules.join("/")}`).join("; ")}); nothing was sent`, { files: secrets });
			}
			const artifact = await this.artifacts.placeFile(taskId, { name: "input-files.tar.gz", mediaType: BUNDLE_MEDIA_TYPE, file: scratch });
			return { artifact, announced: { artifactId: artifact.id, sha256: artifact.sha256, size: artifact.size, fileCount: manifest.files.length } };
		} catch (error) {
			// The task does not exist yet: nothing of it may stay on disk.
			await rm(this.artifacts.taskDir(taskId), { recursive: true, force: true });
			throw error;
		}
	}

	/** Retry of a task: the same input bundle, as an artifact of the new task. */
	async copyInputs(from: TaskRow, toTaskId: string): Promise<{ artifact: typeof artifacts.$inferInsert; announced: InputFiles } | null> {
		const listed = from.inputFiles;
		const source = listed ? this.hub.store.artifact(from.id, listed.artifactId) : undefined;
		if (!listed || !source) return null;
		const scratch = await this.artifacts.scratch(toTaskId, "input");
		await writeFile(scratch, await readFile(this.artifacts.absolutePath(source)));
		const artifact = await this.artifacts.placeFile(toTaskId, { name: "input-files.tar.gz", mediaType: BUNDLE_MEDIA_TYPE, file: scratch });
		return { artifact, announced: { ...listed, artifactId: artifact.id } };
	}

	/** Absolute path of the sender's input bundle of `task`, or null when it has none (or it is gone). */
	inputBundlePath(task: TaskRow): string | null {
		const listed = task.inputFiles;
		const row = listed ? this.hub.store.artifact(task.id, listed.artifactId) : undefined;
		return row ? this.artifacts.absolutePath(row) : null;
	}

	// ------------------------------------------------------------------ executor: prepare the folder, collect the result

	private baseManifestPath(taskId: string): string {
		return path.join(this.artifacts.taskDir(taskId), ".base-manifest.json");
	}

	/**
	 * Before the agent starts: download the input bundle (when the task has one), place its files in `dir` (a file that
	 * already exists there with other content is NOT replaced and reported) and remember the folder's state as the base the
	 * result is measured against.
	 */
	async prepareFolder(task: TaskRow, dir: string): Promise<PreparedFolder> {
		const prepared: PreparedFolder = { paths: [], notReplaced: [] };
		const listed = task.inputFiles;
		if (listed) {
			let row = this.hub.store.artifact(task.id, listed.artifactId);
			if (!row) {
				const bytes = await this.fetchInputs(task, listed);
				const scratch = await this.artifacts.scratch(task.id, "input");
				await writeFile(scratch, bytes);
				row = await this.artifacts.addFile(task.id, { name: "input-files.tar.gz", mediaType: BUNDLE_MEDIA_TYPE, file: scratch, id: listed.artifactId });
			}
			const archive = this.artifacts.absolutePath(row);
			const manifest = await guardBundle(() => readBundleManifest(archive));
			const result = await guardBundle(() => applyBundle(archive, dir));
			prepared.paths = manifest.files.map((f) => f.path);
			prepared.notReplaced = result.skipped.filter((s) => s.reason === "conflict").map((s) => s.path);
		}
		const base = await guardBundle(() => scanFolder(dir));
		await mkdir(this.artifacts.taskDir(task.id), { recursive: true, mode: 0o700 });
		await writeFile(this.baseManifestPath(task.id), JSON.stringify(base), { mode: 0o600 });
		return prepared;
	}

	private async fetchInputs(task: TaskRow, listed: InputFiles): Promise<Buffer> {
		let last: unknown;
		for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
			try {
				return await fetchSenderInput(this.hub.ctx, task, listed);
			} catch (error) {
				last = error;
				// The sender refusing or not having the file cannot be fixed by waiting.
				if (error instanceof ApiError && (error.status === 403 || error.status === 404)) break;
				this.hub.log.warn({ err: errorText(error), taskId: task.id, attempt }, "fetching the task's input files failed");
				if (attempt < FETCH_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, FETCH_PAUSE_MS * attempt));
			}
		}
		throw new ApiError(502, "inputs_unavailable", `The input files could not be fetched from ${task.senderNodeName}: ${errorText(last)}`);
	}

	/**
	 * After the agent is done: bundle the files it created or changed since `prepareFolder` (nothing else). Text files that
	 * look like credentials are left out and reported. `files` is null when nothing changed.
	 */
	async collectResult(task: TaskRow, dir: string): Promise<{ files: ResultFiles | null; withheld: Withheld[] }> {
		let base: BundleManifest | undefined;
		try {
			base = BundleManifest.parse(JSON.parse(await readFile(this.baseManifestPath(task.id), "utf8")));
		} catch {
			base = undefined; // never prepared (cannot normally happen): everything in the folder counts as the agent's
		}
		const now = await guardBundle(() => scanFolder(dir));
		const before = new Map((base?.files ?? []).map((f) => [f.path, f]));
		const changed = now.files.filter((f) => {
			const b = before.get(f.path);
			return !b || b.sha256 !== f.sha256 || b.executable !== f.executable;
		});
		const withheld: Withheld[] = [];
		for (const s of now.skipped) if (s.reason === "too_large") withheld.push({ path: s.path, reason: "too large to return" });
		const secrets = await findSecrets(dir, changed);
		for (const s of secrets) withheld.push({ path: s.path, reason: `looks like it contains credentials (${s.rules.join(", ")})` });
		const flagged = new Set(secrets.map((s) => s.path));
		const allowed = changed.filter((f) => !flagged.has(f.path));
		if (allowed.length === 0) return { files: null, withheld };
		const scratch = await this.artifacts.scratch(task.id, "result");
		try {
			const built = await guardBundle(() => createBundle(dir, scratch, { ...BUNDLE_OPTIONS, paths: allowed.map((f) => f.path) }));
			for (const s of built.manifest.skipped) if (s.reason === "too_large") withheld.push({ path: s.path, reason: "too large to return" });
			if (built.manifest.files.length === 0) {
				await rm(scratch, { force: true });
				return { files: null, withheld };
			}
			const row = await this.artifacts.addFile(task.id, { name: "result-files.tar.gz", mediaType: BUNDLE_MEDIA_TYPE, file: scratch });
			return { files: { artifactId: row.id, sha256: row.sha256, size: row.size, fileCount: built.manifest.files.length }, withheld };
		} catch (error) {
			await rm(scratch, { force: true });
			throw error;
		}
	}

	// ------------------------------------------------------------------ sender: preview and apply the result

	/** The result bundle of an outgoing task on this node's disk (downloaded from the executor once, then cached). */
	private assertOutgoing(task: TaskRow): void {
		if (task.direction !== "outgoing") throw ApiError.conflict("The files of a task come back to the node that delegated it; this node executed it, so they are already in its project folder");
	}

	private resultBundle(task: TaskRow): Promise<string> {
		this.assertOutgoing(task);
		const listed = task.result?.files;
		if (!listed) throw new ApiError(409, "no_result_files", "This task has no result files");
		return this.lock.run(`result:${task.id}`, async () => {
			const cached = this.hub.store.artifact(task.id, listed.artifactId);
			if (cached) return this.artifacts.absolutePath(cached);
			const bytes = await fetchExecutorArtifact(this.hub.ctx, task, listed);
			const scratch = await this.artifacts.scratch(task.id, "result");
			await writeFile(scratch, bytes);
			const row = await this.artifacts.addFile(task.id, { name: "result-files.tar.gz", mediaType: BUNDLE_MEDIA_TYPE, file: scratch, id: listed.artifactId });
			return this.artifacts.absolutePath(row);
		});
	}

	private project(projectId: string): ProjectRow {
		const row = this.hub.ctx.db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).get();
		if (!row) throw ApiError.notFound("Project");
		return row;
	}

	/** The input manifest is the base when the files go back to the project they were taken from: a local edit since then is a conflict, anything else an update. */
	private async baseFor(task: TaskRow, project: ProjectRow): Promise<BundleManifest | undefined> {
		if (project.id !== task.projectId) return undefined;
		const input = this.inputBundlePath(task);
		return input ? guardBundle(() => readBundleManifest(input)) : undefined;
	}

	async preview(taskId: string, projectId: string): Promise<FilesPreview> {
		const task = this.hub.store.get(taskId);
		this.assertOutgoing(task);
		const project = this.project(projectId);
		const archive = await this.resultBundle(task);
		return previewFiles(project.id, archive, project.path, await this.baseFor(task, project));
	}

	async apply(taskId: string, body: { projectId: string; paths?: string[] | undefined; overwrite: string[] }): Promise<FilesApplyResult> {
		const task = this.hub.store.get(taskId);
		this.assertOutgoing(task);
		const project = this.project(body.projectId);
		const archive = await this.resultBundle(task);
		return applyFiles(archive, project.path, body, await this.baseFor(task, project));
	}
}
