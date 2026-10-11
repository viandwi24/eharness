CREATE TABLE `briefings` (
	`id` text PRIMARY KEY NOT NULL,
	`day` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`items` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `briefings_day` ON `briefings` (`day`);--> statement-breakpoint
CREATE TABLE `chat_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`session_id` text NOT NULL,
	`title` text,
	`source` text DEFAULT 'web' NOT NULL,
	`source_label` text,
	`seed` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_message_at` integer,
	`preview` text,
	`archived_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_threads_session` ON `chat_threads` (`session_id`);--> statement-breakpoint
CREATE INDEX `chat_threads_agent` ON `chat_threads` (`agent_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`link` text,
	`agent_id` text,
	`created_at` integer NOT NULL,
	`dismissed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_key` ON `notifications` (`key`);--> statement-breakpoint
CREATE INDEX `notifications_open` ON `notifications` (`dismissed_at`,`created_at`);