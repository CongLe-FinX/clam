CREATE TABLE `handoff_artifacts` (
	`handoff_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`sha256` text NOT NULL,
	`size` integer NOT NULL,
	`path` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`handoff_id`, `artifact_id`),
	FOREIGN KEY (`handoff_id`) REFERENCES `handoffs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `handoff_events` (
	`handoff_id` text NOT NULL,
	`seq` integer NOT NULL,
	`at` text NOT NULL,
	`node_id` text NOT NULL,
	`state` text NOT NULL,
	`summary` text NOT NULL,
	PRIMARY KEY(`handoff_id`, `seq`),
	FOREIGN KEY (`handoff_id`) REFERENCES `handoffs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `handoff_setup` (
	`id` text PRIMARY KEY NOT NULL,
	`handoff_id` text NOT NULL,
	`ord` integer NOT NULL,
	`command` text NOT NULL,
	`cwd` text NOT NULL,
	`purpose` text NOT NULL,
	`state` text NOT NULL,
	`exit_code` integer,
	`output_tail` text DEFAULT '' NOT NULL,
	`started_at` text,
	`finished_at` text,
	FOREIGN KEY (`handoff_id`) REFERENCES `handoffs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `handoff_setup_handoff_idx` ON `handoff_setup` (`handoff_id`,`ord`);--> statement-breakpoint
CREATE TABLE `handoff_steps` (
	`handoff_id` text NOT NULL,
	`n` integer NOT NULL,
	`name` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`detail` text,
	`at` text,
	PRIMARY KEY(`handoff_id`, `n`),
	FOREIGN KEY (`handoff_id`) REFERENCES `handoffs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `handoffs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`role` text NOT NULL,
	`state` text NOT NULL,
	`peer_id` text NOT NULL,
	`subject_id` text NOT NULL,
	`title` text NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text,
	`source_node_id` text NOT NULL,
	`source_node_name` text NOT NULL,
	`source_agent_id` text,
	`source_agent_name` text,
	`source_session_id` text,
	`target_node_id` text NOT NULL,
	`target_node_name` text NOT NULL,
	`target_agent_id` text,
	`target_agent_name` text,
	`target_session_id` text,
	`from_epoch` integer NOT NULL,
	`to_epoch` integer NOT NULL,
	`vcs` text DEFAULT 'none' NOT NULL,
	`include_transcript` integer DEFAULT false NOT NULL,
	`manifest` text,
	`manifest_sha256` text,
	`conversation_summary` text,
	`environment` text,
	`setup_fingerprint` text,
	`failure_code` text,
	`failure_detail` text,
	`failure_step` integer,
	`expires_at` text,
	`deadline_at` text,
	`ack_at` text,
	`fencing_token` text,
	`correlation_id` text NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `handoffs_subject_epoch_role_unique` ON `handoffs` (`subject_id`,`to_epoch`,`role`) WHERE "handoffs"."state" NOT IN ('prepare_failed', 'rejected', 'expired', 'cancelled', 'failed');--> statement-breakpoint
CREATE INDEX `handoffs_role_state_idx` ON `handoffs` (`role`,`state`);--> statement-breakpoint
CREATE INDEX `handoffs_peer_idx` ON `handoffs` (`peer_id`);--> statement-breakpoint
CREATE INDEX `handoffs_subject_idx` ON `handoffs` (`subject_id`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `fenced` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `highest_seen_epoch` integer DEFAULT 0 NOT NULL;