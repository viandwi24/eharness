CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`avatar` text,
	`color` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`instructions` text NOT NULL,
	`model` text,
	`tools` text NOT NULL,
	`skills` text NOT NULL,
	`mcp` text NOT NULL,
	`permission_mode` text NOT NULL,
	`rules` text NOT NULL,
	`version` integer NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_slug_unique` ON `agents` (`slug`);--> statement-breakpoint
CREATE INDEX `agents_workspace` ON `agents` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `chats` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`last_message_at` integer,
	`last_preview` text,
	`unread` integer DEFAULT 0 NOT NULL,
	`last_read_message_id` text
);
--> statement-breakpoint
CREATE TABLE `eh_budget_record` (
	`key` text PRIMARY KEY NOT NULL,
	`recorded_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `eh_budget_reservation` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`scopes` text NOT NULL,
	`period_start` integer NOT NULL,
	`amount_usd` text NOT NULL,
	`expires_at` integer NOT NULL,
	`state` text DEFAULT 'open' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `eh_budget_reservation_key` ON `eh_budget_reservation` (`key`);--> statement-breakpoint
CREATE TABLE `eh_budget_scope` (
	`scope` text NOT NULL,
	`period_start` integer NOT NULL,
	`limit_usd` text,
	`spent_usd` text DEFAULT '0' NOT NULL,
	PRIMARY KEY(`scope`, `period_start`)
);
--> statement-breakpoint
CREATE TABLE `eh_inbox` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`item` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`claimed_by` text,
	`claimed_until` integer,
	`available_at` integer,
	`delayed_until` integer,
	`last_error` text,
	`dead_at` integer,
	`dead_reason` text
);
--> statement-breakpoint
CREATE INDEX `eh_inbox_session` ON `eh_inbox` (`session_id`,`id`);--> statement-breakpoint
CREATE TABLE `eh_locks` (
	`session_id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`until` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `eh_messages` (
	`session_id` text NOT NULL,
	`id` text NOT NULL,
	`role` text NOT NULL,
	`parts` text NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`session_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `eh_state` (
	`session_id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`rev` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `library_files` (
	`path` text PRIMARY KEY NOT NULL,
	`version` text NOT NULL,
	`text` text,
	`bytes` blob,
	`media_type` text,
	`size` integer NOT NULL,
	`created_by_agent_id` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `library_updated` ON `library_files` (`updated_at`);--> statement-breakpoint
CREATE TABLE `routine_runs` (
	`routine_id` text NOT NULL,
	`fire_at` integer NOT NULL,
	`task_id` text,
	`started_at` integer NOT NULL,
	`status` text NOT NULL,
	PRIMARY KEY(`routine_id`, `fire_at`)
);
--> statement-breakpoint
CREATE TABLE `routines` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`name` text NOT NULL,
	`prompt` text NOT NULL,
	`schedule` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`next_run_at` integer,
	`lease_owner` text,
	`lease_until` integer,
	`last_run_at` integer,
	`last_status` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `routines_due` ON `routines` (`enabled`,`next_run_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`session_id` text NOT NULL,
	`parent_session_id` text,
	`origin` text NOT NULL,
	`title` text NOT NULL,
	`state` text NOT NULL,
	`pending_kind` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`summary` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_session_id_unique` ON `tasks` (`session_id`);--> statement-breakpoint
CREATE INDEX `tasks_state` ON `tasks` (`state`);--> statement-breakpoint
CREATE INDEX `tasks_agent` ON `tasks` (`agent_id`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`settings` text NOT NULL,
	`created_at` integer NOT NULL
);
