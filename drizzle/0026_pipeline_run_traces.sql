CREATE TABLE `pipeline_run_traces` (
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
ALTER TABLE `pipeline_run_traces` ADD UNIQUE INDEX `pipeline_run_traces_pipelineRunId_unique` (`pipelineRunId`);
--> statement-breakpoint
CREATE INDEX `pipeline_run_traces_videoId_idx` ON `pipeline_run_traces` (`videoId`);
--> statement-breakpoint
CREATE INDEX `pipeline_run_traces_pipelineVersion_idx` ON `pipeline_run_traces` (`pipelineVersion`);
--> statement-breakpoint
CREATE INDEX `pipeline_run_traces_startedAt_idx` ON `pipeline_run_traces` (`startedAt`);
