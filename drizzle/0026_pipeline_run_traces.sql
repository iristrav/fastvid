CREATE TABLE IF NOT EXISTS `pipeline_run_traces` (
  `id` int AUTO_INCREMENT NOT NULL,
  `pipelineRunId` varchar(64) NOT NULL,
  `videoId` varchar(256) NOT NULL,
  `pipelineVersion` varchar(64) NOT NULL,
  `beatsProcessed` int NOT NULL,
  `beatsSelected` int NOT NULL,
  `beatsResearchRequired` int NOT NULL,
  `totalDurationMs` int NOT NULL,
  `videoContextMs` int NOT NULL,
  `visualIntentMs` int NOT NULL,
  `retrievalTotalMs` int NOT NULL,
  `clipTotalMs` int NOT NULL,
  `rankingTotalMs` int NOT NULL,
  `visionTotalMs` int NOT NULL,
  `selectionTotalMs` int NOT NULL,
  `startedAt` timestamp NOT NULL,
  `completedAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `pipeline_run_traces_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
SET @db = DATABASE();
--> statement-breakpoint
SET @s1 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'pipeline_run_traces' AND INDEX_NAME = 'pipeline_run_traces_pipelineRunId_unique') = 0,
  'ALTER TABLE `pipeline_run_traces` ADD UNIQUE INDEX `pipeline_run_traces_pipelineRunId_unique` (`pipelineRunId`)',
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
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'pipeline_run_traces' AND INDEX_NAME = 'pipeline_run_traces_videoId_idx') = 0,
  'CREATE INDEX `pipeline_run_traces_videoId_idx` ON `pipeline_run_traces` (`videoId`)',
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
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'pipeline_run_traces' AND INDEX_NAME = 'pipeline_run_traces_pipelineVersion_idx') = 0,
  'CREATE INDEX `pipeline_run_traces_pipelineVersion_idx` ON `pipeline_run_traces` (`pipelineVersion`)',
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
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'pipeline_run_traces' AND INDEX_NAME = 'pipeline_run_traces_startedAt_idx') = 0,
  'CREATE INDEX `pipeline_run_traces_startedAt_idx` ON `pipeline_run_traces` (`startedAt`)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s4;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
