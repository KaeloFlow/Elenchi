CREATE TABLE `learning_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`card_version` text NOT NULL,
	`task_id` text NOT NULL,
	`requirement_id` text NOT NULL,
	`user_message_id` text NOT NULL,
	`answer_quote` text NOT NULL,
	`verdict` text NOT NULL,
	`rationale` text NOT NULL,
	`assessment_version` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `learning_evidence_identity` ON `learning_evidence` (`card_version`,`requirement_id`,`user_message_id`);