SET @db = DATABASE();
--> statement-breakpoint
-- Add updatedAt
SET @s1 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'selection_feedback' AND COLUMN_NAME = 'updatedAt') = 0,
  'ALTER TABLE `selection_feedback` ADD COLUMN `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP AFTER `createdAt`',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s1; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s2 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'selection_feedback' AND COLUMN_NAME = 'pipelineVersion') = 0,
  'ALTER TABLE `selection_feedback` ADD COLUMN `pipelineVersion` varchar(64) AFTER `updatedAt`',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s2; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s3 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'selection_feedback' AND COLUMN_NAME = 'engineVersion') = 0,
  'ALTER TABLE `selection_feedback` ADD COLUMN `engineVersion` varchar(32) AFTER `pipelineVersion`',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s3; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s4 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'selection_feedback' AND COLUMN_NAME = 'visionModel') = 0,
  'ALTER TABLE `selection_feedback` ADD COLUMN `visionModel` varchar(128) AFTER `engineVersion`',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s4; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s5 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'selection_feedback' AND COLUMN_NAME = 'embeddingModel') = 0,
  'ALTER TABLE `selection_feedback` ADD COLUMN `embeddingModel` varchar(128) AFTER `visionModel`',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s5; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s6 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'selection_feedback' AND COLUMN_NAME = 'rankingConfigVersion') = 0,
  'ALTER TABLE `selection_feedback` ADD COLUMN `rankingConfigVersion` varchar(32) AFTER `embeddingModel`',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s6; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
-- Rename changedBy → actor (only if changedBy still exists)
SET @s7 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'selection_feedback_events' AND COLUMN_NAME = 'changedBy') > 0,
  'ALTER TABLE `selection_feedback_events` CHANGE COLUMN `changedBy` `actor` varchar(320) NOT NULL',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s7; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
-- Widen eventType enum to include 'restored' — MODIFY is safe to repeat with same value
ALTER TABLE `selection_feedback_events`
  MODIFY COLUMN `eventType` enum('created','updated','deleted','restored') NOT NULL;
