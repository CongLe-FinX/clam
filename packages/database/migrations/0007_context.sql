CREATE TABLE `context_replicas` (
	`context_id` text NOT NULL,
	`peer_id` text NOT NULL,
	`version` integer NOT NULL,
	`sha256` text NOT NULL,
	`state` text DEFAULT 'holds' NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`context_id`, `peer_id`),
	FOREIGN KEY (`context_id`) REFERENCES `contexts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`peer_id`) REFERENCES `peers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `context_replicas_peer_idx` ON `context_replicas` (`peer_id`);--> statement-breakpoint
CREATE TABLE `context_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`context_id` text NOT NULL,
	`version` integer NOT NULL,
	`sha256` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`base` text,
	`merged` text DEFAULT '[]' NOT NULL,
	`ancestors` text DEFAULT '[]' NOT NULL,
	`author` text NOT NULL,
	`origin_node_id` text NOT NULL,
	`git_path` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`context_id`) REFERENCES `contexts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `context_snapshots_identity_unique` ON `context_snapshots` (`context_id`,`version`,`sha256`);--> statement-breakpoint
CREATE INDEX `context_snapshots_sha_idx` ON `context_snapshots` (`context_id`,`sha256`);--> statement-breakpoint
CREATE TABLE `contexts` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text,
	`project_key` text,
	`origin_node_id` text NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`shareable` integer DEFAULT false NOT NULL,
	`deleted_at` text,
	`version` integer NOT NULL,
	`sha256` text NOT NULL,
	`author` text NOT NULL,
	`conflict` text,
	`git_path` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contexts_id_unique` ON `contexts` (`id`);--> statement-breakpoint
CREATE INDEX `contexts_scope_idx` ON `contexts` (`workspace_id`,`project_id`,`type`);--> statement-breakpoint
CREATE INDEX `contexts_project_key_idx` ON `contexts` (`workspace_id`,`project_key`);--> statement-breakpoint
CREATE INDEX `contexts_shareable_idx` ON `contexts` (`workspace_id`,`shareable`);--> statement-breakpoint
-- Custom SQL (not expressible in drizzle; drizzle-kit never sees these objects). Full-text index over the HEAD title/body of every
-- live context: an FTS5 external-content table keyed by `contexts.seq`, kept in sync by three triggers. A tombstone
-- (`deleted_at` set) has no index entry. 'delete' must be given exactly the values that were indexed, hence the WHEN guards.
CREATE VIRTUAL TABLE `context_fts` USING fts5(title, body, content='contexts', content_rowid='seq', tokenize='unicode61 remove_diacritics 2', prefix='2 3 4');--> statement-breakpoint
CREATE TRIGGER `contexts_fts_ai` AFTER INSERT ON `contexts` WHEN new.deleted_at IS NULL BEGIN
	INSERT INTO `context_fts`(rowid, title, body) VALUES (new.seq, new.title, new.body);
END;--> statement-breakpoint
CREATE TRIGGER `contexts_fts_ad` AFTER DELETE ON `contexts` WHEN old.deleted_at IS NULL BEGIN
	INSERT INTO `context_fts`(`context_fts`, rowid, title, body) VALUES ('delete', old.seq, old.title, old.body);
END;--> statement-breakpoint
CREATE TRIGGER `contexts_fts_au` AFTER UPDATE OF title, body, deleted_at ON `contexts` BEGIN
	INSERT INTO `context_fts`(`context_fts`, rowid, title, body) SELECT 'delete', old.seq, old.title, old.body WHERE old.deleted_at IS NULL;
	INSERT INTO `context_fts`(rowid, title, body) SELECT new.seq, new.title, new.body WHERE new.deleted_at IS NULL;
END;
