ALTER TABLE `chats` ADD `last_read_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `events` ADD `agent_id` text;--> statement-breakpoint
ALTER TABLE `events` ADD `session_id` text;--> statement-breakpoint
CREATE INDEX `events_agent` ON `events` (`agent_id`,`type`,`seq`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `last_activity_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `cost_usd` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `tasks_parent` ON `tasks` (`parent_session_id`);