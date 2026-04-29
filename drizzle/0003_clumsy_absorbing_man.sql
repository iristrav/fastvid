CREATE TABLE `voices` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(128) NOT NULL,
	`description` varchar(256),
	`fishAudioReferenceId` varchar(128) NOT NULL,
	`exampleAudioUrl` varchar(1024),
	`flag` varchar(8) DEFAULT '🇺🇸',
	`isActive` int NOT NULL DEFAULT 1,
	`sortOrder` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `voices_id` PRIMARY KEY(`id`)
);
