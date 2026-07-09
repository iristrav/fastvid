-- Clip annotation & editorial score for media_archive_assets.
-- MySQL 8.0 does not support ADD COLUMN IF NOT EXISTS, so we use INFORMATION_SCHEMA checks.
-- statement-breakpoint markers are REQUIRED so Drizzle executes each statement separately.
SET @db = DATABASE();
--> statement-breakpoint
SET @addAnnotationJson = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'media_archive_assets' AND COLUMN_NAME = 'annotationJson') = 0,
  'ALTER TABLE `media_archive_assets` ADD COLUMN `annotationJson` JSON',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @addAnnotationJson; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @addEditorialScore = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'media_archive_assets' AND COLUMN_NAME = 'editorialScore') = 0,
  'ALTER TABLE `media_archive_assets` ADD COLUMN `editorialScore` INT',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @addEditorialScore; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @addAnnotationVersion = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'media_archive_assets' AND COLUMN_NAME = 'annotationVersion') = 0,
  'ALTER TABLE `media_archive_assets` ADD COLUMN `annotationVersion` VARCHAR(16)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @addAnnotationVersion; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @addEditorialIdx = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'media_archive_assets' AND INDEX_NAME = 'media_archive_assets_editorial_idx') = 0,
  'CREATE INDEX `media_archive_assets_editorial_idx` ON `media_archive_assets` (`isActive`, `editorialScore`)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @addEditorialIdx; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @addBackfillIdx = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'media_archive_assets' AND INDEX_NAME = 'media_archive_assets_annotation_backfill_idx') = 0,
  'CREATE INDEX `media_archive_assets_annotation_backfill_idx` ON `media_archive_assets` (`isActive`, `annotationVersion`, `id`)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @addBackfillIdx; EXECUTE stmt; DEALLOCATE PREPARE stmt;
