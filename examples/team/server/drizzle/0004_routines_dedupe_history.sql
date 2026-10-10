CREATE TABLE `eh_inbox_keys` (
	`session_id` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`item_id` text NOT NULL,
	`expires_at` integer,
	PRIMARY KEY(`session_id`, `dedupe_key`)
);
--> statement-breakpoint
CREATE INDEX `eh_inbox_keys_item` ON `eh_inbox_keys` (`item_id`);--> statement-breakpoint
CREATE INDEX `eh_inbox_keys_expiry` ON `eh_inbox_keys` (`expires_at`);--> statement-breakpoint
CREATE TABLE `library_history` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`path` text NOT NULL,
	`action` text NOT NULL,
	`version` text,
	`size` integer,
	`from_path` text,
	`agent_id` text,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `library_history_path` ON `library_history` (`path`,`seq`);--> statement-breakpoint
CREATE TABLE `routine_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`routine_id` text NOT NULL,
	`scheduled_at` integer NOT NULL,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`session_id` text NOT NULL,
	`inbox_id` text,
	`reason` text,
	`claimed_at` integer NOT NULL,
	`fired_at` integer,
	`finished_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `routine_runs_slot` ON `routine_runs` (`routine_id`,`scheduled_at`);--> statement-breakpoint
CREATE INDEX `routine_runs_inbox` ON `routine_runs` (`inbox_id`);--> statement-breakpoint
CREATE TABLE `routines` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`name` text NOT NULL,
	`prompt` text NOT NULL,
	`spec` text NOT NULL,
	`session_mode` text DEFAULT 'task' NOT NULL,
	`overlap` text DEFAULT 'skip' NOT NULL,
	`catch_up_window_ms` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`paused_reason` text,
	`next_fire_at` integer,
	`last_fire_at` integer,
	`last_status` text,
	`failures` integer DEFAULT 0 NOT NULL,
	`max_failures` integer DEFAULT 3 NOT NULL,
	`fire_count` integer DEFAULT 0 NOT NULL,
	`max_fires` integer,
	`end_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `routines_due` ON `routines` (`status`,`next_fire_at`);--> statement-breakpoint
CREATE INDEX `routines_agent` ON `routines` (`agent_id`);