CREATE TABLE `alarms` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`subject` text NOT NULL,
	`agent_id` text,
	`text` text NOT NULL,
	`refs` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`acked_at` integer,
	`acked_by` text,
	`delivered_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alarms_key` ON `alarms` (`key`);--> statement-breakpoint
CREATE INDEX `alarms_open` ON `alarms` (`acked_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `alarms_subject` ON `alarms` (`subject`,`delivered_at`);