import type { HandoffManifestInput } from "../src/index.ts";

export const SHA = "a".repeat(64);
export const COMMIT = "0123456789abcdef0123456789abcdef01234567";

export function manifestInput(overrides: Record<string, unknown> = {}): HandoffManifestInput {
	const base: HandoffManifestInput = {
		schemaVersion: 1,
		handoffId: "hnd_01",
		correlationId: "cor_01",
		createdAt: "2026-01-01T10:00:00.000Z",
		expiresAt: "2026-01-01T10:30:00.000Z",
		deadlineAt: "2026-01-01T11:00:00.000Z",
		task: {
			id: "task_01",
			title: "Build the report",
			description: "Write the quarterly report",
			deliverAs: "files",
			acceptanceCriteria: ["report.md exists"],
			status: "running",
			plan: { planPath: ".clmesh/plans/task_01.md", text: "1. outline\n2. write" },
			todos: [
				{ phase: "Write", content: "outline", status: "completed" },
				{ phase: "Write", content: "draft", status: "in_progress" },
			],
			remaining: ["draft", "proofread"],
		},
		workspaceId: "ws_01",
		projectId: null,
		fromEpoch: 0,
		toEpoch: 1,
		source: { nodeId: "node_a", name: "alpha", fingerprint: "f".repeat(64), agentId: "agent_a" },
		target: { nodeId: "node_b", name: "beta", fingerprint: "e".repeat(64), agentId: null },
		vcs: "files",
		git: null,
		files: { artifactId: "art_files", sha256: SHA, size: 1234, fileCount: 3 },
		contexts: [{ id: "ctx_1", version: 2, sha256: SHA }],
		conversationSummary: { text: "We outlined the report and started drafting.", generatedBy: "clam", scanned: true },
		transcript: null,
		environment: {
			os: "darwin",
			arch: "arm64",
			runtimes: [{ name: "node", versionRange: ">=22" }],
			packageManager: { name: "pnpm", lockfile: "pnpm-lock.yaml", installCommand: "pnpm install --frozen-lockfile" },
			requiredEnvVars: ["API_BASE_URL"],
			setupCommands: [],
			checkCommand: null,
		},
		requiredFiles: ["report.md"],
		artifacts: [],
	};
	return { ...base, ...overrides } as HandoffManifestInput;
}
