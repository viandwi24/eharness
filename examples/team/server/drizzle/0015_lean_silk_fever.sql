CREATE TABLE `programs` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`name` text NOT NULL,
	`brief` text NOT NULL,
	`authority` text NOT NULL,
	`gates` text NOT NULL,
	`escalation` text DEFAULT '' NOT NULL,
	`forbidden` text NOT NULL,
	`budget` text NOT NULL,
	`trigger` text NOT NULL,
	`report` text DEFAULT 'task' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by` text DEFAULT 'client' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `programs_agent` ON `programs` (`agent_id`);--> statement-breakpoint
ALTER TABLE `routines` ADD `program_id` text;--> statement-breakpoint
CREATE INDEX `routines_program` ON `routines` (`program_id`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `report` text;