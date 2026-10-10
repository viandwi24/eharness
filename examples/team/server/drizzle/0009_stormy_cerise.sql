CREATE TABLE `connector_flows` (
	`id` text PRIMARY KEY NOT NULL,
	`state_hash` text,
	`status` text NOT NULL,
	`expires_at` integer NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `connector_flows_state` ON `connector_flows` (`state_hash`);--> statement-breakpoint
CREATE INDEX `connector_flows_expiry` ON `connector_flows` (`expires_at`);--> statement-breakpoint
ALTER TABLE `agents` ADD `connectors` text;--> statement-breakpoint
ALTER TABLE `config_profiles` ADD `extra` text;