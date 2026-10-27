CREATE TABLE `script_timers` (
	`id` text PRIMARY KEY NOT NULL,
	`script_id` text NOT NULL,
	`key` text,
	`due_at` integer NOT NULL,
	`data` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `script_timers_due` ON `script_timers` (`due_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `script_timers_key` ON `script_timers` (`script_id`,`key`);