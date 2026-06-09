CREATE TABLE `media_archives` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(256) NOT NULL,
	`slug` varchar(128) NOT NULL,
	`description` text,
	`nicheTags` json,
	`createdByUserId` int,
	`isActive` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `media_archives_id` PRIMARY KEY(`id`),
	CONSTRAINT `media_archives_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `media_archive_assets` (
	`id` int AUTO_INCREMENT NOT NULL,
	`archiveId` int NOT NULL,
	`title` varchar(512),
	`mediaType` enum('video','image') NOT NULL,
	`mixKind` enum('real_video','photo','stock','screenshot','motion_graphics') NOT NULL DEFAULT 'photo',
	`mimeType` varchar(128) NOT NULL,
	`storageUrl` varchar(1024) NOT NULL,
	`storageKey` varchar(512),
	`tags` json,
	`sourceNote` varchar(512),
	`licenseNote` varchar(256),
	`width` int,
	`height` int,
	`durationSec` int,
	`sortOrder` int NOT NULL DEFAULT 0,
	`isActive` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `media_archive_assets_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `media_archive_assets` ADD CONSTRAINT `media_archive_assets_archiveId_media_archives_id_fk` FOREIGN KEY (`archiveId`) REFERENCES `media_archives`(`id`) ON DELETE cascade ON UPDATE no action;
