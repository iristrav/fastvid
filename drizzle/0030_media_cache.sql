-- Persistent Media Asset Cache
CREATE TABLE IF NOT EXISTS `media_asset_cache` (
  `id` int AUTO_INCREMENT PRIMARY KEY,
  `urlHash` varchar(64) NOT NULL,
  `sourceUrl` text NOT NULL,
  `r2Key` varchar(512) NOT NULL,
  `contentType` varchar(64) NOT NULL DEFAULT 'application/octet-stream',
  `fileSizeBytes` int NOT NULL DEFAULT 0,
  `durationSec` float,
  `cacheVersion` varchar(32) NOT NULL DEFAULT '1',
  `hitCount` int NOT NULL DEFAULT 0,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `lastHitAt` timestamp NOT NULL DEFAULT (now()),
  UNIQUE INDEX `media_asset_cache_urlHash_unique` (`urlHash`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
--> statement-breakpoint

-- Persistent Scene Candidate Cache
CREATE TABLE IF NOT EXISTS `scene_candidate_cache` (
  `id` int AUTO_INCREMENT PRIMARY KEY,
  `queryHash` varchar(64) NOT NULL,
  `queryText` varchar(512) NOT NULL,
  `source` varchar(32) NOT NULL,
  `cacheVersion` varchar(32) NOT NULL,
  `candidatesJson` longtext NOT NULL,
  `hitCount` int NOT NULL DEFAULT 0,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `expiresAt` timestamp NOT NULL,
  UNIQUE INDEX `scene_candidate_cache_queryHash_source_unique` (`queryHash`, `source`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
