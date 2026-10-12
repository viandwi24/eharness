CREATE TABLE `ch_people` (
	`identity_id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`role` text NOT NULL,
	`divisions` text DEFAULT '[]' NOT NULL,
	`set_by` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ch_people_connection` ON `ch_people` (`connection_id`);--> statement-breakpoint
CREATE TABLE `ch_proactive` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`node_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`body` text NOT NULL,
	`mentions` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'held' NOT NULL,
	`created_at` integer NOT NULL,
	`sent_at` integer
);
--> statement-breakpoint
CREATE INDEX `ch_proactive_node` ON `ch_proactive` (`node_id`,`status`);--> statement-breakpoint
CREATE TABLE `ch_reminders` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`node_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`routine_id` text,
	`body` text NOT NULL,
	`mentions` text DEFAULT '[]' NOT NULL,
	`schedule` text NOT NULL,
	`when_text` text NOT NULL,
	`timezone` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by_identity_id` text,
	`created_by_name` text,
	`created_by_role` text,
	`created_at` integer NOT NULL,
	`last_fired_at` integer,
	`fire_count` integer DEFAULT 0 NOT NULL,
	`last_error` text
);
--> statement-breakpoint
CREATE INDEX `ch_reminders_connection` ON `ch_reminders` (`connection_id`,`status`);--> statement-breakpoint
CREATE INDEX `ch_reminders_routine` ON `ch_reminders` (`routine_id`);