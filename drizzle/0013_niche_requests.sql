CREATE TABLE `niche_requests` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`requestType` enum('onboarding','new_channel') NOT NULL DEFAULT 'onboarding',
	`nicheTitle` varchar(256) NOT NULL,
	`channelName` varchar(256),
	`videoFormat` varchar(32) NOT NULL,
	`description` text,
	`status` enum('pending','approved','in_progress','ready','rejected') NOT NULL DEFAULT 'pending',
	`adminNotes` text,
	`linkedArchiveId` int,
	`reviewedByUserId` int,
	`reviewedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `niche_requests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `niche_requests` ADD CONSTRAINT `niche_requests_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;
