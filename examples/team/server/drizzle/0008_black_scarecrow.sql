CREATE TABLE `catalog_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `config_profiles` (
	`kind` text NOT NULL,
	`id` text NOT NULL,
	`definition_id` text NOT NULL,
	`label` text NOT NULL,
	`settings` text NOT NULL,
	`models` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`kind`, `id`)
);
--> statement-breakpoint
ALTER TABLE `agents` ADD `model_profile` text;