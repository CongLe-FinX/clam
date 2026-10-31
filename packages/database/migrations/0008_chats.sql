CREATE TABLE `shared_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`shared_session_id` text NOT NULL,
	`message_id` text,
	`name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`origin_node_id` text NOT NULL,
	`stored` integer DEFAULT false NOT NULL,
	`copied_path` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`shared_session_id`) REFERENCES `shared_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `shared_attachments_session_idx` ON `shared_attachments` (`shared_session_id`);--> statement-breakpoint
CREATE INDEX `shared_attachments_message_idx` ON `shared_attachments` (`message_id`);--> statement-breakpoint
ALTER TABLE `projects` ADD `origin` text DEFAULT 'user' NOT NULL;