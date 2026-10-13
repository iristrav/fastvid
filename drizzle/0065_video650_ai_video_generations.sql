-- VIDEO 650 (pre-deploy) — one AI-video spend ledger per video, kept by the database.
--
-- The Replicate p-video-2 rung may send at most N requests, S seconds and $C per video. The ledger
-- belongs to the video, not to a process: a requeue, a stale-job recovery and a second worker
-- replica all find the same row. A request is claimed through a conditional UPDATE that succeeds
-- only while every ceiling still holds after it; nothing is refunded.
CREATE TABLE IF NOT EXISTS `ai_video_generations` (
  `id` int AUTO_INCREMENT NOT NULL,
  `videoId` int NOT NULL,
  `requests` int NOT NULL DEFAULT 0,
  `secondsRequested` int NOT NULL DEFAULT 0,
  `costMilliUsd` int NOT NULL DEFAULT 0,
  `lastModel` varchar(96),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `ai_video_generations_id` PRIMARY KEY(`id`),
  CONSTRAINT `ai_video_generations_videoId_unique` UNIQUE(`videoId`)
);
--> statement-breakpoint
ALTER TABLE `ai_video_generations` ADD CONSTRAINT `ai_video_generations_videoId_videos_id_fk`
  FOREIGN KEY (`videoId`) REFERENCES `videos`(`id`) ON DELETE cascade ON UPDATE no action;
