CREATE TABLE `agent_persona_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`base_version` integer NOT NULL,
	`identity` text NOT NULL,
	`voice` text NOT NULL,
	`reason` text NOT NULL,
	`request` text,
	`diff` text NOT NULL,
	`source` text NOT NULL,
	`proposer_name` text,
	`proposer_role` text,
	`proposer_ref` text,
	`session_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`applied_version` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_persona_proposals_agent` ON `agent_persona_proposals` (`agent_id`,`status`);--> statement-breakpoint
CREATE TABLE `agent_persona_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`version` integer NOT NULL,
	`identity` text NOT NULL,
	`voice` text NOT NULL,
	`operating_rules` text NOT NULL,
	`source` text NOT NULL,
	`author_name` text,
	`author_role` text,
	`author_ref` text,
	`reason` text,
	`diff` text DEFAULT '' NOT NULL,
	`revert_of` integer,
	`proposal_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_persona_versions_agent` ON `agent_persona_versions` (`agent_id`,`version`);--> statement-breakpoint
CREATE TABLE `ch_people_notes` (
	`identity_id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`note` text NOT NULL,
	`set_by` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ch_people_notes_connection` ON `ch_people_notes` (`connection_id`);