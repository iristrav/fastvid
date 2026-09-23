-- RONDE 640 — YouTube sources fetched outside a render, so a render does not have to.
--
-- Render 603 found forty-nine YouTube videos and downloaded none: by YouTube's turn each scene had
-- between zero and ten seconds left. A background worker has no such limit. A render records what
-- it found here; the worker fetches it patiently into the curated archive; later renders take it
-- from there.
--
-- `videoId` is UNIQUE so finding a video again queues it once. `nextAttemptAt` is the backoff,
-- kept in the row so it survives a worker restart. Nothing here says a video is relevant — every
-- render still judges each archive clip against its own beat.
CREATE TABLE IF NOT EXISTS `youtube_prefetch_queue` (
  `id` int AUTO_INCREMENT NOT NULL,
  `videoId` varchar(32) NOT NULL,
  `title` varchar(512),
  `query` varchar(512),
  `licenseMode` varchar(32),
  `status` enum('queued','fetching','ingested','failed','refused') NOT NULL DEFAULT 'queued',
  `attempts` int NOT NULL DEFAULT 0,
  `lastError` varchar(512),
  `nextAttemptAt` timestamp NOT NULL DEFAULT (now()),
  `archiveAssetId` int,
  `sourceVideoId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `youtube_prefetch_queue_id` PRIMARY KEY(`id`),
  CONSTRAINT `youtube_prefetch_queue_videoId_unique` UNIQUE(`videoId`)
);
--> statement-breakpoint
CREATE INDEX `youtube_prefetch_queue_claim_idx` ON `youtube_prefetch_queue` (`status`,`nextAttemptAt`);
