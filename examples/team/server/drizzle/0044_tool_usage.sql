CREATE TABLE `tool_usage` (
	`agent_id` text NOT NULL,
	`tool` text NOT NULL,
	`last_used_at` integer NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`agent_id`, `tool`)
);
--> statement-breakpoint
CREATE INDEX `tool_usage_last` ON `tool_usage` (`last_used_at`);