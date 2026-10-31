import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { API_PREFIX, normalizePeerUrl, signRequest, signerFromIdentity } from "@clam/agent-network";
import { BundleManifest } from "@clam/contracts";
import type { HandoffManifest, ManifestArtifactRef } from "@clam/handoff-engine";
import { applyBundle, readBundleManifest, scanFolder } from "@clam/workspace-files";
import { taskBranchName } from "@clam/task-engine";
import { ApiError } from "../http/errors.ts";
import { errorText } from "../network/util.ts";
import { guardBundle } from "../services/files-bundles.ts";
import type { ProjectRow } from "../services/project-folders.ts";
import { MAX_ARTIFACT_BYTES } from "../tasks/artifacts.ts";
import { execState } from "../tasks/exec-state.ts";
import { type HandoffHub, HandoffStepError } from "./hub.ts";
import type { HandoffArtifactRow, HandoffRow } from "./store.ts";

const FETCH_ATTEMPTS = 3;
const FETCH_TIMEOUT_MS = 60_000;
const GIT_TIMEOUT_MS = 120_000;
const LISTED_PATHS = 5;

/** What the git restore created on this node; kept in `handoffs.meta.restore` so a re-run and a cleanup know what is ours. */
export interface RestoreMeta {
	workBranch: string;
	originalBranch: string | null;
	originalSha: string | null;
	/** This handoff created the branch (a cleanup may remove it, if untouched). */
	branchCreated: boolean;
}

export const restoreMetaOf = (row: Pick<HandoffRow, "meta">): RestoreMeta | null => {
	const value = row.meta.restore;
	return typeof value === "object" && value !== null ? (value as RestoreMeta) : null;
};

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

function isNoSpace(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOSPC";
}

// ------------------------------------------------------------------ artifacts

async function matches(file: string, ref: ManifestArtifactRef): Promise<boolean> {
	try {
		if ((await stat(file)).size !== ref.size) return false;
		return createHash("sha256").update(await readFile(file)).digest("hex") === ref.sha256;
	} catch {
		return false;
	}
}

/**
 * Download a file of the handoff from the source (`GET /handoffs/:id/artifacts/:artifactId`, signed) into `hub.dir(id)`, verifying size
 * and sha-256 against the manifest while it streams to disk. Idempotent: a verified copy that is already here is kept.
 */
export async function downloadHandoffArtifact(hub: HandoffHub, row: HandoffRow, ref: ManifestArtifactRef, o: { name: string; kind: string }): Promise<HandoffArtifactRow> {
	const dest = path.join(hub.dir(row.id), ref.artifactId);
	const known = hub.store.artifact(row.id, ref.artifactId);
	if (known && (await matches(known.path, ref))) return known;
	if (ref.size > MAX_ARTIFACT_BYTES) throw new HandoffStepError("manifest_invalid", `${o.name} is ${ref.size} bytes; this node accepts at most ${MAX_ARTIFACT_BYTES}`, 2);

	const peer = hub.ctx.network.peers.row(row.peerId);
	const origin = peer ? normalizePeerUrl(peer.url, { allowLoopbackHttp: hub.ctx.config.allowLoopbackPeers }) : null;
	if (!peer || peer.status === "revoked" || origin === null) throw new HandoffStepError("timeout", "The source node is not reachable, so its files cannot be downloaded", 2);
	const url = `${origin}${API_PREFIX}/handoffs/${encodeURIComponent(row.id)}/artifacts/${encodeURIComponent(ref.artifactId)}`;

	let last = "";
	for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
		if (attempt > 1) await sleep(hub.timings.ackRetryMs * attempt);
		const partial = `${dest}.part`;
		try {
			const headers = signRequest(signerFromIdentity(hub.ctx.identity), { method: "GET", url, bodyBytes: new Uint8Array(0) });
			const response = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
			if ([403, 404, 410].includes(response.status)) throw new HandoffStepError("manifest_invalid", `The source no longer serves ${o.name} (${response.status})`, 2);
			if (!response.ok || !response.body) {
				last = `the source answered ${response.status}`;
				continue;
			}
			const declared = Number(response.headers.get("content-length") ?? ref.size);
			if (declared !== ref.size) throw new HandoffStepError("manifest_invalid", `${o.name} is announced as ${ref.size} bytes but the source sends ${declared}`, 2);
			const hash = createHash("sha256");
			let received = 0;
			const handle = await open(partial, "w", 0o600);
			try {
				for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
					received += chunk.length;
					if (received > ref.size) throw new HandoffStepError("manifest_invalid", `${o.name} is larger than announced`, 2);
					hash.update(chunk);
					await handle.write(chunk);
				}
			} finally {
				await handle.close();
			}
			if (received !== ref.size || hash.digest("hex") !== ref.sha256) throw new HandoffStepError("manifest_invalid", `${o.name} does not match the digest in the manifest`, 2);
			await rename(partial, dest);
			return hub.store.insertArtifact({ handoffId: row.id, artifactId: ref.artifactId, name: o.name, kind: o.kind, sha256: ref.sha256, size: ref.size, path: dest });
		} catch (error) {
			await rm(partial, { force: true });
			if (error instanceof HandoffStepError) throw error;
			if (isNoSpace(error)) throw new HandoffStepError("disk_full", `No space left to store ${o.name}`, 2);
			last = errorText(error);
		}
	}
	throw new HandoffStepError("timeout", `${o.name} could not be downloaded from the source: ${last}`, 2);
}

/** Every artifact of the manifest this node needs, downloaded and verified. Optional ones (transcript, logs) never fail the step. */
export async function downloadManifestArtifacts(hub: HandoffHub, row: HandoffRow, manifest: HandoffManifest): Promise<void> {
	const required: Array<[ManifestArtifactRef, string, string]> = [];
	if (manifest.git?.patchArtifact) required.push([manifest.git.patchArtifact, "working-tree.patch", "patch"]);
	if (manifest.files) {
		required.push([manifest.files, "files.tar.gz", "files-bundle"]);
		if (manifest.files.base) required.push([manifest.files.base, "base-manifest.json", "base-manifest"]);
	}
	for (const [ref, name, kind] of required) await downloadHandoffArtifact(hub, row, ref, { name, kind });
	const optional: Array<[ManifestArtifactRef, string, string]> = [];
	if (manifest.transcript) optional.push([manifest.transcript, "session-pack.tar", "session-pack"]);
	for (const a of manifest.artifacts) optional.push([a, a.name, a.kind]);
	for (const [ref, name, kind] of optional) {
		try {
			await downloadHandoffArtifact(hub, row, ref, { name, kind });
		} catch (error) {
			if (error instanceof HandoffStepError && error.code === "disk_full") throw error;
			hub.log.warn({ handoffId: row.id, artifactId: ref.artifactId, err: errorText(error) }, "an optional handoff artifact could not be downloaded");
			hub.note(row.id, `${name} could not be downloaded (${errorText(error)}); continuing without it`);
		}
	}
}

// ------------------------------------------------------------------ git

export interface GitRun {
	code: number;
	stdout: string;
	stderr: string;
}

/** `git -C dir …` without a shell; never throws for a non-zero exit. */
export function runGit(dir: string, args: string[]): Promise<GitRun> {
	const { promise, resolve } = Promise.withResolvers<GitRun>();
	execFile("git", ["-C", dir, "-c", "core.fsmonitor=false", ...args], { timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 << 20, encoding: "utf8" }, (error, stdout, stderr) => {
		const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
		resolve({ code, stdout, stderr: error && code === 1 && stderr === "" ? error.message : stderr });
	});
	return promise;
}

/** `clam/<node>/<title>-<task>-h<handoff>`: a branch of its own, never the name an earlier execution of the task on this node used. */
export function handoffBranchName(hub: HandoffHub, row: HandoffRow, manifest: HandoffManifest): string {
	const short = row.id.toLowerCase().replace(/[^a-z0-9]/g, "").slice(-6);
	return `${taskBranchName({ nodeName: hub.nodeName(), title: manifest.task.title, taskId: manifest.task.id })}-h${short}`;
}

const stripRef = (name: string, prefix: string): string => (name.startsWith(prefix) ? name.slice(prefix.length) : name);

/**
 * Step 3, vcs `git`: fetch, create a dedicated branch at `git.commit` in the project (never the user's own branch, never force) and apply
 * the working-tree patch of the source on top. Re-entrant: HEAD already on the branch at the commit with the patch applied is "done".
 */
export async function restoreGit(hub: HandoffHub, row: HandoffRow, manifest: HandoffManifest, project: ProjectRow): Promise<{ detail: string; prepared: { workBranch: string; baseBranch: string; baseRef: string; originalBranch: string | null; originalSha: string | null } }> {
	const git = manifest.git;
	if (!git) throw new HandoffStepError("manifest_invalid", "The manifest has no git section", 3);
	const { gitService } = hub.ctx;
	const guarded = async <T>(work: () => Promise<T>, code: "git_unavailable" | "checkout_conflict"): Promise<T> => {
		try {
			return await work();
		} catch (error) {
			throw new HandoffStepError(code, errorText(error), 3);
		}
	};

	const { dir } = await guarded(() => gitService.resolve(project.id), "git_unavailable");
	const status = await guarded(() => gitService.status(project.id), "git_unavailable");
	if (!status.isRepo) throw new HandoffStepError("git_unavailable", "The project folder is not a git repository", 3);
	const workBranch = restoreMetaOf(row)?.workBranch ?? handoffBranchName(hub, row, manifest);
	const patchRow = git.patchArtifact ? hub.store.artifact(row.id, git.patchArtifact.artifactId) : undefined;
	if (git.patchArtifact && !patchRow) throw new HandoffStepError("manifest_invalid", "The working-tree patch of the handoff was not downloaded", 3);
	const commit = git.commit.toLowerCase();

	const prepared = (meta: RestoreMeta) => ({ workBranch: meta.workBranch, baseBranch: git.baseBranch, baseRef: `origin/${git.baseBranch}`, originalBranch: meta.originalBranch, originalSha: meta.originalSha });
	let meta = restoreMetaOf(row);

	if (!(status.branch === workBranch && status.headSha?.toLowerCase() === commit)) {
		if (status.branch !== workBranch) {
			if (status.operation) throw new HandoffStepError("checkout_conflict", `A ${status.operation} is in progress in the project; finish or abort it, then retry`, 3);
			const tracked = status.files.filter((f) => f.kind !== "untracked");
			if (tracked.length > 0) {
				const listed = tracked.slice(0, LISTED_PATHS).map((f) => f.path);
				throw new HandoffStepError("checkout_conflict", `The project has uncommitted changes to tracked files (${listed.join(", ")}${tracked.length > listed.length ? ` and ${tracked.length - listed.length} more` : ""}); nothing was touched. Commit, stash or discard them, then retry`, 3);
			}
			const busy = treeHolder(hub, row, project.id);
			if (busy) throw new HandoffStepError("checkout_conflict", `The project's working tree is in use by ${busy}; retry when it is free`, 3);
		}
		if ((await runGit(dir, ["cat-file", "-e", `${commit}^{commit}`])).code !== 0) {
			await guarded(() => gitService.fetch(project.id), "git_unavailable");
			if ((await runGit(dir, ["cat-file", "-e", `${commit}^{commit}`])).code !== 0) {
				throw new HandoffStepError("git_unavailable", `Commit ${commit.slice(0, 12)} is not available from origin after fetching: ${git.pushed ? "is this project linked to the right repository?" : "the source could not push it"}`, 3);
			}
		}
		if (meta === null) {
			meta = { workBranch, originalBranch: status.branch, originalSha: status.headSha, branchCreated: false };
			hub.store.patchMeta(row.id, { restore: meta });
		}
		const branches = await guarded(() => gitService.branches(project.id), "git_unavailable");
		const exists = branches.some((b) => !b.remote && stripRef(b.name, "refs/heads/") === workBranch);
		if (exists) {
			await guarded(() => gitService.checkout(project.id, workBranch), "checkout_conflict");
		} else {
			await guarded(() => gitService.createBranch(project.id, { name: workBranch, from: commit, checkout: true }), "checkout_conflict");
			meta = { ...meta, branchCreated: true };
			hub.store.patchMeta(row.id, { restore: meta });
		}
	}
	meta ??= { workBranch, originalBranch: status.branch, originalSha: status.headSha, branchCreated: false };

	let detail = `Branch ${workBranch} at ${commit.slice(0, 12)}`;
	if (patchRow) {
		const applied = await runGit(dir, ["apply", "--check", "--reverse", patchRow.path]);
		if (applied.code !== 0) {
			const check = await runGit(dir, ["apply", "--check", patchRow.path]);
			if (check.code !== 0) throw new HandoffStepError("patch_failed", `The source's uncommitted changes do not apply on top of ${commit.slice(0, 12)}: ${check.stderr.trim().slice(0, 600)}`, 3);
			const result = await runGit(dir, ["apply", patchRow.path]);
			if (result.code !== 0) throw new HandoffStepError("patch_failed", `git apply failed: ${result.stderr.trim().slice(0, 600)}`, 3);
			await gitService.status(project.id).catch(() => undefined);
		}
		detail += ` plus the patch of ${git.patchArtifact?.files.length ?? 0} file(s)`;
	}
	return { detail, prepared: prepared(meta) };
}

/** The task or handoff that currently occupies a project's working tree (a run in progress, or another restored handoff), or null. */
function treeHolder(hub: HandoffHub, row: HandoffRow, projectId: string): string | null {
	const tasks = hub.ctx.tasks.store.list({ direction: "incoming", projectId, statuses: ["running", "blocked"] });
	const task = tasks.find((t) => t.id !== row.subjectId && (t.status === "running" || execState(t).holdsTree === true));
	if (task) return `task “${task.title}”`;
	const holding = hub.store
		.nonTerminal()
		.find((h) => h.id !== row.id && h.role === "target" && h.kind === "task" && h.projectId === projectId && ["files_restored", "context_restored", "deps_ready", "validated", "session_created", "acked", "owner"].includes(h.state));
	return holding ? `another handoff (“${holding.title}”)` : null;
}

/**
 * Cleanup of a git restore (docs §6.3): remove the dedicated branch only when this handoff created it and it is untouched (tip at the
 * manifest commit, tree clean or exactly the applied patch), and return to the branch the user was on. Anything else is left alone.
 */
export async function discardGitRestore(hub: HandoffHub, row: HandoffRow, manifest: HandoffManifest): Promise<string | null> {
	const meta = restoreMetaOf(row);
	const git = manifest.git;
	if (!meta || !meta.branchCreated || !git || !row.projectId) return null;
	try {
		const { dir } = await hub.ctx.gitService.resolve(row.projectId);
		const tip = await runGit(dir, ["rev-parse", "--verify", `refs/heads/${meta.workBranch}`]);
		if (tip.code !== 0) return null;
		if (tip.stdout.trim().toLowerCase() !== git.commit.toLowerCase()) return `Left branch ${meta.workBranch}: it has commits of its own`;
		const head = await runGit(dir, ["symbolic-ref", "--short", "-q", "HEAD"]);
		const onIt = head.code === 0 && head.stdout.trim() === meta.workBranch;
		const patchRow = git.patchArtifact ? hub.store.artifact(row.id, git.patchArtifact.artifactId) : undefined;
		if (onIt) {
			const dirty = (await runGit(dir, ["status", "--porcelain", "--untracked-files=no"])).stdout.trim() !== "";
			if (dirty) {
				if (!patchRow || (await runGit(dir, ["apply", "--check", "--reverse", patchRow.path])).code !== 0) return `Left branch ${meta.workBranch}: its working tree has changes of its own`;
				if ((await runGit(dir, ["apply", "--reverse", patchRow.path])).code !== 0) return `Left branch ${meta.workBranch}: the patch could not be taken back`;
			}
			if (!meta.originalBranch) return `Left branch ${meta.workBranch}: there is no original branch to return to`;
			await hub.ctx.gitService.checkout(row.projectId, meta.originalBranch);
		}
		const deleted = await runGit(dir, ["branch", "-D", meta.workBranch]);
		await hub.ctx.gitService.status(row.projectId).catch(() => undefined);
		return deleted.code === 0 ? `Removed branch ${meta.workBranch}` : `Could not remove branch ${meta.workBranch}: ${deleted.stderr.trim()}`;
	} catch (error) {
		return `Left branch ${meta.workBranch}: ${errorText(error)}`;
	}
}

// ------------------------------------------------------------------ files

/** Where `TaskFiles.collectResult` looks for the folder state the result is measured against. */
export const baseManifestPath = (hub: HandoffHub, taskId: string): string => path.join(hub.ctx.tasks.artifacts.taskDir(taskId), ".base-manifest.json");

/**
 * Step 3, vcs `files`: unpack the folder bundle into the project without replacing anything that differs (`files_conflict`), then install the
 * base manifest the result is measured against (the executor's, or — when the source had none — the folder as it is now).
 */
export async function restoreFilesBundle(hub: HandoffHub, row: HandoffRow, manifest: HandoffManifest, project: ProjectRow): Promise<string> {
	const files = manifest.files;
	if (!files) throw new HandoffStepError("manifest_invalid", "The manifest has no files bundle", 3);
	const bundle = hub.store.artifact(row.id, files.artifactId);
	if (!bundle) throw new HandoffStepError("manifest_invalid", "The folder bundle of the handoff was not downloaded", 3);
	let listed: Awaited<ReturnType<typeof readBundleManifest>>;
	try {
		listed = await guardBundle(() => readBundleManifest(bundle.path));
		const result = await guardBundle(() => applyBundle(bundle.path, project.path));
		const conflicts = result.skipped.filter((s) => s.reason === "conflict").map((s) => s.path);
		if (conflicts.length > 0) {
			throw new HandoffStepError("files_conflict", `${conflicts.length} file(s) in the project folder differ from the handed-over ones and were not replaced: ${conflicts.slice(0, LISTED_PATHS).join(", ")}${conflicts.length > LISTED_PATHS ? " …" : ""}`, 3);
		}
	} catch (error) {
		if (error instanceof HandoffStepError) throw error;
		if (error instanceof ApiError && error.status === 422) throw new HandoffStepError("manifest_invalid", error.message, 3);
		if (isNoSpace(error)) throw new HandoffStepError("disk_full", "No space left to restore the files", 3);
		throw error;
	}

	await mkdir(path.dirname(baseManifestPath(hub, manifest.task.id)), { recursive: true, mode: 0o700 });
	const baseRow = files.base ? hub.store.artifact(row.id, files.base.artifactId) : undefined;
	if (files.base && !baseRow) throw new HandoffStepError("manifest_invalid", "The base manifest of the handoff was not downloaded", 3);
	if (baseRow) {
		let base: BundleManifest;
		try {
			base = BundleManifest.parse(JSON.parse(await readFile(baseRow.path, "utf8")));
		} catch {
			throw new HandoffStepError("manifest_invalid", "The base manifest of the handoff is not valid", 3);
		}
		await writeFile(baseManifestPath(hub, manifest.task.id), JSON.stringify(base), { mode: 0o600 });
	} else {
		await writeFile(baseManifestPath(hub, manifest.task.id), JSON.stringify(await guardBundle(() => scanFolder(project.path))), { mode: 0o600 });
	}
	return `${listed.files.length} file(s) restored into ${project.path}`;
}
