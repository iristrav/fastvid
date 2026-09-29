-- VIDEO 618 — YouTube videos that do not work, remembered across renders.
--
-- One row per video refused for a reason about the video itself (googlevideo's HTTP error on the
-- stream, no format, unavailable, private, members only, country block). `refusals` counts them
-- since the video last delivered; `unusableAt` is set at the limit and the video is not asked for
-- again.
CREATE TABLE IF NOT EXISTS `youtube_unusable_videos` (
  `id` int AUTO_INCREMENT NOT NULL,
  `videoId` varchar(32) NOT NULL,
  `refusals` int NOT NULL DEFAULT 0,
  `lastReason` varchar(128),
  `unusableAt` timestamp NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `youtube_unusable_videos_id` PRIMARY KEY(`id`),
  CONSTRAINT `youtube_unusable_videos_videoId_unique` UNIQUE(`videoId`)
);
