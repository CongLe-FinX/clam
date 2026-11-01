import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { i18nMsg, type ContextExportResult, type ContextImportResult, type ContextType } from "@clam/contracts";
import {
	CLMESH_INDEX,
	MAX_FILE_BYTES,
	TYPE_DIRS,
	contextPath,
	fileToVersion,
	isContextFilePath,
	parseContextFile,
	renderContextFile,
	renderIndex,
	type IndexEntry,
} from "@clam/context-engine";
import { initClmesh, scanForSecrets } from "@clam/git-engine";
import { ApiError } from "../http/errors.ts";
import { errorText } from "../network/util.ts";
import { projectVcs } from "../services/project-folders.ts";
import { projectKeyOf } from "./project-keys.ts";
import type { ContextService } from "./service.ts";
import type { ContextRow } from "./store.ts";

const CLMESH = ".clmesh";

interface Scope {
	projectId: string;
	projectName: string;
	workspaceId: string;
	dir: string;
	key: string;
}

interface FileOnDisk {
	/** Relative to `.clmesh/`, POSIX separators. */
	rel: string;
	abs: string;
}

/**
 * `.clmesh/` export and import for git projects (docs/github-integration.md §9). Export writes the shareable contexts of a
 * project's workspace into the working tree through the secret scanner (a hit refuses that file; nothing is committed, ever);
 * import reads the directory (e.g. after a pull) through the same engine rules as a peer's push: fast-forward, stale or conflict.
 * Operations of one project run one at a time.
 */
export class ClmeshService {
	private readonly queues = new Map<string, Promise<unknown>>();

	constructor(private readonly hub: ContextService) {}

	private serialize<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
		const run = (this.queues.get(projectId) ?? Promise.resolve()).then(fn, fn);
		const tail = run.catch(() => undefined);
		this.queues.set(projectId, tail);
		void tail.then(() => {
			if (this.queues.get(projectId) === tail) this.queues.delete(projectId);
		});
		return run;
	}

	private async scopeOf(projectId: string): Promise<Scope> {
		const { row, dir } = await this.hub.ctx.gitService.resolve(projectId);
		if (projectVcs(dir) !== "git") {
			throw new ApiError(409, "not_a_git_project", i18nMsg("Exporting to and importing from .clmesh/ needs a git project; this project is a plain folder (its contexts still sync to the other nodes of the workspace)."));
		}
		return { projectId, projectName: row.name, workspaceId: row.workspaceId, dir, key: projectKeyOf(row) };
	}

	/** `.clmesh/` must be a real directory, never a link that could lead the writes elsewhere. */
	private async rootOf(scope: Scope, create: boolean): Promise<string | null> {
		const root = path.join(scope.dir, CLMESH);
		const info = await lstat(root).catch(() => null);
		if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new ApiError(409, "clmesh_not_a_directory", i18nMsg(".clmesh exists but is not a plain directory"));
		if (!info) {
			if (!create) return null;
			await mkdir(root, { recursive: true });
		}
		return root;
	}

	/** Context files currently under `.clmesh/` (regular files only; links and strangers are ignored). */
	private async filesOf(root: string): Promise<FileOnDisk[]> {
		const out: FileOnDisk[] = [];
		for (const dirName of Object.values(TYPE_DIRS)) {
			const dir = path.join(root, dirName);
			const info = await lstat(dir).catch(() => null);
			if (!info || info.isSymbolicLink() || !info.isDirectory()) continue;
			for (const name of (await readdir(dir)).sort()) {
				const rel = `${dirName}/${name}`;
				if (!isContextFilePath(rel)) continue;
				const abs = path.join(dir, name);
				const file = await lstat(abs).catch(() => null);
				if (file?.isFile()) out.push({ rel, abs });
			}
		}
		return out;
	}

	private async writeAtomic(abs: string, content: string): Promise<void> {
		await mkdir(path.dirname(abs), { recursive: true });
		const temp = path.join(path.dirname(abs), `.${path.basename(abs)}.${randomBytes(4).toString("hex")}.tmp`);
		try {
			await writeFile(temp, content, { encoding: "utf8", flag: "wx", mode: 0o644 });
			await rename(temp, abs);
		} catch (error) {
			await rm(temp, { force: true });
			throw error;
		}
	}

	private async readIfFile(abs: string): Promise<string | null> {
		const info = await lstat(abs).catch(() => null);
		if (!info || !info.isFile() || info.size > MAX_FILE_BYTES * 2) return null;
		return readFile(abs, "utf8");
	}

	// ------------------------------------------------------------------ export

	/**
	 * Write the project's shareable contexts (its own and the workspace-wide ones) to `.clmesh/`. A file whose text trips the
	 * secret scanner is refused and reported (nothing is written for it); files of contexts that are no longer
	 * shareable (or were deleted) are removed from the working tree. Never stages or commits.
	 */
	async export(projectId: string): Promise<ContextExportResult> {
		const scope = await this.scopeOf(projectId);
		return this.serialize(projectId, async () => {
			const { hub } = this;
			await initClmesh(hub.ctx.git, scope.dir, { workspaceId: scope.workspaceId, projectId, projectName: scope.projectName }).catch((error: unknown) => {
				// A secret in the project's own name is not a reason to lose the contexts; anything else is.
				if (!(error instanceof Error) || (error as { code?: string }).code !== "secret_detected") throw error;
			});
			const root = (await this.rootOf(scope, true)) as string;
			const rows = hub.store.rows({ workspaceId: scope.workspaceId, project: { id: projectId, key: scope.key, includeWorkspaceWide: true }, shareable: true, limit: 1000 });
			const existing = await this.filesOf(root);

			// Which file belongs to which context (by the id in its front matter).
			const owner = new Map<string, string>();
			const idsOnDisk = new Map<string, string>();
			for (const f of existing) {
				const text = await this.readIfFile(f.abs);
				const parsed = text === null ? null : parseContextFile(text, f.rel);
				if (parsed?.ok) {
					owner.set(f.rel, parsed.front.id);
					idsOnDisk.set(parsed.front.id, f.rel);
				}
			}

			const exportedIds = new Set(rows.map((r) => r.id));
			const taken = new Set<string>();
			for (const [rel, id] of owner) if (!exportedIds.has(id)) taken.add(rel);
			const written: string[] = [];
			const unchanged: string[] = [];
			const refused: ContextExportResult["refused"] = [];
			const index: IndexEntry[] = [];

			for (const row of rows) {
				const head = hub.store.head(row);
				const known = [row.gitPath, idsOnDisk.get(row.id)].find((p): p is string => typeof p === "string" && isContextFilePath(p) && !taken.has(p) && (owner.get(p) === undefined || owner.get(p) === row.id));
				const rel = known ?? contextPath({ id: row.id, type: row.type as ContextType, title: head.title, createdAt: row.createdAt }, taken);
				taken.add(rel);
				const text = renderContextFile({
					id: row.id,
					type: row.type as ContextType,
					title: head.title,
					body: head.body,
					version: head.version,
					sha256: head.sha256,
					base: head.base,
					scope: row.projectId === null && row.projectKey === null ? "workspace" : "project",
					author: head.author,
					updatedAt: row.updatedAt,
				});
				const hits = scanForSecrets(text, `${CLMESH}/${rel}`);
				if (hits.length > 0) {
					const first = hits[0] as { rule: string; line: number };
					refused.push({ contextId: row.id, path: `${CLMESH}/${rel}`, rule: first.rule, line: first.line });
					continue;
				}
				const abs = path.join(root, ...rel.split("/"));
				const current = await this.readIfFile(abs);
				if (current === text) unchanged.push(`${CLMESH}/${rel}`);
				else {
					await this.writeAtomic(abs, text);
					written.push(`${CLMESH}/${rel}`);
				}
				index.push({ id: row.id, path: rel, sha256: head.sha256, version: head.version });
				if (row.gitPath !== rel) hub.store.update(row.id, { gitPath: rel });
			}

			// Files of contexts that are not shareable any more (or were deleted) must not stay in the repository's working tree.
			const removed: string[] = [];
			for (const f of existing) {
				const id = owner.get(f.rel);
				if (id === undefined || exportedIds.has(id)) continue;
				const local = hub.store.find(id);
				if (local && (!local.shareable || local.deletedAt !== null)) {
					await rm(f.abs, { force: true });
					removed.push(`${CLMESH}/${f.rel}`);
				}
			}

			const indexText = renderIndex(index);
			const indexAbs = path.join(root, ...CLMESH_INDEX.split("/"));
			if ((await this.readIfFile(indexAbs)) === indexText) unchanged.push(`${CLMESH}/${CLMESH_INDEX}`);
			else {
				await this.writeAtomic(indexAbs, indexText);
				written.push(`${CLMESH}/${CLMESH_INDEX}`);
			}

			const result: ContextExportResult = { written, unchanged, removed, refused };
			try {
				result.status = await hub.ctx.gitService.status(projectId);
			} catch (error) {
				hub.log.debug({ err: errorText(error), projectId }, "git status after a context export failed");
			}
			return result;
		});
	}

	// ------------------------------------------------------------------ import

	/**
	 * Read `.clmesh/` into contexts. A file of a version this node lacks moves the context forward (or creates it); an older
	 * or identical one changes nothing; one that was edited from a version this node has since left behind is a
	 * conflict (reported, never merged). Files with a secret, bad front matter, another workspace's context or a
	 * context that is private here are skipped and reported.
	 */
	async import(projectId: string): Promise<ContextImportResult> {
		const scope = await this.scopeOf(projectId);
		return this.serialize(projectId, async () => {
			const { hub } = this;
			const result: ContextImportResult = { created: [], updated: [], unchanged: [], conflicts: [], skipped: [] };
			const root = await this.rootOf(scope, false);
			if (root === null) return result;
			const at = (): string => new Date().toISOString();
			for (const file of await this.filesOf(root)) {
				const shown = `${CLMESH}/${file.rel}`;
				const skip = (reason: string): void => void result.skipped.push({ path: shown, reason });
				const info = await lstat(file.abs).catch(() => null);
				if (!info?.isFile()) continue;
				if (info.size > MAX_FILE_BYTES) {
					skip("file is larger than 1 MiB");
					continue;
				}
				const text = await readFile(file.abs, "utf8");
				const parsed = parseContextFile(text, file.rel);
				if (!parsed.ok) {
					skip(parsed.reason);
					continue;
				}
				const hits = scanForSecrets(text, shown);
				if (hits.length > 0) {
					skip(`possible secret (${hits.map((h) => `${h.rule}@${h.line}`).join(", ")}); not imported`);
					continue;
				}
				const { front } = parsed;
				const existing = hub.store.find(front.id);
				if (existing && existing.workspaceId !== scope.workspaceId) {
					skip("belongs to another workspace");
					continue;
				}
				if (existing && existing.deletedAt === null && !existing.shareable) {
					skip("private on this node");
					continue;
				}
				const { version, edited } = fileToVersion(parsed, { author: hub.systemAuthor(), originNodeId: hub.nodeId, at: at() });
				// A file somebody edited by hand is a person's edit; an untouched one is just a copy of a version.
				if (edited) version.author = hub.humanAuthor();
				const projectScope = front.scope === "project" ? { id: projectId, key: scope.key } : { id: null, key: null };
				const { row, applied, headMoved, conflictChanged } = hub.applyVersion({
					existing,
					workspaceId: scope.workspaceId,
					contextId: front.id,
					type: front.type,
					originNodeId: hub.nodeId,
					contextCreatedAt: Number.isNaN(Date.parse(front.updated)) ? at() : front.updated,
					project: projectScope,
					incoming: version,
					from: { nodeId: "git", nodeName: ".clmesh" },
				});
				if (row.gitPath !== file.rel) hub.store.update(row.id, { gitPath: file.rel });
				switch (applied.outcome) {
					case "new":
						result.created.push(shown);
						break;
					case "fast_forward":
					case "resurrect":
						result.updated.push(shown);
						break;
					case "conflict":
					case "conflict_updated":
					case "conflict_extra":
						result.conflicts.push(shown);
						break;
					default:
						result.unchanged.push(shown);
				}
				const fresh = hub.store.find(row.id) ?? row;
				if (headMoved || conflictChanged) hub.publish(fresh);
				if (headMoved) hub.sync.changed(fresh);
			}
			return result;
		});
	}
}
