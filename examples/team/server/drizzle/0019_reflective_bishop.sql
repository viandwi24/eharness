CREATE TABLE `program_tests` (
	`id` text PRIMARY KEY NOT NULL,
	`program_id` text NOT NULL,
	`name` text NOT NULL,
	`data` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `program_tests_program` ON `program_tests` (`program_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `rehearsals` (
	`id` text PRIMARY KEY NOT NULL,
	`program_id` text NOT NULL,
	`session_id` text NOT NULL,
	`test_id` text,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rehearsals_program` ON `rehearsals` (`program_id`,`started_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `rehearsals_session` ON `rehearsals` (`session_id`);