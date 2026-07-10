CREATE TABLE IF NOT EXISTS `selection_feedback` (
  `id` int AUTO_INCREMENT NOT NULL,
  `pipelineRunId` varchar(64) NOT NULL,
  `beatId` varchar(256) NOT NULL,
  `candidateId` varchar(256) NOT NULL,
  `feedbackType` enum('correct','wrong','acceptable','preferred_candidate','duplicate','bad_crop','wrong_time_period','wrong_location','wrong_subject','low_quality','not_relevant','other') NOT NULL,
  `comment` text,
  `createdBy` varchar(320) NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `selection_feedback_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `selection_feedback_events` (
  `id` int AUTO_INCREMENT NOT NULL,
  `feedbackId` int NOT NULL,
  `eventType` enum('created','updated','deleted') NOT NULL,
  `snapshot` longtext NOT NULL,
  `changedBy` varchar(320) NOT NULL,
  `changedAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `selection_feedback_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
SET @db = DATABASE();
--> statement-breakpoint
SET @fk = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = @db AND CONSTRAINT_NAME = 'selection_feedback_events_feedbackId_fk') = 0,
  'ALTER TABLE `selection_feedback_events` ADD CONSTRAINT `selection_feedback_events_feedbackId_fk` FOREIGN KEY (`feedbackId`) REFERENCES `selection_feedback`(`id`)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @fk;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s1 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'selection_feedback' AND INDEX_NAME = 'selection_feedback_pipelineRunId_idx') = 0,
  'CREATE INDEX `selection_feedback_pipelineRunId_idx` ON `selection_feedback` (`pipelineRunId`)',
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
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'selection_feedback' AND INDEX_NAME = 'selection_feedback_beatId_idx') = 0,
  'CREATE INDEX `selection_feedback_beatId_idx` ON `selection_feedback` (`beatId`)',
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
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'selection_feedback' AND INDEX_NAME = 'selection_feedback_feedbackType_idx') = 0,
  'CREATE INDEX `selection_feedback_feedbackType_idx` ON `selection_feedback` (`feedbackType`)',
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
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'selection_feedback_events' AND INDEX_NAME = 'selection_feedback_events_feedbackId_idx') = 0,
  'CREATE INDEX `selection_feedback_events_feedbackId_idx` ON `selection_feedback_events` (`feedbackId`)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s4;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
