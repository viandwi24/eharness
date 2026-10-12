CREATE TABLE `tgu_chats` (
	`connection_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`username` text,
	`forum` integer DEFAULT 0 NOT NULL,
	`admin` integer DEFAULT 0 NOT NULL,
	`selected` integer DEFAULT 0 NOT NULL,
	`high_id` integer,
	`first_live_id` integer,
	`backfill_days` integer,
	`backfill_state` text DEFAULT 'idle' NOT NULL,
	`backfill_oldest_id` integer,
	`backfill_oldest_at` integer,
	`backfill_count` integer DEFAULT 0 NOT NULL,
	`backfill_error` text,
	`parked_until` integer,
	`admin_log_enabled` integer DEFAULT 0 NOT NULL,
	`admin_log_last_id` text,
	`admin_log_last_at` integer,
	`admin_log_count` integer DEFAULT 0 NOT NULL,
	`admin_log_error` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`connection_id`, `chat_id`)
);
--> statement-breakpoint
CREATE TABLE `tgu_counters` (
	`connection_id` text NOT NULL,
	`day` text NOT NULL,
	`key` text NOT NULL,
	`n` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`connection_id`, `day`, `key`)
);
--> statement-breakpoint
CREATE TABLE `tgu_leases` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tgu_settings` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`config` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `channel_messages` ADD `rev` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `channel_messages_rev` ON `channel_messages` (`connection_id`,`rev`);--> statement-breakpoint
UPDATE `channel_messages` SET `rev` = `rowid` WHERE `rev` = 0;
