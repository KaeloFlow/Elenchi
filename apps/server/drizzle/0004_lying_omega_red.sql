CREATE TABLE `session_pedagogy_state` (
	`session_id` text PRIMARY KEY NOT NULL,
	`hint_level` integer DEFAULT 0 NOT NULL,
	`stuck_counter` integer DEFAULT 0 NOT NULL,
	`consecutive_no_coverage` integer DEFAULT 0 NOT NULL,
	`turns_on_focus` integer DEFAULT 0 NOT NULL,
	`current_focus` text,
	`misconceptions` text DEFAULT '[]' NOT NULL,
	`covered_points` text DEFAULT '[]' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`user_message_id` text NOT NULL,
	`assistant_message_id` text NOT NULL,
	`assessment` text NOT NULL,
	`action` text NOT NULL,
	`created_at` integer NOT NULL
);
