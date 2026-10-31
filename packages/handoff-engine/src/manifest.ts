import { HandoffEnvironment, TaskConstraints, TaskDeliverAs } from "@clam/contracts";
import { z } from "zod";
import { canonicalJson, sha256OfCanonical } from "./canonical.ts";
import { type ManifestSecretFinding, scanManifestForSecrets } from "./secrets.ts";

/**
 * Handoff manifest (docs/handoff-protocol.md §2), adapted for work that may have NO git repository:
 * `vcs` says how the files travel — `git` (pushed branch + commit, optional patch artifact), `files`
 * (a `@clam/workspace-files` bundle artifact) or `none` (nothing to restore: research/report chats).
 * Only references, names and hashes live here — never secret values.
 */

const IsoTimestamp = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "not an ISO timestamp");
const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "expected lowercase hex sha-256");
const EnvVarName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "environment variable NAME only");
const RelPath = z
	.string()
	.min(1)
	.refine((p) => !p.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(p) && !p.split(/[\\/]/).includes(".."), "must be a relative path inside the work folder");

export const ManifestNode = z.object({
	nodeId: z.string().min(1),
	name: z.string().min(1),
	fingerprint: z.string().min(1),
	agentId: z.string().min(1).nullable(),
});
export type ManifestNode = z.infer<typeof ManifestNode>;

export const ManifestArtifactRef = z.object({
	artifactId: z.string().min(1),
	sha256: Sha256Hex,
	size: z.number().int().nonnegative(),
});
export type ManifestArtifactRef = z.infer<typeof ManifestArtifactRef>;

export const ManifestGit = z.object({
	/** https/ssh clone URL, never with embedded credentials. */
	repoUrl: z.string().min(1).refine(noUrlCredentials, "repoUrl must not embed credentials"),
	branch: z.string().min(1),
	/** Full sha the target MUST check out. */
	commit: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i, "expected a full commit sha"),
	baseBranch: z.string().min(1),
	/** Commit reachable from the remote. */
	pushed: z.boolean(),
	/** `git diff --binary` of uncommitted changes, applied on top of `commit`. */
	patchArtifact: ManifestArtifactRef.extend({ baseCommit: z.string().min(1), files: z.array(RelPath) }).optional(),
});
export type ManifestGit = z.infer<typeof ManifestGit>;

/** A `@clam/workspace-files` bundle. */
export const ManifestFiles = ManifestArtifactRef.extend({
	fileCount: z.number().int().nonnegative(),
	/** The executor's "state at the start" manifest of the work folder: the target keeps measuring the task's result files against it. */
	base: ManifestArtifactRef.nullable().default(null),
});
export type ManifestFiles = z.infer<typeof ManifestFiles>;

export const ManifestTodo = z.object({
	phase: z.string().optional(),
	content: z.string(),
	status: z.string(),
});
export type ManifestTodo = z.infer<typeof ManifestTodo>;

/** One message of the task's discussion thread (the new executor continues the same thread). */
export const ManifestThreadMessage = z.object({
	id: z.string().min(1),
	authorKind: z.enum(["human", "agent", "system"]),
	authorNodeId: z.string(),
	authorNodeName: z.string(),
	authorAgentId: z.string().nullable().default(null),
	authorAgentName: z.string().nullable().default(null),
	kind: z.string(),
	text: z.string(),
	createdAt: IsoTimestamp,
});
export type ManifestThreadMessage = z.infer<typeof ManifestThreadMessage>;

export const ManifestTask = z.object({
	id: z.string().min(1),
	title: z.string(),
	description: z.string(),
	deliverAs: TaskDeliverAs,
	acceptanceCriteria: z.array(z.string()).default([]),
	status: z.enum(["running", "blocked"]).default("running"),
	/** Plan text or path (`.clmesh/plans/<taskId>.md`), plus the structured todos from OMP `get_state.todoPhases`. */
	plan: z.object({ planPath: z.string().nullable().default(null), text: z.string().nullable().default(null) }).default({ planPath: null, text: null }),
	todos: z.array(ManifestTodo).default([]),
	/** Remaining TODOs, human-readable. */
	remaining: z.array(z.string()).default([]),
	/** The node that delegated the task (results and events keep going to it) and the delegation's own identifiers. */
	sender: z.object({ nodeId: z.string().min(1), nodeName: z.string().min(1), agentId: z.string().nullable().default(null), agentName: z.string().nullable().default(null) }).nullable().default(null),
	constraints: TaskConstraints.default({}),
	/** Correlation id of the delegation, preserved so both nodes trace one flow. */
	taskCorrelationId: z.string().nullable().default(null),
	/** The executor's last event seq at sealing: the new executor continues the timeline at `lastEventSeq + 1`. */
	lastEventSeq: z.number().int().nonnegative().default(0),
	/** Repository the task was delegated for (base branch / commit as the sender announced them). */
	repo: z.object({ url: z.string(), branch: z.string().nullable().default(null), commit: z.string().nullable().default(null) }).nullable().default(null),
	thread: z.array(ManifestThreadMessage).default([]),
});
export type ManifestTask = z.infer<typeof ManifestTask>;

export const ManifestContextRef = z.object({
	id: z.string().min(1),
	version: z.number().int().nonnegative(),
	sha256: Sha256Hex,
});
export type ManifestContextRef = z.infer<typeof ManifestContextRef>;

export const HandoffManifest = z
	.object({
		schemaVersion: z.literal(1),
		handoffId: z.string().min(1),
		correlationId: z.string().min(1),
		createdAt: IsoTimestamp,
		/** Offer lifetime. */
		expiresAt: IsoTimestamp,
		/** Restore deadline (accept → ack), absolute. */
		deadlineAt: IsoTimestamp,

		task: ManifestTask,
		workspaceId: z.string().min(1),
		projectId: z.string().min(1).nullable(),

		fromEpoch: z.number().int().nonnegative(),
		/** `fromEpoch + 1`. */
		toEpoch: z.number().int().positive(),
		source: ManifestNode,
		target: ManifestNode,

		vcs: z.enum(["git", "files", "none"]),
		git: ManifestGit.nullable(),
		files: ManifestFiles.nullable(),

		contexts: z.array(ManifestContextRef).default([]),
		/** Secret-scanned summary (OMP `handoff`). */
		conversationSummary: z.object({ text: z.string(), generatedBy: z.enum(["omp-handoff", "clam"]), scanned: z.literal(true) }),
		/** Optional OMP `session pack` of the old transcript (opt-in, reference only). */
		transcript: ManifestArtifactRef.nullable().default(null),
		/** Names only. */
		environment: HandoffEnvironment,
		/** Paths that must exist after restore (step 6). */
		requiredFiles: z.array(RelPath).default([]),
		execution: z
			.object({
				lastModel: z.string().optional(),
				progress: z.object({ phase: z.string().optional(), step: z.string().optional(), percent: z.number().optional() }).default({}),
				lastToolSummary: z.string().optional(),
			})
			.optional(),
		/** Other artifacts the target downloads (logs, results). */
		artifacts: z.array(ManifestArtifactRef.extend({ name: z.string(), kind: z.string() })).default([]),
	})
	.superRefine((m, ctx) => {
		const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
		if (m.toEpoch !== m.fromEpoch + 1) issue(["toEpoch"], "toEpoch must equal fromEpoch + 1");
		if (m.vcs === "git") {
			if (!m.git) issue(["git"], "vcs=git requires git");
			else if (!m.git.pushed && !m.git.patchArtifact) issue(["git", "pushed"], "git.commit must be pushed or a patch artifact present");
			if (m.files) issue(["files"], "vcs=git must not carry a files bundle");
		} else if (m.vcs === "files") {
			if (!m.files) issue(["files"], "vcs=files requires a files bundle");
			if (m.git) issue(["git"], "vcs=files must not carry git");
		} else {
			if (m.git) issue(["git"], "vcs=none must not carry git");
			if (m.files) issue(["files"], "vcs=none must not carry a files bundle");
		}
		if (Date.parse(m.expiresAt) < Date.parse(m.createdAt)) issue(["expiresAt"], "expiresAt before createdAt");
		if (m.source.nodeId === m.target.nodeId) issue(["target", "nodeId"], "source and target must differ");
		for (const [i, name] of m.environment.requiredEnvVars.entries()) {
			if (!EnvVarName.safeParse(name).success) issue(["environment", "requiredEnvVars", i], "environment variable NAME only");
		}
		for (const [i, cmd] of m.environment.setupCommands.entries()) {
			if (/[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]*@/i.test(cmd)) issue(["environment", "setupCommands", i], "setup command embeds URL credentials");
		}
	});
export type HandoffManifest = z.infer<typeof HandoffManifest>;
export type HandoffManifestInput = z.input<typeof HandoffManifest>;

function noUrlCredentials(url: string): boolean {
	try {
		const u = new URL(url);
		return u.username === "" && u.password === "";
	} catch {
		// scp-style `git@github.com:org/repo.git` has no password part; reject `user:pass@` spellings.
		return !/^[^@\s/]+:[^@\s]+@/.test(url);
	}
}

/** Canonical bytes' SHA-256 (hex) of a manifest (or any JSON value, e.g. a raw received document). */
export function manifestSha256(manifest: unknown): string {
	return sha256OfCanonical(manifest);
}

export type ManifestFailureCode = "manifest_invalid" | "secret_detected" | "hash_mismatch" | "expired" | "wrong_target";

export type SealResult =
	| { ok: true; manifest: HandoffManifest; canonical: string; sha256: string }
	| { ok: false; code: "manifest_invalid"; issues: string[] }
	| { ok: false; code: "secret_detected"; findings: ManifestSecretFinding[] };

/**
 * Source side before sending: Zod-validate (filling defaults), secret-scan every string, then hash the
 * canonical form of the PARSED manifest. Always send and store `manifest`, never the raw input.
 */
export function sealManifest(input: unknown): SealResult {
	const parsed = HandoffManifest.safeParse(input);
	if (!parsed.success) return { ok: false, code: "manifest_invalid", issues: formatIssues(parsed.error) };
	const findings = scanManifestForSecrets(parsed.data);
	if (findings.length > 0) return { ok: false, code: "secret_detected", findings };
	return { ok: true, manifest: parsed.data, canonical: canonicalJson(parsed.data), sha256: manifestSha256(parsed.data) };
}

export type VerifyResult =
	| { ok: true; manifest: HandoffManifest }
	| { ok: false; code: "manifest_invalid"; detail: string }
	| { ok: false; code: "secret_detected"; detail: string; findings: ManifestSecretFinding[] }
	| { ok: false; code: "hash_mismatch" | "expired" | "wrong_target"; detail: string };

/**
 * Target step 1: re-validate a received document — schema, `expectedSha256` over the received JSON as
 * delivered, secret scan, offer expiry and that `target.nodeId` is this node. `now` is epoch ms or a Date.
 */
export function verifyReceivedManifest(
	raw: unknown,
	opts: { expectedSha256: string; selfNodeId: string; now?: number | Date },
): VerifyResult {
	const parsed = HandoffManifest.safeParse(raw);
	if (!parsed.success) return { ok: false, code: "manifest_invalid", detail: formatIssues(parsed.error).join("; ") };
	if (manifestSha256(raw) !== opts.expectedSha256.toLowerCase()) {
		return { ok: false, code: "hash_mismatch", detail: "manifest hash does not match manifestSha256" };
	}
	const findings = scanManifestForSecrets(parsed.data);
	if (findings.length > 0) {
		return { ok: false, code: "secret_detected", detail: `${findings.length} secret-like value(s) in the manifest`, findings };
	}
	if (parsed.data.target.nodeId !== opts.selfNodeId) {
		return { ok: false, code: "wrong_target", detail: `manifest targets ${parsed.data.target.nodeId}, not ${opts.selfNodeId}` };
	}
	const now = opts.now instanceof Date ? opts.now.getTime() : (opts.now ?? Date.now());
	if (now >= Date.parse(parsed.data.expiresAt)) return { ok: false, code: "expired", detail: `offer expired at ${parsed.data.expiresAt}` };
	return { ok: true, manifest: parsed.data };
}

function formatIssues(error: z.ZodError): string[] {
	return error.issues.map((i) => `${i.path.join(".") || "$"}: ${i.message}`);
}
