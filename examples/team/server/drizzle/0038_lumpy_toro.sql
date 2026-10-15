CREATE TABLE `turn_retries` (
	`session_id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`max_attempts` integer NOT NULL,
	`next_at` integer NOT NULL,
	`error_code` text NOT NULL,
	`error_message` text NOT NULL,
	`state` text NOT NULL,
	`claimed_until` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `turn_retries_due` ON `turn_retries` (`state`,`next_at`);