CREATE TABLE `videos` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`title` varchar(512),
	`prompt` text NOT NULL,
	`videoLength` varchar(16) NOT NULL,
	`status` enum('pending','generating_script','generating_voiceover','generating_visuals','generating_effects','completed','failed') NOT NULL DEFAULT 'pending',
	`script` text,
	`voiceoverUrl` varchar(1024),
	`videoUrl` varchar(1024),
	`thumbnailUrl` varchar(1024),
	`metadata` json,
	`errorMessage` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `videos_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `subscriptionStatus` enum('active','inactive','cancelled') DEFAULT 'inactive' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `subscriptionStartDate` timestamp;--> statement-breakpoint
ALTER TABLE `users` ADD `subscriptionEndDate` timestamp;--> statement-breakpoint
ALTER TABLE `users` ADD `stripeCustomerId` varchar(128);--> statement-breakpoint
ALTER TABLE `users` ADD `stripeSubscriptionId` varchar(128);--> statement-breakpoint
ALTER TABLE `videos` ADD CONSTRAINT `videos_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;