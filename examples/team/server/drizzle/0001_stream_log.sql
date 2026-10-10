CREATE TABLE `eh_stream_chunks` (
	`session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`idx` integer NOT NULL,
	`chunk` text NOT NULL,
	PRIMARY KEY(`session_id`, `turn_id`, `idx`)
);
--> statement-breakpoint
CREATE TABLE `eh_stream_log` (
	`session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`status` text NOT NULL,
	`length` integer DEFAULT 0 NOT NULL,
	`ttl_ms` integer NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`session_id`, `turn_id`)
);
--> statement-breakpoint
CREATE INDEX `eh_stream_log_expiry` ON `eh_stream_log` (`expires_at`);