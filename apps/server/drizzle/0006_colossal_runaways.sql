CREATE TABLE `prep_checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`unit_key` text NOT NULL,
	`input_hash` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `prep_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `prep_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`chunk_id` text NOT NULL,
	`input_hash` text NOT NULL,
	`rules_version` text NOT NULL,
	`status` text NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`reason` text,
	`budget` text NOT NULL,
	`calls_used` integer DEFAULT 0 NOT NULL,
	`tokens_used` integer DEFAULT 0 NOT NULL,
	`lease_until` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prep_checkpoints_unit_identity` ON `prep_checkpoints` (`task_id`,`unit_key`,`input_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `prep_tasks_input_identity` ON `prep_tasks` (`chunk_id`,`input_hash`,`rules_version`);