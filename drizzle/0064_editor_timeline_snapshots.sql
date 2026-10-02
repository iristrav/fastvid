-- EDITOR — the timeline's saved versions, so a person can go back to an earlier edit.
--
-- One row per save of a video's timeline: the version number it was saved as and the document
-- itself. Only the newest versions of each video are kept (the save trims the rest).
CREATE TABLE IF NOT EXISTS `timeline_snapshots` (
  `id` int AUTO_INCREMENT NOT NULL,
  `videoId` int NOT NULL,
  `timelineVersion` int NOT NULL,
  `timeline` json NOT NULL,
  `label` varchar(128),
  `createdByUserId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `timeline_snapshots_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `timeline_snapshots_video_version_idx` ON `timeline_snapshots` (`videoId`,`timelineVersion`);
