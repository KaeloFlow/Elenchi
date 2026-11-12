CREATE TABLE `flashcards` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`question` text NOT NULL,
	`options` text,
	`answer` text NOT NULL,
	`explanation` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `materials` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`source_path` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`material_id` text NOT NULL,
	`started_at` integer NOT NULL
);
