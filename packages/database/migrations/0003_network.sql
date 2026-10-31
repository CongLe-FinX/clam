CREATE TABLE `network_events` (
	`stream` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`audience` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`stream`, `seq`)
);
--> statement-breakpoint
CREATE TABLE `nonce_log` (
	`peer_id` text NOT NULL,
	`nonce` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`peer_id`, `nonce`)
);
--> statement-breakpoint
CREATE INDEX `nonce_log_expires_idx` ON `nonce_log` (`expires_at`);--> statement-breakpoint
CREATE TABLE `pairing_invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`capabilities` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 5 NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`consumed_at` text,
	`consumed_by` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pairing_invitations_state_idx` ON `pairing_invitations` (`state`);--> statement-breakpoint
CREATE TABLE `pairing_joins` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`invitation_id` text NOT NULL,
	`remote_node_id` text NOT NULL,
	`remote_name` text NOT NULL,
	`remote_public_key` text NOT NULL,
	`remote_fingerprint` text NOT NULL,
	`remote_preview` text NOT NULL,
	`nonce_joiner` text NOT NULL,
	`nonce_inviter` text,
	`workspace_id` text,
	`workspace_name` text,
	`granted_capabilities` text NOT NULL,
	`received_capabilities` text,
	`state` text DEFAULT 'hello_sent' NOT NULL,
	`error` text,
	`correlation_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pairing_joins_state_idx` ON `pairing_joins` (`state`);--> statement-breakpoint
CREATE TABLE `pairing_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`invitation_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`remote_node_id` text NOT NULL,
	`remote_name` text NOT NULL,
	`remote_public_key` text NOT NULL,
	`remote_fingerprint` text NOT NULL,
	`remote_url` text NOT NULL,
	`nonce_inviter` text NOT NULL,
	`nonce_joiner` text NOT NULL,
	`hello_response` text NOT NULL,
	`capabilities` text,
	`state` text DEFAULT 'awaiting_approval' NOT NULL,
	`error` text,
	`correlation_id` text NOT NULL,
	`requested_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`invitation_id`) REFERENCES `pairing_invitations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pairing_requests_invitation_unique` ON `pairing_requests` (`invitation_id`);--> statement-breakpoint
CREATE INDEX `pairing_requests_state_idx` ON `pairing_requests` (`state`);--> statement-breakpoint
CREATE TABLE `peer_agents` (
	`peer_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`name` text NOT NULL,
	`role` text DEFAULT '' NOT NULL,
	`runtime` text NOT NULL,
	`capabilities` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'offline' NOT NULL,
	`active_sessions` integer DEFAULT 0 NOT NULL,
	`fetched_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`peer_id`, `agent_id`),
	FOREIGN KEY (`peer_id`) REFERENCES `peers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `peers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`fingerprint` text NOT NULL,
	`public_key` text NOT NULL,
	`key_id` text NOT NULL,
	`url` text NOT NULL,
	`status` text DEFAULT 'offline' NOT NULL,
	`granted_capabilities` text DEFAULT '[]' NOT NULL,
	`received_capabilities` text DEFAULT '[]' NOT NULL,
	`protocol_version` integer DEFAULT 1 NOT NULL,
	`latency_ms` integer,
	`last_seen_at` text,
	`last_error` text,
	`last_event_cursor` text,
	`paired_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`revoked_at` text,
	`revoked_by` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `peers_status_idx` ON `peers` (`status`);--> statement-breakpoint
ALTER TABLE `workspace_members` ADD `permissions` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_members` ADD `granted_by` text;--> statement-breakpoint
ALTER TABLE `workspace_members` ADD `revoked_at` text;