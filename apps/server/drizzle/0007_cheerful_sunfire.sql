CREATE TABLE `lesson_card_versions` (
	`version` text PRIMARY KEY NOT NULL,
	`lesson_id` text NOT NULL,
	`task_id` text NOT NULL,
	`source_hash` text NOT NULL,
	`learner_version` text NOT NULL,
	`rules_version` text NOT NULL,
	`payload` text NOT NULL,
	`published_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `sessions` ADD `card_version` text;