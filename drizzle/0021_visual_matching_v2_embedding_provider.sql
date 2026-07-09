SET @db = DATABASE();
--> statement-breakpoint
SET @s1 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'embedding_cache' AND COLUMN_NAME = 'provider') = 0,
  'ALTER TABLE `embedding_cache` ADD `provider` varchar(64) NOT NULL DEFAULT ''voyage''',
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
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'media_archive_asset_embeddings' AND COLUMN_NAME = 'provider') = 0,
  'ALTER TABLE `media_archive_asset_embeddings` ADD `provider` varchar(64) NOT NULL DEFAULT ''voyage''',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s2;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
