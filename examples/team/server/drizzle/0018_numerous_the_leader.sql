ALTER TABLE `programs` ADD `deliverables` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `deliverables` text;