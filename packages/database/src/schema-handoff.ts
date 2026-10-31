import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * M7 — handoffs (docs/handoff-protocol.md). Migration `0009_handoff`.
 *
 * One `handoffs` row per (handoff, role): the source node and the target node each keep their own side with its own
 * state machine (`@clam/handoff-engine` states), exactly like the doc's "Each node keeps its own side in `handoffs.status`
 * with `role = source|target`". `kind = session` rows record an M5 shared-session hand-over/takeover so the Handoff Center
 * shows it; they use the same step/event/setup tables. `handoff_events.seq` is gap-free per handoff on this node.
 */

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

/** Free-form bookkeeping of a side (work folder, restore branch, prepared artifacts, ack retry state ...); never leaves the node. */
export type HandoffMeta = Record<string, unknown>;

export const handoffs = sqliteTable(
	"handoffs",
	{
		id: text("id").primaryKey(),
		/** task | session */
		kind: text("kind").notNull(),
		/** source | target */
		role: text("role").notNull(),
		/** `@clam/handoff-engine` source or target state. */
		state: text("state").notNull(),
		/** The other node of this side: the target for `role = source`, the source for `role = target`. */
		peerId: text("peer_id").notNull(),
		/** M4 task id (kind task) or shared session id (kind session). */
		subjectId: text("subject_id").notNull(),
		title: text("title").notNull(),
		workspaceId: text("workspace_id").notNull(),
		/** Local project: the task's project on the source; the restored/chosen project on the target. */
		projectId: text("project_id"),
		sourceNodeId: text("source_node_id").notNull(),
		sourceNodeName: text("source_node_name").notNull(),
		sourceAgentId: text("source_agent_id"),
		sourceAgentName: text("source_agent_name"),
		sourceSessionId: text("source_session_id"),
		targetNodeId: text("target_node_id").notNull(),
		targetNodeName: text("target_node_name").notNull(),
		targetAgentId: text("target_agent_id"),
		targetAgentName: text("target_agent_name"),
		targetSessionId: text("target_session_id"),
		fromEpoch: integer("from_epoch").notNull(),
		toEpoch: integer("to_epoch").notNull(),
		/** git | files | none */
		vcs: text("vcs").notNull().default("none"),
		includeTranscript: integer("include_transcript", { mode: "boolean" }).notNull().default(false),
		/** The sealed manifest (source: as built; target: as received), and its sha-256 over the canonical bytes. */
		manifest: text("manifest", { mode: "json" }).$type<unknown>(),
		manifestSha256: text("manifest_sha256"),
		conversationSummary: text("conversation_summary"),
		environment: text("environment", { mode: "json" }).$type<unknown>(),
		/** `setupFingerprint` of the last dependency setup that succeeded (idempotent re-run). */
		setupFingerprint: text("setup_fingerprint"),
		failureCode: text("failure_code"),
		failureDetail: text("failure_detail"),
		failureStep: integer("failure_step"),
		/** Offer lifetime; restore deadline (accept → ack, extendable); when the durable ack was written. */
		expiresAt: text("expires_at"),
		deadlineAt: text("deadline_at"),
		ackAt: text("ack_at"),
		/** `<taskId>:<epoch>:<sig>` signed by the target; the source persists it with `acked`. */
		fencingToken: text("fencing_token"),
		correlationId: text("correlation_id").notNull(),
		meta: text("meta", { mode: "json" }).$type<HandoffMeta>().notNull().default(sql`'{}'`),
		createdAt: text("created_at").notNull().default(now),
		updatedAt: text("updated_at").notNull().default(now),
	},
	(t) => [
		// At most one live (or effective) handoff per (subject, epoch, role): competing handoffs for the same epoch cannot both
		// exist. Attempts that ended without consuming the epoch (rejected, expired, cancelled, failed) free it again.
		uniqueIndex("handoffs_subject_epoch_role_unique")
			.on(t.subjectId, t.toEpoch, t.role)
			.where(sql`${t.state} NOT IN ('prepare_failed', 'rejected', 'expired', 'cancelled', 'failed')`),
		index("handoffs_role_state_idx").on(t.role, t.state),
		index("handoffs_peer_idx").on(t.peerId),
		index("handoffs_subject_idx").on(t.subjectId),
	],
);

/** The ten target steps (and the source's step 0): one row per step, `state` pending | running | done | failed | skipped. */
export const handoffSteps = sqliteTable(
	"handoff_steps",
	{
		handoffId: text("handoff_id")
			.notNull()
			.references(() => handoffs.id, { onDelete: "cascade" }),
		n: integer("n").notNull(),
		name: text("name").notNull(),
		state: text("state").notNull().default("pending"),
		detail: text("detail"),
		at: text("at"),
	},
	(t) => [primaryKey({ columns: [t.handoffId, t.n] })],
);

/** Timeline of a handoff on this node (both nodes show an identical timeline in the Handoff Center). `seq` is gap-free. */
export const handoffEvents = sqliteTable(
	"handoff_events",
	{
		handoffId: text("handoff_id")
			.notNull()
			.references(() => handoffs.id, { onDelete: "cascade" }),
		seq: integer("seq").notNull(),
		at: text("at").notNull(),
		nodeId: text("node_id").notNull(),
		state: text("state").notNull(),
		summary: text("summary").notNull(),
	},
	(t) => [primaryKey({ columns: [t.handoffId, t.seq] })],
);

/** Commands the target node wants to run while setting up dependencies (step 5); `state` follows `SetupCommand.state`. */
export const handoffSetup = sqliteTable(
	"handoff_setup",
	{
		id: text("id").primaryKey(),
		handoffId: text("handoff_id")
			.notNull()
			.references(() => handoffs.id, { onDelete: "cascade" }),
		/** Execution order. */
		ord: integer("ord").notNull(),
		command: text("command").notNull(),
		cwd: text("cwd").notNull(),
		/** install | setup | check */
		purpose: text("purpose").notNull(),
		/** pending_approval | approved | denied | running | succeeded | failed | skipped */
		state: text("state").notNull(),
		exitCode: integer("exit_code"),
		outputTail: text("output_tail").notNull().default(""),
		startedAt: text("started_at"),
		finishedAt: text("finished_at"),
	},
	(t) => [index("handoff_setup_handoff_idx").on(t.handoffId, t.ord)],
);

/** Files of a handoff held on this node: the work folder bundle, the working-tree patch, the opt-in transcript pack. */
export const handoffArtifacts = sqliteTable(
	"handoff_artifacts",
	{
		handoffId: text("handoff_id")
			.notNull()
			.references(() => handoffs.id, { onDelete: "cascade" }),
		artifactId: text("artifact_id").notNull(),
		name: text("name").notNull(),
		/** files-bundle | patch | session-pack */
		kind: text("kind").notNull(),
		sha256: text("sha256").notNull(),
		size: integer("size").notNull(),
		/** Absolute path on this node. */
		path: text("path").notNull(),
		createdAt: text("created_at").notNull().default(now),
	},
	(t) => [primaryKey({ columns: [t.handoffId, t.artifactId] })],
);
