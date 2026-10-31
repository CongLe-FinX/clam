CREATE TABLE `shared_checkpoints` (
	`shared_session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`epoch` integer NOT NULL,
	`node_id` text NOT NULL,
	`branch` text NOT NULL,
	`commit` text,
	`pushed` integer DEFAULT false NOT NULL,
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
CREATE TABLE `shared_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`shared_session_id` text NOT NULL,
	`from_node_id` text NOT NULL,
	`from_node_name` text NOT NULL,
	`from_agent_id` text,
	`from_agent_name` text,
	`title` text NOT NULL,
	`goal` text DEFAULT '' NOT NULL,
	`repo_url` text NOT NULL,
	`repo_branch` text NOT NULL,
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
CREATE INDEX `shared_invites_state_idx` ON `shared_invites` (`state`);--> statement-breakpoint
CREATE INDEX `shared_invites_session_idx` ON `shared_invites` (`shared_session_id`);--> statement-breakpoint
CREATE TABLE `shared_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`shared_session_id` text NOT NULL,
	`author_kind` text NOT NULL,
	`author_node_id` text NOT NULL,
	`author_node_name` text NOT NULL,
	`author_agent_id` text,
	`author_agent_name` text,
	`kind` text NOT NULL,
	`to` text DEFAULT '{"mode":"lead","agents":[]}' NOT NULL,
	`text` text NOT NULL,
	`epoch` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`hlc` text NOT NULL,
	`origin_seq` integer,
	`delivery` text DEFAULT 'local' NOT NULL,
	`injected_session_id` text,
	`read_at` text,
	`received_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`shared_session_id`) REFERENCES `shared_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `shared_messages_order_idx` ON `shared_messages` (`shared_session_id`,`hlc`);--> statement-breakpoint
CREATE UNIQUE INDEX `shared_messages_origin_seq_unique` ON `shared_messages` (`shared_session_id`,`author_node_id`,`origin_seq`);--> statement-breakpoint
CREATE TABLE `shared_mirror_messages` (
	`mirror_session_id` text NOT NULL,
	`message_id` text NOT NULL,
	`position` integer NOT NULL,
	`message` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`mirror_session_id`, `message_id`),
	FOREIGN KEY (`mirror_session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `shared_mirror_messages_pos_idx` ON `shared_mirror_messages` (`mirror_session_id`,`position`);--> statement-breakpoint
CREATE TABLE `shared_mirror_state` (
	`mirror_session_id` text PRIMARY KEY NOT NULL,
	`shared_session_id` text NOT NULL,
	`epoch` integer NOT NULL,
	`stream_id` text,
	`last_seq` integer DEFAULT 0 NOT NULL,
	`syncing` integer DEFAULT false NOT NULL,
	`state` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`mirror_session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `shared_participants` (
	`shared_session_id` text NOT NULL,
	`node_id` text NOT NULL,
	`node_name` text NOT NULL,
	`agent_id` text,
	`agent_name` text,
	`role` text NOT NULL,
	`state` text NOT NULL,
	`agent_session_id` text,
	`ui_url` text,
	`snapshot_seq` integer DEFAULT 0 NOT NULL,
	`briefed` integer DEFAULT false NOT NULL,
	`joined_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`shared_session_id`, `node_id`),
	FOREIGN KEY (`shared_session_id`) REFERENCES `shared_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `shared_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`title` text NOT NULL,
	`goal` text DEFAULT '' NOT NULL,
	`repo_url` text NOT NULL,
	`branch` text NOT NULL,
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
	`last_checkpoint_seq` integer DEFAULT 0 NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`local_session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`mirror_session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`local_project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `shared_sessions_local_session_idx` ON `shared_sessions` (`local_session_id`);--> statement-breakpoint
CREATE INDEX `shared_sessions_mirror_session_idx` ON `shared_sessions` (`mirror_session_id`);--> statement-breakpoint
CREATE INDEX `shared_sessions_state_idx` ON `shared_sessions` (`state`);--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `kind` text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `shared_session_id` text;--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `moved_to` text;