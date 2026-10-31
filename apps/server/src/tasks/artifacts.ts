import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { scanForSecrets } from "@clam/git-engine";
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

	async add(taskId: string, input: { name: string; mediaType: string; bytes: Buffer }): Promise<ArtifactRow> {
		if (input.bytes.length > MAX_ARTIFACT_BYTES) {
			throw new ApiError(413, "artifact_too_large", `Artifact ${input.name} is ${input.bytes.length} bytes; the limit is ${MAX_ARTIFACT_BYTES}`);
		}
		const looksTextual = input.mediaType.startsWith("text/") || input.mediaType.endsWith("json") || TEXT_NAME.test(input.name);
		if (looksTextual) {
			const findings = scanForSecrets(input.bytes.toString("utf8"), input.name);
			if (findings.length > 0) {
				const rules = [...new Set(findings.map((f) => f.rule))].join(", ");
				throw new ApiError(422, "artifact_contains_secrets", `Artifact ${input.name} looks like it contains credentials (${rules}, first at line ${findings[0]?.line}); it was not stored`, {
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
		if (!absolute.startsWith(`${path.resolve(this.root)}${path.sep}`)) throw new ApiError(500, "internal_error", "Artifact path escapes the artifact directory");
		return absolute;
	}
}
