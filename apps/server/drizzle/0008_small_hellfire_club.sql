CREATE TABLE `task_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`card_version` text NOT NULL,
	`task_id` text NOT NULL,
	`user_message_id` text NOT NULL,
	`assistance` text NOT NULL,
	`observed_performance` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_attempts_identity` ON `task_attempts` (`card_version`,`task_id`,`user_message_id`);