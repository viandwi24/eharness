CREATE TABLE `browser_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`adapter` text NOT NULL,
	`mode` text NOT NULL,
	`settings_json` text NOT NULL,
	`allow_domains` text DEFAULT '[]' NOT NULL,
	`trusted` integer DEFAULT 0 NOT NULL,
	`metadata_json` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `browser_profiles_created` ON `browser_profiles` (`created_at`);