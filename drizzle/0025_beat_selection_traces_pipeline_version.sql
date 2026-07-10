SET @db = DATABASE();
--> statement-breakpoint
SET @s1 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'beat_selection_traces' AND COLUMN_NAME = 'pipelineVersion') = 0,
  'ALTER TABLE `beat_selection_traces` ADD COLUMN `pipelineVersion` varchar(64) NOT NULL DEFAULT ''visual-matching-v2'' AFTER `engineVersion`',
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
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'beat_selection_traces' AND INDEX_NAME = 'beat_selection_traces_pipelineVersion_idx') = 0,
  'CREATE INDEX `beat_selection_traces_pipelineVersion_idx` ON `beat_selection_traces` (`pipelineVersion`)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s2;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
