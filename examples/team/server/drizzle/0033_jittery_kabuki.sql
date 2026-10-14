ALTER TABLE `routines` ADD `sched_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `routines` ADD `claimed_by` text;--> statement-breakpoint
ALTER TABLE `routines` ADD `claimed_until` integer;--> statement-breakpoint
ALTER TABLE `routines` ADD `sched_payload` text;