CREATE TABLE `channel_events` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`at` integer NOT NULL,
	`type` text NOT NULL,
	`reason` text,
	`conversation_id` text,
	`peer_id` text,
	`peer_name` text,
	`platform_id` text,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `channel_events_conn` ON `channel_events` (`connection_id`,`id`);--> statement-breakpoint
CREATE INDEX `channel_events_type` ON `channel_events` (`connection_id`,`type`,`id`);--> statement-breakpoint
CREATE INDEX `channel_events_conversation` ON `channel_events` (`connection_id`,`conversation_id`,`id`);--> statement-breakpoint
CREATE INDEX `channel_events_at` ON `channel_events` (`at`);--> statement-breakpoint
CREATE TABLE `channel_inbox` (
	`connection_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`ref` text NOT NULL,
	`woke` integer DEFAULT 0 NOT NULL,
	`observed` integer DEFAULT 0 NOT NULL,
	`dropped` integer DEFAULT 0 NOT NULL,
	`first_at` integer NOT NULL,
	`last_at` integer NOT NULL,
	PRIMARY KEY(`connection_id`, `conversation_id`)
);
--> statement-breakpoint
CREATE INDEX `channel_inbox_last` ON `channel_inbox` (`connection_id`,`last_at`);--> statement-breakpoint
CREATE TABLE `channel_unlinked` (
	`connection_id` text NOT NULL,
	`peer_id` text NOT NULL,
	`name` text,
	`username` text,
	`first_seen` integer NOT NULL,
	`last_seen` integer NOT NULL,
	`message_count` integer DEFAULT 0 NOT NULL,
	`ignored` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`connection_id`, `peer_id`)
);
--> statement-breakpoint
ALTER TABLE `channel_messages` ADD `disposition` text;