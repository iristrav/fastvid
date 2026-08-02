-- Persistent Beat Semantic Profile Cache
CREATE TABLE IF NOT EXISTS `beat_semantic_cache` (
  `id` int AUTO_INCREMENT PRIMARY KEY,
  `cacheKey` varchar(64) NOT NULL,
  `cacheVersion` varchar(32) NOT NULL,
  `profileJson` text NOT NULL,
  `hitCount` int NOT NULL DEFAULT 0,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  UNIQUE INDEX `beat_semantic_cache_cacheKey_unique` (`cacheKey`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
