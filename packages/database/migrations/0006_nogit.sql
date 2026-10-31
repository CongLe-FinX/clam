-- Table rebuilds: openDatabase() runs migrations with foreign_keys=OFF (the pragma is a no-op inside the migration transaction).
-- The INSERT ... SELECT lists name only the columns that already exist; new columns take their defaults.
CREATE TABLE `__new_shared_checkpoints` (
	`shared_session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`epoch` integer NOT NULL,
	`node_id` text NOT NULL,
	`branch` text,
	`commit` text,
	`pushed` integer DEFAULT false NOT NULL,
	`files` text,
	`files_path` text,
	`snapshot_sha256` text,
	`snapshot_size` integer,
	`snapshot_messages` integer,
	`snapshot_path` text,
	`model` text,
	`delivered_to` text DEFAULT '[]' NOT NULL,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`shared_session_id`, `seq`),
	FOREIGN KEY (`shared_session_id`) REFERENCES `shared_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_shared_checkpoints`("shared_session_id", "seq", "epoch", "node_id", "branch", "commit", "pushed", "snapshot_sha256", "snapshot_size", "snapshot_messages", "snapshot_path", "model", "delivered_to", "note", "created_at") SELECT "shared_session_id", "seq", "epoch", "node_id", "branch", "commit", "pushed", "snapshot_sha256", "snapshot_size", "snapshot_messages", "snapshot_path", "model", "delivered_to", "note", "created_at" FROM `shared_checkpoints`;--> statement-breakpoint
DROP TABLE `shared_checkpoints`;--> statement-breakpoint
ALTER TABLE `__new_shared_checkpoints` RENAME TO `shared_checkpoints`;--> statement-breakpoint
CREATE TABLE `__new_shared_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`shared_session_id` text NOT NULL,
	`from_node_id` text NOT NULL,
	`from_node_name` text NOT NULL,
	`from_agent_id` text,
	`from_agent_name` text,
	`title` text NOT NULL,
	`goal` text DEFAULT '' NOT NULL,
	`vcs` text DEFAULT 'git' NOT NULL,
	`repo_url` text,
	`repo_branch` text,
	`workspace_id` text NOT NULL,
	`agent_id` text,
	`epoch` integer NOT NULL,
	`driver_ui_url` text,
	`model` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`decided_at` text
);
--> statement-breakpoint
INSERT INTO `__new_shared_invites`("id", "shared_session_id", "from_node_id", "from_node_name", "from_agent_id", "from_agent_name", "title", "goal", "repo_url", "repo_branch", "workspace_id", "agent_id", "epoch", "driver_ui_url", "model", "state", "created_at", "decided_at") SELECT "id", "shared_session_id", "from_node_id", "from_node_name", "from_agent_id", "from_agent_name", "title", "goal", "repo_url", "repo_branch", "workspace_id", "agent_id", "epoch", "driver_ui_url", "model", "state", "created_at", "decided_at" FROM `shared_invites`;--> statement-breakpoint
DROP TABLE `shared_invites`;--> statement-breakpoint
ALTER TABLE `__new_shared_invites` RENAME TO `shared_invites`;--> statement-breakpoint
CREATE INDEX `shared_invites_state_idx` ON `shared_invites` (`state`);--> statement-breakpoint
CREATE INDEX `shared_invites_session_idx` ON `shared_invites` (`shared_session_id`);--> statement-breakpoint
CREATE TABLE `__new_shared_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`title` text NOT NULL,
	`goal` text DEFAULT '' NOT NULL,
	`vcs` text DEFAULT 'git' NOT NULL,
	`repo_url` text,
	`branch` text,
	`base_branch` text,
	`base_commit` text,
	`epoch` integer DEFAULT 1 NOT NULL,
	`driver_node_id` text NOT NULL,
	`driver_node_name` text NOT NULL,
	`local_role` text NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`local_session_id` text,
	`mirror_session_id` text,
	`local_project_id` text,
	`agent_message_limit` integer DEFAULT 12 NOT NULL,
	`rescue_branch` text,
	`rescue_files` text,
	`last_checkpoint_seq` integer DEFAULT 0 NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`local_session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`mirror_session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`local_project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_shared_sessions`("id", "workspace_id", "title", "goal", "repo_url", "branch", "base_branch", "base_commit", "epoch", "driver_node_id", "driver_node_name", "local_role", "state", "local_session_id", "mirror_session_id", "local_project_id", "agent_message_limit", "rescue_branch", "last_checkpoint_seq", "meta", "created_at", "updated_at") SELECT "id", "workspace_id", "title", "goal", "repo_url", "branch", "base_branch", "base_commit", "epoch", "driver_node_id", "driver_node_name", "local_role", "state", "local_session_id", "mirror_session_id", "local_project_id", "agent_message_limit", "rescue_branch", "last_checkpoint_seq", "meta", "created_at", "updated_at" FROM `shared_sessions`;--> statement-breakpoint
DROP TABLE `shared_sessions`;--> statement-breakpoint
ALTER TABLE `__new_shared_sessions` RENAME TO `shared_sessions`;--> statement-breakpoint
CREATE INDEX `shared_sessions_local_session_idx` ON `shared_sessions` (`local_session_id`);--> statement-breakpoint
CREATE INDEX `shared_sessions_mirror_session_idx` ON `shared_sessions` (`mirror_session_id`);--> statement-breakpoint
CREATE INDEX `shared_sessions_state_idx` ON `shared_sessions` (`state`);--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`direction` text NOT NULL,
	`peer_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'offered' NOT NULL,
	`epoch` integer DEFAULT 0 NOT NULL,
	`repo_url` text,
	`repo_branch` text,
	`repo_commit` text,
	`deliver_as` text DEFAULT 'branch' NOT NULL,
	`input_files` text,
	`constraints` text DEFAULT '{}' NOT NULL,
	`sender_node_id` text NOT NULL,
	`sender_node_name` text NOT NULL,
	`sender_agent_id` text,
	`sender_agent_name` text,
	`sender_session_id` text,
	`executor_node_id` text NOT NULL,
	`executor_node_name` text NOT NULL,
	`executor_agent_id` text,
	`executor_agent_name` text,
	`executor_session_id` text,
	`reason` text,
	`result` text,
	`cost` real,
	`retry_of` text,
	`correlation_id` text NOT NULL,
	`last_event_seq` integer DEFAULT 0 NOT NULL,
	`exec_state` text DEFAULT '{}' NOT NULL,
	`notified_status` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`started_at` text,
	`finished_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_tasks`("id", "direction", "peer_id", "workspace_id", "project_id", "title", "description", "status", "epoch", "repo_url", "repo_branch", "repo_commit", "deliver_as", "constraints", "sender_node_id", "sender_node_name", "sender_agent_id", "sender_agent_name", "sender_session_id", "executor_node_id", "executor_node_name", "executor_agent_id", "executor_agent_name", "executor_session_id", "reason", "result", "cost", "retry_of", "correlation_id", "last_event_seq", "exec_state", "notified_status", "created_at", "updated_at", "started_at", "finished_at") SELECT "id", "direction", "peer_id", "workspace_id", "project_id", "title", "description", "status", "epoch", "repo_url", "repo_branch", "repo_commit", "deliver_as", "constraints", "sender_node_id", "sender_node_name", "sender_agent_id", "sender_agent_name", "sender_session_id", "executor_node_id", "executor_node_name", "executor_agent_id", "executor_agent_name", "executor_session_id", "reason", "result", "cost", "retry_of", "correlation_id", "last_event_seq", "exec_state", "notified_status", "created_at", "updated_at", "started_at", "finished_at" FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
CREATE INDEX `tasks_direction_status_idx` ON `tasks` (`direction`,`status`);--> statement-breakpoint
CREATE INDEX `tasks_peer_idx` ON `tasks` (`peer_id`);--> statement-breakpoint
CREATE INDEX `tasks_project_status_idx` ON `tasks` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `tasks_executor_session_idx` ON `tasks` (`executor_session_id`);--> statement-breakpoint
CREATE INDEX `tasks_sender_session_idx` ON `tasks` (`sender_session_id`);--> statement-breakpoint
ALTER TABLE `projects` ADD `managed` integer DEFAULT false NOT NULL;