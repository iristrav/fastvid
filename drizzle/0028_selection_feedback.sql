CREATE TABLE `selection_feedback` (
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
CREATE TABLE `selection_feedback_events` (
  `id` int AUTO_INCREMENT NOT NULL,
  `feedbackId` int NOT NULL,
  `eventType` enum('created','updated','deleted') NOT NULL,
  `snapshot` longtext NOT NULL,
  `changedBy` varchar(320) NOT NULL,
  `changedAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `selection_feedback_events_id` PRIMARY KEY(`id`),
  CONSTRAINT `selection_feedback_events_feedbackId_fk`
    FOREIGN KEY (`feedbackId`) REFERENCES `selection_feedback`(`id`)
);
--> statement-breakpoint
CREATE INDEX `selection_feedback_pipelineRunId_idx` ON `selection_feedback` (`pipelineRunId`);
--> statement-breakpoint
CREATE INDEX `selection_feedback_beatId_idx` ON `selection_feedback` (`beatId`);
--> statement-breakpoint
CREATE INDEX `selection_feedback_feedbackType_idx` ON `selection_feedback` (`feedbackType`);
--> statement-breakpoint
CREATE INDEX `selection_feedback_events_feedbackId_idx` ON `selection_feedback_events` (`feedbackId`);
