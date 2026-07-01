CREATE TABLE `beat_selection_traces` (
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
CREATE INDEX `beat_selection_traces_beatId_idx` ON `beat_selection_traces` (`beatId`);
--> statement-breakpoint
CREATE INDEX `beat_selection_traces_startedAt_idx` ON `beat_selection_traces` (`startedAt`);
