CREATE TABLE `misconception_records` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`material_id` text NOT NULL,
	`label` text NOT NULL,
	`kp_id` text,
	`status` text NOT NULL,
	`evidence_message_ids` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `misconception_records_identity` ON `misconception_records` (`session_id`,`label`,`kp_id`);