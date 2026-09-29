-- VIDEO 619 — refusals remembered per channel as well as per video.
--
-- `channel` is the channel title YouTube's search returns. `refusedEver` stays 1 once the video
-- has been refused for a reason about the video itself, even after it later delivers; `deliveries`
-- counts its deliveries. A channel with more refused videos than delivered ones is asked last.
ALTER TABLE `youtube_unusable_videos` ADD `channel` varchar(128);
--> statement-breakpoint
ALTER TABLE `youtube_unusable_videos` ADD `refusedEver` int NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `youtube_unusable_videos` ADD `deliveries` int NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE `youtube_unusable_videos` SET `refusedEver` = 1 WHERE `refusals` > 0 OR `unusableAt` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `youtube_unusable_videos_channel_idx` ON `youtube_unusable_videos` (`channel`);
