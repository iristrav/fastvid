-- Tracks search keywords that fell back to Pexels/Pixabay because the media archive had no
-- good match — surfaces missing topics in the Media Archive admin so uploads can be targeted.
CREATE TABLE IF NOT EXISTS `archive_content_gaps` (
  `id` int AUTO_INCREMENT PRIMARY KEY,
  `keywordHash` varchar(64) NOT NULL,
  `keyword` varchar(256) NOT NULL,
  `sampleBeatText` varchar(512),
  `hitCount` int NOT NULL DEFAULT 1,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `lastSeenAt` timestamp NOT NULL DEFAULT (now()),
  UNIQUE INDEX `archive_content_gaps_keywordHash_unique` (`keywordHash`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
