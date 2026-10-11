CREATE TABLE `channel_known_chats` (
	`connection_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`username` text,
	`forum` integer DEFAULT 0 NOT NULL,
	`topics` text DEFAULT '{}' NOT NULL,
	`bot_status` text,
	`can_post` integer,
	`first_seen` integer NOT NULL,
	`last_seen` integer NOT NULL,
	PRIMARY KEY(`connection_id`, `chat_id`)
);
