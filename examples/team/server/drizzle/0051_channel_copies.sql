CREATE TABLE `ch_copies` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`source_node` text NOT NULL,
	`source_id` text NOT NULL,
	`target_node` text NOT NULL,
	`target_id` text,
	`trial` integer DEFAULT 0 NOT NULL,
	`sync` integer DEFAULT 1 NOT NULL,
	`own_caption` integer DEFAULT 0 NOT NULL,
	`agent_id` text,
	`note` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ch_copies_source` ON `ch_copies` (`source_node`,`source_id`);--> statement-breakpoint
CREATE INDEX `ch_copies_target` ON `ch_copies` (`target_node`,`target_id`);--> statement-breakpoint
CREATE INDEX `ch_copies_created` ON `ch_copies` (`created_at`);