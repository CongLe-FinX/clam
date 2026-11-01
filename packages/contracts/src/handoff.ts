import { z } from "zod";
import { I18nText, IsoDate } from "./common.ts";

/**
 * M7 — Handoff protocol (docs/handoff-protocol.md), with dependency setup and crash-safe recovery.
 *
 * Two kinds of handoff share one record, one step engine and one UI (Handoff Center):
 * - `task`: the OWNER (executor) of an in-flight M4 task moves it to another node with the full protocol:
 *   manifest → target restores files (git branch or folder bundle) + context → sets up dependencies → validates →
 *   creates a NEW local session → writes a durable ack → acquires the next ownership epoch → resumes. The source
 *   releases only after a valid ack; the epoch fences the source forever after.
 * - `session`: the M5 shared-session hand-over/takeover, recorded here and extended with the same dependency-setup
 *   and validation steps on the node that continues the work.
 */

export const HandoffKind = z.enum(["task", "session"]);
export type HandoffKind = z.infer<typeof HandoffKind>;
export const HandoffRole = z.enum(["source", "target"]);
export type HandoffRole = z.infer<typeof HandoffRole>;

export const SourceHandoffState = z.enum([
	"draft",
	"preparing",
	"prepare_failed",
	"offered",
	"accepted",
	"awaiting_ack",
	"ack_timeout",
	"acked",
	"released",
	"completed",
	"rejected",
	"expired",
	"cancelled",
	"reclaimed",
	"failed",
]);
export const TargetHandoffState = z.enum([
	"received",
	"accepted",
	"persisted",
	"files_restored",
	"context_restored",
	"deps_ready",
	"validated",
	"session_created",
	"acked",
	"owner",
	"resumed",
	"completed",
	"rejected",
	"failed",
	"cancelled",
]);
export const HandoffState = z.union([SourceHandoffState, TargetHandoffState]);
export type HandoffState = z.infer<typeof HandoffState>;

export const HandoffFailureCode = z.enum([
	"git_unavailable",
	"checkout_conflict",
	"patch_failed",
	"files_conflict",
	"deps_failed",
	"deps_denied",
	"validation_failed",
	"session_failed",
	"disk_full",
	"timeout",
	"manifest_invalid",
	"secret_detected",
	"superseded",
	"cancelled",
	"capacity",
	"policy_denied",
]);
export type HandoffFailureCode = z.infer<typeof HandoffFailureCode>;

/** A package manager and how it installs, as detected in a folder. */
export const HandoffPackageManager = z.object({ name: z.string(), lockfile: z.string().nullable(), installCommand: z.string() });
export type HandoffPackageManager = z.infer<typeof HandoffPackageManager>;

/** A project inside a subfolder of the work folder (its own manifest/lockfile): installed with `cwd` = that folder. */
export const HandoffProject = z.object({
	/** Folder relative to the work folder, `/`-separated; never the root itself, never `..`, never absolute. */
	path: z
		.string()
		.min(1)
		.max(500)
		.refine((p) => !p.startsWith("/") && !/^[A-Za-z]:/.test(p) && !p.includes("\\") && !p.split("/").some((part) => part === "" || part === "." || part === ".."), "a relative folder inside the work folder"),
	packageManager: HandoffPackageManager,
});
export type HandoffProject = z.infer<typeof HandoffProject>;

/** Detected or declared environment of the work folder. Names only — never secret values. */
export const HandoffEnvironment = z.object({
	os: z.string().nullable(),
	arch: z.string().nullable(),
	runtimes: z.array(z.object({ name: z.string(), versionRange: z.string() })),
	packageManager: HandoffPackageManager.nullable(),
	requiredEnvVars: z.array(z.string()),
	setupCommands: z.array(z.string()),
	/** Projects of subfolders (a `web/package.json` next to a root without one); absent when the root is the only project. */
	projects: z.array(HandoffProject).max(20).optional(),
	checkCommand: z.string().nullable(),
});
export type HandoffEnvironment = z.infer<typeof HandoffEnvironment>;

/** A command the target node wants to run while setting up; needs approval unless the node's policy is `auto`. */
export const SetupCommand = z.object({
	id: z.string(),
	command: z.string(),
	cwd: z.string(),
	purpose: z.enum(["install", "setup", "check"]),
	state: z.enum(["pending_approval", "approved", "denied", "running", "succeeded", "failed", "skipped"]),
	exitCode: z.number().int().nullable(),
	/** Last lines of output (scrubbed of secret patterns). */
	outputTail: z.string(),
	startedAt: IsoDate.nullable(),
	finishedAt: IsoDate.nullable(),
});
export type SetupCommand = z.infer<typeof SetupCommand>;

export const HandoffStep = z.object({
	/** 1–10 for target steps (docs §4); source steps use 0. */
	n: z.number().int(),
	name: z.string(),
	state: z.enum(["pending", "running", "done", "failed", "skipped"]),
	detail: z.string().nullable(),
	/** Structured twin of `detail` for localisation when the detail is our own text; absent otherwise. */
	i18n: I18nText.optional(),
	at: IsoDate.nullable(),
});
export type HandoffStep = z.infer<typeof HandoffStep>;

export const HandoffEvent = z.object({
	seq: z.number().int(),
	at: IsoDate,
	nodeId: z.string(),
	state: HandoffState,
	summary: z.string(),
	/** Structured twin of `summary` for localisation; `summary` stays the English rendering. */
	i18n: I18nText.optional(),
});
export type HandoffEvent = z.infer<typeof HandoffEvent>;

export const Handoff = z.object({
	id: z.string(),
	kind: HandoffKind,
	role: HandoffRole,
	state: HandoffState,
	/** M4 task id (kind task) or shared session id (kind session). */
	subjectId: z.string(),
	title: z.string(),
	workspaceId: z.string(),
	source: z.object({ nodeId: z.string(), nodeName: z.string(), agentName: z.string().nullable(), sessionId: z.string().nullable() }),
	target: z.object({ nodeId: z.string(), nodeName: z.string(), agentName: z.string().nullable(), sessionId: z.string().nullable() }),
	fromEpoch: z.number().int(),
	toEpoch: z.number().int(),
	/** How the files travel. */
	vcs: z.enum(["git", "files", "none"]),
	git: z.object({ repoUrl: z.string(), branch: z.string(), commit: z.string(), pushed: z.boolean(), patch: z.boolean() }).nullable(),
	files: z.object({ sha256: z.string(), size: z.number().int(), fileCount: z.number().int() }).nullable(),
	environment: HandoffEnvironment.nullable(),
	setup: z.array(SetupCommand),
	steps: z.array(HandoffStep),
	manifestSha256: z.string().nullable(),
	/** Secret-scanned summary of the conversation (OMP `handoff`), shown to both sides. */
	conversationSummary: z.string().nullable(),
	includeTranscript: z.boolean(),
	failure: z.object({ code: HandoffFailureCode, detail: z.string(), i18n: I18nText.optional(), step: z.number().int().nullable() }).nullable(),
	/** What the user can do now (e.g. retry, extend, reclaim, cancel, approve_setup). */
	actions: z.array(z.enum(["accept", "reject", "cancel", "retry", "extend", "reclaim", "approve_setup", "deny_setup"])),
	expiresAt: IsoDate.nullable(),
	deadlineAt: IsoDate.nullable(),
	ackAt: IsoDate.nullable(),
	createdAt: IsoDate,
	updatedAt: IsoDate,
});
export type Handoff = z.infer<typeof Handoff>;

export const HandoffDetail = z.object({ handoff: Handoff, events: z.array(HandoffEvent) });
export type HandoffDetail = z.infer<typeof HandoffDetail>;

// ---------------------------------------------------------------- requests

/** Source side: hand an in-flight task this node executes to another node. */
export const CreateTaskHandoffBody = z.object({
	taskId: z.string().min(1),
	targetNodeId: z.string().min(1),
	targetAgentId: z.string().optional(),
	/** Abort a running turn first (otherwise 409 `session_busy` while the agent is mid-turn). */
	stopRunning: z.boolean().default(false),
	/** Ship the old OMP transcript (session pack) for reading; off by default (it may contain tool output). */
	includeTranscript: z.boolean().default(false),
	/** Extra setup commands the source declares (reviewed on the target before running). */
	setupCommands: z.array(z.string().min(1).max(500)).max(20).default([]),
	checkCommand: z.string().max(500).optional(),
});
export const DecideHandoffBody = z.discriminatedUnion("decision", [
	z.object({ decision: z.literal("accept"), projectId: z.string().optional(), agentId: z.string().optional() }),
	z.object({ decision: z.literal("reject"), reason: z.string().trim().min(1).max(2000) }),
]);
export const SetupDecisionBody = z.object({
	/** Commands to approve; the rest stay pending (or are denied when `denyOthers`). */
	approve: z.array(z.string()).default([]),
	deny: z.array(z.string()).default([]),
});
export const ExtendHandoffBody = z.object({ minutes: z.number().int().min(5).max(24 * 60) });
export const ReclaimHandoffBody = z.object({
	/** Required when the target could not be asked whether it acked (risk of duplicate execution). */
	override: z.boolean().default(false),
});

export const HandoffListQuery = z.object({
	role: HandoffRole.optional(),
	kind: HandoffKind.optional(),
	active: z.enum(["true", "false"]).optional(),
});

/** Events on topic `handoffs` (list) and `handoff:<id>` (detail). */
export type HandoffTopicEvent = { type: "handoff"; handoff: Handoff } | { type: "event"; handoffId: string; event: HandoffEvent };
