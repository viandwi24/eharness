CREATE INDEX `events_message_agent` ON `events` (`agent_id`,`seq`) WHERE "events"."type" = 'message-added';--> statement-breakpoint
CREATE INDEX `events_assistant_agent` ON `events` (`agent_id`,`seq`) WHERE "events"."type" = 'message-added' and json_extract("events"."payload", '$.role') = 'assistant';--> statement-breakpoint
CREATE INDEX `library_history_at` ON `library_history` (`at`);--> statement-breakpoint
CREATE INDEX `routine_runs_finished` ON `routine_runs` (`finished_at`);--> statement-breakpoint
CREATE INDEX `tasks_activity` ON `tasks` (`last_activity_at`);--> statement-breakpoint
CREATE INDEX `tasks_ended` ON `tasks` (`ended_at`);