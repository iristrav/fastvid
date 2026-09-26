-- RONDE 658 — one YouTube search budget per video, kept by the database.
--
-- "1 search normaal, 2 searches maximaal, 3 searches nooit", over every retry, replica, requeue,
-- deploy and user retry. `searchCount` moves 0 -> 1 -> 2 only through a conditional UPDATE that
-- exactly one caller wins; the rest of the row records what each search found and why a second
-- one was (or was not) needed. `poolJson` keeps the judged candidates for a later attempt.
CREATE TABLE IF NOT EXISTS `youtube_video_searches` (
  `id` int AUTO_INCREMENT NOT NULL,
  `videoId` int NOT NULL,
  `searchCount` int NOT NULL DEFAULT 0,
  `beatsTotal` int,
  `search1StartedAt` timestamp NULL,
  `search1CompletedAt` timestamp NULL,
  `search1Query` varchar(300),
  `search1Status` varchar(64),
  `search1Candidates` int,
  `search1Usable` int,
  `search1Coverage` int,
  `archiveUsable` int,
  `search2Needed` int,
  `search2Reason` varchar(400),
  `search2StartedAt` timestamp NULL,
  `search2CompletedAt` timestamp NULL,
  `search2Query` varchar(300),
  `search2Status` varchar(64),
  `search2Candidates` int,
  `search2Usable` int,
  `finalCoverage` int,
  `downloads` int,
  `downloadsOk` int,
  `timelineClips` int,
  `fallbackUsed` int,
  `poolJson` longtext,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `youtube_video_searches_id` PRIMARY KEY(`id`),
  CONSTRAINT `youtube_video_searches_videoId_unique` UNIQUE(`videoId`)
);
--> statement-breakpoint
ALTER TABLE `youtube_video_searches` ADD CONSTRAINT `youtube_video_searches_videoId_videos_id_fk`
  FOREIGN KEY (`videoId`) REFERENCES `videos`(`id`) ON DELETE cascade ON UPDATE no action;
