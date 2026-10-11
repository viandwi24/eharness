CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`agent_id` text NOT NULL,
	`session_id` text,
	`program_id` text,
	`payload` text NOT NULL,
	`wait_id` text,
	`decided_by` text,
	`decided_at` integer,
	`decision_note` text,
	`outcome` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `decisions_status` ON `decisions` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `decisions_agent` ON `decisions` (`agent_id`);--> statement-breakpoint
CREATE INDEX `decisions_session` ON `decisions` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `decisions_wait` ON `decisions` (`wait_id`);