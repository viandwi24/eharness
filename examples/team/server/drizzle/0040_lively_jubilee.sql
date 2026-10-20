ALTER TABLE `agents` ADD `context_window` integer;--> statement-breakpoint
ALTER TABLE `agents` ADD `compact_at_percent` integer DEFAULT 80 NOT NULL;