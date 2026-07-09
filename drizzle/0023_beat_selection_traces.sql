CREATE TABLE IF NOT EXISTS `beat_selection_traces` (
  `id` int AUTO_INCREMENT NOT NULL,
  `beatId` varchar(256) NOT NULL,
  `selectedCandidateId` varchar(256),
  `needsResearch` int NOT NULL DEFAULT 0,
  `researchReason` varchar(64),
  `confidenceTier` varchar(32),
  `confidence` varchar(32),
  `overallScore` int,
  `candidateCount` int NOT NULL,
  `durationMs` int NOT NULL,
  `tieBreakApplied` int NOT NULL DEFAULT 0,
  `traceVersion` varchar(32) NOT NULL,
  `selectorVersion` varchar(32) NOT NULL,
  `visionVersion` varchar(32) NOT NULL,
  `rankingVersion` varchar(32) NOT NULL,
  `promptVersion` varchar(64) NOT NULL,
  `contentType` varchar(64) NOT NULL,
  `payload` longtext NOT NULL,
  `startedAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `beat_selection_traces_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
SET @db = DATABASE();
--> statement-breakpoint
SET @s1 = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'beat_selection_traces' AND INDEX_NAME = 'beat_selection_traces_beatId_idx') = 0,
  'CREATE INDEX `beat_selection_traces_beatId_idx` ON `beat_selection_traces` (`beatId`)',
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
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'beat_selection_traces' AND INDEX_NAME = 'beat_selection_traces_startedAt_idx') = 0,
  'CREATE INDEX `beat_selection_traces_startedAt_idx` ON `beat_selection_traces` (`startedAt`)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE stmt FROM @s2;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
