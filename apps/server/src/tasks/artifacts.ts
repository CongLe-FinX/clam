import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { artifacts } from "@clam/database";
import { scanForSecrets } from "@clam/git-engine";
import { i18nMsg } from "@clam/contracts";
import { ApiError } from "../http/errors.ts";
import { newArtifactId, type ArtifactRow, type TaskStore } from "./store.ts";

/** Largest artifact the executor stores or serves (docs/agent-network-protocol.md §5.14: small, task-scoped files; no bulk transfer in M4). */
export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;

const TEXT_NAME = /\.(?:patch|diff|txt|md|json|log|ya?ml|toml|csv)$/i;

/**
 * Task artifacts on the executor, under `<dataDir>/artifacts/<taskId>/<artifactId>`: size-capped, hashed, and
 * text artifacts are scanned for credentials before they can ever be offered to a peer (a hit refuses the artifact;
 * the finding's rule is reported, never its content).
 */
export class ArtifactStore {
	constructor(
		private readonly store: TaskStore,
		private readonly root: string,
	) {}

	/**
	 * Move an existing file (a folder bundle built next to it) into place as an artifact and return the row values, WITHOUT
	 * inserting them (the caller inserts them in its own transaction). The digest is computed while reading. `id` lets a node
	 * keep a copy under the id the other node knows it by. Bundles are not text-scanned here: their files are scanned before
	 * the bundle is built.
	 */
	async placeFile(taskId: string, input: { name: string; mediaType: string; file: string; id?: string }): Promise<typeof artifacts.$inferInsert> {
		const { size } = await stat(input.file);
		if (size > MAX_ARTIFACT_BYTES) throw new ApiError(413, "artifact_too_large", i18nMsg("Artifact {name} is {size} bytes; the limit is {limit}", { name: input.name, size, limit: MAX_ARTIFACT_BYTES }));
		const hash = createHash("sha256");
		for await (const chunk of createReadStream(input.file) as AsyncIterable<Buffer>) hash.update(chunk);
		const id = input.id ?? newArtifactId();
		const relative = path.join(taskId, id);
		const absolute = path.join(this.root, relative);
		await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
		await chmod(input.file, 0o600);
		await rename(input.file, absolute);
		return {
			id,
			taskId,
			name: input.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "artifact",
			mediaType: input.mediaType,
			size,
			sha256: hash.digest("hex"),
			storagePath: relative,
		};
	}

	/** `placeFile` + insert the row. */
	async addFile(taskId: string, input: { name: string; mediaType: string; file: string; id?: string }): Promise<ArtifactRow> {
		return this.store.insertArtifact(await this.placeFile(taskId, input));
	}

	/** Forget an artifact's file (the row stays out of it: callers delete the row with the task). */
	async removeFile(row: ArtifactRow): Promise<void> {
		await rm(this.absolutePath(row), { force: true });
	}

	/** The directory holding a task's artifacts (and its executor-private files). */
	taskDir(taskId: string): string {
		return path.join(this.root, taskId);
	}

	/** A scratch path inside the artifact root (same filesystem as the final location, so `addFile` is a rename). */
	async scratch(taskId: string, label: string): Promise<string> {
		const dir = path.join(this.root, taskId);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		return path.join(dir, `.${label}.${process.pid}.${Date.now()}.tmp`);
	}

	async add(taskId: string, input: { name: string; mediaType: string; bytes: Buffer }): Promise<ArtifactRow> {
		if (input.bytes.length > MAX_ARTIFACT_BYTES) {
			throw new ApiError(413, "artifact_too_large", i18nMsg("Artifact {name} is {size} bytes; the limit is {limit}", { name: input.name, size: input.bytes.length, limit: MAX_ARTIFACT_BYTES }));
		}
		const looksTextual = input.mediaType.startsWith("text/") || input.mediaType.endsWith("json") || TEXT_NAME.test(input.name);
		if (looksTextual) {
			const findings = scanForSecrets(input.bytes.toString("utf8"), input.name);
			if (findings.length > 0) {
				const rules = [...new Set(findings.map((f) => f.rule))].join(", ");
				throw new ApiError(422, "artifact_contains_secrets", i18nMsg("Artifact {name} looks like it contains credentials ({rules}, first at line {line}); it was not stored", { name: input.name, rules, line: findings[0]?.line ?? 0 }), {
					rules: [...new Set(findings.map((f) => f.rule))],
				});
			}
		}
		const id = newArtifactId();
		const relative = path.join(taskId, id);
		const absolute = path.join(this.root, relative);
		await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
		await writeFile(absolute, input.bytes, { mode: 0o600 });
		return this.store.insertArtifact({
			id,
			taskId,
			name: input.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "artifact",
			mediaType: input.mediaType,
			size: input.bytes.length,
			sha256: createHash("sha256").update(input.bytes).digest("hex"),
			storagePath: relative,
		});
	}

	/** Absolute path of a stored artifact (always inside the artifacts root). */
	absolutePath(row: ArtifactRow): string {
		const absolute = path.resolve(this.root, row.storagePath);
		if (!absolute.startsWith(`${path.resolve(this.root)}${path.sep}`)) throw new ApiError(500, "internal_error", i18nMsg("Artifact path escapes the artifact directory"));
		return absolute;
	}
}
