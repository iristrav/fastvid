SET @db = DATABASE();
--> statement-breakpoint
SET @s1 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'beat_selection_traces' AND COLUMN_NAME = 'traceId') = 0,
  'ALTER TABLE `beat_selection_traces` ADD COLUMN `traceId` varchar(64) NOT NULL DEFAULT '''' AFTER `id`',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s1; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s2 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'beat_selection_traces' AND COLUMN_NAME = 'videoId') = 0,
  'ALTER TABLE `beat_selection_traces` ADD COLUMN `videoId` varchar(256) AFTER `beatId`',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s2; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s3 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'beat_selection_traces' AND COLUMN_NAME = 'winnerSource') = 0,
  'ALTER TABLE `beat_selection_traces` ADD COLUMN `winnerSource` varchar(64) AFTER `overallScore`',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s3; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s4 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'beat_selection_traces' AND COLUMN_NAME = 'schemaVersion') = 0,
  'ALTER TABLE `beat_selection_traces` ADD COLUMN `schemaVersion` varchar(16) NOT NULL DEFAULT ''1.0'' AFTER `promptVersion`',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s4; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s5 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'beat_selection_traces' AND COLUMN_NAME = 'engineVersion') = 0,
  'ALTER TABLE `beat_selection_traces` ADD COLUMN `engineVersion` varchar(32) NOT NULL DEFAULT ''v2'' AFTER `schemaVersion`',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s5; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s6 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'beat_selection_traces' AND COLUMN_NAME = 'host') = 0,
  'ALTER TABLE `beat_selection_traces` ADD COLUMN `host` varchar(256) NOT NULL DEFAULT '''' AFTER `engineVersion`',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s6; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s7 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'beat_selection_traces' AND COLUMN_NAME = 'workerId') = 0,
  'ALTER TABLE `beat_selection_traces` ADD COLUMN `workerId` varchar(128) NOT NULL DEFAULT '''' AFTER `host`',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s7; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s8 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'beat_selection_traces' AND COLUMN_NAME = 'traceHash') = 0,
  'ALTER TABLE `beat_selection_traces` ADD COLUMN `traceHash` varchar(64) NOT NULL DEFAULT '''' AFTER `workerId`',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s8; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s9 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'beat_selection_traces' AND INDEX_NAME = 'beat_selection_traces_traceId_unique') = 0,
  'ALTER TABLE `beat_selection_traces` ADD UNIQUE INDEX `beat_selection_traces_traceId_unique` (`traceId`)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s9; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s10 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'beat_selection_traces' AND INDEX_NAME = 'beat_selection_traces_videoId_idx') = 0,
  'CREATE INDEX `beat_selection_traces_videoId_idx` ON `beat_selection_traces` (`videoId`)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s10; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s11 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'beat_selection_traces' AND INDEX_NAME = 'beat_selection_traces_winnerSource_idx') = 0,
  'CREATE INDEX `beat_selection_traces_winnerSource_idx` ON `beat_selection_traces` (`winnerSource`)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s11; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @s12 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'beat_selection_traces' AND INDEX_NAME = 'beat_selection_traces_confidenceTier_idx') = 0,
  'CREATE INDEX `beat_selection_traces_confidenceTier_idx` ON `beat_selection_traces` (`confidenceTier`)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s12; EXECUTE stmt; DEALLOCATE PREPARE stmt;
