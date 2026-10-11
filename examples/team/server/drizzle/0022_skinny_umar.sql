CREATE TABLE `channel_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`session_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`item_id` text NOT NULL,
	`item_kind` text NOT NULL,
	`tool_name` text NOT NULL,
	`trigger_id` text,
	`requester_peer` text,
	`requester_member` text,
	`status` text DEFAULT 'open' NOT NULL,
	`answered_by` text,
	`outcome` text,
	`message_id` text,
	`consumed` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`answered_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_approvals_item` ON `channel_approvals` (`session_id`,`item_id`);--> statement-breakpoint
CREATE INDEX `channel_approvals_session` ON `channel_approvals` (`session_id`,`status`);--> statement-breakpoint
CREATE TABLE `channel_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`session_id` text,
	`kind` text NOT NULL,
	`trigger_id` text,
	`chunk_index` integer DEFAULT 0 NOT NULL,
	`chunk_count` integer DEFAULT 1 NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_at` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`platform_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`sent_at` integer
);
--> statement-breakpoint
CREATE INDEX `channel_outbox_due` ON `channel_outbox` (`connection_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `channel_outbox_trigger` ON `channel_outbox` (`connection_id`,`conversation_id`,`kind`,`trigger_id`);--> statement-breakpoint
ALTER TABLE `channel_conversations` ADD `generation` integer DEFAULT 0 NOT NULL;