import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GitEngineError } from "./errors.ts";
import { scanForSecrets } from "./secrets.ts";
import type { GitEngine } from "./engine.ts";

export interface ClmeshInitOptions {
	workspaceId: string;
	projectId: string;
	projectName: string;
}

function readme(projectName: string): string {
	const name = projectName.replace(/[\r\n]+/g, " ").trim() || "this project";
	return `# .clmesh

This directory is written by **CL Agent Mesh** and is versioned with the repository so that every machine working on **${name}** shares the same project state.

It holds reviewable text only: project memory, plans, task snapshots, handoff manifests and the shared-context index. Nothing in here is a credential, a conversation transcript, an agent session file or an absolute local path. Every file is scanned for secrets before it is written.

| Path | Purpose |
| --- | --- |
| \`config.json\` | Identifies the workspace and project this repository belongs to (\`schema\` and \`version\` are 1). |
| \`memory/\` | Approved project memory shared with the team. |
| \`plans/\` | Agent plans and remaining TODOs, one file per task. |
| \`tasks/\` | Task snapshots (title, status, owner, links). |
| \`handoffs/\` | Handoff manifests. |
| \`context/\` | Index of synchronised context documents. |

Changes here are ordinary commits: review them like code, resolve merge conflicts the normal way, and never force-push them.
`;
}

/** JSON with recursively sorted keys, 2-space indent, trailing newline — stable and merge-friendly. */
export function stableJson(value: unknown): string {
	const sort = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(sort);
		if (v && typeof v === "object") {
			return Object.fromEntries(
				Object.entries(v as Record<string, unknown>)
					.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
					.map(([k, x]) => [k, sort(x)]),
			);
		}
		return v;
	};
	return `${JSON.stringify(sort(value), null, 2)}\n`;
}

/** Creates `.clmesh/README.md` and `.clmesh/config.json` (never overwriting, never committing). */
export async function initClmesh(engine: GitEngine, dir: string, o: ClmeshInitOptions): Promise<{ written: string[]; skipped: string[] }> {
	if (!(await engine.isRepo(dir))) throw new GitEngineError("not_a_repo", `${dir} is not the root of a git repository`);
	const files: Array<{ rel: string; content: string }> = [
		{ rel: ".clmesh/README.md", content: readme(o.projectName) },
		{ rel: ".clmesh/config.json", content: stableJson({ projectId: o.projectId, schema: 1, version: 1, workspaceId: o.workspaceId }) },
	];

	// Scan everything first so a hit writes nothing.
	for (const f of files) {
		const hits = scanForSecrets(f.content, f.rel);
		if (hits.length > 0) {
			const first = hits[0];
			throw new GitEngineError("secret_detected", `Refusing to write ${f.rel}: possible secret (${hits.map((h) => `${h.rule}@${h.line}`).join(", ")})`, first ? first.excerpt : "");
		}
	}

	const root = join(dir, ".clmesh");
	const existing = await lstat(root).catch(() => null);
	if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) {
		throw new GitEngineError("failed", ".clmesh exists and is not a plain directory");
	}
	await mkdir(root, { recursive: true });

	const written: string[] = [];
	const skipped: string[] = [];
	for (const f of files) {
		try {
			await writeFile(join(dir, f.rel), f.content, { flag: "wx", encoding: "utf8" });
			written.push(f.rel);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "EEXIST") skipped.push(f.rel);
			else throw err;
		}
	}
	return { written, skipped };
}
