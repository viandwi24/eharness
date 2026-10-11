ALTER TABLE `programs` ADD `worker` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `brief` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `inputs` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `priority` text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `due_at` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `created_by` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `accepted_at` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `round` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `history` text DEFAULT '[]' NOT NULL;