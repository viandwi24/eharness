CREATE TABLE `script_kv` (
	`script_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`script_id`, `key`)
);
--> statement-breakpoint
CREATE TABLE `script_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`script_id` text NOT NULL,
	`version` integer NOT NULL,
	`trigger` text NOT NULL,
	`dry_run` integer DEFAULT false NOT NULL,
	`outcome` text NOT NULL,
	`reason` text,
	`error` text,
	`event` text,
	`result` text,
	`logs` text NOT NULL,
	`calls` text NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`cpu_ms` integer DEFAULT 0 NOT NULL,
	`started_by` text NOT NULL,
	`started_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `script_runs_script` ON `script_runs` (`script_id`,`id`);--> statement-breakpoint
CREATE INDEX `script_runs_started` ON `script_runs` (`started_at`);--> statement-breakpoint
CREATE TABLE `script_versions` (
	`script_id` text NOT NULL,
	`version` integer NOT NULL,
	`source` text NOT NULL,
	`manifest` text NOT NULL,
	`hash` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_by` text NOT NULL,
	`author_kind` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`script_id`, `version`)
);
--> statement-breakpoint
CREATE TABLE `scripts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`agent_id` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`latest_version` integer DEFAULT 1 NOT NULL,
	`active_version` integer,
	`author_kind` text NOT NULL,
	`created_by` text NOT NULL,
	`approval_state` text DEFAULT 'none' NOT NULL,
	`approval_version` integer,
	`approval_by` text,
	`approval_at` integer,
	`approval_note` text,
	`routine_id` text,
	`last_run_at` integer,
	`run_count` integer DEFAULT 0 NOT NULL,
	`error_count` integer DEFAULT 0 NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`disabled_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scripts_name_unique` ON `scripts` (`name`);