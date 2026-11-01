import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { AgentSession, I18nText, RepositoryRef, SessionLiveState, SessionStats, TaskConstraints, TaskResult, UiMessage } from "@clam/contracts";

/**
 * SQLite schema for one CL Agent Mesh node. Every node keeps its own database; no node reads
 * another node's database (spec §Database). Timestamps are ISO-8601 strings (UTC). JSON columns
 * hold serialized values and are typed through `$type`.
 *
 * Committed SQL migrations live in `../migrations` (generated with `pnpm --filter @clam/database db:generate`).
 */

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

/** The single row describing this node. Identity key material lives on disk (`@clam/node-identity`). */
export const node = sqliteTable("node", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	/** Raw Ed25519 public key, base64. */
	publicKey: text("public_key").notNull(),
	/** SHA-256 of the raw public key, hex. */
	fingerprint: text("fingerprint").notNull(),
	/** Public tunnel URL once configured (M3+). */
	publicUrl: text("public_url"),
	status: text("status").notNull().default("online"),
	createdAt: text("created_at").notNull().default(now),
	updatedAt: text("updated_at").notNull().default(now),
});

/** Key/value node settings; `value` is JSON. */
export const settings = sqliteTable("settings", {
	key: text("key").primaryKey(),
	value: text("value").notNull(),
	updatedAt: text("updated_at").notNull().default(now),
});

export const workspaces = sqliteTable("workspaces", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	description: text("description").notNull().default(""),
	ownerNodeId: text("owner_id")
		.notNull()
		.references(() => node.id),
	createdAt: text("created_at").notNull().default(now),
	updatedAt: text("updated_at").notNull().default(now),
});

/**
 * `memberId` is a node id: the owner (M1) or a paired peer (M3). A peer's row carries the capabilities this node
 * granted it for the workspace (`permissions`, a JSON `Capability[]`); revoking the peer sets `revokedAt`.
 */
export const workspaceMembers = sqliteTable(
	"workspace_members",
	{
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		memberId: text("member_id").notNull(),
		role: text("role").notNull(),
		createdAt: text("created_at").notNull().default(now),
		permissions: text("permissions", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
		/** Node id that granted the membership (this node for the owner row). */
		grantedBy: text("granted_by"),
		revokedAt: text("revoked_at"),
	},
	(t) => [primaryKey({ columns: [t.workspaceId, t.memberId] })],
);

export const projects = sqliteTable(
	"projects",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		/** Absolute working directory on this node. */
		path: text("path").notNull(),
		/** GitHub repository numeric id (denormalized from `repository`) for joins; null when unlinked. */
		repositoryId: text("repository_id"),
		/** Linked repository snapshot (contracts `RepositoryRef`); null when unlinked. */
		repository: text("repository", { mode: "json" }).$type<RepositoryRef | null>(),
		/**
		 * Created by CL Agent Mesh under `<dataDir>/projects/<id>` (the user picked no path). Whether the folder is a git
		 * working tree is NOT stored: `vcs` is derived live from the folder (a `.git` entry at its root).
		 */
		managed: integer("managed", { mode: "boolean" }).notNull().default(false),
		/** `user` = a project the person added or created; `chat` = the working folder of a chat started without a project. */
		origin: text("origin", { enum: ["user", "chat"] }).notNull().default("user"),
		createdAt: text("created_at").notNull().default(now),
		updatedAt: text("updated_at").notNull().default(now),
	},
	(t) => [index("projects_workspace_idx").on(t.workspaceId)],
);

export const agents = sqliteTable("agents", {
	id: text("id").primaryKey(),
	nodeId: text("node_id")
		.notNull()
		.references(() => node.id),
	name: text("name").notNull(),
	role: text("role").notNull().default(""),
	runtime: text("runtime").notNull(),
	capabilities: text("capabilities", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
	createdAt: text("created_at").notNull().default(now),
	updatedAt: text("updated_at").notNull().default(now),
});

export const agentSessions = sqliteTable(
	"agent_sessions",
	{
		id: text("id").primaryKey(),
		agentId: text("agent_id")
			.notNull()
			.references(() => agents.id),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		title: text("title").notNull(),
		/** Directory the runtime is bound to (`open_session { sessionDir }`); owned by this node. */
		sessionDir: text("session_dir").notNull(),
		runtimeSessionId: text("runtime_session_id"),
		runtimeSessionFile: text("runtime_session_file"),
		/** `provider/id` */
		model: text("model"),
		thinkingLevel: text("thinking_level"),
		/** idle | running | error | stopped */
		status: text("status").notNull().default("stopped"),
		archived: integer("archived", { mode: "boolean" }).notNull().default(false),
		stats: text("stats", { mode: "json" }).$type<SessionStats | null>(),
		/** local = an OMP session running on this node | mirror = read-only live copy of a session that runs on another node (shared sessions). */
		kind: text("kind").notNull().default("local"),
		/** The shared session this session belongs to (driving session, mirror, participant agent session, moved copy). */
		sharedSessionId: text("shared_session_id"),
		/** Set once the work continued on another node (takeover/transfer): this copy is read-only. */
		movedTo: text("moved_to", { mode: "json" }).$type<NonNullable<AgentSession["movedTo"]> | null>(),
		createdAt: text("created_at").notNull().default(now),
		updatedAt: text("updated_at").notNull().default(now),
	},
	(t) => [index("agent_sessions_project_idx").on(t.projectId), index("agent_sessions_agent_idx").on(t.agentId)],
);

/**
 * OMP-recorded usage attributed to a CLAM session (append-only; one row per flush of a settled run).
 * `source` is a contracts `DataSource`; rows written from `get_session_stats` are `omp-recorded`.
 * `sessionId` is kept (set null) when the session is deleted so historical cost survives.
 */
export const providerUsage = sqliteTable(
	"provider_usage",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		sessionId: text("session_id").references(() => agentSessions.id, { onDelete: "set null" }),
		projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
		agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
		provider: text("provider").notNull(),
		model: text("model").notNull(),
		inputTokens: integer("input_tokens").notNull().default(0),
		outputTokens: integer("output_tokens").notNull().default(0),
		cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
		cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
		/** USD. */
		cost: real("cost").notNull().default(0),
		source: text("source").notNull().default("omp-recorded"),
		recordedAt: text("recorded_at").notNull().default(now),
	},
	(t) => [
		index("provider_usage_session_idx").on(t.sessionId),
		index("provider_usage_project_idx").on(t.projectId),
		index("provider_usage_agent_idx").on(t.agentId),
		index("provider_usage_recorded_idx").on(t.recordedAt),
	],
);

/** Contract shared with `@clam/github-integration`; do not change columns without coordinating. */
export const githubConnections = sqliteTable(
	"github_connections",
	{
		id: text("id").primaryKey(),
		login: text("login").notNull(),
		name: text("name"),
		email: text("email"),
		avatarUrl: text("avatar_url"),
		/** JSON array of granted OAuth scopes. */
		scopes: text("scopes").notNull().default("[]"),
		/** oauth-device | gh-cli */
		source: text("source").notNull(),
		isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
		status: text("status").notNull().default("unknown"),
		/** Key in the secret store holding the token. */
		credentialRef: text("credential_ref").notNull(),
		lastVerifiedAt: text("last_verified_at"),
		createdAt: text("created_at").notNull().default(now),
	},
	(t) => [uniqueIndex("github_connections_login_unique").on(t.login)],
);

/** Contract shared with `@clam/github-integration`. `id` is the GitHub numeric repository id. */
export const githubRepositories = sqliteTable(
	"github_repositories",
	{
		id: text("id").primaryKey(),
		owner: text("owner").notNull(),
		name: text("name").notNull(),
		htmlUrl: text("html_url").notNull(),
		defaultBranch: text("default_branch"),
		accountId: text("account_id").references(() => githubConnections.id, { onDelete: "set null" }),
		updatedAt: text("updated_at").notNull().default(now),
	},
	(t) => [index("github_repositories_account_idx").on(t.accountId)],
);

/** Append-only audit/event log of node-level happenings (runtime crashes, restarts, logins, settings changes). */
export const nodeEvents = sqliteTable(
	"node_events",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		nodeId: text("node_id")
			.notNull()
			.references(() => node.id),
		type: text("type").notNull(),
		/** info | warning | error */
		level: text("level").notNull().default("info"),
		payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>(),
		createdAt: text("created_at").notNull().default(now),
	},
	(t) => [index("node_events_created_idx").on(t.createdAt), index("node_events_type_idx").on(t.type)],
);

/** Accumulated OMP-recorded usage history in hourly UTC buckets (written by `@clam/provider-usage` via the raw client). */
export const usageBuckets = sqliteTable("usage_buckets", {
	/** Epoch ms of the UTC hour start. */
	bucketStart: integer("bucket_start").primaryKey(),
	requests: integer("requests").notNull(),
	failedRequests: integer("failed_requests").notNull(),
	tokensTotal: integer("tokens_total").notNull(),
	cost: real("cost").notNull(),
	updatedAt: text("updated_at").notNull(),
});

/**
 * Last observed Git state of a project's branch (one row per project and branch), refreshed whenever the server
 * reads status or runs fetch/pull/push. A cache for dashboards and handoff checks, never the source of truth: Git is.
 */
export const gitSyncStates = sqliteTable(
	"git_sync_states",
	{
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		branch: text("branch").notNull(),
		/** Local HEAD of the branch. */
		commitSha: text("commit_sha").notNull(),
		/** Upstream tip as last fetched; null without an upstream. */
		remoteSha: text("remote_sha"),
		ahead: integer("ahead"),
		behind: integer("behind"),
		dirty: integer("dirty", { mode: "boolean" }).notNull().default(false),
		lastFetchedAt: text("last_fetched_at"),
		lastPushedAt: text("last_pushed_at"),
		lastPulledAt: text("last_pulled_at"),
		updatedAt: text("updated_at").notNull().default(now),
	},
	(t) => [primaryKey({ columns: [t.projectId, t.branch] })],
);

// ------------------------------------------------------------------------------------------------ M3: agent network

/**
 * Nodes this node has paired with. The row is the pinned identity (`publicKey`/`keyId`/`fingerprint`) plus liveness
 * and the capabilities granted in each direction. A revoked peer is kept (status `revoked`) so its requests keep
 * being refused with a precise error and the UI can show who revoked whom.
 */
export const peers = sqliteTable(
	"peers",
	{
		/** The peer's node id. */
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		/** SHA-256 of the raw public key, hex. */
		fingerprint: text("fingerprint").notNull(),
		/** Pinned raw Ed25519 public key, base64. A different key for this node id is a hard failure. */
		publicKey: text("public_key").notNull(),
		/** First 16 hex chars of the fingerprint (`X-Clam-Key-Id`). */
		keyId: text("key_id").notNull(),
		/** Base URL of the peer's network listener (its tunnel URL; loopback only in dev). */
		url: text("url").notNull(),
		/** online | degraded | offline | revoked */
		status: text("status").notNull().default("offline"),
		/** Capabilities WE grant the peer. */
		grantedCapabilities: text("granted_capabilities", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
		/** Capabilities the peer grants US. */
		receivedCapabilities: text("received_capabilities", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
		protocolVersion: integer("protocol_version").notNull().default(1),
		latencyMs: integer("latency_ms"),
		lastSeenAt: text("last_seen_at"),
		lastError: text("last_error"),
		/** Resume cursor for the peer's `GET /events` (`Last-Event-ID`). */
		lastEventCursor: text("last_event_cursor"),
		pairedAt: text("paired_at").notNull().default(now),
		revokedAt: text("revoked_at"),
		/** local | remote */
		revokedBy: text("revoked_by"),
		/** Receiver policy (M4): run tasks from this peer without a human accepting them here. */
		autoAcceptTasks: integer("auto_accept_tasks", { mode: "boolean" }).notNull().default(false),
		updatedAt: text("updated_at").notNull().default(now),
	},
	(t) => [index("peers_status_idx").on(t.status)],
);

/** Directory cache of the agents a peer exposes (`GET /agents`). Offline peers keep their last known rows. */
export const peerAgents = sqliteTable(
	"peer_agents",
	{
		peerId: text("peer_id")
			.notNull()
			.references(() => peers.id, { onDelete: "cascade" }),
		agentId: text("agent_id").notNull(),
		name: text("name").notNull(),
		role: text("role").notNull().default(""),
		runtime: text("runtime").notNull(),
		capabilities: text("capabilities", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
		/** online | busy | offline */
		status: text("status").notNull().default("offline"),
		activeSessions: integer("active_sessions").notNull().default(0),
		fetchedAt: text("fetched_at").notNull().default(now),
	},
	(t) => [primaryKey({ columns: [t.peerId, t.agentId] })],
);

/**
 * Invitations issued by this node (inviter side). The plain code is never stored: `codeHash` identifies it, and the
 * HKDF-derived code key needed to verify the joiner's proof lives in the secret store until the hello is verified.
 */
export const pairingInvitations = sqliteTable(
	"pairing_invitations",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		codeHash: text("code_hash").notNull(),
		/** Capabilities the inviter offers the joiner (JSON `Capability[]`). */
		capabilities: text("capabilities", { mode: "json" }).$type<string[]>().notNull(),
		/** pending | consumed | revoked | locked (`expired` is derived from `expiresAt`). */
		state: text("state").notNull().default("pending"),
		attempts: integer("attempts").notNull().default(0),
		maxAttempts: integer("max_attempts").notNull().default(5),
		expiresAt: text("expires_at").notNull(),
		createdAt: text("created_at").notNull().default(now),
		consumedAt: text("consumed_at"),
		consumedBy: text("consumed_by"),
	},
	(t) => [index("pairing_invitations_state_idx").on(t.state)],
);

/**
 * Incoming pairing (inviter side): a joiner that proved possession of the code. Holds everything needed to resume the
 * handshake after a restart (nonces, remote identity, the stored hello reply for idempotent retries) - never the code.
 */
export const pairingRequests = sqliteTable(
	"pairing_requests",
	{
		id: text("id").primaryKey(),
		invitationId: text("invitation_id")
			.notNull()
			.references(() => pairingInvitations.id, { onDelete: "cascade" }),
		workspaceId: text("workspace_id").notNull(),
		remoteNodeId: text("remote_node_id").notNull(),
		remoteName: text("remote_name").notNull(),
		remotePublicKey: text("remote_public_key").notNull(),
		remoteFingerprint: text("remote_fingerprint").notNull(),
		remoteUrl: text("remote_url").notNull(),
		nonceInviter: text("nonce_inviter").notNull(),
		nonceJoiner: text("nonce_joiner").notNull(),
		/** The JSON hello reply sent to the joiner; replayed verbatim when the same hello is retried. */
		helloResponse: text("hello_response", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
		/** Capabilities the user approved (null until approval). */
		capabilities: text("capabilities", { mode: "json" }).$type<string[] | null>(),
		/** awaiting_approval | confirming | paired | rejected | expired | failed */
		state: text("state").notNull().default("awaiting_approval"),
		error: text("error"),
		correlationId: text("correlation_id").notNull(),
		requestedAt: text("requested_at").notNull().default(now),
		updatedAt: text("updated_at").notNull().default(now),
	},
	(t) => [uniqueIndex("pairing_requests_invitation_unique").on(t.invitationId), index("pairing_requests_state_idx").on(t.state)],
);

/** Outgoing pairing (joiner side): enough state to resume after a restart. Never stores the code. */
export const pairingJoins = sqliteTable(
	"pairing_joins",
	{
		id: text("id").primaryKey(),
		/** The inviter's base URL as the user entered it. */
		url: text("url").notNull(),
		invitationId: text("invitation_id").notNull(),
		remoteNodeId: text("remote_node_id").notNull(),
		remoteName: text("remote_name").notNull(),
		remotePublicKey: text("remote_public_key").notNull(),
		remoteFingerprint: text("remote_fingerprint").notNull(),
		/** Contracts `NodePreview` captured from the inviter's `/node/info`. */
		remotePreview: text("remote_preview", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
		nonceJoiner: text("nonce_joiner").notNull(),
		nonceInviter: text("nonce_inviter"),
		/** Workspace the inviter shares (id + name from the hello reply). */
		workspaceId: text("workspace_id"),
		workspaceName: text("workspace_name"),
		/** Capabilities WE grant the inviter. */
		grantedCapabilities: text("granted_capabilities", { mode: "json" }).$type<string[]>().notNull(),
		/** Capabilities the inviter granted us (known once it confirms). */
		receivedCapabilities: text("received_capabilities", { mode: "json" }).$type<string[] | null>(),
		/** hello_sent | awaiting_remote_approval | paired | rejected | expired | failed */
		state: text("state").notNull().default("hello_sent"),
		error: text("error"),
		correlationId: text("correlation_id").notNull(),
		expiresAt: text("expires_at").notNull(),
		createdAt: text("created_at").notNull().default(now),
		updatedAt: text("updated_at").notNull().default(now),
	},
	(t) => [index("pairing_joins_state_idx").on(t.state)],
);

/** Replay protection for signed `/api/v1` requests: nonces seen per peer until `expiresAt` (epoch ms). */
export const nonceLog = sqliteTable(
	"nonce_log",
	{
		peerId: text("peer_id").notNull(),
		nonce: text("nonce").notNull(),
		expiresAt: integer("expires_at").notNull(),
	},
	(t) => [primaryKey({ columns: [t.peerId, t.nonce] }), index("nonce_log_expires_idx").on(t.expiresAt)],
);

/**
 * Durable log behind `GET /api/v1/events`: per-stream, gap-free `seq` (M3 has the single stream `node`). `audience`,
 * when set, is the only peer that may see the payload (others get the frame with an empty payload so seq stays gap-free).
 */
export const networkEvents = sqliteTable(
	"network_events",
	{
		stream: text("stream").notNull(),
		seq: integer("seq").notNull(),
		type: text("type").notNull(),
		payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
		audience: text("audience"),
		createdAt: text("created_at").notNull().default(now),
	},
	(t) => [primaryKey({ columns: [t.stream, t.seq] })],
);

// ------------------------------------------------------------------------------------------------ M4: tasks

/**
 * A delegated task as THIS node knows it. Both nodes keep a row with the same `id`: the executor's row is the source
 * of truth (status, events, result), the sender's row mirrors it. `direction` says which side this node is.
 * `peerId` is the other node and is deliberately not a foreign key: task history must survive re-pairing.
 */
export const tasks = sqliteTable(
	"tasks",
	{
		/** `tsk_<ULID>`, chosen by the sender; the wire idempotency key of the task. */
		id: text("id").primaryKey(),
		/** outgoing | incoming */
		direction: text("direction").notNull(),
		peerId: text("peer_id").notNull(),
		workspaceId: text("workspace_id").notNull(),
		/** Origin project on the sender, execution project on the executor (null until the executor assigned one). */
		projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
		title: text("title").notNull(),
		description: text("description").notNull().default(""),
		/** contracts `TaskStatus` */
		status: text("status").notNull().default("offered"),
		/** Ownership epoch / fencing token (protocol §9). */
		epoch: integer("epoch").notNull().default(0),
		/** null = a task without a git repository (deliverAs summary/files). */
		repoUrl: text("repo_url"),
		repoBranch: text("repo_branch"),
		repoCommit: text("repo_commit"),
		/** summary | branch | files */
		deliverAs: text("deliver_as").notNull().default("branch"),
		/** The input bundle sent along (sender: stored as an artifact of this task; executor: fetched from the sender); null = none. */
		inputFiles: text("input_files", { mode: "json" }).$type<{ artifactId: string; sha256: string; size: number; fileCount: number } | null>(),
		constraints: text("constraints", { mode: "json" }).$type<TaskConstraints>().notNull().default(sql`'{}'`),
		senderNodeId: text("sender_node_id").notNull(),
		senderNodeName: text("sender_node_name").notNull(),
		senderAgentId: text("sender_agent_id"),
		senderAgentName: text("sender_agent_name"),
		/** Delegating agent session on the sender node (null for tasks created from the UI). */
		senderSessionId: text("sender_session_id"),
		executorNodeId: text("executor_node_id").notNull(),
		executorNodeName: text("executor_node_name").notNull(),
		executorAgentId: text("executor_agent_id"),
		executorAgentName: text("executor_agent_name"),
		/** Executing agent session on the executor node. */
		executorSessionId: text("executor_session_id"),
		reason: text("reason"),
		/** Structured twin of `reason` when the text is ours (not a user's or a peer's); null = none. */
		reasonI18n: text("reason_i18n", { mode: "json" }).$type<I18nText>(),
		result: text("result", { mode: "json" }).$type<TaskResult | null>(),
		cost: real("cost"),
		retryOf: text("retry_of"),
		correlationId: text("correlation_id").notNull(),
		/** Highest event seq held locally (executor: allocated; sender: mirrored). */
		lastEventSeq: integer("last_event_seq").notNull().default(0),
		/** Executor-private run state (branch names, completion bookkeeping); never leaves the node. */
		execState: text("exec_state", { mode: "json" }).$type<Record<string, unknown>>().notNull().default(sql`'{}'`),
		/** Sender side: the terminal/blocked status for which a note was already injected into the delegating session. */
		notifiedStatus: text("notified_status"),
		/** M7: this node released the task by a handoff (or saw a higher epoch): its sessions are never started, resumed or prompted again. */
		fenced: integer("fenced", { mode: "boolean" }).notNull().default(false),
		/** M7: highest ownership epoch this node has ever seen for the task (boot fence scan, docs/handoff-protocol.md §8). */
		highestSeenEpoch: integer("highest_seen_epoch").notNull().default(0),
		createdAt: text("created_at").notNull().default(now),
		updatedAt: text("updated_at").notNull().default(now),
		startedAt: text("started_at"),
		finishedAt: text("finished_at"),
	},
	(t) => [
		index("tasks_direction_status_idx").on(t.direction, t.status),
		index("tasks_peer_idx").on(t.peerId),
		index("tasks_project_status_idx").on(t.projectId, t.status),
		index("tasks_executor_session_idx").on(t.executorSessionId),
		index("tasks_sender_session_idx").on(t.senderSessionId),
	],
);

/** Append-only task timeline. The executor allocates `seq` (gap-free per task); the sender stores the executor's events under the same seq. */
export const taskEvents = sqliteTable(
	"task_events",
	{
		taskId: text("task_id")
			.notNull()
			.references(() => tasks.id, { onDelete: "cascade" }),
		seq: integer("seq").notNull(),
		/** status | progress | tool | message | result | note */
		type: text("type").notNull(),
		summary: text("summary").notNull(),
		/** Structured twin of `summary`; null = none. */
		i18n: text("i18n", { mode: "json" }).$type<I18nText>(),
		payload: text("payload", { mode: "json" }).$type<unknown>(),
		createdAt: text("created_at").notNull().default(now),
	},
	(t) => [primaryKey({ columns: [t.taskId, t.seq] })],
);

/** The discussion thread of a task. `id` is the sender-chosen message id (global natural key: both nodes store the same id). */
export const taskMessages = sqliteTable(
	"task_messages",
	{
		id: text("id").primaryKey(),
		taskId: text("task_id")
			.notNull()
			.references(() => tasks.id, { onDelete: "cascade" }),
		/** human | agent | system */
		authorKind: text("author_kind").notNull(),
		authorNodeId: text("author_node_id").notNull(),
		authorNodeName: text("author_node_name").notNull(),
		authorAgentId: text("author_agent_id"),
		authorAgentName: text("author_agent_name"),
		/** instruction | question | answer | note */
		kind: text("kind").notNull(),
		text: text("text").notNull(),
		createdAt: text("created_at").notNull(),
		/** local (authored on the other node) | pending | delivered | failed */
		delivery: text("delivery").notNull().default("local"),
		/** Local session the message was injected into; null until injected / when there is none. */
		injectedSessionId: text("injected_session_id"),
		readAt: text("read_at"),
		receivedAt: text("received_at").notNull().default(now),
	},
	(t) => [index("task_messages_task_idx").on(t.taskId, t.createdAt)],
);

/**
 * Durable at-least-once delivery of mutating peer calls (task creation, messages, cancel). One row per logical call;
 * every attempt re-sends the same body with the same `Idempotency-Key` (protocol §6–7).
 */
export const outbox = sqliteTable(
	"outbox",
	{
		id: text("id").primaryKey(),
		peerId: text("peer_id")
			.notNull()
			.references(() => peers.id, { onDelete: "cascade" }),
		taskId: text("task_id"),
		/** task.create | task.message | task.cancel */
		kind: text("kind").notNull(),
		/** The entity this call carries (`task_messages.id` for messages), to update its delivery state. */
		refId: text("ref_id"),
		method: text("method").notNull(),
		/** Path relative to `/api/v1`. */
		path: text("path").notNull(),
		body: text("body", { mode: "json" }).$type<unknown>().notNull(),
		idempotencyKey: text("idempotency_key").notNull(),
		correlationId: text("correlation_id").notNull(),
		/** Attempts made so far (an attempt is only made while the peer is reachable). */
		attempts: integer("attempts").notNull().default(0),
		nextAttemptAt: text("next_attempt_at").notNull(),
		/** pending | sent | dead | cancelled */
		state: text("state").notNull().default("pending"),
		lastError: text("last_error"),
		/** Structured twin of `last_error` when the text is ours (not a peer/transport error); null = none. */
		lastErrorI18n: text("last_error_i18n", { mode: "json" }).$type<I18nText>(),
		lastStatus: integer("last_status"),
		createdAt: text("created_at").notNull().default(now),
		sentAt: text("sent_at"),
	},
	(t) => [
		uniqueIndex("outbox_peer_key_unique").on(t.peerId, t.idempotencyKey),
		index("outbox_state_idx").on(t.state, t.nextAttemptAt),
		index("outbox_task_idx").on(t.taskId),
	],
);

/** Receiver-side response store of `(peer, Idempotency-Key)` for non-idempotent endpoints (protocol §6). Kept 24 h. */
export const idempotencyRecords = sqliteTable(
	"idempotency_records",
	{
		peerId: text("peer_id").notNull(),
		key: text("key").notNull(),
		method: text("method").notNull(),
		path: text("path").notNull(),
		requestHash: text("request_hash").notNull(),
		status: integer("status").notNull(),
		responseBody: text("response_body").notNull(),
		createdAt: text("created_at").notNull().default(now),
		/** Epoch ms. */
		expiresAt: integer("expires_at").notNull(),
	},
	(t) => [primaryKey({ columns: [t.peerId, t.key] }), index("idempotency_expires_idx").on(t.expiresAt)],
);

/** Files produced by an executed task (patch of a refused push, ...), stored under `<dataDir>/artifacts/<taskId>/`. Executor side only. */
export const artifacts = sqliteTable(
	"artifacts",
	{
		id: text("id").primaryKey(),
		taskId: text("task_id")
			.notNull()
			.references(() => tasks.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		mediaType: text("media_type").notNull(),
		size: integer("size").notNull(),
		sha256: text("sha256").notNull(),
		/** Relative to `<dataDir>/artifacts`. */
		storagePath: text("storage_path").notNull(),
		createdAt: text("created_at").notNull().default(now),
	},
	(t) => [index("artifacts_task_idx").on(t.taskId)],
);

// ---------------------------------------------------------------- shared sessions (M5)

/** Progress of a hand-over of the driver role: the `SharedTransfer` of `@clam/contracts`. */
export interface SharedTransferMeta {
	id: string;
	toNodeId: string;
	toNodeName: string;
	phase: "inviting" | "waiting_accept" | "stopping" | "checkpointing" | "delivering" | "handing_over" | "continuing" | "failed" | "cancelled";
	message: string;
	/** Structured twin of `message`; absent on records written before it existed. */
	i18n?: I18nText | undefined;
	stopRunning: boolean;
	error: { code: string; message: string; i18n?: I18nText | undefined } | null;
	newSessionId: string | null;
	newSessionUrl: string | null;
	startedAt: string;
	updatedAt: string;
}

/** Files mode: what the former driver kept of its own work (see `shared_sessions.rescue_files`). */
export interface SharedRescueFiles {
	/** Relative to `<dataDir>/shared`. */
	path: string;
	sha256: string;
	size: number;
	fileCount: number;
	/** The files in the bundle (capped at 200). */
	paths: string[];
	epoch: number;
	at: string;
}

/** Node-private bookkeeping of a shared session (never leaves the node). */
export interface SharedMeta {
	/** Former driver: the rescue/moved/mirror steps of the epoch change are not finished yet (re-run at boot). */
	pendingFormerDriver?: { epoch: number; driverNodeId: string; driverNodeName: string; reason: string; sessionId: string | null; uiUrl: string | null } | null;
	/** Driver: the working tree was committed to this checkpoint commit last (debounce / "nothing changed" check). */
	lastCheckpointCommit?: string | null;
	/** Driver: settled turns since the last checkpoint (drives the automatic checkpoint). */
	turnsSinceCheckpoint?: number;
	/** Driver: the hand-over this node started (progress and result; terminal records stay until dismissed). */
	transfer?: SharedTransferMeta | null;
	/** Files mode: the checkpoint whose folder bundle this node last made (driver) or applied (participant); undefined = the folder never received one. */
	appliedFilesSeq?: number;
	/** Participant: the node already fetched the shared branch once. */
	[key: string]: unknown;
}

/**
 * A shared session as THIS node knows it. Every participating node keeps a row with the same `id` (`shs_<ULID>`, chosen by
 * the node that shared the session). `driver_node_id` + `epoch` are the fencing state: a driver action carrying an older
 * epoch is refused. `local_role` is this node's relation: driver | participant | former_driver.
 */
export const sharedSessions = sqliteTable(
	"shared_sessions",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id").notNull(),
		title: text("title").notNull(),
		/** What the work is about (the first prompt / title); sent to participants as the briefing. */
		goal: text("goal").notNull().default(""),
		/** git | files: how the working files travel (a shared branch, or folder bundles with no repository). */
		vcs: text("vcs").notNull().default("git"),
		/** null in files mode. */
		repoUrl: text("repo_url"),
		/** The shared branch `clam/shared/<slug>-<shortid>`; null in files mode. */
		branch: text("branch"),
		baseBranch: text("base_branch"),
		baseCommit: text("base_commit"),
		epoch: integer("epoch").notNull().default(1),
		driverNodeId: text("driver_node_id").notNull(),
		driverNodeName: text("driver_node_name").notNull(),
		/** driver | participant | former_driver */
		localRole: text("local_role").notNull(),
		/** active | left (this node left, was removed, or the invitation was declined) */
		state: text("state").notNull().default("active"),
		/** The driving session (driver), the moved copy (former driver) or the mirror (participant). */
		localSessionId: text("local_session_id").references(() => agentSessions.id, { onDelete: "set null" }),
		/** Live mirror of the current driver's conversation on this node. */
		mirrorSessionId: text("mirror_session_id").references(() => agentSessions.id, { onDelete: "set null" }),
		localProjectId: text("local_project_id").references(() => projects.id, { onDelete: "set null" }),
		/** Loop guard: agent messages a node may post to the thread without a human message in between. */
		agentMessageLimit: integer("agent_message_limit").notNull().default(12),
		rescueBranch: text("rescue_branch"),
		/** Files mode: the former driver's unsynced local changes, saved as a bundle under `<dataDir>/shared/<id>/` (`{ path, sha256, size, fileCount, paths, at }`). */
		rescueFiles: text("rescue_files", { mode: "json" }).$type<SharedRescueFiles | null>(),
		lastCheckpointSeq: integer("last_checkpoint_seq").notNull().default(0),
		meta: text("meta", { mode: "json" }).$type<SharedMeta>().notNull().default(sql`'{}'`),
		createdAt: text("created_at").notNull().default(now),
		updatedAt: text("updated_at").notNull().default(now),
	},
	(t) => [index("shared_sessions_local_session_idx").on(t.localSessionId), index("shared_sessions_mirror_session_idx").on(t.mirrorSessionId), index("shared_sessions_state_idx").on(t.state)],
);

/** Everyone in a shared session, this node included. `node_id` is deliberately not a foreign key: history survives re-pairing. */
export const sharedParticipants = sqliteTable(
	"shared_participants",
	{
		sharedSessionId: text("shared_session_id")
			.notNull()
			.references(() => sharedSessions.id, { onDelete: "cascade" }),
		nodeId: text("node_id").notNull(),
		nodeName: text("node_name").notNull(),
		agentId: text("agent_id"),
		agentName: text("agent_name"),
		/** driver | participant */
		role: text("role").notNull(),
		/** invited | active | declined | left | removed */
		state: text("state").notNull(),
		/** That node's own participant agent session (known for this node; learned from the decision/announcements for others). */
		agentSessionId: text("agent_session_id"),
		/** Public base URL of that node's web UI. */
		uiUrl: text("ui_url"),
		/** Driver side: highest checkpoint whose snapshot this participant acknowledged. */
		snapshotSeq: integer("snapshot_seq").notNull().default(0),
		/** This node's own participant agent session got its briefing prompt. */
		briefed: integer("briefed", { mode: "boolean" }).notNull().default(false),
		joinedAt: text("joined_at"),
		createdAt: text("created_at").notNull().default(now),
		updatedAt: text("updated_at").notNull().default(now),
	},
	(t) => [primaryKey({ columns: [t.sharedSessionId, t.nodeId] })],
);

/** Who a group message is for (`SharedMessage.to`): everybody, the current lead, or named agents (one per node). */
export interface SharedMessageTo {
	mode: "all" | "lead" | "agents";
	agents: Array<{ nodeId: string; agentId: string }>;
}

/**
 * One message of the group chat of a shared session. The log is replicated on every member node: a message is accepted by
 * ONE node (its origin = `author_node_id`), which gives it an id (global natural key), a hybrid logical clock stamp and the
 * next per-origin sequence number; the others store the same row idempotently by id. Order everywhere: `(hlc, author_node_id, id)`.
 * `origin_seq` is also what the catch-up cursor counts; NULL marks a note of THIS node only (never replicated).
 */
export const sharedMessages = sqliteTable(
	"shared_messages",
	{
		id: text("id").primaryKey(),
		sharedSessionId: text("shared_session_id")
			.notNull()
			.references(() => sharedSessions.id, { onDelete: "cascade" }),
		/** human | agent | system */
		authorKind: text("author_kind").notNull(),
		/** The node that accepted the message first (its origin). */
		authorNodeId: text("author_node_id").notNull(),
		authorNodeName: text("author_node_name").notNull(),
		authorAgentId: text("author_agent_id"),
		authorAgentName: text("author_agent_name"),
		/** chat | reply | system | instruction | question | answer | note */
		kind: text("kind").notNull(),
		/** Addressing, resolved by the origin (mentions or explicit); `lead` is resolved by each receiver against its driver. */
		to: text("to", { mode: "json" }).$type<SharedMessageTo>().notNull().default(sql`'{"mode":"lead","agents":[]}'`),
		text: text("text").notNull(),
		/** Structured twin of `text` (generated system lines); null = none. */
		i18n: text("i18n", { mode: "json" }).$type<I18nText>(),
		/** Epoch the author was at (informational: epochs fence the lead role, never chat). */
		epoch: integer("epoch").notNull().default(1),
		createdAt: text("created_at").notNull(),
		/** Hybrid logical clock stamp `<15 digits ms>-<5 digits counter>`; compares as a string. */
		hlc: text("hlc").notNull(),
		/** Per-origin sequence 1, 2, 3 … assigned by the origin in the transaction that inserts the message; NULL = local-only note. */
		originSeq: integer("origin_seq"),
		/** local (authored elsewhere, or a local-only note) | pending | delivered | failed */
		delivery: text("delivery").notNull().default("local"),
		/** Local agent session that was handed the message (as a prompt or inside the "since your last turn" block); `history` = before it joined; null = not yet. */
		injectedSessionId: text("injected_session_id"),
		readAt: text("read_at"),
		receivedAt: text("received_at").notNull().default(now),
	},
	(t) => [
		index("shared_messages_order_idx").on(t.sharedSessionId, t.hlc),
		uniqueIndex("shared_messages_origin_seq_unique").on(t.sharedSessionId, t.authorNodeId, t.originSeq),
	],
);

/**
 * Files posted into the group chat of a shared session (migration `0008_chats`). The metadata replicates with the message
 * that carries it; the bytes live in `<dataDir>/attachments/<sha256>` (content-addressed, shared by every row with the same
 * digest) and `stored` says whether THIS node holds them. `message_id` is null between the upload and the message that
 * references it. `copied_path` is where this node's agent already got a copy (relative to its project folder).
 */
export const sharedAttachments = sqliteTable(
	"shared_attachments",
	{
		id: text("id").primaryKey(),
		sharedSessionId: text("shared_session_id")
			.notNull()
			.references(() => sharedSessions.id, { onDelete: "cascade" }),
		messageId: text("message_id"),
		name: text("name").notNull(),
		mimeType: text("mime_type").notNull(),
		size: integer("size").notNull(),
		sha256: text("sha256").notNull(),
		/** The node that first stored the bytes. */
		originNodeId: text("origin_node_id").notNull(),
		stored: integer("stored", { mode: "boolean" }).notNull().default(false),
		copiedPath: text("copied_path"),
		createdAt: text("created_at").notNull().default(now),
	},
	(t) => [index("shared_attachments_session_idx").on(t.sharedSessionId), index("shared_attachments_message_idx").on(t.messageId)],
);

/**
 * Checkpoints: the driver's commit on the shared branch plus the OMP session snapshot (`omp session pack`, archive v1).
 * Every node stores the metadata; `snapshot_path` (relative to `<dataDir>/shared`, file mode 0600) is set on the nodes that
 * hold the archive: the driver that made it and each participant that downloaded it. Snapshots never enter Git.
 */
export const sharedCheckpoints = sqliteTable(
	"shared_checkpoints",
	{
		sharedSessionId: text("shared_session_id")
			.notNull()
			.references(() => sharedSessions.id, { onDelete: "cascade" }),
		seq: integer("seq").notNull(),
		epoch: integer("epoch").notNull(),
		/** The driver node that took it. */
		nodeId: text("node_id").notNull(),
		/** null in files mode. */
		branch: text("branch"),
		commit: text("commit"),
		pushed: integer("pushed", { mode: "boolean" }).notNull().default(false),
		/** Files mode: the folder bundle of this checkpoint (metadata on every node; `files_path` on the nodes that hold the archive). */
		files: text("files", { mode: "json" }).$type<{ sha256: string; size: number; fileCount: number } | null>(),
		/** Relative to `<dataDir>/shared`, file mode 0600. */
		filesPath: text("files_path"),
		snapshotSha256: text("snapshot_sha256"),
		snapshotSize: integer("snapshot_size"),
		snapshotMessages: integer("snapshot_messages"),
		snapshotPath: text("snapshot_path"),
		/** `provider/id` the driving session used (informational). */
		model: text("model"),
		/** Driver side: node ids that acknowledged holding the snapshot. */
		deliveredTo: text("delivered_to", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
		note: text("note"),
		createdAt: text("created_at").notNull().default(now),
	},
	(t) => [primaryKey({ columns: [t.sharedSessionId, t.seq] })],
);

/** Invitations received from another node (the sender's side of an invite is its `shared_participants` row in state `invited`). */
export const sharedInvites = sqliteTable(
	"shared_invites",
	{
		id: text("id").primaryKey(),
		sharedSessionId: text("shared_session_id").notNull(),
		fromNodeId: text("from_node_id").notNull(),
		fromNodeName: text("from_node_name").notNull(),
		/** The driving agent (display name and id): the invited node needs the id to address it in the group chat. */
		fromAgentId: text("from_agent_id"),
		fromAgentName: text("from_agent_name"),
		title: text("title").notNull(),
		goal: text("goal").notNull().default(""),
		vcs: text("vcs").notNull().default("git"),
		repoUrl: text("repo_url"),
		repoBranch: text("repo_branch"),
		workspaceId: text("workspace_id").notNull(),
		/** The local agent the driver asked for; null = this node picks. */
		agentId: text("agent_id"),
		epoch: integer("epoch").notNull(),
		driverUiUrl: text("driver_ui_url"),
		/** `provider/id` the driving session uses; the participant agent session starts with it when this node has that model. */
		model: text("model"),
		/** pending | accepted | declined | expired */
		state: text("state").notNull().default("pending"),
		createdAt: text("created_at").notNull().default(now),
		decidedAt: text("decided_at"),
	},
	(t) => [index("shared_invites_state_idx").on(t.state), index("shared_invites_session_idx").on(t.sharedSessionId)],
);

/** Participant side: the driver's conversation as received over the wire, one transcript per mirror session. */
export const sharedMirrorMessages = sqliteTable(
	"shared_mirror_messages",
	{
		mirrorSessionId: text("mirror_session_id")
			.notNull()
			.references(() => agentSessions.id, { onDelete: "cascade" }),
		messageId: text("message_id").notNull(),
		/** Order of first appearance. */
		position: integer("position").notNull(),
		message: text("message", { mode: "json" }).$type<UiMessage>().notNull(),
		updatedAt: text("updated_at").notNull().default(now),
	},
	(t) => [primaryKey({ columns: [t.mirrorSessionId, t.messageId] }), index("shared_mirror_messages_pos_idx").on(t.mirrorSessionId, t.position)],
);

/** Stream position and last live state of a mirror (what lets the driver's batches be applied once and in order). */
export const sharedMirrorState = sqliteTable("shared_mirror_state", {
	mirrorSessionId: text("mirror_session_id")
		.primaryKey()
		.references(() => agentSessions.id, { onDelete: "cascade" }),
	sharedSessionId: text("shared_session_id").notNull(),
	epoch: integer("epoch").notNull(),
	/** The driver's publisher run this mirror follows; a batch of another run needs a full sync first. */
	streamId: text("stream_id"),
	lastSeq: integer("last_seq").notNull().default(0),
	/** A full sync is in progress (chunks received, final one not yet). */
	syncing: integer("syncing", { mode: "boolean" }).notNull().default(false),
	state: text("state", { mode: "json" }).$type<SessionLiveState | null>(),
	updatedAt: text("updated_at").notNull().default(now),
});
