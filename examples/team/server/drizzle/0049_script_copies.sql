CREATE TABLE `script_copies` (
	`script_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`source_node` text NOT NULL,
	`source_id` text NOT NULL,
	`target_node` text NOT NULL,
	`target_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`script_id`, `source_node`, `source_id`, `target_node`, `target_id`)
);
--> statement-breakpoint
CREATE INDEX `script_copies_target` ON `script_copies` (`script_id`,`target_node`,`target_id`);--> statement-breakpoint
CREATE INDEX `script_copies_created` ON `script_copies` (`created_at`);--> statement-breakpoint
ALTER TABLE `script_kv` ADD `expires_at` integer;