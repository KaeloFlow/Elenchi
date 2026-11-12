CREATE TABLE `chunk_prep` (
	`chunk_id` text PRIMARY KEY NOT NULL,
	`material_id` text NOT NULL,
	`status` text NOT NULL,
	`kp_count` integer NOT NULL,
	`lesson_count` integer NOT NULL,
	`partial_sections` integer DEFAULT 0 NOT NULL,
	`auto_packed_lessons` integer DEFAULT 0 NOT NULL,
	`error` text,
	`prepared_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `knowledge_points` (
	`id` text PRIMARY KEY NOT NULL,
	`material_id` text NOT NULL,
	`chunk_id` text NOT NULL,
	`order` integer NOT NULL,
	`statement` text NOT NULL,
	`type` text NOT NULL,
	`section_index` integer NOT NULL,
	`section_title` text NOT NULL,
	`evidence` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `lessons` (
	`id` text PRIMARY KEY NOT NULL,
	`material_id` text NOT NULL,
	`chunk_id` text NOT NULL,
	`order` integer NOT NULL,
	`title` text NOT NULL,
	`objective` text NOT NULL,
	`kp_ids` text NOT NULL,
	`carry_out_summary` text,
	`auto_packed` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`completed_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `material_progress` (
	`material_id` text PRIMARY KEY NOT NULL,
	`mastered_kp_ids` text DEFAULT '[]' NOT NULL,
	`open_misconceptions` text DEFAULT '[]' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `sessions` ADD `lesson_id` text;