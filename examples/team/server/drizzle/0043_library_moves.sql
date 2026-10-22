CREATE TABLE `library_moves` (
	`id` text PRIMARY KEY NOT NULL,
	`from_path` text NOT NULL,
	`to_path` text NOT NULL,
	`kind` text NOT NULL,
	`at` integer NOT NULL,
	`restore_point_id` text,
	`note` text
);
--> statement-breakpoint
CREATE INDEX `library_moves_from` ON `library_moves` (`from_path`);--> statement-breakpoint
CREATE INDEX `library_moves_point` ON `library_moves` (`restore_point_id`);