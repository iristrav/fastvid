-- Persistent Media Asset Cache
-- Stores downloaded external assets (Pexels, Wikimedia, Archive.org) in R2/S3
-- so identical assets are never re-downloaded, re-FFmpeg'd, or re-CLIP'd.
-- Only active when ENABLE_MEDIA_CACHE=true and S3 storage is configured.

CREATE TABLE `media_asset_cache` (
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
-- Stores search API results per normalized query so Pexels/Wikimedia/Archive
-- are not re-queried for the same topic across videos.
-- TTL managed in application layer (expiresAt compared at read time).

CREATE TABLE `scene_candidate_cache` (
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
