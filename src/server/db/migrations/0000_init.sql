CREATE TABLE `alert_responses` (
	`id` text PRIMARY KEY NOT NULL,
	`alert_id` text NOT NULL,
	`user_id` text NOT NULL,
	`accepted` integer NOT NULL,
	`responded_at` integer NOT NULL,
	`streak_at_response` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`alert_id`) REFERENCES `alerts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_response_per_user` ON `alert_responses` (`alert_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `ix_alert_responses_user` ON `alert_responses` (`user_id`);--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`alert_id` text NOT NULL,
	`tick` integer NOT NULL,
	`timestamp` text NOT NULL,
	`severity` text NOT NULL,
	`parameter` text NOT NULL,
	`title` text NOT NULL,
	`message` text NOT NULL,
	`incentive` text,
	`value` real NOT NULL,
	`threshold` real NOT NULL,
	`reward_idr_per_kwh` real,
	`expected_shed_kwh` real DEFAULT 0 NOT NULL,
	`duration_minutes` integer,
	`target_reduction_w` real,
	`triggered_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`pushed_at` integer,
	`pushed_by` text,
	`auto_pushed` integer DEFAULT false NOT NULL,
	`push_attempts` integer DEFAULT 0 NOT NULL,
	`delivered_at` integer,
	`ignored_at` integer,
	`ignored_by` text,
	`cleared_at` integer,
	FOREIGN KEY (`pushed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`ignored_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_alert_per_tick` ON `alerts` (`alert_id`,`tick`);--> statement-breakpoint
CREATE INDEX `ix_alerts_triggered_at` ON `alerts` (`triggered_at`);--> statement-breakpoint
CREATE INDEX `ix_alerts_delivered_at` ON `alerts` (`delivered_at`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text,
	`actor_label` text DEFAULT 'system' NOT NULL,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`target_label` text,
	`detail` text,
	`ip` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`cleared_at` integer,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_audit_created_at` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `ix_audit_action` ON `audit_log` (`action`);--> statement-breakpoint
CREATE INDEX `ix_audit_target` ON `audit_log` (`target_id`);--> statement-breakpoint
CREATE INDEX `ix_audit_actor` ON `audit_log` (`actor_user_id`);--> statement-breakpoint
CREATE TABLE `refresh_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `refresh_tokens_token_hash_unique` ON `refresh_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `ix_refresh_tokens_user` ON `refresh_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'consumer' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`last_login_at` integer,
	`approved_at` integer,
	`approved_by` text,
	FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);