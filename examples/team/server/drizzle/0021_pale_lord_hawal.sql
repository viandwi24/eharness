CREATE TABLE `channel_connections` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`config` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `channel_conversations` (
	`connection_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`session_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`ref` text NOT NULL,
	`label` text,
	`retention_days` integer,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`connection_id`, `conversation_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_conversations_session` ON `channel_conversations` (`session_id`);--> statement-breakpoint
CREATE TABLE `channel_identities` (
	`connection_id` text NOT NULL,
	`peer_id` text NOT NULL,
	`member_id` text NOT NULL,
	`name` text,
	`linked_at` integer NOT NULL,
	PRIMARY KEY(`connection_id`, `peer_id`)
);
--> statement-breakpoint
CREATE INDEX `channel_identities_member` ON `channel_identities` (`connection_id`,`member_id`);--> statement-breakpoint
CREATE TABLE `channel_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`platform_id` text NOT NULL,
	`at` integer NOT NULL,
	`self` integer DEFAULT 0 NOT NULL,
	`pending` integer DEFAULT 0 NOT NULL,
	`handled` integer DEFAULT 0 NOT NULL,
	`edited_at` integer,
	`deleted_at` integer,
	`body` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_messages_platform` ON `channel_messages` (`connection_id`,`conversation_id`,`platform_id`);--> statement-breakpoint
CREATE INDEX `channel_messages_conversation` ON `channel_messages` (`connection_id`,`conversation_id`,`id`);--> statement-breakpoint
CREATE INDEX `channel_messages_at` ON `channel_messages` (`at`);--> statement-breakpoint
CREATE TABLE `channel_pairing_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`member_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer
);
--> statement-breakpoint
CREATE INDEX `channel_pairing_expiry` ON `channel_pairing_tokens` (`expires_at`);