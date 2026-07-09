-- Schema sync: three mismatches found by schemaAuditor at startup.
-- Fully idempotent — handles both "table already exists" and "table missing" cases.
--
-- 1. Ensure editorial_reviews exists with correct column types.
--    If the table exists with overallScore as TINYINT UNSIGNED, widen it to INT.
--    If the table does not exist yet, create it correctly from scratch.
--
-- 2. NULL out orphaned media_archives.createdByUserId rows.
-- 3. Add missing FK on media_archives.createdByUserId → users.id.

-- ── Step 1a: create editorial_reviews if it does not exist yet ────────────────
CREATE TABLE IF NOT EXISTS `editorial_reviews` (
  `id`               INT AUTO_INCREMENT PRIMARY KEY,
  `videoId`          VARCHAR(128) NOT NULL,
  `videoTitle`       VARCHAR(512),
  `overallScore`     INT NOT NULL,
  `scores`           JSON NOT NULL,
  `sourcing`         JSON NOT NULL,
  `feedback`         JSON NOT NULL,
  `autoImprovements` JSON NOT NULL,
  `topIssues`        JSON NOT NULL,
  `createdAt`        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `editorial_reviews_videoId_idx` (`videoId`),
  INDEX `editorial_reviews_created_idx` (`createdAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
--> statement-breakpoint

-- ── Step 1b: widen overallScore from TINYINT UNSIGNED → INT if still narrow ──
SET @db = DATABASE();
--> statement-breakpoint
SET @widen = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = @db
     AND TABLE_NAME   = 'editorial_reviews'
     AND COLUMN_NAME  = 'overallScore'
     AND DATA_TYPE    = 'tinyint') > 0,
  'ALTER TABLE `editorial_reviews` MODIFY COLUMN `overallScore` INT NOT NULL',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @widen;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- ── Step 2: NULL out orphaned createdByUserId before adding FK ────────────────
UPDATE `media_archives` m
LEFT JOIN `users` u ON u.id = m.createdByUserId
SET m.createdByUserId = NULL
WHERE m.createdByUserId IS NOT NULL AND u.id IS NULL;
--> statement-breakpoint

-- ── Step 3: add missing FK on media_archives.createdByUserId → users.id ──────
SET @addFk = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS
   WHERE CONSTRAINT_SCHEMA = @db
     AND CONSTRAINT_NAME   = 'media_archives_createdByUserId_users_id_fk') = 0,
  'ALTER TABLE `media_archives` ADD CONSTRAINT `media_archives_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE NO ACTION',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @addFk;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
