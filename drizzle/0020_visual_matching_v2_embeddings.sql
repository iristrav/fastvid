CREATE TABLE IF NOT EXISTS `embedding_cache` (
	`id` int AUTO_INCREMENT NOT NULL,
	`subjectId` varchar(128) NOT NULL,
	`model` varchar(128) NOT NULL,
	`embeddingVersion` varchar(32) NOT NULL,
	`embedding` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `embedding_cache_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `media_archive_asset_embeddings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`assetId` int NOT NULL,
	`model` varchar(128) NOT NULL,
	`embeddingVersion` varchar(32) NOT NULL,
	`embedding` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `media_archive_asset_embeddings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
SET @db = DATABASE();
--> statement-breakpoint
SET @s1 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'embedding_cache' AND INDEX_NAME = 'embedding_cache_subject_model_version_idx') = 0,
  'CREATE INDEX `embedding_cache_subject_model_version_idx` ON `embedding_cache` (`subjectId`,`model`,`embeddingVersion`)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s1;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s2 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'media_archive_asset_embeddings' AND INDEX_NAME = 'media_archive_asset_embeddings_asset_model_version_idx') = 0,
  'CREATE INDEX `media_archive_asset_embeddings_asset_model_version_idx` ON `media_archive_asset_embeddings` (`assetId`,`model`,`embeddingVersion`)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s2;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s3 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = @db AND CONSTRAINT_NAME = 'asset_embeddings_assetId_fk') = 0,
  'ALTER TABLE `media_archive_asset_embeddings` ADD CONSTRAINT `asset_embeddings_assetId_fk` FOREIGN KEY (`assetId`) REFERENCES `media_archive_assets`(`id`) ON DELETE no action ON UPDATE no action',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s3;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
