CREATE TABLE `embedding_cache` (
	`id` int AUTO_INCREMENT NOT NULL,
	`subjectId` varchar(128) NOT NULL,
	`model` varchar(128) NOT NULL,
	`embeddingVersion` varchar(32) NOT NULL,
	`embedding` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `embedding_cache_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `media_archive_asset_embeddings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`assetId` int NOT NULL,
	`model` varchar(128) NOT NULL,
	`embeddingVersion` varchar(32) NOT NULL,
	`embedding` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `media_archive_asset_embeddings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `embedding_cache_subject_model_version_idx` ON `embedding_cache` (`subjectId`,`model`,`embeddingVersion`);
--> statement-breakpoint
CREATE INDEX `media_archive_asset_embeddings_asset_model_version_idx` ON `media_archive_asset_embeddings` (`assetId`,`model`,`embeddingVersion`);
--> statement-breakpoint
ALTER TABLE `media_archive_asset_embeddings` ADD CONSTRAINT `media_archive_asset_embeddings_assetId_media_archive_assets_id_fk` FOREIGN KEY (`assetId`) REFERENCES `media_archive_assets`(`id`) ON DELETE no action ON UPDATE no action;
