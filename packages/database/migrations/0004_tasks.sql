CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`name` text NOT NULL,
	`media_type` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`storage_path` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `artifacts_task_idx` ON `artifacts` (`task_id`);--> statement-breakpoint
CREATE TABLE `idempotency_records` (
	`peer_id` text NOT NULL,
	`key` text NOT NULL,
	`method` text NOT NULL,
	`path` text NOT NULL,
	`request_hash` text NOT NULL,
	`status` integer NOT NULL,
	`response_body` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`peer_id`, `key`)
);
--> statement-breakpoint
CREATE INDEX `idempotency_expires_idx` ON `idempotency_records` (`expires_at`);--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`peer_id` text NOT NULL,
	`task_id` text,
	`kind` text NOT NULL,
	`ref_id` text,
	`method` text NOT NULL,
	`path` text NOT NULL,
	`body` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`correlation_id` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`last_error` text,
	`last_status` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`sent_at` text,
	FOREIGN KEY (`peer_id`) REFERENCES `peers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_peer_key_unique` ON `outbox` (`peer_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `outbox_state_idx` ON `outbox` (`state`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `outbox_task_idx` ON `outbox` (`task_id`);--> statement-breakpoint
CREATE TABLE `task_events` (
	`task_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`summary` text NOT NULL,
	`payload` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`task_id`, `seq`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `task_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`author_kind` text NOT NULL,
	`author_node_id` text NOT NULL,
	`author_node_name` text NOT NULL,
	`author_agent_id` text,
	`author_agent_name` text,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`created_at` text NOT NULL,
	`delivery` text DEFAULT 'local' NOT NULL,
	`injected_session_id` text,
	`read_at` text,
	`received_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_messages_task_idx` ON `task_messages` (`task_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`direction` text NOT NULL,
	`peer_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'offered' NOT NULL,
	`epoch` integer DEFAULT 0 NOT NULL,
	`repo_url` text NOT NULL,
	`repo_branch` text,
	`repo_commit` text,
	`deliver_as` text DEFAULT 'branch' NOT NULL,
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
CREATE INDEX `tasks_direction_status_idx` ON `tasks` (`direction`,`status`);--> statement-breakpoint
CREATE INDEX `tasks_peer_idx` ON `tasks` (`peer_id`);--> statement-breakpoint
CREATE INDEX `tasks_project_status_idx` ON `tasks` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `tasks_executor_session_idx` ON `tasks` (`executor_session_id`);--> statement-breakpoint
CREATE INDEX `tasks_sender_session_idx` ON `tasks` (`sender_session_id`);--> statement-breakpoint
ALTER TABLE `peers` ADD `auto_accept_tasks` integer DEFAULT false NOT NULL;