CREATE TABLE IF NOT EXISTS `niche_requests` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int,
	`contactEmail` varchar(320),
	`requestType` enum('onboarding','new_channel') NOT NULL DEFAULT 'onboarding',
	`nicheTitle` varchar(256) NOT NULL,
	`channelName` varchar(256),
	`videoFormat` varchar(32),
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
SET @db = DATABASE();
--> statement-breakpoint
SET @fk = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = @db AND CONSTRAINT_NAME = 'niche_requests_userId_users_id_fk') = 0,
  'ALTER TABLE `niche_requests` ADD CONSTRAINT `niche_requests_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @fk;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
