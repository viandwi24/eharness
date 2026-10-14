ALTER TABLE `channel_outbox` ADD `owner` text;--> statement-breakpoint
ALTER TABLE `channel_outbox` ADD `lease_until` integer;--> statement-breakpoint
ALTER TABLE `channel_outbox` ADD `max_attempts` integer;--> statement-breakpoint
ALTER TABLE `channel_outbox` ADD `result` text;