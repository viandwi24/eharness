CREATE TABLE `agent_connectors` (
	`agent_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`choices` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `connection_id`)
);
--> statement-breakpoint
CREATE INDEX `agent_connectors_conn` ON `agent_connectors` (`connection_id`);--> statement-breakpoint
ALTER TABLE `agents` ADD `connectors_migrated` integer DEFAULT 0 NOT NULL;