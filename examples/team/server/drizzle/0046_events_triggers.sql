CREATE TABLE `ch_join_requests` (
	`connection_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`user_id` text NOT NULL,
	`chat_title` text DEFAULT '' NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`username` text,
	`bio` text,
	`link` text,
	`requested_at` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`resolved_at` integer,
	`resolved_by` text,
	PRIMARY KEY(`connection_id`, `chat_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `ch_join_requests_status` ON `ch_join_requests` (`connection_id`,`status`,`requested_at`);--> statement-breakpoint
CREATE TABLE `trigger_fires` (
	`id` text PRIMARY KEY NOT NULL,
	`trigger_id` text NOT NULL,
	`event_id` text NOT NULL,
	`event_type` text NOT NULL,
	`at` integer NOT NULL,
	`result` text NOT NULL,
	`reason` text,
	`action_kind` text NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`detail` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `trigger_fires_trigger` ON `trigger_fires` (`trigger_id`,`id`);--> statement-breakpoint
CREATE INDEX `trigger_fires_at` ON `trigger_fires` (`at`);--> statement-breakpoint
CREATE TABLE `triggers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`event_types` text NOT NULL,
	`scope` text NOT NULL,
	`filters` text NOT NULL,
	`action` text NOT NULL,
	`webhook_secret` text,
	`cooldown_sec` integer DEFAULT 0 NOT NULL,
	`allow_self` integer DEFAULT false NOT NULL,
	`created_by` text NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_fired_at` integer,
	`fire_count` integer DEFAULT 0 NOT NULL,
	`error_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `triggers_enabled` ON `triggers` (`enabled`);