CREATE TABLE `material_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`material_id` text NOT NULL,
	`order` integer NOT NULL,
	`title` text NOT NULL,
	`level` integer NOT NULL,
	`content` text NOT NULL
);
