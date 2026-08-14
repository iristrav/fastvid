-- F3-26: web-wide visual sourcing + self-learning archive.
-- Adds structured web-sourcing provenance columns to media_archive_assets (additive only —
-- sourceNote/licenseNote and every existing column/row are untouched) and a new
-- visual_search_memory table that remembers which (entity, query, source) combinations
-- previously found usable footage. Idempotent via INFORMATION_SCHEMA guards, matching the
-- 0031/0040/0041 pattern (drizzle-kit's auto-diff has been unreliable in this repo's history).
SET @db = DATABASE();

--> statement-breakpoint
SET @s1 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'media_archive_assets' AND COLUMN_NAME = 'sourceUrl') = 0,
  'ALTER TABLE `media_archive_assets` ADD COLUMN `sourceUrl` text',
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
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'media_archive_assets' AND COLUMN_NAME = 'sourceUrlHash') = 0,
  'ALTER TABLE `media_archive_assets` ADD COLUMN `sourceUrlHash` varchar(64)',
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
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'media_archive_assets' AND COLUMN_NAME = 'sourcePlatform') = 0,
  'ALTER TABLE `media_archive_assets` ADD COLUMN `sourcePlatform` varchar(64)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s3;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;

--> statement-breakpoint
SET @s4 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'media_archive_assets' AND COLUMN_NAME = 'sourceCreator') = 0,
  'ALTER TABLE `media_archive_assets` ADD COLUMN `sourceCreator` varchar(256)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s4;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;

--> statement-breakpoint
SET @s5 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'media_archive_assets' AND COLUMN_NAME = 'licenseUrl') = 0,
  'ALTER TABLE `media_archive_assets` ADD COLUMN `licenseUrl` varchar(512)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s5;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;

--> statement-breakpoint
SET @s6 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'media_archive_assets' AND COLUMN_NAME = 'downloadedAt') = 0,
  'ALTER TABLE `media_archive_assets` ADD COLUMN `downloadedAt` timestamp',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s6;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;

--> statement-breakpoint
SET @s7 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'media_archive_assets' AND COLUMN_NAME = 'originalQuery') = 0,
  'ALTER TABLE `media_archive_assets` ADD COLUMN `originalQuery` varchar(512)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s7;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;

--> statement-breakpoint
SET @s8 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'media_archive_assets' AND COLUMN_NAME = 'matchedQuery') = 0,
  'ALTER TABLE `media_archive_assets` ADD COLUMN `matchedQuery` varchar(512)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s8;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;

--> statement-breakpoint
SET @s9 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'media_archive_assets' AND COLUMN_NAME = 'entities') = 0,
  'ALTER TABLE `media_archive_assets` ADD COLUMN `entities` json',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s9;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;

--> statement-breakpoint
SET @s10 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'media_archive_assets' AND COLUMN_NAME = 'topics') = 0,
  'ALTER TABLE `media_archive_assets` ADD COLUMN `topics` json',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s10;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;

--> statement-breakpoint
SET @s11 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'media_archive_assets' AND INDEX_NAME = 'media_archive_assets_sourceUrlHash_idx') = 0,
  'CREATE INDEX `media_archive_assets_sourceUrlHash_idx` ON `media_archive_assets` (`sourceUrlHash`)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s11;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `visual_search_memory` (
	`id` int AUTO_INCREMENT NOT NULL,
	`entity` varchar(256) NOT NULL,
	`entityType` varchar(32) NOT NULL,
	`topic` varchar(256),
	`query` varchar(512) NOT NULL,
	`source` varchar(64) NOT NULL,
	`sourceUrl` text,
	`assetId` int,
	`success` int NOT NULL DEFAULT 1,
	`qualityScore` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`lastUsedAt` timestamp NOT NULL DEFAULT (now()),
	`usageCount` int NOT NULL DEFAULT 1,
	`dedupeKeyHash` varchar(64) NOT NULL,
	CONSTRAINT `visual_search_memory_id` PRIMARY KEY(`id`),
	CONSTRAINT `visual_search_memory_dedupeKeyHash_unique` UNIQUE(`dedupeKeyHash`)
);

--> statement-breakpoint
SET @s12 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'visual_search_memory' AND INDEX_NAME = 'visual_search_memory_entity_idx') = 0,
  'CREATE INDEX `visual_search_memory_entity_idx` ON `visual_search_memory` (`entity`)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s12;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
