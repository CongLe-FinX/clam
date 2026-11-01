ALTER TABLE `outbox` ADD `last_error_i18n` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `reason_i18n` text;--> statement-breakpoint
ALTER TABLE `handoff_steps` ADD `detail_i18n` text;