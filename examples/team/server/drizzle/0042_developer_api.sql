CREATE TABLE `api_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`instructions` text NOT NULL,
	`rules` text NOT NULL,
	`model` text,
	`model_profile` text,
	`read_folders` text NOT NULL,
	`write_folder` text,
	`web_search` integer DEFAULT 0 NOT NULL,
	`retention_days` integer DEFAULT 30 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_agents_slug_unique` ON `api_agents` (`slug`);--> statement-breakpoint
CREATE INDEX `api_agents_created` ON `api_agents` (`created_at`);--> statement-breakpoint
CREATE TABLE `api_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`key_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`request_id` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `api_calls_key` ON `api_calls` (`key_id`,`at`);--> statement-breakpoint
CREATE TABLE `api_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`key_id` text NOT NULL,
	`end_user_id` text,
	`metadata` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_message_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `api_conversations_user` ON `api_conversations` (`agent_id`,`key_id`,`end_user_id`,`status`);--> statement-breakpoint
CREATE INDEX `api_conversations_idle` ON `api_conversations` (`agent_id`,`last_message_at`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`hash` text NOT NULL,
	`agents` text NOT NULL,
	`daily_cost_limit_usd` real,
	`rate_limit_per_min` integer,
	`origins` text NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	`last_used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `api_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`key_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`mode` text NOT NULL,
	`conversation_id` text,
	`status` integer NOT NULL,
	`error_code` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `api_requests_key` ON `api_requests` (`key_id`,`at`);--> statement-breakpoint
CREATE INDEX `api_requests_at` ON `api_requests` (`at`);