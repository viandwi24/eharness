CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`nickname` text,
	`status` text DEFAULT 'active' NOT NULL,
	`role` text,
	`divisions` text DEFAULT '[]' NOT NULL,
	`fields` text DEFAULT '{}' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`member_id` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `people_name` ON `people` (`display_name`);--> statement-breakpoint
CREATE TABLE `people_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`platform` text NOT NULL,
	`native_id` text NOT NULL,
	`label` text,
	`status` text DEFAULT 'linked' NOT NULL,
	`linked_via` text NOT NULL,
	`linked_by` text,
	`linked_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE INDEX `people_accounts_person` ON `people_accounts` (`person_id`);--> statement-breakpoint
CREATE INDEX `people_accounts_native` ON `people_accounts` (`platform`,`native_id`);--> statement-breakpoint
CREATE TABLE `people_events` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`kind` text NOT NULL,
	`actor` text,
	`detail` text DEFAULT '{}' NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `people_events_person` ON `people_events` (`person_id`,`at`);--> statement-breakpoint
CREATE TABLE `people_link_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `people_link_codes_person` ON `people_link_codes` (`person_id`);