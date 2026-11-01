import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type HandoffFailureCode, type I18nMessage, i18nMsg, plainMsg } from "@clam/contracts";
import type { projects } from "@clam/database";
import { scanForSecrets } from "@clam/git-engine";
import type { ManifestArtifactRef, ManifestFiles, ManifestGit } from "@clam/handoff-engine";
import { taskBranchName } from "@clam/task-engine";
import { createBundle } from "@clam/workspace-files";
import { errorText } from "../network/util.ts";
import { findSecrets, guardBundle } from "../services/files-bundles.ts";
import { MAX_ARTIFACT_BYTES } from "../tasks/artifacts.ts";
import { execState } from "../tasks/exec-state.ts";
import type { TaskRow } from "../tasks/store.ts";
import type { HandoffHub } from "./hub.ts";
import { baseManifestPath } from "./restore.ts";
import { newHandoffArtifactId, type HandoffRow } from "./store.ts";

type ProjectRow = typeof projects.$inferSelect;

/** Why the work could not be pushed (kept structured so the note that follows can be localised). */
type PushFailure = { kind: "tracks"; branch: string; upstream: string } | { kind: "nobranch" } | { kind: "error"; text: string };

function patchNote(why: PushFailure, branch: string, count: number, base: string): I18nMessage {
	if (why.kind === "tracks") return i18nMsg("Could not push {branch} ({branch} tracks {upstream}, so a push would update that branch instead); the work travels as a patch of {count} file(s) on {base}", { branch, upstream: why.upstream, count, base });
	if (why.kind === "nobranch") return i18nMsg("Could not push {branch} (the task has no branch of its own (it is delivered as a summary)); the work travels as a patch of {count} file(s) on {base}", { branch, count, base });
	return i18nMsg("Could not push {branch} ({error}); the work travels as a patch of {count} file(s) on {base}", { branch, error: why.text, count, base });
}

function cannotSendAsPatch(why: PushFailure, baseRef: string): I18nMessage {
	if (why.kind === "tracks") return i18nMsg("The work could not be pushed ({branch} tracks {upstream}, so a push would update that branch instead) and {baseRef} is unknown in the project, so it cannot be sent as a patch either. Fetch the repository (check the GitHub account), then retry", { branch: why.branch, upstream: why.upstream, baseRef });
	if (why.kind === "nobranch") return i18nMsg("The work could not be pushed (the task has no branch of its own (it is delivered as a summary)) and {baseRef} is unknown in the project, so it cannot be sent as a patch either. Fetch the repository (check the GitHub account), then retry", { baseRef });
	return i18nMsg("The work could not be pushed ({error}) and {baseRef} is unknown in the project, so it cannot be sent as a patch either. Fetch the repository (check the GitHub account), then retry", { error: why.text, baseRef });
}

/** The preparation cannot produce a sealed package: carries what `prepare_failed` records (code + a user-readable detail, never a secret value). */
export class PrepareFailure extends Error {
	constructor(
		readonly code: HandoffFailureCode,
		readonly detail: I18nMessage,
	) {
		super(detail.text);
		this.name = "PrepareFailure";
	}
}

export interface VcsOutcome {
	vcs: "git" | "files" | "none";
	git: ManifestGit | null;
	files: ManifestFiles | null;
	/** Up to {@link MAX_REQUIRED_FILES} paths the target checks after the restore (step 6). */
	requiredFiles: string[];
	/** The work folder on this node (null when the project folder does not exist any more). */
	dir: string | null;
	/** Timeline notes about decisions taken on the way (a push that fell back to a patch ...). */
	notes: I18nMessage[];
}

export const MAX_REQUIRED_FILES = 20;
const BUNDLE_OPTIONS = { maxFileBytes: MAX_ARTIFACT_BYTES, maxTotalBytes: MAX_ARTIFACT_BYTES } as const;
const SMALL_FILE_BYTES = 1024 * 1024;

/** Run the real `git` in `cwd` (read-only plumbing; `env` is added to the process environment). */
function execGit(cwd: string, args: string[], o: { env?: Record<string, string>; maxBytes?: number } = {}): Promise<Buffer> {
	const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
	execFile(
		"git",
		args,
		{ cwd, encoding: "buffer", maxBuffer: o.maxBytes ?? 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...o.env } },
		(error, stdout, stderr) => {
			if (error) reject(new Error(`git ${args[0]} failed: ${error.message.includes("maxBuffer") ? "output over the size limit" : stderr.toString("utf8").trim().slice(0, 300) || error.message}`));
			else resolve(stdout);
		},
	);
	return promise;
}

const text = (buffer: Buffer): string => buffer.toString("utf8").trim();

async function isDir(dir: string): Promise<boolean> {
	return stat(dir).then((s) => s.isDirectory(), () => false);
}

/** `<hex sha-256, size>` of a file, streamed. */
export async function digest(file: string): Promise<{ sha256: string; size: number }> {
	const hash = createHash("sha256");
	let size = 0;
	for await (const chunk of createReadStream(file)) {
		hash.update(chunk as Buffer);
		size += (chunk as Buffer).length;
	}
	return { sha256: hash.digest("hex"), size };
}

/**
 * Step "package the work" of the source (docs/handoff-protocol.md §1): decides how the files travel (`git` branch/commit/patch, a `files`
 * bundle, or `none`), stores the artifacts under `hub.dir(handoffId)` and records them in `handoff_artifacts`. Nothing here changes the
 * task row; it may commit WIP to the task branch and push it (never force).
 */
export class HandoffPreparer {
	constructor(private readonly hub: HandoffHub) {}

	async prepare(i: { row: HandoffRow; task: TaskRow; project: ProjectRow | undefined; targetName: string }): Promise<VcsOutcome> {
		return i.task.repoUrl !== null ? this.git(i) : this.files(i);
	}

	/** Store `file` as a handoff artifact (sha-256 + size). */
	async addArtifact(handoffId: string, file: string, name: string, kind: string): Promise<ManifestArtifactRef> {
		const { sha256, size } = await digest(file);
		if (size > MAX_ARTIFACT_BYTES) {
			throw new PrepareFailure("manifest_invalid", i18nMsg("{name} is {size} bytes, over the {limit} MiB limit for handoff files", { name, size, limit: Math.round(MAX_ARTIFACT_BYTES / 1024 / 1024) }));
		}
		const row = this.hub.store.insertArtifact({ handoffId, artifactId: newHandoffArtifactId(), name, kind, sha256, size, path: file });
		return { artifactId: row.artifactId, sha256, size };
	}

	// ------------------------------------------------------------------ vcs none / files

	private async files(i: { row: HandoffRow; task: TaskRow; project: ProjectRow | undefined }): Promise<VcsOutcome> {
		const none: VcsOutcome = { vcs: "none", git: null, files: null, requiredFiles: [], dir: null, notes: [] };
		const project = i.project;
		if (!project || !(await isDir(project.path))) return none;
		const dir = project.path;
		none.dir = dir;
		const out = path.join(this.hub.dir(i.row.id), "task-files.tar.gz");
		try {
			const built = await guardBundle(() => createBundle(dir, out, BUNDLE_OPTIONS));
			const tooLarge = built.manifest.skipped.filter((s) => s.reason === "too_large");
			if (tooLarge.length > 0) {
				throw new PrepareFailure("manifest_invalid", i18nMsg("The task folder is over the {limit} MiB limit for handoff files ({files}); remove or shrink those files and retry", { limit: Math.round(MAX_ARTIFACT_BYTES / 1024 / 1024), files: tooLarge.slice(0, 5).map((s) => s.path).join(", ") }));
			}
			if (built.manifest.files.length === 0) {
				await rm(out, { force: true });
				return none;
			}
			const secrets = await findSecrets(dir, built.manifest.files);
			if (secrets.length > 0) {
				throw new PrepareFailure("secret_detected", i18nMsg("Files in the task folder look like they contain credentials ({findings}); nothing was sent. Remove them and retry", { findings: secrets.slice(0, 5).map((s) => `${s.path}: ${s.rules.join("/")}`).join("; ") }));
			}
			const bundle = await this.addArtifact(i.row.id, out, "task-files.tar.gz", "files-bundle");
			let base: ManifestArtifactRef | null = null;
			const baseBytes = await readFile(baseManifestPath(this.hub, i.task.id)).catch(() => null);
			if (baseBytes) {
				const baseFile = path.join(this.hub.dir(i.row.id), "base-manifest.json");
				await writeFile(baseFile, baseBytes, { mode: 0o600 });
				base = await this.addArtifact(i.row.id, baseFile, "base-manifest.json", "base-manifest");
			}
			const required = built.manifest.files
				.filter((f) => f.size <= SMALL_FILE_BYTES)
				.map((f) => f.path)
				.sort((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : a > b ? 1 : 0))
				.slice(0, MAX_REQUIRED_FILES);
			return {
				vcs: "files",
				git: null,
				files: { ...bundle, fileCount: built.manifest.files.length, base },
				requiredFiles: required,
				dir,
				notes: [i18nMsg("Bundled {count} file(s) of the task folder", { count: built.manifest.files.length })],
			};
		} catch (error) {
			await rm(out, { force: true });
			throw error;
		}
	}

	// ------------------------------------------------------------------ vcs git

	private async git(i: { row: HandoffRow; task: TaskRow; project: ProjectRow | undefined; targetName: string }): Promise<VcsOutcome> {
		const { task, row, project } = i;
		const repoUrl = task.repoUrl as string;
		if (!project) throw new PrepareFailure("git_unavailable", i18nMsg("The project of this task no longer exists on this node, so its repository cannot be handed over"));
		const gs = this.hub.ctx.gitService;
		const notes: I18nMessage[] = [];
		const git = <T>(work: () => Promise<T>): Promise<T> => work().catch((error: unknown) => Promise.reject(error instanceof PrepareFailure ? error : new PrepareFailure("git_unavailable", plainMsg(errorText(error, 400)))));

		let status = await git(() => gs.status(project.id));
		if (!status.isRepo) throw new PrepareFailure("git_unavailable", i18nMsg("The project directory is not a git repository"));
		if (status.operation) throw new PrepareFailure("git_unavailable", i18nMsg("A {operation} is in progress in the project; finish or abort it, then retry the handoff", { operation: status.operation }));
		const { dir } = await git(() => gs.resolve(project.id));

		const prepared = execState(task).prepared ?? null;
		const baseBranch = prepared?.baseBranch ?? task.repoBranch ?? project.repository?.defaultBranch ?? "main";
		const baseRef = prepared?.baseRef ?? `origin/${baseBranch}`;
		const workBranch = prepared?.workBranch ?? taskBranchName({ nodeName: this.hub.nodeName(), title: task.title, taskId: task.id });

		let pushed = false;
		let pushError: PushFailure = { kind: "error", text: "" };
		if (prepared) {
			if (status.branch !== prepared.workBranch) {
				status = await git(() => gs.checkout(project.id, prepared.workBranch));
				notes.push(i18nMsg("Returned to the task branch {branch}", { branch: prepared.workBranch }));
			}
			if (status.files.length > 0) {
				await this.assertNoSecrets(dir, status.files.map((f) => f.path));
				const renamed = status.files.flatMap((f) => (f.origPath ? [f.path, f.origPath] : []));
				if (renamed.length > 0) status = await git(() => gs.unstage(project.id, renamed));
				const paths = status.files.map((f) => f.path);
				const sessionId = task.executorSessionId;
				const committed = await git(() =>
					gs.commit(
						project.id,
						{ message: `WIP: ${task.title} (handoff to ${i.targetName})`.slice(0, 200), paths, ...(sessionId && { sessionId }) },
						{ Task: task.id, ...(!sessionId && { Agent: `${task.executorAgentName ?? "agent"}@${this.hub.nodeName()}` }) },
					),
				);
				status = committed.status;
				notes.push(i18nMsg("Committed {count} file(s) of work in progress on {branch}", { count: paths.length, branch: workBranch }));
			}
			const ahead = await execGit(dir, ["rev-list", "--count", `${baseRef}..HEAD`]).then((b) => Number(text(b)), () => null);
			if (ahead === 0) {
				// Nothing beyond the base: the base commit is on the remote already.
				pushed = true;
			} else if (status.upstream !== null && status.upstream !== `origin/${workBranch}`) {
				pushError = { kind: "tracks", branch: workBranch, upstream: status.upstream };
			} else {
				try {
					status = (await gs.push(project.id, { setUpstream: true })).status;
					pushed = true;
					notes.push(i18nMsg("Pushed {branch}", { branch: workBranch }));
				} catch (error) {
					pushError = { kind: "error", text: errorText(error, 300) };
				}
			}
		} else {
			pushError = { kind: "nobranch" };
		}

		const head = status.headSha;
		if (pushed) {
			if (!head) throw new PrepareFailure("git_unavailable", i18nMsg("The project has no commit to hand over"));
			const required = await this.changedFiles(dir, baseRef, "HEAD");
			return { vcs: "git", git: { repoUrl, branch: workBranch, commit: head, baseBranch, pushed: true }, files: null, requiredFiles: required.slice(0, MAX_REQUIRED_FILES), dir, notes };
		}

		// The work cannot be pushed: ship it as a binary patch on top of the commit of the base that IS on the remote.
		const baseSha = await this.resolveBase(dir, project.id, baseRef, pushError);
		const patch = await this.snapshotPatch(dir, baseSha);
		if (!patch) {
			notes.push(i18nMsg("The work equals its base commit; nothing to carry besides the commit"));
			return { vcs: "git", git: { repoUrl, branch: workBranch, commit: baseSha, baseBranch, pushed: true }, files: null, requiredFiles: [], dir, notes };
		}
		const findings = scanForSecrets(patch.bytes.toString("utf8"), "working-tree.patch");
		if (findings.length > 0) {
			throw new PrepareFailure("secret_detected", i18nMsg("The changes look like they contain credentials ({rules}); nothing was sent. Remove them and retry", { rules: [...new Set(findings.map((f) => f.rule))].join(", ") }));
		}
		const file = path.join(this.hub.dir(row.id), "working-tree.patch");
		await writeFile(file, patch.bytes, { mode: 0o600 });
		const ref = await this.addArtifact(row.id, file, "working-tree.patch", "patch");
		notes.push(patchNote(pushError, workBranch, patch.files.length, baseSha.slice(0, 12)));
		return {
			vcs: "git",
			git: { repoUrl, branch: workBranch, commit: baseSha, baseBranch, pushed: false, patchArtifact: { ...ref, baseCommit: baseSha, files: patch.files } },
			files: null,
			requiredFiles: patch.present.slice(0, MAX_REQUIRED_FILES),
			dir,
			notes,
		};
	}

	/** Refuse to commit/push files that look like credentials (never echoes content). */
	private async assertNoSecrets(dir: string, paths: string[]): Promise<void> {
		const sized: Array<{ path: string; size: number }> = [];
		for (const p of paths) {
			const info = await stat(path.join(dir, ...p.split("/"))).catch(() => null);
			if (info?.isFile()) sized.push({ path: p, size: info.size });
		}
		const secrets = await findSecrets(dir, sized);
		if (secrets.length > 0) {
			throw new PrepareFailure("secret_detected", i18nMsg("Changed files look like they contain credentials ({findings}); nothing was committed or pushed. Remove them and retry", { findings: secrets.slice(0, 5).map((s) => `${s.path}: ${s.rules.join("/")}`).join("; ") }));
		}
	}

	/** The commit of `baseRef` the work forks from (fetching once when the ref is unknown locally). */
	private async resolveBase(dir: string, projectId: string, baseRef: string, why: PushFailure): Promise<string> {
		const mergeBase = (): Promise<string> => execGit(dir, ["merge-base", "HEAD", baseRef]).then(text);
		try {
			return await mergeBase();
		} catch {
			await this.hub.ctx.gitService.fetch(projectId).catch(() => undefined);
		}
		try {
			return await mergeBase();
		} catch {
			throw new PrepareFailure("git_unavailable", cannotSendAsPatch(why, baseRef));
		}
	}

	/** Added/modified files between two revisions (what must exist after the restore). */
	private async changedFiles(dir: string, from: string, to: string): Promise<string[]> {
		try {
			return text(await execGit(dir, ["diff", "--name-only", "-z", "--no-renames", "--diff-filter=AM", from, to]))
				.split("\0")
				.filter(Boolean);
		} catch {
			return [];
		}
	}

	/**
	 * `git diff --binary` of everything in the work tree (commits not on the base, tracked changes AND untracked files that are not ignored)
	 * against `baseSha`, computed with a temporary index so the project's own index and files are never touched. Null when identical.
	 */
	private async snapshotPatch(dir: string, baseSha: string): Promise<{ bytes: Buffer; files: string[]; present: string[] } | null> {
		const scratch = await mkdtemp(path.join(tmpdir(), "clam-handoff-index-"));
		try {
			const env = { GIT_INDEX_FILE: path.join(scratch, "index") };
			await execGit(dir, ["read-tree", "HEAD"], { env });
			await execGit(dir, ["add", "-A"], { env });
			const tree = text(await execGit(dir, ["write-tree"], { env }));
			const baseTree = text(await execGit(dir, ["rev-parse", `${baseSha}^{tree}`]));
			if (tree === baseTree) return null;
			const bytes = await execGit(dir, ["diff", "--binary", "--full-index", "--no-color", "--no-ext-diff", baseSha, tree], { maxBytes: MAX_ARTIFACT_BYTES + 1 }).catch((error: unknown) => {
				throw new PrepareFailure("manifest_invalid", i18nMsg("The changes cannot be sent as a patch: {error}", { error: errorText(error) }));
			});
			const names = async (filter: string[]): Promise<string[]> => text(await execGit(dir, ["diff", "--name-only", "-z", "--no-renames", ...filter, baseSha, tree])).split("\0").filter(Boolean);
			return { bytes, files: await names([]), present: await names(["--diff-filter=AM"]) };
		} finally {
			await rm(scratch, { recursive: true, force: true });
		}
	}
}
