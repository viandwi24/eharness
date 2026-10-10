CREATE TABLE `model_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`kind` text NOT NULL,
	`agent_id` text,
	`session_id` text,
	`turn_id` text,
	`step_index` integer,
	`message_id` text,
	`task_id` text,
	`provider` text NOT NULL,
	`model_id` text NOT NULL,
	`status` text NOT NULL,
	`finish_reason` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`reasoning_tokens` integer,
	`cached_tokens` integer,
	`cost_usd` real,
	`started_at` integer NOT NULL,
	`first_chunk_ms` integer,
	`duration_ms` integer NOT NULL,
	`error_name` text,
	`error_message` text,
	`request_options` text,
	`request_body` text,
	`response` text,
	`output` text,
	`provider_metadata` text,
	`usage_raw` text,
	`truncated` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `model_calls_started` ON `model_calls` (`started_at`,`id`);--> statement-breakpoint
CREATE INDEX `model_calls_agent` ON `model_calls` (`agent_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `model_calls_session` ON `model_calls` (`session_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `model_calls_created` ON `model_calls` (`created_at`);