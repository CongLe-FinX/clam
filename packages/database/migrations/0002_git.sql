CREATE TABLE `git_sync_states` (
	`project_id` text NOT NULL,
	`branch` text NOT NULL,
	`commit_sha` text NOT NULL,
	`remote_sha` text,
	`ahead` integer,
	`behind` integer,
	`dirty` integer DEFAULT false NOT NULL,
	`last_fetched_at` text,
	`last_pushed_at` text,
	`last_pulled_at` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`project_id`, `branch`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
