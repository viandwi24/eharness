CREATE TABLE `ch_events` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`type` text NOT NULL,
	`node_id` text,
	`actor_identity_id` text,
	`target_message_native_id` text,
	`target_message_id` text,
	`at` integer NOT NULL,
	`received_at` integer NOT NULL,
	`dedupe_key` text NOT NULL,
	`stream_order` text,
	`normalizer_version` integer DEFAULT 1 NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`raw` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ch_events_dedupe` ON `ch_events` (`connection_id`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `ch_events_conn` ON `ch_events` (`connection_id`,`id`);--> statement-breakpoint
CREATE INDEX `ch_events_type` ON `ch_events` (`connection_id`,`type`,`id`);--> statement-breakpoint
CREATE INDEX `ch_events_node` ON `ch_events` (`connection_id`,`node_id`,`id`);--> statement-breakpoint
CREATE INDEX `ch_events_at` ON `ch_events` (`at`);--> statement-breakpoint
CREATE TABLE `ch_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`native_id` text NOT NULL,
	`kind` text DEFAULT 'human' NOT NULL,
	`person_id` text,
	`linked_at` integer,
	`is_self` integer DEFAULT 0 NOT NULL,
	`display_name` text,
	`username` text,
	`avatar` text,
	`meta` text DEFAULT '{}' NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`dm_first_at` integer,
	`dm_last_at` integer,
	`dm_count` integer DEFAULT 0 NOT NULL,
	`ignored` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ch_identities_native` ON `ch_identities` (`connection_id`,`native_id`);--> statement-breakpoint
CREATE INDEX `ch_identities_person` ON `ch_identities` (`connection_id`,`person_id`);--> statement-breakpoint
CREATE TABLE `ch_identity_aliases` (
	`identity_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`identity_id`, `kind`, `value`)
);
--> statement-breakpoint
CREATE INDEX `ch_identity_aliases_value` ON `ch_identity_aliases` (`connection_id`,`kind`,`value`);--> statement-breakpoint
CREATE TABLE `ch_identity_profiles` (
	`identity_id` text NOT NULL,
	`scope_node_id` text NOT NULL,
	`nick` text,
	`avatar` text,
	`roles` text DEFAULT '[]' NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	PRIMARY KEY(`identity_id`, `scope_node_id`)
);
--> statement-breakpoint
CREATE TABLE `ch_memberships` (
	`node_id` text NOT NULL,
	`identity_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`joined_at` integer,
	`left_at` integer,
	PRIMARY KEY(`node_id`, `identity_id`)
);
--> statement-breakpoint
CREATE TABLE `ch_message_revisions` (
	`message_id` text NOT NULL,
	`version` integer NOT NULL,
	`content` text NOT NULL,
	`edited_at` integer NOT NULL,
	`editor_identity_id` text,
	PRIMARY KEY(`message_id`, `version`)
);
--> statement-breakpoint
CREATE TABLE `ch_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`node_id` text NOT NULL,
	`native_id` text NOT NULL,
	`sender_identity_id` text,
	`sent_at` integer NOT NULL,
	`sort_key` text DEFAULT '' NOT NULL,
	`direction` text DEFAULT 'in' NOT NULL,
	`kind` text DEFAULT 'message' NOT NULL,
	`content` text,
	`content_version` integer DEFAULT 0 NOT NULL,
	`reply_to_native_id` text,
	`reply_to_message_id` text,
	`thread_root_native_id` text,
	`edited_at` integer,
	`deleted_at` integer,
	`deleted_by` text,
	`deleted_has_content` integer DEFAULT 0 NOT NULL,
	`send_txn_id` text,
	`disposition` text,
	`pending` integer DEFAULT 0 NOT NULL,
	`handled` integer DEFAULT 0 NOT NULL,
	`rev` integer DEFAULT 0 NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ch_messages_native` ON `ch_messages` (`node_id`,`native_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ch_messages_txn` ON `ch_messages` (`node_id`,`send_txn_id`) WHERE "ch_messages"."send_txn_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `ch_messages_rev` ON `ch_messages` (`connection_id`,`rev`);--> statement-breakpoint
CREATE INDEX `ch_messages_node` ON `ch_messages` (`node_id`,`id`);--> statement-breakpoint
CREATE INDEX `ch_messages_native_any` ON `ch_messages` (`connection_id`,`native_id`);--> statement-breakpoint
CREATE INDEX `ch_messages_sent` ON `ch_messages` (`sent_at`);--> statement-breakpoint
CREATE TABLE `ch_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ch_node_access` (
	`node_id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`member` text DEFAULT 'unknown' NOT NULL,
	`can_post` integer,
	`can_read` integer,
	`muted` integer DEFAULT 0 NOT NULL,
	`last_read_native_id` text,
	`history` text DEFAULT '{}' NOT NULL,
	`extra` text DEFAULT '{}' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ch_node_links` (
	`from_node_id` text NOT NULL,
	`to_node_id` text NOT NULL,
	`rel` text NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	PRIMARY KEY(`from_node_id`, `to_node_id`, `rel`)
);
--> statement-breakpoint
CREATE INDEX `ch_node_links_to` ON `ch_node_links` (`to_node_id`,`rel`);--> statement-breakpoint
CREATE TABLE `ch_node_sessions` (
	`connection_id` text NOT NULL,
	`node_id` text NOT NULL,
	`session_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`label` text,
	`created_at` integer NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`last_node_id` text,
	PRIMARY KEY(`connection_id`, `node_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ch_node_sessions_session` ON `ch_node_sessions` (`session_id`);--> statement-breakpoint
CREATE TABLE `ch_node_settings` (
	`node_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`node_id`, `key`)
);
--> statement-breakpoint
CREATE TABLE `ch_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`native_id` text NOT NULL,
	`parent_id` text,
	`path` text NOT NULL,
	`kind` text NOT NULL,
	`traits` text NOT NULL,
	`platform_type` text DEFAULT '' NOT NULL,
	`origin_message_native_id` text,
	`title` text,
	`state` text DEFAULT 'active' NOT NULL,
	`state_reason` text,
	`meta` text DEFAULT '{}' NOT NULL,
	`meta_version` integer DEFAULT 0 NOT NULL,
	`legacy_ref_id` text,
	`first_seen_at` integer NOT NULL,
	`last_event_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ch_nodes_native` ON `ch_nodes` (`connection_id`,`native_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ch_nodes_legacy` ON `ch_nodes` (`connection_id`,`legacy_ref_id`);--> statement-breakpoint
CREATE INDEX `ch_nodes_parent` ON `ch_nodes` (`parent_id`);--> statement-breakpoint
CREATE INDEX `ch_nodes_path` ON `ch_nodes` (`connection_id`,`path`);--> statement-breakpoint
CREATE TABLE `ch_reactions` (
	`message_id` text NOT NULL,
	`identity_id` text NOT NULL,
	`emoji_id` text NOT NULL,
	`emoji` text NOT NULL,
	`at` integer NOT NULL,
	`removed_at` integer,
	PRIMARY KEY(`message_id`, `identity_id`, `emoji_id`)
);
