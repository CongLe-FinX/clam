CREATE TABLE `usage_buckets` (
	`bucket_start` integer PRIMARY KEY NOT NULL,
	`requests` integer NOT NULL,
	`failed_requests` integer NOT NULL,
	`tokens_total` integer NOT NULL,
	`cost` real NOT NULL,
	`updated_at` text NOT NULL
);
