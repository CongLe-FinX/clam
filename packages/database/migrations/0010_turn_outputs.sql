CREATE TABLE `turn_outputs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`project_id` text NOT NULL,
	`anchor_message_id` text,
	`anchor_timestamp` integer,
	`started_at` integer NOT NULL,
	`ended_at` integer NOT NULL,
	`files` text NOT NULL,
	`truncated` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `turn_outputs_session_idx` ON `turn_outputs` (`session_id`,`ended_at`);