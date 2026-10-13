CREATE TABLE `artifact_blobs` (
	`hash` text PRIMARY KEY NOT NULL,
	`bytes` blob NOT NULL,
	`media_type` text NOT NULL,
	`size` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `artifact_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`artifact_id` text NOT NULL,
	`action` text NOT NULL,
	`actor` text NOT NULL,
	`session_id` text,
	`detail` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `artifact_events_artifact` ON `artifact_events` (`artifact_id`,`seq`);--> statement-breakpoint
CREATE TABLE `artifact_versions` (
	`artifact_id` text NOT NULL,
	`n` integer NOT NULL,
	`files` text NOT NULL,
	`entry` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`by` text NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`artifact_id`, `n`)
);
--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`dir` text NOT NULL,
	`entry` text NOT NULL,
	`agent_id` text,
	`session_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`visibility` text DEFAULT 'private' NOT NULL,
	`share_token` text,
	`share_version` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `artifacts_updated` ON `artifacts` (`updated_at`);--> statement-breakpoint
CREATE INDEX `artifacts_dir` ON `artifacts` (`dir`);--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_share_token` ON `artifacts` (`share_token`);